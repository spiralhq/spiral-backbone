import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { describe, expect, it, vi } from "vitest";
import { readJsonLines } from "../common/ndjson";
import { runStatusSchema } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const OTHER_CID = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";

const state = vi.hoisted(() => ({ observedCid: "", tamperCalls: 0 }));

vi.mock("@spiral-backbone/protocol/generated/film", () => ({
  fetchFilm: async () => ({
    data: { cid: new Uint8Array(0), cidLen: 0 },
  }),
}));
vi.mock("@spiral-backbone/protocol", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bytesToCidString: () => CID,
}));
vi.mock("./retrieve", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveToFile: async () => 10,
}));
vi.mock("../../verifier/index", () => ({
  computeSpiralCidFromFile: async () => ({ toString: () => state.observedCid }),
}));
vi.mock("./hash", () => ({
  sha256File: async () => "1".repeat(64),
}));
vi.mock("./tamper", () => ({
  tamperOffset: () => 0,
  writeTamperedCopy: async () => {
    state.tamperCalls++;
    throw new Error("disk full");
  },
}));

const work = {
  work_id: "pd-1",
  film_pda: "11111111111111111111111111111111",
  size_band: "small",
  byte_size: 10,
  cid: CID,
  sha256: "0".repeat(64),
} as unknown as InventoryRecord;

describe("runH1 stage tracking", () => {
  it("aborts without recording a false tampered failure after the intact record", async () => {
    state.observedCid = CID;
    const { runH1 } = await import("./run");
    const dir = mkdtempSync(join(tmpdir(), "h1-run-"));
    const outPath = join(dir, "h1.ndjson");
    await expect(
      runH1({
        golden: [work],
        rpcUrl: "http://127.0.0.1:1",
        kuboUrl: "http://127.0.0.1:1",
        outPath,
        workDir: dir,
        runId: "2026-10-02T12:00:00Z-h1-unit",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("disk full");
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records.map((r) => [r.scenario, r.outcome])).toEqual([["intact", "success"]]);
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started"]);
    expect(marks[0]).toMatchObject({ expected_attempts: 1 });
  });

  it("does not evaluate the tamper attempt after an intact mismatch", async () => {
    state.observedCid = OTHER_CID;
    state.tamperCalls = 0;
    const { runH1 } = await import("./run");
    const dir = mkdtempSync(join(tmpdir(), "h1-run-"));
    const outPath = join(dir, "h1.ndjson");
    const runId = "2026-10-02T12:00:00Z-h1-unit";
    const summary = await runH1({
      golden: [work],
      rpcUrl: "http://127.0.0.1:1",
      kuboUrl: "http://127.0.0.1:1",
      outPath,
      workDir: dir,
      runId,
      timeoutMs: 1000,
    });
    expect(state.tamperCalls).toBe(0);
    expect(summary).toEqual({
      intact: { success: 0, failure: 1 },
      tampered: { success: 0, failure: 0 },
    });
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records.map((r) => [r.scenario, r.outcome, r.failure_class])).toEqual([
      ["intact", "failure", "cid_mismatch"],
    ]);
    const evidence = readFileSync(sidecarPath(outPath, "evidence"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks.map((m) => m.status)).toEqual(["started", "completed"]);
    expect(marks[1]).toMatchObject({ recorded_attempts: 1 });
    expect(evidence.map((e) => e.scenario)).toEqual(["intact", "tampered"]);
    expect(evidence[1]).toEqual({
      run_id: runId,
      work_id: "pd-1",
      scenario: "tampered",
      not_evaluable: "intact recomputation already mismatched",
    });
  });
});
