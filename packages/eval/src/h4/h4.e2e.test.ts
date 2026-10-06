import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Database } from "@spiral-backbone/db";
import {
  startPostgresContainer,
  type PostgresContainer,
} from "@spiral-backbone/db/testing/postgres";
import { resultRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJsonLines } from "../common/ndjson";
import { sidecarPath } from "../common/sidecar";
import { startKuboContainer, type KuboContainer } from "../kubo-node";
import { shouldSkipE2e, startLocalChain, type LocalChain } from "../testing/chain";
import { createOrg, submitForTest } from "../testing/submit";
import { runH4 } from "./run";

const skip = shouldSkipE2e("H4 end-to-end");

describe.skipIf(skip)("eval:h4 against Surfpool + Postgres", () => {
  let chain: LocalChain;
  let kubo: KuboContainer;
  let pg: PostgresContainer;
  let db: Database;
  let golden: InventoryRecord[];

  beforeAll(async () => {
    chain = await startLocalChain();
    kubo = await startKuboContainer();
    pg = await startPostgresContainer();
    db = createDb({ DATABASE_URL: pg.url });
    await createOrg(chain, "h4-e2e");
    golden = [
      await submitForTest({
        chain,
        slug: "h4-e2e",
        workId: "pd-901",
        content: randomBytes(300_000),
        title: "H4 one",
        kuboUrls: [kubo.apiUrl],
      }),
      await submitForTest({
        chain,
        slug: "h4-e2e",
        workId: "pd-902",
        content: randomBytes(400_000),
        title: "H4 dois — ação",
        kuboUrls: [kubo.apiUrl],
      }),
    ];
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end().catch(() => {});
    await pg?.stop();
    await kubo?.stop();
    chain?.stop();
  });

  it("rebuilds from zero and matches the golden field by field", async () => {
    const outPath = join(mkdtempSync(join(tmpdir(), "h4-e2e-")), "h4.ndjson");
    const result = await runH4({
      golden,
      db,
      rpcUrl: chain.rpcUrl,
      outPath,
      runId: "2026-10-02T12:00:00Z-h4-e2e",
    });

    expect(result).toEqual({ success: 2, failure: 0, backfillFailed: false });
    const records = await readJsonLines(outPath, resultRecordSchema);
    expect(records.map((r) => [r.work_id, r.outcome, r.cid_observed === r.cid_expected])).toEqual([
      ["pd-901", "success", true],
      ["pd-902", "success", true],
    ]);
    const run = JSON.parse(readFileSync(sidecarPath(outPath, "run"), "utf8"));
    expect(run.golden_count).toBe(2);
    expect(run.rebuilt_count).toBe(2);
    expect(run.diffs).toEqual([]);
    expect(run.backfill.status).toBe("succeeded");
    expect(run.backfill.rpc_calls.getProgramAccounts).toBe(3);
  }, 120_000);

  it("reports a divergence when the golden disagrees with the chain", async () => {
    const outPath = join(mkdtempSync(join(tmpdir(), "h4-e2e-")), "h4.ndjson");
    const altered = [{ ...golden[0]!, title: "not what was registered" }, golden[1]!];
    const result = await runH4({
      golden: altered,
      db,
      rpcUrl: chain.rpcUrl,
      outPath,
      runId: "2026-10-02T12:00:01Z-h4-e2e",
    });

    expect(result).toEqual({ success: 1, failure: 1, backfillFailed: false });
    const run = JSON.parse(readFileSync(sidecarPath(outPath, "run"), "utf8"));
    expect(run.diffs).toEqual([
      expect.objectContaining({
        table: "films",
        key: golden[0]!.film_pda,
        kind: "field",
        field: "title",
      }),
    ]);
  }, 120_000);
});
