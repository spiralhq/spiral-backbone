import type { ResultRecord } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import type { BlockRecord } from "../h2/blocks-log";
import { h2AttemptsLine, percentile, summarizeH2 } from "./h2";

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
): BlockRecord {
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

describe("summarizeH2", () => {
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
    const s = summarizeH2(records, blocks, RUN);
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
    );
    expect(s.directCacheAtZero).toBe(0);
  });

  it("computes latency over included successes per band and method", () => {
    const s = summarizeH2(records, blocks, RUN);
    expect(s.latencyRows).toContainEqual(["small", "direct", "3", "200", "200", "300"]);
  });

  it("flags a direct success with zero active replicas", () => {
    const s = summarizeH2([...records, rec({ scenario: "replicas=0@g1" })], blocks, RUN);
    expect(s.directSuccessAtZero).toBe(1);
  });

  it("does not depend on how many gate records a block has", () => {
    const gate = (
      block: string,
      generation: number,
      check: number,
      intended: string[],
    ): BlockRecord => ({
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
    const s = summarizeH2([...records, rec({ scenario: "replicas=0@g1" })], withGates, RUN);
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
    );
    expect(s.directSuccessAtZero).toBe(0);
    expect(s.excludedUnconfirmed).toBe(2);
  });

  it("counts attempts without an end-of-block check separately", () => {
    const s = summarizeH2(
      [...records, rec({ scenario: "replicas=5@g1" }), rec({ scenario: "garbage" })],
      [...blocks, { ...end("replicas=5", 1, true, ["a"]), phase: "gate" as const }],
      RUN,
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
    );
    expect(s.rateRows.map((r) => `${r[0]}/${r[1]}`)).toEqual([
      "replicas=10/direct",
      "replicas=10/gateway",
      "replicas=2/direct",
      "replicas=2/gateway",
      "replicas=0/direct",
    ]);
    expect(s.latencyRows.map((r) => `${r[0]}/${r[1]}`)).toEqual([
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
