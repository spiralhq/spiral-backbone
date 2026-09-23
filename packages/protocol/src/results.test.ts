import { describe, expect, it } from "vitest";
import { resultRecordSchema } from "./results";

function validRecord() {
  return {
    run_id: "run-001",
    hypothesis: "H1",
    film_pda: "61cFSS8a4CEfZ1MxLUNd4HWpemd3qDwbZ9soGLomMNU7",
    work_id: "work-001",
    size_bytes: 1024,
    size_band: "small",
    scenario: "baseline",
    method: "direct",
    attempt: 1,
    started_at: "2026-09-21T00:00:00.000Z",
    finished_at: "2026-09-21T00:00:01.000Z",
    latency_ms: 1000,
    cid_expected: "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem",
    cid_observed: "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem",
    outcome: "success",
    failure_class: null,
    tx_signature: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    rpc_endpoint: "https://api.devnet.solana.com",
    verifier_impl: "packages/eval/verifier",
    artifact_versions: { organization: "0.1.0", film: "0.1.0" },
  };
}

describe("resultRecordSchema", () => {
  it("accepts a fully valid record", () => {
    expect(resultRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it("accepts every closed failure_class value", () => {
    for (const failureClass of [
      "object_unavailable",
      "timeout",
      "gateway_failure",
      "connection_error",
      "cid_mismatch",
      "external_cache",
    ]) {
      const record = { ...validRecord(), outcome: "failure", failure_class: failureClass };
      expect(resultRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it("rejects a failure_class outside the closed enum", () => {
    const record = { ...validRecord(), outcome: "failure", failure_class: "made_up_reason" };
    expect(resultRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a record missing a required field", () => {
    const { run_id: _run_id, ...withoutRunId } = validRecord();
    expect(resultRecordSchema.safeParse(withoutRunId).success).toBe(false);
  });
});
