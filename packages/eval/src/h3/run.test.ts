import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sidecarPath } from "../common/sidecar";

vi.mock("../common/cluster", () => ({ assertExpectedCluster: async () => {} }));
vi.mock("./fixtures", () => ({ setupH3Fixtures: async () => ({}) }));
vi.mock("./attempts", () => ({
  buildScenarioAttempt: async () => ({
    instruction: {},
    feePayer: {},
    film: "11111111111111111111111111111111",
    cid: "cid",
  }),
}));
const send = vi.hoisted(() => ({
  result: async (): Promise<unknown> => {
    throw new Error("429 Too Many Requests");
  },
}));
vi.mock("./raw-send", () => ({ sendRawSkipPreflight: () => send.result() }));

describe("runH3 transport failure", () => {
  it("aborts without recording a result and leaves the run started", async () => {
    const { runH3 } = await import("./run");
    const outPath = join(mkdtempSync(join(tmpdir(), "h3-run-")), "h3.ndjson");
    await expect(
      runH3({
        client: {} as never,
        rpcUrl: "http://127.0.0.1:1",
        expectedGenesis: "g",
        outPath,
        runId: "2026-10-02T12:00:00Z-h3-unit",
        label: "unit",
      }),
    ).rejects.toThrow(/429/);
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(sidecarPath(outPath, "evidence"))).toBe(false);
    const statuses = readFileSync(sidecarPath(outPath, "runs"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(statuses.map((s) => s.status)).toEqual(["started"]);
  });

  it("aborts the same way when a failed transaction comes back without logs", async () => {
    send.result = async () => ({
      signature: "sig",
      err: { InstructionError: [0, { Custom: 3012 }] },
      logs: [],
    });
    const { runH3 } = await import("./run");
    const outPath = join(mkdtempSync(join(tmpdir(), "h3-run-")), "h3.ndjson");
    await expect(
      runH3({
        client: {} as never,
        rpcUrl: "http://127.0.0.1:1",
        expectedGenesis: "g",
        outPath,
        runId: "2026-10-02T12:00:00Z-h3-nologs",
        label: "unit",
      }),
    ).rejects.toThrow(/logs/);
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(sidecarPath(outPath, "evidence"))).toBe(false);
    const statuses = readFileSync(sidecarPath(outPath, "runs"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(statuses.map((s) => s.status)).toEqual(["started"]);
  });
});
