import type { ResultRecord } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import { validGenerations, type BlockCheckRecord } from "../h2/blocks-log";
import {
  h2AcceptanceLine,
  h2AttemptsLine,
  h2DirectOnlyLine,
  h2OneReplicaLine,
  percentile,
  provenanceAudit,
  summarizeH2,
} from "./h2";
import type { H2Evidence } from "./load";

const RUN = "2026-10-06T12:00:00Z-h2-r";

function rec(o: Partial<ResultRecord>): ResultRecord {
  return {
    run_id: RUN,
    hypothesis: "H2",
    film_pda: "F",
    work_id: "pd-901",
    size_bytes: 1,
    size_band: "small",
    scenario: "replicas=3@g1",
    method: "direct",
    attempt: 1,
    started_at: "s",
    finished_at: "f",
    latency_ms: 100,
    cid_expected: "c",
    cid_observed: "c",
    outcome: "success",
    failure_class: null,
    tx_signature: null,
    rpc_endpoint: "h",
    verifier_impl: "v",
    artifact_versions: {},
    ...o,
  };
}

function end(
  block: string,
  generation: number,
  confirmed: boolean,
  intended: string[],
  blockIndex = 0,
): BlockCheckRecord {
  return {
    run_id: RUN,
    block_index: blockIndex,
    block_name: block,
    generation,
    phase: "end",
    check_number: 1,
    intended_active: intended,
    observed: [],
    missing_providers: {},
    confirmed,
    reasons: [],
    at: "t",
  };
}

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
  });
});

type Kind = "main" | "cold-start" | "degradation";
const planOf = (...blocks: [name: string, kind: Kind, active: number][]) =>
  blocks.map(([name, kind, active]) => ({
    name,
    kind,
    active_replicas: ["a", "b", "c"].slice(0, active),
  }));

describe("summarizeH2", () => {
  const plan = planOf(
    ["replicas=3", "degradation", 3],
    ["replicas=1", "degradation", 1],
    ["replicas=0", "degradation", 0],
  );
  const blocks = [
    end("replicas=3", 1, true, ["a", "b", "c"]),
    end("replicas=1", 1, false, ["a"]),
    end("replicas=1", 2, true, ["a"]),
    end("replicas=0", 1, true, []),
  ];
  const records = [
    rec({ scenario: "replicas=3@g1", latency_ms: 100 }),
    rec({ scenario: "replicas=3@g1", latency_ms: 300 }),
    rec({ scenario: "replicas=3@g1", method: "gateway", latency_ms: 50 }),
    rec({ scenario: "replicas=1@g1", outcome: "failure", failure_class: "timeout" }),
    rec({ scenario: "replicas=1@g2", latency_ms: 200 }),
    rec({ scenario: "replicas=0@g1", outcome: "failure", failure_class: "timeout" }),
    rec({
      scenario: "replicas=0@g1",
      method: "gateway",
      outcome: "failure",
      failure_class: "external_cache",
    }),
  ];

  it("excludes unconfirmed generations and keeps external_cache out of the rate", () => {
    const s = summarizeH2(records, blocks, RUN, plan);
    expect(s.excludedUnconfirmed).toBe(1);
    expect(s.excludedNoEnd).toBe(0);
    expect(s.included).toBe(6);
    expect(s.rateRows).toContainEqual(["replicas=3", "direct", "2", "2", "0", "100.0%"]);
    expect(s.rateRows).toContainEqual(["replicas=1", "direct", "1", "1", "0", "100.0%"]);
    expect(s.rateRows).toContainEqual(["replicas=0", "gateway", "1", "0", "1", "—"]);
    expect(s.directSuccessAtZero).toBe(0);
    expect(s.directCacheAtZero).toBe(0);
  });

  it("counts a direct external_cache at zero replicas as control contamination, not refutation", () => {
    const s = summarizeH2(
      [
        ...records,
        rec({ scenario: "replicas=0@g1", outcome: "failure", failure_class: "external_cache" }),
        rec({ scenario: "replicas=3@g1", outcome: "failure", failure_class: "external_cache" }),
      ],
      blocks,
      RUN,
      plan,
    );
    expect(s.directCacheAtZero).toBe(1);
    expect(s.directSuccessAtZero).toBe(0);
  });

  it("does not count a direct external_cache at zero replicas outside a valid generation", () => {
    const s = summarizeH2(
      [
        ...records,
        rec({ scenario: "replicas=0@g2", outcome: "failure", failure_class: "external_cache" }),
        rec({ scenario: "replicas=0@g3", outcome: "failure", failure_class: "external_cache" }),
      ],
      [...blocks, end("replicas=0", 2, false, [])],
      RUN,
      plan,
    );
    expect(s.directCacheAtZero).toBe(0);
  });

  it("computes latency over included successes per band and method", () => {
    const s = summarizeH2(records, blocks, RUN, plan);
    expect(s.latencyRows).toContainEqual([
      "degradation",
      "small",
      "direct",
      "3",
      "200",
      "200",
      "300",
    ]);
  });

  it("flags a direct success with zero active replicas", () => {
    const s = summarizeH2([...records, rec({ scenario: "replicas=0@g1" })], blocks, RUN, plan);
    expect(s.directSuccessAtZero).toBe(1);
  });

  it("does not depend on how many gate records a block has", () => {
    const gate = (
      block: string,
      generation: number,
      check: number,
      intended: string[],
    ): BlockCheckRecord => ({
      ...end(block, generation, true, intended),
      phase: "gate",
      check_number: check,
    });
    const withGates = [
      gate("replicas=0", 1, 1, []),
      gate("replicas=0", 1, 2, []),
      ...blocks,
      gate("replicas=0", 1, 3, []),
    ];
    const s = summarizeH2([...records, rec({ scenario: "replicas=0@g1" })], withGates, RUN, plan);
    expect(s.included).toBe(7);
    expect(s.excludedUnconfirmed).toBe(1);
    expect(s.excludedNoEnd).toBe(0);
    expect(s.directSuccessAtZero).toBe(1);
  });

  it("does not count a direct success in an unconfirmed zero-replica generation", () => {
    const s = summarizeH2(
      [...records, rec({ scenario: "replicas=0@g2" })],
      [...blocks, end("replicas=0", 2, false, [])],
      RUN,
      plan,
    );
    expect(s.directSuccessAtZero).toBe(0);
    expect(s.excludedUnconfirmed).toBe(2);
  });

  it("counts attempts without an end-of-block check separately", () => {
    const s = summarizeH2(
      [...records, rec({ scenario: "replicas=5@g1" }), rec({ scenario: "garbage" })],
      [...blocks, { ...end("replicas=5", 1, true, ["a"]), phase: "gate" as const }],
      RUN,
      plan,
    );
    expect(s.excludedUnconfirmed).toBe(1);
    expect(s.excludedNoEnd).toBe(2);
    expect(s.included).toBe(6);
  });

  it("orders rows by plan order, then method; latency by size band; failures by plan order", () => {
    const planBlocks = [
      end("replicas=10", 1, true, ["a"], 0),
      end("replicas=2", 1, true, ["a"], 1),
      end("replicas=0", 1, true, [], 2),
    ];
    const s = summarizeH2(
      [
        rec({ scenario: "replicas=0@g1", outcome: "failure", failure_class: "timeout" }),
        rec({ scenario: "replicas=2@g1", method: "gateway", size_band: "large" }),
        rec({ scenario: "replicas=2@g1", size_band: "medium" }),
        rec({
          scenario: "replicas=10@g1",
          method: "gateway",
          outcome: "failure",
          failure_class: "timeout",
        }),
        rec({ scenario: "replicas=10@g1" }),
      ],
      planBlocks,
      RUN,
      planOf(
        ["replicas=10", "degradation", 1],
        ["replicas=2", "degradation", 1],
        ["replicas=0", "degradation", 0],
      ),
    );
    expect(s.rateRows.map((r) => `${r[0]}/${r[1]}`)).toEqual([
      "replicas=10/direct",
      "replicas=10/gateway",
      "replicas=2/direct",
      "replicas=2/gateway",
      "replicas=0/direct",
    ]);
    expect(s.latencyRows.map((r) => `${r[1]}/${r[2]}`)).toEqual([
      "small/direct",
      "medium/direct",
      "large/gateway",
    ]);
    expect(s.failureRows).toEqual([
      ["replicas=10", "gateway", "timeout", "1"],
      ["replicas=0", "direct", "timeout", "1"],
    ]);
  });
});

describe("validGenerations with retried end checks", () => {
  it("judges a generation by its last end try only", () => {
    const tries = (generation: number, ...outcomes: boolean[]) =>
      outcomes.map((ok, i) => ({ ...end("main", generation, ok, ["a"]), check_number: i + 1 }));
    const log = [...tries(1, false, false), ...tries(2, false, true), ...tries(3, true, false)];
    expect(validGenerations(log, RUN)).toEqual(new Set(["main@g2"]));
  });
});

describe("summarizeH2 by active replicas", () => {
  const plan = planOf(
    ["main", "main", 3],
    ["replicas=3", "degradation", 3],
    ["replicas=1", "degradation", 1],
    ["cold-start", "cold-start", 3],
  );
  const blocks = [
    end("main", 1, true, ["a", "b", "c"], 0),
    end("replicas=3", 1, true, ["a", "b", "c"], 1),
    end("replicas=1", 1, true, ["a"], 2),
  ];
  const times = (n: number, o: Partial<ResultRecord>) => Array.from({ length: n }, () => rec(o));
  const records = [
    ...times(10, { scenario: "main@g1" }),
    rec({ scenario: "main@g1", outcome: "failure", failure_class: "external_cache" }),
    ...times(9, { scenario: "main@g1", method: "gateway" }),
    rec({ scenario: "main@g1", method: "gateway", outcome: "failure", failure_class: "timeout" }),
    ...times(2, { scenario: "replicas=3@g1" }),
    rec({ scenario: "replicas=1@g1" }),
    rec({ scenario: "replicas=1@g1", outcome: "failure", failure_class: "timeout" }),
  ];

  it("aggregates by active replica count and reports the acceptance line", () => {
    const s = summarizeH2(records, blocks, RUN, plan);
    expect(s.byReplicaRows).toEqual([
      ["3", "direct", "13", "12", "1", "100.0%"],
      ["3", "gateway", "10", "9", "0", "90.0%"],
      ["1", "direct", "2", "1", "0", "50.0%"],
    ]);
    expect(s.threeReplicaAcceptance).toEqual({
      activeReplicas: 3,
      successes: 21,
      denominator: 22,
      externalCache: 1,
      rate: 21 / 22,
    });
    expect(h2AcceptanceLine(s)).toBe(
      "**Success with 3 active replicas: 95.45% (21 of 22, excluding 1 external_cache) — criterion ≥ 95%: met**\n",
    );
  });

  it("splits latency by block kind", () => {
    const s = summarizeH2(
      [rec({ scenario: "cold-start@g1", latency_ms: 70 }), ...records],
      [...blocks, end("cold-start", 1, true, ["a", "b", "c"], 3)],
      RUN,
      plan,
    );
    expect(s.latencyRows.map((r) => r.slice(0, 3))).toEqual([
      ["main", "small", "direct"],
      ["main", "small", "gateway"],
      ["cold-start", "small", "direct"],
      ["degradation", "small", "direct"],
    ]);
    expect(s.latencyRows[2]).toEqual(["cold-start", "small", "direct", "1", "70", "70", "70"]);
    expect(s.latencyRows[3]!.slice(0, 4)).toEqual(["degradation", "small", "direct", "3"]);
  });

  it("excludes invalid generations from the aggregation", () => {
    const s = summarizeH2(
      [
        ...records,
        rec({ scenario: "main@g2" }),
        rec({
          scenario: "main@g2",
          method: "gateway",
          outcome: "failure",
          failure_class: "timeout",
        }),
      ],
      [
        end("main", 1, false, ["a", "b", "c"], 0),
        end("main", 2, true, ["a", "b", "c"], 0),
        ...blocks.slice(1),
      ],
      RUN,
      plan,
    );
    expect(s.excludedUnconfirmed).toBe(21);
    expect(s.byReplicaRows).toEqual([
      ["3", "direct", "3", "3", "0", "100.0%"],
      ["3", "gateway", "1", "0", "0", "0.0%"],
      ["1", "direct", "2", "1", "0", "50.0%"],
    ]);
    expect(s.threeReplicaAcceptance).toEqual({
      activeReplicas: 3,
      successes: 3,
      denominator: 4,
      externalCache: 0,
      rate: 0.75,
    });
    expect(h2AcceptanceLine(s)).toBe(
      "**Success with 3 active replicas: 75.00% (3 of 4, excluding 0 external_cache) — criterion ≥ 95%: NOT met**\n",
    );
  });

  it("states no data when every attempt at the top count is external_cache", () => {
    const s = summarizeH2(
      [
        rec({ scenario: "main@g1", outcome: "failure", failure_class: "external_cache" }),
        ...records.filter((r) => r.scenario === "replicas=1@g1"),
      ],
      blocks,
      RUN,
      plan,
    );
    expect(s.byReplicaRows[0]).toEqual(["3", "direct", "1", "0", "1", "—"]);
    expect(s.threeReplicaAcceptance).toEqual({
      activeReplicas: 3,
      successes: 0,
      denominator: 0,
      externalCache: 1,
      rate: null,
    });
    expect(h2AcceptanceLine(s)).toBe(
      "**Success with 3 active replicas: — (0 of 0, excluding 1 external_cache) — criterion ≥ 95%: no data**\n",
    );
  });

  const noValid =
    "**Success with 3 active replicas: no valid attempts — criterion ≥ 95%: no data**\n";

  it("has no acceptance without included attempts", () => {
    const s = summarizeH2(
      [rec({ scenario: "main@g1" })],
      [end("main", 1, false, ["a", "b", "c"])],
      RUN,
      plan,
    );
    expect(s.byReplicaRows).toEqual([]);
    expect(s.threeReplicaAcceptance).toBeNull();
    expect(h2AcceptanceLine(s)).toBe(noValid);
  });

  it("never judges the criterion at a lower count when every top-count generation is invalid", () => {
    const s = summarizeH2(
      records,
      [
        end("main", 1, false, ["a", "b", "c"], 0),
        end("replicas=3", 1, false, ["a", "b", "c"], 1),
        end("replicas=1", 1, true, ["a"], 2),
      ],
      RUN,
      plan,
    );
    expect(s.byReplicaRows).toEqual([["1", "direct", "2", "1", "0", "50.0%"]]);
    expect(s.threeReplicaAcceptance).toBeNull();
    expect(h2AcceptanceLine(s)).toBe(noValid);
  });

  it("shows two decimals so the rate cannot contradict the verdict at the boundary", () => {
    const s = summarizeH2(
      [
        ...times(189, { scenario: "main@g1" }),
        ...times(10, { scenario: "main@g1", outcome: "failure", failure_class: "timeout" }),
      ],
      blocks,
      RUN,
      plan,
    );
    expect(h2AcceptanceLine(s)).toBe(
      "**Success with 3 active replicas: 94.97% (189 of 199, excluding 0 external_cache) — criterion ≥ 95%: NOT met**\n",
    );
    const line = (successes: number, failures: number) =>
      h2AcceptanceLine({
        maxActiveReplicas: 3,
        threeReplicaAcceptance: {
          activeReplicas: 3,
          successes,
          denominator: successes + failures,
          externalCache: 0,
          rate: successes / (successes + failures),
        },
      });
    expect(line(18999, 1000)).toContain(": 94.99% (18999 of 19999, ");
    expect(line(18999, 1000)).toContain("NOT met");
    expect(line(57, 3)).toContain(": 95.00% (57 of 60, ");
    expect(line(57, 3)).toContain(": met**");
  });

  it("uses the singular for one active replica", () => {
    const s = summarizeH2(
      [rec({ scenario: "replicas=1@g1" })],
      [end("replicas=1", 1, true, ["a"])],
      RUN,
      planOf(["replicas=1", "degradation", 1]),
    );
    expect(h2AcceptanceLine(s)).toBe(
      "**Success with 1 active replica: 100.00% (1 of 1, excluding 0 external_cache) — criterion ≥ 95%: met**\n",
    );
  });

  it("rejects an included block whose logged replica count differs from the frozen plan", () => {
    expect(() =>
      summarizeH2(
        records,
        [...blocks.slice(0, 2), end("replicas=1", 1, true, ["a", "b"], 2)],
        RUN,
        plan,
      ),
    ).toThrow("block replicas=1: block log has 2 intended active replicas, frozen plan has 1");
  });

  it("ignores a replica-count mismatch in a block with no included attempts", () => {
    const s = summarizeH2(
      records.filter((r) => r.scenario === "main@g1"),
      [...blocks, end("cold-start", 1, false, ["a"], 3)],
      RUN,
      plan,
    );
    expect(s.included).toBe(21);
  });

  it("rejects an included block that is not in the frozen plan", () => {
    expect(() => summarizeH2(records, blocks, RUN, planOf(["main", "main", 3]))).toThrow(
      /block replicas=3 is not in the frozen plan/,
    );
  });
});

describe("h2AttemptsLine", () => {
  it("states included against planned and recorded", () => {
    expect(h2AttemptsLine(3, 4, 5)).toBe(
      "Attempts included: 3 of 4 planned (5 recorded, including re-run generations)\n",
    );
    expect(h2AttemptsLine(3, undefined, 5)).toBe(
      "Attempts included: 3 (5 recorded, including re-run generations; planned count unknown)\n",
    );
  });
});

describe("provenanceAudit", () => {
  const blocks = [
    end("main", 1, true, ["a", "b", "c"], 0),
    end("main", 2, false, ["a", "b", "c"], 0),
    end("replicas=0", 1, true, [], 1),
  ];
  const ev = (
    attemptId: string,
    unattributed: number,
    dagSize: number | null = 700158,
    generation = 1,
    runId = RUN,
  ): H2Evidence => ({
    run_id: runId,
    attempt_id: attemptId,
    generation,
    provenance: {
      unattributed,
      dag_size: dagSize,
      data_received: 700158 + unattributed,
    },
  });
  const records = [
    rec({ scenario: "main@g1", work_id: "pd-901" }),
    rec({ scenario: "main@g1", work_id: "pd-902" }),
    rec({ scenario: "main@g1", work_id: "pd-903" }),
  ];
  const evidence = [
    ev("main/pd-901/direct/r1", 999),
    ev("main/pd-901/direct/r1", 0),
    ev("main/pd-902/direct/r1", 158),
    ev("main/pd-903/direct/r1", 316),
  ];

  it("joins each direct success to its last evidence line and summarizes unattributed bytes", () => {
    const audit = provenanceAudit(records, blocks, RUN, evidence);
    expect(audit.n).toBe(3);
    expect(audit.missingEvidence).toBe(0);
    expect(audit.rows).toEqual([
      ["unattributed_bytes", "0", "158", "316", "316"],
      ["unattributed_pct_of_dag", "0.00", "0.02", "0.05", "0.05"],
    ]);
  });

  it("counts direct successes that have no evidence", () => {
    const audit = provenanceAudit(records, blocks, RUN, [
      ...evidence.filter((e) => !e.attempt_id.startsWith("main/pd-902/")),
      ev("main/pd-902/direct/r1", 158, 700158, 2),
      ev("main/pd-902/direct/r2", 158),
    ]);
    expect(audit.n).toBe(2);
    expect(audit.missingEvidence).toBe(1);
    expect(audit.rows).toEqual([
      ["unattributed_bytes", "0", "0", "316", "316"],
      ["unattributed_pct_of_dag", "0.00", "0.00", "0.05", "0.05"],
    ]);
  });

  it("counts a direct success whose evidence has null provenance as missing", () => {
    const audit = provenanceAudit(records, blocks, RUN, [
      ...evidence,
      { run_id: RUN, attempt_id: "main/pd-903/direct/r1", generation: 1, provenance: null },
    ]);
    expect(audit.n).toBe(2);
    expect(audit.missingEvidence).toBe(1);
    expect(audit.rows[0]).toEqual(["unattributed_bytes", "0", "0", "158", "158"]);
  });

  it("ignores gateway attempts, failures and invalid generations", () => {
    const audit = provenanceAudit(
      [
        ...records,
        rec({ scenario: "main@g1", work_id: "pd-904", method: "gateway" }),
        rec({
          scenario: "main@g1",
          work_id: "pd-905",
          outcome: "failure",
          failure_class: "timeout",
        }),
        rec({
          scenario: "main@g1",
          work_id: "pd-906",
          outcome: "failure",
          failure_class: "external_cache",
        }),
        rec({ scenario: "main@g2", work_id: "pd-907" }),
        rec({ scenario: "main@g3", work_id: "pd-908" }),
        rec({ scenario: "main@g1", work_id: "pd-909", run_id: "other" }),
      ],
      blocks,
      RUN,
      [
        ...evidence,
        ev("main/pd-904/gateway/r1", 50_000),
        ev("main/pd-905/direct/r1", 50_000),
        ev("main/pd-906/direct/r1", 50_000),
        ev("main/pd-907/direct/r1", 50_000, 700158, 2),
      ],
    );
    expect(audit.n).toBe(3);
    expect(audit.missingEvidence).toBe(0);
    expect(audit.rows[0]).toEqual(["unattributed_bytes", "0", "158", "316", "316"]);
  });

  it("keeps the sign of negative unattributed and leaves null dag sizes out of the pct row only", () => {
    const audit = provenanceAudit(records, blocks, RUN, [
      ev("main/pd-901/direct/r1", -1000, 100_000),
      ev("main/pd-902/direct/r1", 500, null),
      ev("main/pd-903/direct/r1", 2000, 100_000),
    ]);
    expect(audit.n).toBe(3);
    expect(audit.pctExcluded).toBe(1);
    expect(audit.rows).toEqual([
      ["unattributed_bytes", "-1000", "500", "2000", "2000"],
      ["unattributed_pct_of_dag", "-1.00", "-1.00", "2.00", "2.00"],
    ]);
  });

  it("has no rows without audited successes", () => {
    const audit = provenanceAudit(records, blocks, RUN, []);
    expect(audit).toEqual({ n: 0, missingEvidence: 3, pctExcluded: 0, rows: [] });
  });

  it("ignores evidence from another run with the same key, even when written last", () => {
    const audit = provenanceAudit(records, blocks, RUN, [
      ...evidence.filter((e) => !e.attempt_id.startsWith("main/pd-903/")),
      ev("main/pd-903/direct/r1", 77_777, 700158, 1, "2026-10-05T12:00:00Z-h2-old"),
    ]);
    expect(audit.n).toBe(2);
    expect(audit.missingEvidence).toBe(1);
    expect(audit.rows[0]).toEqual(["unattributed_bytes", "0", "0", "158", "158"]);
    const shadowed = provenanceAudit(records, blocks, RUN, [
      ...evidence,
      ev("main/pd-903/direct/r1", 77_777, 700158, 1, "2026-10-05T12:00:00Z-h2-old"),
    ]);
    expect(shadowed.rows[0]).toEqual(["unattributed_bytes", "0", "158", "316", "316"]);
  });

  it("counts no exclusions from the pct row when every dag_size is known", () => {
    expect(provenanceAudit(records, blocks, RUN, evidence).pctExcluded).toBe(0);
  });

  it("rejects a direct success whose evidence has a negative dag_size", () => {
    expect(() =>
      provenanceAudit(records, blocks, RUN, [...evidence, ev("main/pd-902/direct/r1", 158, -5)]),
    ).toThrow("dag_size is ≤ 0 on a direct success");
  });

  it("rejects a direct success whose evidence has a zero dag_size", () => {
    expect(() =>
      provenanceAudit(records, blocks, RUN, [...evidence, ev("main/pd-902/direct/r1", 158, 0)]),
    ).toThrow(
      "evidence for main/pd-902/direct/r1 (generation 1): dag_size is ≤ 0 on a direct success",
    );
  });
});

describe("direct-only and one-replica lines", () => {
  const plan = planOf(["replicas=3", "degradation", 3], ["replicas=1", "degradation", 1]);
  const blocks = [
    end("replicas=3", 1, true, ["a", "b", "c"], 0),
    end("replicas=1", 1, true, ["a"], 1),
  ];
  const times = (n: number, o: Partial<ResultRecord>) => Array.from({ length: n }, () => rec(o));
  const fail = (o: Partial<ResultRecord>) =>
    rec({ outcome: "failure", failure_class: "timeout", ...o });
  const summary = (records: ResultRecord[], b = blocks) => summarizeH2(records, b, RUN, plan);

  it("judges the direct-only criterion apart from gateway attempts", () => {
    const s = summary([
      ...times(19, { scenario: "replicas=3@g1" }),
      rec({ scenario: "replicas=3@g1", outcome: "failure", failure_class: "external_cache" }),
      ...times(30, { scenario: "replicas=3@g1", method: "gateway" }),
    ]);
    expect(h2DirectOnlyLine(s)).toBe(
      "**Direct-only success with 3 active replicas: 100.00% (19 of 19, excluding 1 external_cache) — criterion ≥ 95%: met**\n",
    );
  });

  it("reports NOT met when direct fails although the combined line passes", () => {
    const s = summary([
      ...times(9, { scenario: "replicas=3@g1" }),
      fail({ scenario: "replicas=3@g1" }),
      ...times(90, { scenario: "replicas=3@g1", method: "gateway" }),
    ]);
    expect(h2AcceptanceLine(s)).toContain("criterion ≥ 95%: met");
    expect(h2DirectOnlyLine(s)).toBe(
      "**Direct-only success with 3 active replicas: 90.00% (9 of 10, excluding 0 external_cache) — criterion ≥ 95%: NOT met**\n",
    );
  });

  it("truncates the percentage like the combined line", () => {
    const s = summary([
      ...times(1899, { scenario: "replicas=3@g1" }),
      ...times(100, { scenario: "replicas=3@g1", outcome: "failure", failure_class: "timeout" }),
    ]);
    expect(h2DirectOnlyLine(s)).toContain(": 94.99% (1899 of 1999, ");
  });

  it("states no data without direct attempts or when all are external_cache", () => {
    expect(h2DirectOnlyLine(summary([rec({ scenario: "replicas=3@g1", method: "gateway" })]))).toBe(
      "**Direct-only success with 3 active replicas: no valid attempts — criterion ≥ 95%: no data**\n",
    );
    const s = summary([
      rec({ scenario: "replicas=3@g1", outcome: "failure", failure_class: "external_cache" }),
    ]);
    expect(h2DirectOnlyLine(s)).toBe(
      "**Direct-only success with 3 active replicas: — (0 of 0, excluding 1 external_cache) — criterion ≥ 95%: no data**\n",
    );
  });

  it("reports recovery with one active replica as yes, no or no data", () => {
    const yes = summary([
      rec({ scenario: "replicas=1@g1" }),
      fail({ scenario: "replicas=1@g1" }),
      rec({ scenario: "replicas=1@g1", method: "gateway" }),
    ]);
    expect(h2OneReplicaLine(yes)).toBe(
      "**Direct success with 1 active replica: 1 of 2 (50.00%) — recovery operational: yes**\n",
    );
    const no = summary([fail({ scenario: "replicas=1@g1" }), rec({ scenario: "replicas=3@g1" })]);
    expect(h2OneReplicaLine(no)).toBe(
      "**Direct success with 1 active replica: 0 of 1 (0.00%) — recovery operational: no**\n",
    );
    expect(h2OneReplicaLine(summary([rec({ scenario: "replicas=3@g1" })]))).toBe(
      "**Direct success with 1 active replica: no valid attempts — recovery operational: no data**\n",
    );
    const cache = summary([
      rec({ scenario: "replicas=1@g1", outcome: "failure", failure_class: "external_cache" }),
    ]);
    expect(h2OneReplicaLine(cache)).toBe(
      "**Direct success with 1 active replica: 0 of 0 (—) — recovery operational: no data**\n",
    );
  });
});
