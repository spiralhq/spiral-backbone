import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonLines } from "../common/ndjson";
import { runStatusSchema } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import { generateReport } from "../report/run";
import { summarizeH2 } from "../report/h2";
import { shouldSkipE2e, startLocalChain, type LocalChain } from "../testing/chain";
import { createOrg, submitForTest } from "../testing/submit";
import { blocksPath, readBlockRecords } from "./blocks-log";
import { loadCampaign, type CampaignSpec } from "./campaign";
import { expectedDeclaredOf, payloadContextOf, realDeps } from "./deps";
import { buildExecutorImage } from "./executor/image";
import { runPlan, type OrchestratorDeps } from "./orchestrator";
import { generatePlan } from "./plan";
import { sshReplicaController } from "./state";
import { HOST_GATEWAY_ADD_HOST, startRpcRelay } from "./testing/rpc-relay";
import { startLocalTopology, type LocalTopology } from "./testing/local-topology";

const skip = shouldSkipE2e("H2 dry run");
const PRESET = join(import.meta.dirname, "..", "..", "campaigns", "h2-dry-run.json");
const count = z.number().int().nonnegative();
const provenanceSchema = z
  .object({
    peers: z.array(
      z.object({ peer_id: z.string(), bytes_received: count, declared: z.boolean() }).strict(),
    ),
    data_received: count,
    dup_data_received: count,
    dag_size: count.nullable(),
    ledger_declared_total: count,
    ledger_undeclared_total: count,
    unattributed: z.number().int(),
  })
  .strict();
const evidenceSchema = z
  .object({
    run_id: z.string(),
    attempt_id: z.string(),
    scenario: z.string(),
    generation: z.number().int().positive(),
    block_index: count,
    reason: z.string(),
    active_replicas: count,
    declared_replicas: z.array(z.string()),
    provenance: provenanceSchema.nullable(),
    gateway_status: z.number().int().nullable(),
    gateway_headers: z.record(z.string(), z.string()),
  })
  .strict();

describe.skipIf(skip)("eval:h2 reduced-scale dry run", () => {
  let chain: LocalChain;
  let relay: Awaited<ReturnType<typeof startRpcRelay>>;
  let local: LocalTopology;
  let golden: InventoryRecord[];
  const deps = (): OrchestratorDeps =>
    realDeps(local.topology, { pingTimeoutMs: 5_000, providersTimeoutMs: 15_000 });

  beforeAll(async () => {
    chain = await startLocalChain();
    relay = await startRpcRelay(chain.rpcUrl);
    local = await startLocalTopology({
      rpcUrlForContainers: relay.urlForContainers,
      addHosts: [HOST_GATEWAY_ADD_HOST],
    });
    await buildExecutorImage();
    await createOrg(chain, "h2-dry");
    const urls = Object.values(local.replicaApiUrls);
    golden = [
      await submitForTest({
        chain,
        slug: "h2-dry",
        workId: "pd-901",
        content: randomBytes(700_000),
        title: "warm",
        kuboUrls: urls,
      }),
      await submitForTest({
        chain,
        slug: "h2-dry",
        workId: "pd-902",
        content: randomBytes(500_000),
        title: "cold",
        kuboUrls: urls,
        coldCid: true,
      }),
    ];
  }, 900_000);

  afterAll(async () => {
    await local?.stop();
    await relay?.stop();
    chain?.stop();
  }, 120_000);

  it("runs the full 3 → 2 → 1 → 0 degradation and produces three correlated artifacts", async () => {
    const plan = generatePlan({
      campaign: await loadCampaign(PRESET),
      golden,
      runId: "2026-10-06T12:00:00Z-h2-dry",
    });
    const outDir = mkdtempSync(join(tmpdir(), "h2-dry-"));
    const outPath = join(outDir, "h2.ndjson");
    const result = await runPlan({
      plan,
      outPath,
      deps: deps(),
      context: payloadContextOf(local.topology),
      expectedDeclared: expectedDeclaredOf(local.topology),
    });
    expect(result).toMatchObject({ executed: 14, interrupted: false, generationsRerun: 0 });

    const log = await readBlockRecords(blocksPath(outPath));
    const order = ["main", "cold-start", "replicas=3", "replicas=2", "replicas=1", "replicas=0"];
    expect(log.every((r) => r.run_id === plan.run_id)).toBe(true);
    expect(log.filter((r) => r.phase === "gate" && r.confirmed).map((r) => r.block_name)).toEqual(
      order,
    );
    const ends = log.filter((r) => r.phase === "end");
    expect(ends.map((r) => [r.block_name, r.generation, r.confirmed])).toEqual(
      order.map((name) => [name, 1, true]),
    );
    expect(ends.find((r) => r.block_name === "replicas=2")?.intended_active).toEqual(["a", "b"]);
    expect(ends.map((r) => r.intended_active.length)).toEqual(
      plan.blocks.map((b) => b.active_replicas.length),
    );
    for (const name of order) {
      const mine = log.filter((r) => r.block_name === name);
      expect(mine.at(-1)?.phase).toBe("end");
      expect(mine.at(-2)).toMatchObject({ phase: "gate", confirmed: true });
    }

    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records).toHaveLength(14);
    expect(records.every((r) => r.run_id === plan.run_id && r.hypothesis === "H2")).toBe(true);
    const by = (scenario: string, work: string, method: string) =>
      records.find((r) => r.scenario === scenario && r.work_id === work && r.method === method)!;
    for (const scenario of [
      "main@g1",
      "cold-start@g1",
      "replicas=3@g1",
      "replicas=2@g1",
      "replicas=1@g1",
    ]) {
      expect(
        records.filter((r) => r.scenario === scenario).every((r) => r.outcome === "success"),
      ).toBe(true);
    }
    for (const work of ["pd-901", "pd-902"]) {
      expect(["timeout", "object_unavailable"]).toContain(
        by("replicas=0@g1", work, "direct").failure_class,
      );
    }
    expect(by("replicas=0@g1", "pd-901", "gateway")).toMatchObject({
      outcome: "failure",
      failure_class: "external_cache",
    });
    expect(by("replicas=0@g1", "pd-902", "gateway").outcome).toBe("failure");
    expect(by("replicas=0@g1", "pd-902", "gateway").failure_class).not.toBe("external_cache");

    const evidence = await readJsonLines(sidecarPath(outPath, "evidence"), evidenceSchema);
    const planned = plan.blocks.flatMap((b) =>
      b.attempts.map((a) => ({ id: a.attempt_id, block: b })),
    );
    expect(evidence.map((e) => e.attempt_id).sort()).toEqual(planned.map((p) => p.id).sort());
    for (const e of evidence) {
      const block = planned.find((p) => p.id === e.attempt_id)!.block;
      expect(e).toMatchObject({
        run_id: plan.run_id,
        generation: 1,
        block_index: block.block_index,
        active_replicas: block.active_replicas.length,
      });
      for (const p of e.provenance?.peers ?? [])
        expect(p.declared || p.bytes_received === 0).toBe(true);
      const [name, work, method] = e.attempt_id.split("/") as [string, string, string];
      const record = by(`${name}@g1`, work, method);
      if (method === "gateway") expect(e.provenance).toBeNull();
      if (method === "direct" && record.outcome === "success") {
        const p = e.provenance!;
        expect(p.data_received).toBeGreaterThan(0);
        expect(p.ledger_undeclared_total).toBe(0);
        expect(p.dag_size).not.toBeNull();
        expect(p.ledger_declared_total).toBeGreaterThanOrEqual(p.dag_size!);
      }
    }

    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started", "completed"]);

    const { markdownPath } = await generateReport({
      resultsDir: outDir,
      outDir: join(outDir, "report"),
    });
    const md = readFileSync(markdownPath, "utf8");
    expect(md).toContain("## H2");
    expect(md).toContain("Status: complete (14/14 attempts)");
    expect(md).toContain(
      "Attempts included: 14 of 14 planned (14 recorded, including re-run generations)",
    );
    expect(md).not.toContain("Attempts excluded");
    expect(md).toContain("| replicas=1 | direct | 2 | 2 | 0 | 100.0% |");
    expect(md).toContain("| replicas=0 | gateway | external_cache | 1 |");
    expect(md).not.toContain("refutes H2");
    expect(md).not.toContain("Zero-replica control contaminated");
  }, 1_800_000);

  it("resumes an interrupted run without repeating attempts", async () => {
    const campaign: CampaignSpec = {
      ...(await loadCampaign(PRESET)),
      blocks: [
        {
          name: "main",
          kind: "main",
          active_replicas: ["a", "b", "c"],
          methods: ["direct"],
          works: "all",
          repetitions: 2,
        },
      ],
    };
    const plan = generatePlan({ campaign, golden, runId: "2026-10-06T12:00:00Z-h2-resume" });
    const outPath = join(mkdtempSync(join(tmpdir(), "h2-resume-")), "h2.ndjson");
    const first = await runPlan({
      plan,
      outPath,
      deps: deps(),
      context: payloadContextOf(local.topology),
      expectedDeclared: expectedDeclaredOf(local.topology),
      stopAfterAttempts: 2,
    });
    expect(first).toMatchObject({ executed: 2, interrupted: true });
    const second = await runPlan({
      plan,
      outPath,
      deps: deps(),
      context: payloadContextOf(local.topology),
      expectedDeclared: expectedDeclaredOf(local.topology),
    });
    expect(second).toMatchObject({ executed: 2, skipped: 2, interrupted: false });
    const keys = (await readJsonLines(outPath, resultRecordSchema)).map(
      (r) => `${r.scenario}|${r.work_id}|${r.attempt}`,
    );
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);

    const log = await readBlockRecords(blocksPath(outPath));
    expect(log.every((r) => r.generation === 1)).toBe(true);
    const gates = log.filter((r) => r.phase === "gate");
    expect(gates.map((r) => r.check_number)).toEqual(gates.map((_, i) => i + 1));
    expect(gates.filter((r) => r.confirmed).length).toBe(3);
    expect(log.filter((r) => r.phase === "end").map((r) => r.confirmed)).toEqual([true]);
    expect(log.at(-1)?.phase).toBe("end");
  }, 900_000);

  it("invalidates a block whose replica state drifts mid-block and re-runs it", async () => {
    const campaign: CampaignSpec = {
      ...(await loadCampaign(PRESET)),
      blocks: [
        {
          name: "main",
          kind: "main",
          active_replicas: ["a", "b", "c"],
          methods: ["direct"],
          works: ["pd-901"],
          repetitions: 2,
        },
      ],
    };
    const plan = generatePlan({ campaign, golden, runId: "2026-10-06T12:00:00Z-h2-drift" });
    const outPath = join(mkdtempSync(join(tmpdir(), "h2-drift-")), "h2.ndjson");
    const controller = sshReplicaController(local.topology, { pingTimeoutMs: 5_000 });
    const base = deps();
    let sabotaged = false;
    const drifting: OrchestratorDeps = {
      ...base,
      runAttempt: async (payload) => {
        const out = await base.runAttempt(payload);
        if (!sabotaged) {
          sabotaged = true;
          await controller.stop("c");
        }
        return out;
      },
    };
    const result = await runPlan({
      plan,
      outPath,
      deps: drifting,
      context: payloadContextOf(local.topology),
      expectedDeclared: expectedDeclaredOf(local.topology),
    });
    expect(result.generationsRerun).toBe(1);
    const blocks = await readBlockRecords(blocksPath(outPath));
    const ends = blocks.filter((r) => r.phase === "end");
    expect(ends.map((e) => [e.generation, e.confirmed])).toEqual([
      [1, false],
      [2, true],
    ]);
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records.map((r) => r.scenario)).toEqual(["main@g1", "main@g1", "main@g2", "main@g2"]);
    const summary = summarizeH2(records, blocks, plan.run_id);
    expect(summary.excludedUnconfirmed).toBe(2);
    expect(summary.excludedNoEnd).toBe(0);
    expect(summary.included).toBe(2);
  }, 900_000);
});
