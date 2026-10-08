import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { resultRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fetchGenesis } from "../common/cluster";
import { readJsonLines } from "../common/ndjson";
import { sidecarPath } from "../common/sidecar";
import { startKuboContainer, type KuboContainer } from "../kubo-node";
import { shouldSkipE2e, startLocalChain, type LocalChain } from "../testing/chain";
import { createOrg, submitForTest } from "../testing/submit";
import { runH1 } from "./run";

const skip = shouldSkipE2e("H1 end-to-end");

describe.skipIf(skip)("eval:h1 against Surfpool + Kubo", () => {
  let chain: LocalChain;
  let kubo: KuboContainer;
  let golden: InventoryRecord;
  const outDir = mkdtempSync(join(tmpdir(), "h1-e2e-out-"));

  beforeAll(async () => {
    chain = await startLocalChain();
    kubo = await startKuboContainer();
    await createOrg(chain, "h1-e2e");
    golden = await submitForTest({
      chain,
      slug: "h1-e2e",
      workId: "pd-901",
      content: randomBytes(600_000),
      title: "H1 e2e work",
      kuboUrls: [kubo.apiUrl],
    });
  }, 180_000);

  afterAll(async () => {
    chain?.stop();
    await kubo?.stop();
  });

  it("verifies the intact work and detects the tampered copy", async () => {
    const outPath = join(outDir, "h1.ndjson");
    const summary = await runH1({
      golden: [golden],
      rpcUrl: chain.rpcUrl,
      expectedGenesis: await fetchGenesis(chain.rpcUrl),
      kuboUrl: kubo.apiUrl,
      outPath,
      workDir: mkdtempSync(join(tmpdir(), "h1-e2e-work-")),
      runId: "2026-10-02T12:00:00Z-h1-e2e",
      timeoutMs: 60_000,
    });

    expect(summary).toEqual({
      intact: { success: 1, failure: 0 },
      tampered: { success: 1, failure: 0 },
    });
    const records = await readJsonLines(outPath, resultRecordSchema);
    const intact = records.find((r) => r.scenario === "intact")!;
    const tampered = records.find((r) => r.scenario === "tampered")!;
    expect(intact.cid_observed).toBe(intact.cid_expected);
    expect(intact.cid_expected).toBe(golden.cid);
    expect(intact.verifier_impl).toMatch(/^ipfs-unixfs-importer@/);
    expect(tampered.cid_observed).not.toBe(tampered.cid_expected);
    expect(tampered.outcome).toBe("success");

    const evidence = await readJsonLines(
      sidecarPath(outPath, "evidence"),
      z.object({ scenario: z.string(), offset: z.number().optional() }).passthrough(),
    );
    const offset = evidence.find((e) => e.scenario === "tampered")!.offset!;
    expect(offset).toBeGreaterThanOrEqual(150_000);
    expect(offset).toBeLessThan(450_000);
  }, 120_000);

  it("records a classified failure for an unrecoverable work and keeps going", async () => {
    const outPath = join(outDir, "h1-mixed.ndjson");
    const ghost: InventoryRecord = {
      ...golden,
      work_id: "pd-902",
      film_pda: (await generateKeyPairSigner()).address,
    };
    const summary = await runH1({
      golden: [ghost, golden],
      rpcUrl: chain.rpcUrl,
      expectedGenesis: await fetchGenesis(chain.rpcUrl),
      kuboUrl: kubo.apiUrl,
      outPath,
      workDir: mkdtempSync(join(tmpdir(), "h1-e2e-work-")),
      runId: "2026-10-02T12:00:01Z-h1-e2e",
      timeoutMs: 60_000,
    });

    expect(summary.intact).toEqual({ success: 1, failure: 1 });
    const records = await readJsonLines(outPath, resultRecordSchema);
    const failed = records.find((r) => r.work_id === "pd-902")!;
    expect(failed.outcome).toBe("failure");
    expect(failed.failure_class).toBe("object_unavailable");
    expect(failed.cid_observed).toBeNull();
    expect(records.filter((r) => r.work_id === "pd-901")).toHaveLength(2);
  }, 120_000);
});
