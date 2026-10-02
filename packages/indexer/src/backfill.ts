import { migrateCatalog, resetCatalog, type Database } from "@spiral-backbone/db";
import { writeCatalog } from "./catalog-store";
import { snapshotFromChain } from "./chain";
import { createIndexerRpc, describeEndpoint, type IndexerRpcOptions } from "./rpc";

export interface BackfillReport {
  mode: "backfill";
  status: "succeeded" | "failed";
  error?: string;
  reset: boolean;
  rpc_endpoint: string;
  rpc_endpoint_fingerprint: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  rpc_calls: Record<string, number>;
  rpc_calls_total: number;
  rate_limit_retries: number;
  counts: { organizations: number; memberships: number; films: number; film_replicas: number };
}

export interface BackfillOptions {
  db: Database;
  rpcUrl: string;
  reset: boolean;
  rpcOptions?: IndexerRpcOptions;
}

export class BackfillError extends Error {
  readonly report: BackfillReport;

  constructor(report: BackfillReport, cause: unknown) {
    super(report.error ?? "backfill failed", { cause });
    this.name = "BackfillError";
    this.report = report;
  }
}

const NO_COUNTS = { organizations: 0, memberships: 0, films: 0, film_replicas: 0 };

export async function backfill(options: BackfillOptions): Promise<BackfillReport> {
  const startedAt = new Date();
  const endpoint = describeEndpoint(options.rpcUrl);
  const { rpc, stats } = createIndexerRpc(options.rpcUrl, options.rpcOptions);

  const baseReport = (counts: BackfillReport["counts"]) => {
    const finishedAt = new Date();
    return {
      reset: options.reset,
      rpc_endpoint: endpoint.host,
      rpc_endpoint_fingerprint: endpoint.fingerprint,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rpc_calls: { ...stats.calls },
      rpc_calls_total: Object.values(stats.calls).reduce((sum, n) => sum + n, 0),
      rate_limit_retries: stats.rateLimitRetries,
      counts,
    };
  };

  let snapshot: Awaited<ReturnType<typeof snapshotFromChain>>;
  try {
    if (options.reset) {
      await resetCatalog(options.db);
    } else {
      await migrateCatalog(options.db);
    }
    snapshot = await snapshotFromChain(rpc);
    await writeCatalog(options.db, snapshot);
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : String(error),
      options.rpcUrl,
      endpoint.host,
    );
    throw new BackfillError(
      { mode: "backfill", status: "failed", error: message, ...baseReport({ ...NO_COUNTS }) },
      error,
    );
  }

  return {
    mode: "backfill",
    status: "succeeded",
    ...baseReport({
      organizations: snapshot.organizations.length,
      memberships: snapshot.memberships.length,
      films: snapshot.films.length,
      film_replicas: snapshot.filmReplicas.length,
    }),
  };
}

function redact(message: string, rpcUrl: string, host: string): string {
  const query = new URL(rpcUrl).search;
  let out = message.split(rpcUrl).join(host);
  if (query.length > 1) out = out.split(query).join("");
  return out;
}
