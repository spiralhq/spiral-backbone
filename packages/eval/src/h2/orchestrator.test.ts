import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultRecordSchema } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import { appendResult, readJsonLines } from "../common/ndjson";
import { runStatusSchema } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import {
  appendBlockRecord,
  blocksPath,
  readBlockRecords,
  scenarioFor,
  validGenerations,
} from "./blocks-log";
import type { CampaignSpec } from "./campaign";
import type { AttemptPayload, ExecutorOutput } from "./executor/attempt";
import {
  BlockGateError,
  GenerationLimitError,
  runPlan,
  type OrchestratorDeps,
} from "./orchestrator";
import { generatePlan, type FrozenPlan } from "./plan";
import type { StateCheck } from "./state";
import { goldenFixture } from "./testing/fixtures";

const campaign: CampaignSpec = {
  campaign_version: 1,
  replica_nodes: ["a", "b"],
  stabilization_ms: 0,
  max_gate_attempts: 3,
  max_block_generations: 2,
  timeout: { base_ms: 1000, per_mb_ms: 0 },
  blocks: [
    {
      name: "main",
      kind: "main",
      active_replicas: ["a", "b"],
      methods: ["direct"],
      works: "all",
      repetitions: 2,
    },
    {
      name: "replicas=2",
      kind: "degradation",
      active_replicas: ["a", "b"],
      methods: ["direct"],
      works: "all",
      repetitions: 1,
    },
    {
      name: "replicas=1",
      kind: "degradation",
      active_replicas: ["a"],
      methods: ["direct"],
      works: "all",
      repetitions: 1,
    },
    {
      name: "replicas=0",
      kind: "degradation",
      active_replicas: [],
      methods: ["direct"],
      works: "all",
      repetitions: 1,
    },
  ],
};
const golden = [
  goldenFixture({ work_id: "pd-901", film_pda: "F1" }),
  goldenFixture({
    work_id: "pd-902",
    film_pda: "F2",
    cid: "bafybeidsllxmnuveplqr6cs7ndxpgsolad3j7wj3bntrkvl4bor5cb44lq",
  }),
];
const expectedDeclared = ["12D3KooWReplicaA", "12D3KooWReplicaB"];
const cidOf = (workId: string) => golden.find((g) => g.work_id === workId)!.cid;
const context = {
  rpc_url: "http://rpc.local:8899",
  gateway_url: "http://gw.local:8080",
  bootstrap_multiaddr: null,
  private_network: false,
  artifact_versions: {},
};
const confirmed = (intended: string[]): StateCheck => ({
  intended,
  observed: [],
  missing_providers: {},
  confirmed: true,
  reasons: [],
});
const unconfirmed = (intended: string[]): StateCheck => ({
  ...confirmed(intended),
  confirmed: false,
  reasons: ["drift"],
});

function fakeOutput(p: AttemptPayload): ExecutorOutput {
  return {
    record: resultRecordSchema.parse({
      run_id: p.run_id,
      hypothesis: "H2",
      film_pda: p.film_pda,
      work_id: p.work_id,
      size_bytes: p.size_bytes,
      size_band: p.size_band,
      scenario: p.scenario,
      method: p.method,
      attempt: p.repetition,
      started_at: "2026-10-06T12:00:00.000Z",
      finished_at: "2026-10-06T12:00:01.000Z",
      latency_ms: 1000,
      cid_expected: cidOf(p.work_id),
      cid_observed: cidOf(p.work_id),
      outcome: "success",
      failure_class: null,
      tx_signature: null,
      rpc_endpoint: "rpc.local:8899",
      verifier_impl: "v",
      artifact_versions: {},
    }),
    evidence: {
      run_id: p.run_id,
      attempt_id: p.attempt_id,
      scenario: p.scenario,
      declared_replicas: [...expectedDeclared].reverse(),
    },
  };
}

function setup(overrides: Partial<OrchestratorDeps> = {}) {
  const outPath = join(mkdtempSync(join(tmpdir(), "h2-orch-")), "h2.ndjson");
  const plan = generatePlan({ campaign, golden, runId: "2026-10-06T12:00:00Z-h2-unit" });
  const applied: string[][] = [];
  const payloads: AttemptPayload[] = [];
  const deps: OrchestratorDeps = {
    applyState: async (intended) => void applied.push(intended),
    checkState: async (intended) => confirmed(intended),
    runAttempt: async (p) => {
      payloads.push(p);
      return fakeOutput(p);
    },
    sleep: async () => {},
    ...overrides,
  };
  return { outPath, plan, deps, applied, payloads };
}

const records = (outPath: string) => readJsonLines(outPath, resultRecordSchema);

describe("runPlan", () => {
  it("runs blocks in plan order, logs gate and end per block, and marks the run complete", async () => {
    const { outPath, plan, deps, applied } = setup();
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(result).toEqual({ executed: 10, skipped: 0, interrupted: false, generationsRerun: 0 });
    expect(applied).toEqual([["a", "b"], ["a", "b"], ["a"], [], ["a", "b"]]);
    const log = await readBlockRecords(blocksPath(outPath));
    expect(log.filter((r) => r.phase === "gate").map((r) => r.block_name)).toEqual([
      "main",
      "replicas=2",
      "replicas=1",
      "replicas=0",
    ]);
    expect((await records(outPath)).map((r) => r.scenario)).toContain("replicas=1@g1");
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started", "completed"]);
  });

  it("retries the gate until the state confirms", async () => {
    let calls = 0;
    const { outPath, plan, deps } = setup({
      checkState: async (intended) => (++calls <= 2 ? unconfirmed(intended) : confirmed(intended)),
    });
    await runPlan({ plan, outPath, deps, context, expectedDeclared });
    const gates = (await readBlockRecords(blocksPath(outPath))).filter(
      (r) => r.phase === "gate" && r.block_name === "main",
    );
    expect(gates.map((g) => g.confirmed)).toEqual([false, false, true]);
  });

  it("stabilizes before every gate check: apply → sleep(stabilization_ms) → check, retries included", async () => {
    const plan = generatePlan({
      campaign: { ...campaign, stabilization_ms: 1234 },
      golden,
      runId: "2026-10-06T12:00:00Z-h2-stabilize",
    });
    const outPath = join(mkdtempSync(join(tmpdir(), "h2-orch-")), "h2.ndjson");
    const calls: string[] = [];
    let checks = 0;
    const deps: OrchestratorDeps = {
      applyState: async (intended) => void calls.push(`apply:${intended.join(",")}`),
      checkState: async (intended) => {
        calls.push(`check:${intended.join(",")}`);
        return ++checks === 1 ? unconfirmed(intended) : confirmed(intended);
      },
      runAttempt: async (p) => {
        calls.push("run");
        return fakeOutput(p);
      },
      sleep: async (ms) => void calls.push(`sleep:${ms}`),
    };
    await runPlan({ plan, outPath, deps, context, expectedDeclared });

    const gate = (s: string) => [`apply:${s}`, "sleep:1234", `check:${s}`];
    const expected: string[] = [];
    for (const block of plan.blocks) {
      const s = block.active_replicas.join(",");
      if (block.block_index === 0) expected.push(...gate(s));
      expected.push(...gate(s), ...block.attempts.map(() => "run"), `check:${s}`);
    }
    expected.push("apply:a,b");
    expect(calls).toEqual(expected);
  });

  it("aborts a block whose gate never confirms, recording no attempts for it", async () => {
    const { outPath, plan, deps, payloads } = setup({
      checkState: async (intended) => unconfirmed(intended),
    });
    await expect(
      runPlan({ plan, outPath, deps, context, expectedDeclared }),
    ).rejects.toBeInstanceOf(BlockGateError);
    expect(payloads).toEqual([]);
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started"]);
  });

  it("re-runs a block as a new generation when its end check fails, and only the valid generation counts", async () => {
    let endChecks = 0;
    const { outPath, plan, deps } = setup({
      checkState: async (intended) => {
        return intended.length === 1 && ++endChecks === 2
          ? unconfirmed(intended)
          : confirmed(intended);
      },
    });
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(result.generationsRerun).toBe(1);
    const scenarios = (await records(outPath)).map((r) => r.scenario);
    expect(scenarios.filter((s) => s.startsWith("replicas=1@"))).toEqual([
      "replicas=1@g1",
      "replicas=1@g1",
      "replicas=1@g2",
      "replicas=1@g2",
    ]);
    const valid = validGenerations(await readBlockRecords(blocksPath(outPath)), plan.run_id);
    expect(valid.has("replicas=1@g1")).toBe(false);
    expect(valid.has("replicas=1@g2")).toBe(true);
  });

  it("stops at max_block_generations", async () => {
    const { outPath, plan, deps } = setup({
      checkState: async (intended) =>
        intended.length === 1 ? unconfirmedAfterGate(intended) : confirmed(intended),
    });
    let phase = 0;
    function unconfirmedAfterGate(intended: string[]): StateCheck {
      return ++phase % 2 === 1 ? confirmed(intended) : unconfirmed(intended);
    }
    await expect(
      runPlan({ plan, outPath, deps, context, expectedDeclared }),
    ).rejects.toBeInstanceOf(GenerationLimitError);
  });

  it("resumes after an interruption without repeating recorded attempts", async () => {
    const { outPath, plan, deps, payloads } = setup();
    const first = await runPlan({
      plan,
      outPath,
      deps,
      context,
      expectedDeclared,
      stopAfterAttempts: 3,
    });
    expect(first.interrupted).toBe(true);
    const second = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(second.executed).toBe(7);
    expect(payloads).toHaveLength(10);
    const keys = (await records(outPath)).map(
      (r) => `${r.scenario}|${r.work_id}|${r.method}|${r.attempt}`,
    );
    expect(new Set(keys).size).toBe(10);
  });

  it("treats an executor fault as a harness fault: nothing recorded, resume re-runs it", async () => {
    let fail = true;
    const { outPath, plan, deps, payloads } = setup();
    const flaky: OrchestratorDeps = {
      ...deps,
      runAttempt: async (p) => {
        if (fail && p.attempt_id === "main/pd-902/direct/r1") {
          fail = false;
          throw new Error("executor fault: boom");
        }
        return deps.runAttempt(p);
      },
    };
    await expect(
      runPlan({ plan, outPath, deps: flaky, context, expectedDeclared }),
    ).rejects.toThrow(/boom/);
    expect(
      (await records(outPath)).some(
        (r) => r.work_id === "pd-902" && r.scenario === "main@g1" && r.attempt === 1,
      ),
    ).toBe(false);
    await runPlan({ plan, outPath, deps: flaky, context, expectedDeclared });
    expect((await records(outPath)).length).toBe(10);
    expect(payloads.filter((p) => p.attempt_id === "main/pd-902/direct/r1")).toHaveLength(1);
  });

  it("refuses an executor record for a different attempt", async () => {
    const { outPath, plan, deps } = setup();
    const wrong: OrchestratorDeps = {
      ...deps,
      runAttempt: async (p) => fakeOutput({ ...p, repetition: p.repetition + 7 }),
    };
    await expect(
      runPlan({ plan, outPath, deps: wrong, context, expectedDeclared }),
    ).rejects.toThrow(/different attempt/);
    expect(existsSync(outPath)).toBe(false);
  });
});

async function logBlock(
  outPath: string,
  plan: FrozenPlan,
  blockName: string,
  generation: number,
  phase: "gate" | "end",
  ok: boolean,
): Promise<void> {
  const block = plan.blocks.find((b) => b.name === blockName)!;
  await appendBlockRecord(blocksPath(outPath), {
    run_id: plan.run_id,
    block_index: block.block_index,
    block_name: block.name,
    generation,
    phase,
    check_number: 1,
    intended_active: block.active_replicas,
    observed: [],
    missing_providers: {},
    confirmed: ok,
    reasons: ok ? [] : ["drift"],
    at: "2026-10-06T12:00:00.000Z",
  });
}

async function recordAttempts(
  outPath: string,
  plan: FrozenPlan,
  blockName: string,
  generation: number,
  count?: number,
): Promise<void> {
  const block = plan.blocks.find((b) => b.name === blockName)!;
  for (const a of block.attempts.slice(0, count)) {
    const payload: AttemptPayload = {
      run_id: plan.run_id,
      attempt_id: a.attempt_id,
      scenario: scenarioFor(block.name, generation),
      work_id: a.work_id,
      film_pda: a.film_pda,
      size_bytes: a.size_bytes,
      size_band: a.size_band,
      method: a.method,
      repetition: a.repetition,
      timeout_ms: a.timeout_ms,
      gateway_eligible: a.gateway_eligible,
      active_replicas: block.active_replicas.length,
      ...context,
    };
    await appendResult(outPath, fakeOutput(payload).record);
  }
}

const mainLog = async (outPath: string) =>
  (await readBlockRecords(blocksPath(outPath)))
    .filter((r) => r.block_name === "main")
    .map((r) => `${r.phase}:g${r.generation}#${r.check_number}:${r.confirmed}`);

describe("runPlan resume and integrity", () => {
  it("skips a block whose confirmed generation is fully recorded", async () => {
    const { outPath, plan, deps, payloads } = setup();
    await runPlan({ plan, outPath, deps, context, expectedDeclared });
    const again = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(again).toEqual({ executed: 0, skipped: 10, interrupted: false, generationsRerun: 0 });
    expect(payloads).toHaveLength(10);
  });

  it("resumes at g+1 when the logged end of the latest generation is unconfirmed", async () => {
    const { outPath, plan, deps } = setup();
    await logBlock(outPath, plan, "main", 1, "gate", true);
    await recordAttempts(outPath, plan, "main", 1);
    await logBlock(outPath, plan, "main", 1, "end", false);
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(result).toEqual({ executed: 10, skipped: 0, interrupted: false, generationsRerun: 1 });
    const scenarios = (await records(outPath)).map((r) => r.scenario);
    expect(scenarios.filter((s) => s === "main@g2")).toHaveLength(4);
    const valid = validGenerations(await readBlockRecords(blocksPath(outPath)), plan.run_id);
    expect(valid.has("main@g1")).toBe(false);
    expect(valid.has("main@g2")).toBe(true);
  });

  it("checks state before re-applying on a mid-block resume, and opens g+1 on drift", async () => {
    const ops: string[] = [];
    let checks = 0;
    const { outPath, plan, deps } = setup({
      applyState: async () => void ops.push("apply"),
      checkState: async (intended) => {
        ops.push("check");
        return ++checks === 1 ? unconfirmed(intended) : confirmed(intended);
      },
    });
    await logBlock(outPath, plan, "main", 1, "gate", true);
    await recordAttempts(outPath, plan, "main", 1);
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(ops[0]).toBe("check");
    expect(result.generationsRerun).toBe(1);
    expect(result.executed).toBe(10);
    expect(await mainLog(outPath)).toEqual([
      "gate:g1#1:true",
      "end:g1#1:false",
      "gate:g2#1:true",
      "end:g2#1:true",
    ]);
  });

  it("finishes the same generation on a mid-block resume without drift", async () => {
    const ops: string[] = [];
    const { outPath, plan, deps } = setup({
      applyState: async () => void ops.push("apply"),
      checkState: async (intended) => {
        ops.push("check");
        return confirmed(intended);
      },
    });
    await logBlock(outPath, plan, "main", 1, "gate", true);
    await recordAttempts(outPath, plan, "main", 1);
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(ops.slice(0, 2)).toEqual(["check", "apply"]);
    expect(result).toEqual({ executed: 6, skipped: 4, interrupted: false, generationsRerun: 0 });
    expect(await mainLog(outPath)).toEqual([
      "gate:g1#1:true",
      "gate:g1#2:true",
      "gate:g1#3:true",
      "end:g1#1:true",
    ]);
  });

  it("finishes the remaining attempts of the same generation after a true mid-block crash", async () => {
    const { outPath, plan, deps } = setup();
    await logBlock(outPath, plan, "main", 1, "gate", true);
    await recordAttempts(outPath, plan, "main", 1, 2);
    const result = await runPlan({ plan, outPath, deps, context, expectedDeclared });
    expect(result).toEqual({ executed: 8, skipped: 2, interrupted: false, generationsRerun: 0 });
    const scenarios = (await records(outPath)).map((r) => r.scenario);
    expect(scenarios.filter((s) => s === "main@g1")).toHaveLength(4);
    expect(scenarios.some((s) => s.startsWith("main@g2"))).toBe(false);
  });

  it("refuses to continue when a confirmed generation is missing results", async () => {
    const { outPath, plan, deps, payloads } = setup();
    await logBlock(outPath, plan, "main", 1, "gate", true);
    await recordAttempts(outPath, plan, "main", 1, 3);
    await logBlock(outPath, plan, "main", 1, "end", true);
    await expect(runPlan({ plan, outPath, deps, context, expectedDeclared })).rejects.toThrow(
      /inconsistent/,
    );
    expect(payloads).toEqual([]);
  });

  it.each(["attempt_id", "run_id", "scenario"])(
    "refuses executor evidence whose %s differs from the attempt, writing nothing",
    async (field) => {
      const { outPath, plan, deps } = setup();
      const wrong: OrchestratorDeps = {
        ...deps,
        runAttempt: async (p) => {
          const out = fakeOutput(p);
          return { ...out, evidence: { ...out.evidence, [field]: "other" } };
        },
      };
      await expect(
        runPlan({ plan, outPath, deps: wrong, context, expectedDeclared }),
      ).rejects.toThrow(/evidence/);
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(sidecarPath(outPath, "evidence"))).toBe(false);
    },
  );

  it.each([
    ["cid_expected", { cid_expected: "bafkreiother" }, /cid_expected/],
    ["film_pda", { film_pda: "OtherFilm" }, /film_pda/],
  ] as const)(
    "refuses an executor record whose %s differs from the plan, writing nothing",
    async (_field, patch, message) => {
      const { outPath, plan, deps } = setup();
      const wrong: OrchestratorDeps = {
        ...deps,
        runAttempt: async (p) => {
          const out = fakeOutput(p);
          return { ...out, record: { ...out.record, ...patch } };
        },
      };
      await expect(
        runPlan({ plan, outPath, deps: wrong, context, expectedDeclared }),
      ).rejects.toThrow(message);
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(sidecarPath(outPath, "evidence"))).toBe(false);
    },
  );

  it.each([
    ["an extra declared peer", [...expectedDeclared, "12D3KooWStranger"]],
    ["a missing declared peer", expectedDeclared.slice(0, 1)],
    ["a non-list", "12D3KooWReplicaA"],
    ["no declared_replicas", undefined],
  ])(
    "refuses executor evidence with %s against the topology, writing nothing",
    async (_label, declared) => {
      const { outPath, plan, deps } = setup();
      const wrong: OrchestratorDeps = {
        ...deps,
        runAttempt: async (p) => {
          const out = fakeOutput(p);
          return { ...out, evidence: { ...out.evidence, declared_replicas: declared } };
        },
      };
      await expect(
        runPlan({ plan, outPath, deps: wrong, context, expectedDeclared }),
      ).rejects.toThrow(/declared_replicas/);
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(sidecarPath(outPath, "evidence"))).toBe(false);
    },
  );

  it("writes the evidence before the result, so the result line is the commit point", async () => {
    const { outPath, plan, deps } = setup();
    const blocked: OrchestratorDeps = {
      ...deps,
      runAttempt: async (p) => {
        mkdirSync(outPath);
        return deps.runAttempt(p);
      },
    };
    await expect(
      runPlan({ plan, outPath, deps: blocked, context, expectedDeclared }),
    ).rejects.toThrow();
    const evidence = readFileSync(sidecarPath(outPath, "evidence"), "utf8").trim().split("\n");
    expect(evidence.map((l) => JSON.parse(l).attempt_id)).toEqual(["main/pd-901/direct/r1"]);
  });
});
