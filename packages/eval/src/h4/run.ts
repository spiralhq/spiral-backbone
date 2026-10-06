import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database } from "@spiral-backbone/db";
import {
  BackfillError,
  backfill,
  InvalidAccountError,
  readCatalog,
  type BackfillReport,
} from "@spiral-backbone/indexer";
import {
  artifactVersions,
  bytesToCidString,
  describeEndpoint,
  type InventoryRecord,
  type ResultRecord,
} from "@spiral-backbone/protocol";
import { appendResult, toJsonLine } from "../common/ndjson";
import { markRunCompleted, markRunStarted } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import { compareWithGolden } from "./compare";

export interface H4Options {
  golden: InventoryRecord[];
  db: Database;
  rpcUrl: string;
  outPath: string;
  runId: string;
}

async function writeRun(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${toJsonLine(value)}\n`);
}

export async function runH4(
  options: H4Options,
): Promise<{ success: number; failure: number; backfillFailed: boolean }> {
  const runPath = sidecarPath(options.outPath, "run");
  const base = {
    run_id: options.runId,
    hypothesis: "H4" as const,
    scenario: "cold-rebuild",
    method: "getProgramAccounts-backfill",
    attempt: 1,
    failure_class: null,
    tx_signature: null,
    rpc_endpoint: describeEndpoint(options.rpcUrl).host,
    verifier_impl: "n/a",
    artifact_versions: artifactVersions(),
  };
  const toRecord = (
    g: InventoryRecord,
    report: BackfillReport | null,
    observed: string | null,
    ok: boolean,
  ): ResultRecord => ({
    ...base,
    film_pda: g.film_pda,
    work_id: g.work_id,
    size_bytes: Number(g.byte_size),
    size_band: g.size_band,
    started_at: report?.started_at ?? new Date().toISOString(),
    finished_at: report?.finished_at ?? new Date().toISOString(),
    latency_ms: report?.duration_ms ?? 0,
    cid_expected: g.cid,
    cid_observed: observed,
    outcome: ok ? "success" : "failure",
  });

  await markRunStarted(options.outPath, options.runId, options.golden.length);
  let report: BackfillReport;
  try {
    report = await backfill({ db: options.db, rpcUrl: options.rpcUrl, reset: true });
  } catch (error) {
    const failed = error instanceof BackfillError ? error.report : null;
    const refuted = error instanceof BackfillError && error.cause instanceof InvalidAccountError;
    await writeRun(runPath, {
      run_id: options.runId,
      backfill: failed,
      error: (error as Error).message,
      infrastructure_failure: !refuted,
    });
    if (!refuted) return { success: 0, failure: 0, backfillFailed: true };
    for (const g of options.golden)
      await appendResult(options.outPath, toRecord(g, failed, null, false));
    await markRunCompleted(options.outPath, options.runId, options.golden.length);
    return { success: 0, failure: options.golden.length, backfillFailed: true };
  }

  const catalog = await readCatalog(options.db);
  const comparison = compareWithGolden(options.golden, catalog);
  const rebuilt = new Map(catalog.films.map((f) => [f.address, f]));
  let success = 0;
  for (const g of options.golden) {
    const film = rebuilt.get(g.film_pda);
    const observed = film ? bytesToCidString(film.cid, film.cidLen) : null;
    const ok = film !== undefined && !comparison.failingFilms.has(g.film_pda);
    if (ok) success++;
    await appendResult(options.outPath, toRecord(g, report, observed, ok));
  }
  await writeRun(runPath, {
    run_id: options.runId,
    backfill: report,
    golden_count: options.golden.length,
    rebuilt_count: comparison.rebuiltCount,
    missing_organizations: comparison.missingOrganizations,
    diffs: comparison.diffs,
  });
  await markRunCompleted(options.outPath, options.runId, options.golden.length);
  return { success, failure: options.golden.length - success, backfillFailed: false };
}
