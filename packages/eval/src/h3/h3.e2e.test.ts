import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultRecordSchema } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonLines } from "../common/ndjson";
import { runStatusSchema } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import { shouldSkipE2e, startLocalChain, type LocalChain } from "../testing/chain";
import { createH3Client } from "./client";
import { runH3 } from "./run";
import { H3_SCENARIOS, REFUSING_PROGRAM_ADDRESS } from "./scenarios";

const skip = shouldSkipE2e("H3 end-to-end");

const evidenceSchema = z
  .object({
    scenario_id: z.number(),
    observed: z.object({ index: z.number(), code: z.number() }).nullable(),
    failing_program: z.string().nullable(),
    logs: z.array(z.string()),
  })
  .passthrough();

describe.skipIf(skip)("eval:h3 against Surfpool", () => {
  let chain: LocalChain;

  beforeAll(async () => {
    chain = await startLocalChain();
  }, 120_000);

  afterAll(() => {
    chain?.stop();
  });

  it("all seven unauthorized submissions are rejected on-chain with the expected code", async () => {
    const outPath = join(mkdtempSync(join(tmpdir(), "h3-e2e-")), "h3.ndjson");
    const client = await createH3Client(chain.keypairPath, chain.rpcUrl, chain.wsUrl);

    const summary = await runH3({
      client,
      rpcUrl: chain.rpcUrl,
      outPath,
      runId: "2026-10-02T12:00:00Z-h3-e2e",
      label: "e2e",
    });

    expect(summary).toEqual({ success: 7, failure: 0 });
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records).toHaveLength(7);
    expect(records.every((r) => r.outcome === "success" && r.tx_signature !== null)).toBe(true);

    const marks = await readJsonLines(sidecarPath(outPath, "runs"), runStatusSchema);
    expect(marks).toMatchObject([
      { status: "started", expected_attempts: 7 },
      { status: "completed", recorded_attempts: 7 },
    ]);

    const evidence = await readJsonLines(sidecarPath(outPath, "evidence"), evidenceSchema);
    for (const scenario of H3_SCENARIOS) {
      const entry = evidence.find((e) => e.scenario_id === scenario.id)!;
      expect(entry.observed).toEqual({ index: 0, code: scenario.expectedCode });
      expect(entry.failing_program).toBe(REFUSING_PROGRAM_ADDRESS[scenario.refusingProgram]);
      expect(entry.logs.length).toBeGreaterThan(0);
    }
  }, 180_000);

  it("a second run with another label does not collide with the first", async () => {
    const outPath = join(mkdtempSync(join(tmpdir(), "h3-e2e-")), "h3.ndjson");
    const client = await createH3Client(chain.keypairPath, chain.rpcUrl, chain.wsUrl);
    const summary = await runH3({
      client,
      rpcUrl: chain.rpcUrl,
      outPath,
      runId: "2026-10-02T12:00:01Z-h3-e2e2",
      label: "e2e2",
    });
    expect(summary).toEqual({ success: 7, failure: 0 });
  }, 180_000);
});
