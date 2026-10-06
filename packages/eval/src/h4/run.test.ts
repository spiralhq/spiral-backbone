import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@spiral-backbone/db";
import type { BackfillReport } from "@spiral-backbone/indexer";
import { resultRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { describe, expect, it, vi } from "vitest";
import { readJsonLines } from "../common/ndjson";
import { runStatusSchema } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";

const state = vi.hoisted(() => ({ cause: undefined as unknown }));

vi.mock("@spiral-backbone/indexer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spiral-backbone/indexer")>();
  return {
    ...actual,
    backfill: async () => {
      throw new actual.BackfillError(
        {
          mode: "backfill",
          status: "failed",
          error: (state.cause as Error).message,
          reset: true,
          rpc_endpoint: "127.0.0.1:1",
          rpc_endpoint_fingerprint: "x",
          started_at: "2026-10-02T12:00:00.000Z",
          finished_at: "2026-10-02T12:00:01.000Z",
          duration_ms: 1000,
          rpc_calls: {},
          rpc_calls_total: 0,
          rate_limit_retries: 0,
          counts: { organizations: 0, memberships: 0, films: 0, film_replicas: 0 },
        } satisfies BackfillReport,
        state.cause,
      );
    },
    readCatalog: async () => {
      throw new Error("readCatalog must not be reached");
    },
  };
});

const golden = ["pd-1", "pd-2"].map(
  (work_id) =>
    ({
      work_id,
      film_pda: "11111111111111111111111111111111",
      size_band: "small",
      byte_size: 10,
      cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    }) as unknown as InventoryRecord,
);

async function run() {
  const { runH4 } = await import("./run");
  const outPath = join(mkdtempSync(join(tmpdir(), "h4-run-")), "h4.ndjson");
  const result = await runH4({
    golden,
    db: {} as Database,
    rpcUrl: "http://127.0.0.1:1",
    outPath,
    runId: "2026-10-02T12:00:00Z-h4-unit",
  });
  const runJson = JSON.parse(readFileSync(sidecarPath(outPath, "run"), "utf8"));
  return { result, outPath, runJson };
}

describe("runH4 backfill failure", () => {
  it("records a refutation when the chain could not be projected", async () => {
    const { InvalidAccountError } = await import("@spiral-backbone/indexer");
    state.cause = new InvalidAccountError("film account X could not be decoded");
    const { result, outPath, runJson } = await run();
    expect(result).toEqual({ success: 0, failure: 2, backfillFailed: true });
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records.map((r) => [r.work_id, r.outcome])).toEqual([
      ["pd-1", "failure"],
      ["pd-2", "failure"],
    ]);
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks).toMatchObject([
      { status: "started", expected_attempts: 2 },
      { status: "completed", recorded_attempts: 2 },
    ]);
    expect(runJson).toMatchObject({
      error: "film account X could not be decoded",
      infrastructure_failure: false,
    });
  });

  it("writes no result records when the backfill infrastructure failed", async () => {
    state.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const { result, outPath, runJson } = await run();
    expect(result).toEqual({ success: 0, failure: 0, backfillFailed: true });
    expect(existsSync(outPath)).toBe(false);
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started"]);
    expect(runJson).toMatchObject({
      run_id: "2026-10-02T12:00:00Z-h4-unit",
      error: "connect ECONNREFUSED 127.0.0.1:5432",
      infrastructure_failure: true,
      backfill: { status: "failed" },
    });
  });
});
