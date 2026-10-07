import type { ResultRecord } from "@spiral-backbone/protocol";
import { parseScenario, scenarioFor, validGenerations, type BlockRecord } from "../h2/blocks-log";

export const H2_RATE_HEADERS = [
  "replica_state",
  "method",
  "attempts",
  "successes",
  "external_cache",
  "success_rate",
];
export const H2_LATENCY_HEADERS = ["size_band", "method", "n", "mean_ms", "median_ms", "p95_ms"];
export const H2_FAILURE_HEADERS = ["replica_state", "method", "failure_class", "count"];

const SIZE_BAND_ORDER = ["small", "medium", "large"];

export interface H2Summary {
  rateRows: string[][];
  latencyRows: string[][];
  failureRows: string[][];
  included: number;
  excludedUnconfirmed: number;
  excludedNoEnd: number;
  directSuccessAtZero: number;
  directCacheAtZero: number;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function h2AttemptsLine(
  included: number,
  planned: number | undefined,
  recorded: number,
): string {
  return planned === undefined
    ? `Attempts included: ${included} (${recorded} recorded, including re-run generations; planned count unknown)\n`
    : `Attempts included: ${included} of ${planned} planned (${recorded} recorded, including re-run generations)\n`;
}

const byKeys =
  <T>(keys: (item: T) => (number | string)[]) =>
  (a: T, b: T): number => {
    const [ka, kb] = [keys(a), keys(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  };

export function summarizeH2(
  records: ResultRecord[],
  blocks: BlockRecord[],
  runId: string,
): H2Summary {
  const own = records.filter((r) => r.run_id === runId);
  const runBlocks = blocks.filter((b) => b.run_id === runId);
  const valid = validGenerations(blocks, runId);
  const ended = new Set<string>();
  const planIndex = new Map<string, number>();
  for (const b of runBlocks) {
    if (b.phase === "end") ended.add(scenarioFor(b.block_name, b.generation));
    planIndex.set(b.block_name, Math.min(planIndex.get(b.block_name) ?? Infinity, b.block_index));
  }
  const included = own.filter((r) => valid.has(r.scenario));
  const excludedUnconfirmed = own.filter(
    (r) => !valid.has(r.scenario) && ended.has(r.scenario),
  ).length;
  const zeroBlocks = new Set(
    runBlocks.filter((b) => b.intended_active.length === 0).map((b) => b.block_name),
  );
  const blockOf = (r: ResultRecord) => parseScenario(r.scenario)!.block;
  const planOrder = (block: string) => planIndex.get(block) ?? Infinity;

  const rateRows = [...groupBy(included, (r) => `${blockOf(r)}\u0000${r.method}`)]
    .map(([key, rows]) => {
      const [state, method] = key.split("\u0000") as [string, string];
      const cache = rows.filter((r) => r.failure_class === "external_cache").length;
      const successes = rows.filter((r) => r.outcome === "success").length;
      const denominator = rows.length - cache;
      const rate = denominator === 0 ? "—" : `${((successes / denominator) * 100).toFixed(1)}%`;
      return [state, method, String(rows.length), String(successes), String(cache), rate];
    })
    .sort(byKeys((row) => [planOrder(row[0]!), row[1]!]));

  const latencyRows = [
    ...groupBy(
      included.filter((r) => r.outcome === "success"),
      (r) => `${r.size_band}\u0000${r.method}`,
    ),
  ]
    .map(([key, rows]) => {
      const [band, method] = key.split("\u0000") as [string, string];
      const values = rows.map((r) => r.latency_ms);
      const mean = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
      return [
        band,
        method,
        String(values.length),
        String(mean),
        String(percentile(values, 50)),
        String(percentile(values, 95)),
      ];
    })
    .sort(byKeys((row) => [SIZE_BAND_ORDER.indexOf(row[0]!), row[1]!]));

  const failureRows = [
    ...groupBy(
      included.filter((r) => r.outcome === "failure"),
      (r) => `${blockOf(r)}\u0000${r.method}\u0000${r.failure_class ?? "unclassified"}`,
    ),
  ]
    .map(([key, rows]) => [...key.split("\u0000"), String(rows.length)])
    .sort(byKeys((row) => [planOrder(row[0]!), row[1]!, row[2]!]));

  const directSuccessAtZero = included.filter(
    (r) => r.method === "direct" && r.outcome === "success" && zeroBlocks.has(blockOf(r)),
  ).length;

  const directCacheAtZero = included.filter(
    (r) =>
      r.method === "direct" && r.failure_class === "external_cache" && zeroBlocks.has(blockOf(r)),
  ).length;

  return {
    rateRows,
    latencyRows,
    failureRows,
    included: included.length,
    excludedUnconfirmed,
    excludedNoEnd: own.length - included.length - excludedUnconfirmed,
    directSuccessAtZero,
    directCacheAtZero,
  };
}
