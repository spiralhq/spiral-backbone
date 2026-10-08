import type { ResultRecord } from "@spiral-backbone/protocol";
import {
  isExtraGeneration,
  parseScenario,
  scenarioFor,
  validGenerations,
  type BlockRecord,
} from "../h2/blocks-log";
import type { PlannedBlock } from "../h2/plan";
import type { H2Evidence } from "./load";

export type H2PlanBlock = Pick<PlannedBlock, "name" | "kind" | "active_replicas">;

export const H2_RATE_HEADERS = [
  "replica_state",
  "method",
  "attempts",
  "successes",
  "external_cache",
  "success_rate",
];
export const H2_BY_REPLICAS_HEADERS = [
  "active_replicas",
  "method",
  "attempts",
  "successes",
  "external_cache",
  "success_rate",
];
export const H2_LATENCY_HEADERS = [
  "block_kind",
  "size_band",
  "method",
  "n",
  "mean_ms",
  "median_ms",
  "p95_ms",
];
export const H2_FAILURE_HEADERS = ["replica_state", "method", "failure_class", "count"];
export const H2_AUDIT_HEADERS = ["metric", "min", "median", "p95", "max"];

const SIZE_BAND_ORDER = ["small", "medium", "large"];
const KIND_ORDER = ["main", "cold-start", "degradation"];

interface Acceptance {
  successes: number;
  denominator: number;
  externalCache: number;
  rate: number | null;
}

export interface H2Summary {
  rateRows: string[][];
  byReplicaRows: string[][];
  maxActiveReplicas: number;
  threeReplicaAcceptance: (Acceptance & { activeReplicas: number }) | null;
  directOnlyAcceptance: Acceptance | null;
  oneReplicaDirect: { successes: number; denominator: number; rate: number | null } | null;
  latencyRows: string[][];
  failureRows: string[][];
  included: number;
  excludedUnconfirmed: number;
  excludedNoEnd: number;
  directSuccessAtZero: number;
  directCacheAtZero: number;
  extraGenerations: string[];
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

function rateOf(rows: ResultRecord[]) {
  const cache = rows.filter((r) => r.failure_class === "external_cache").length;
  const successes = rows.filter((r) => r.outcome === "success").length;
  const denominator = rows.length - cache;
  return {
    cache,
    successes,
    denominator,
    rate: denominator === 0 ? null : successes / denominator,
  };
}

function acceptanceOf(rows: ResultRecord[]): Acceptance | null {
  if (rows.length === 0) return null;
  const { cache, successes, denominator, rate } = rateOf(rows);
  return { successes, denominator, externalCache: cache, rate };
}

const percent = (rate: number | null) => (rate === null ? "—" : `${(rate * 100).toFixed(1)}%`);

const rateCells = (rows: ResultRecord[]) => {
  const { cache, successes, rate } = rateOf(rows);
  return [String(rows.length), String(successes), String(cache), percent(rate)];
};

export function h2ExtraGenerationsLine(extraGenerations: string[]): string {
  return `Generations beyond the campaign limit: ${extraGenerations.length} (block ${extraGenerations.join(", ")})\n`;
}

const truncatedPercent = (successes: number, denominator: number) =>
  denominator === 0 ? "—" : `${(Math.floor((successes * 10_000) / denominator) / 100).toFixed(2)}%`;

const criterionVerdict = (rate: number | null) =>
  rate === null ? "no data" : rate >= 0.95 ? "met" : "NOT met";

const replicaNoun = (n: number) => `${n} active ${n === 1 ? "replica" : "replicas"}`;

export function h2AcceptanceLine(
  summary: Pick<H2Summary, "maxActiveReplicas" | "threeReplicaAcceptance">,
): string {
  const subject = `**Success with ${replicaNoun(summary.maxActiveReplicas)}:`;
  const a = summary.threeReplicaAcceptance;
  if (a === null) return `${subject} no valid attempts — criterion ≥ 95%: no data**\n`;
  return `${subject} ${truncatedPercent(a.successes, a.denominator)} (${a.successes} of ${a.denominator}, excluding ${a.externalCache} external_cache) — criterion ≥ 95%: ${criterionVerdict(a.rate)}**\n`;
}

export function h2DirectOnlyLine(
  summary: Pick<H2Summary, "maxActiveReplicas" | "directOnlyAcceptance">,
): string {
  const subject = `**Direct-only success with ${replicaNoun(summary.maxActiveReplicas)}:`;
  const a = summary.directOnlyAcceptance;
  if (a === null) return `${subject} no valid attempts — criterion ≥ 95%: no data**\n`;
  return `${subject} ${truncatedPercent(a.successes, a.denominator)} (${a.successes} of ${a.denominator}, excluding ${a.externalCache} external_cache) — criterion ≥ 95%: ${criterionVerdict(a.rate)}**\n`;
}

export function h2OneReplicaLine(summary: Pick<H2Summary, "oneReplicaDirect">): string {
  const subject = "**Direct success with 1 active replica:";
  const a = summary.oneReplicaDirect;
  if (a === null) return `${subject} no valid attempts — recovery operational: no data**\n`;
  const verdict = a.rate === null ? "no data" : a.successes > 0 ? "yes" : "no";
  const shown = a.denominator === 0 ? "—" : truncatedPercent(a.successes, a.denominator);
  return `${subject} ${a.successes} of ${a.denominator} (${shown}) — recovery operational: ${verdict}**\n`;
}

const byKeys =
  <T>(keys: (item: T) => (number | string)[]) =>
  (a: T, b: T): number => {
    const [ka, kb] = [keys(a), keys(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  };

export function assertNoDuplicateH2Results(records: ResultRecord[]): void {
  const seen = new Map<string, number>();
  for (const r of records) {
    const key = `run_id ${r.run_id}, scenario ${r.scenario}, work_id ${r.work_id}, method ${r.method}, attempt ${r.attempt}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicate = [...seen].find(([, count]) => count > 1);
  if (duplicate) {
    throw new Error(
      `duplicate H2 result (${duplicate[0]}) appears ${duplicate[1]} times in the results; the artifacts were written twice for one attempt — investigate before reporting`,
    );
  }
}

export function summarizeH2(
  records: ResultRecord[],
  blocks: BlockRecord[],
  runId: string,
  plan: H2PlanBlock[],
): H2Summary {
  const kinds = new Map(plan.map((b) => [b.name, b.kind]));
  const maxActiveReplicas = Math.max(...plan.map((b) => b.active_replicas.length));
  const own = records.filter((r) => r.run_id === runId);
  const runBlocks = blocks.filter((b) => b.run_id === runId);
  const valid = validGenerations(blocks, runId);
  const ended = new Set<string>();
  const planIndex = new Map<string, number>();
  const activeCount = new Map<string, number>();
  for (const b of runBlocks) {
    activeCount.set(b.block_name, b.intended_active.length);
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
  const kindOf = (r: ResultRecord) => {
    const kind = kinds.get(blockOf(r));
    if (kind === undefined) throw new Error(`block ${blockOf(r)} is not in the frozen plan`);
    return kind;
  };
  const activeOf = (r: ResultRecord) => activeCount.get(blockOf(r))!;
  const planActive = new Map(plan.map((b) => [b.name, b.active_replicas.length]));
  for (const r of included) {
    kindOf(r);
    if (activeOf(r) !== planActive.get(blockOf(r)))
      throw new Error(
        `block ${blockOf(r)}: block log has ${activeOf(r)} intended active replicas, frozen plan has ${planActive.get(blockOf(r))}`,
      );
  }

  const rateRows = [...groupBy(included, (r) => `${blockOf(r)}\u0000${r.method}`)]
    .map(([key, rows]) => [...key.split("\u0000"), ...rateCells(rows)])
    .sort(byKeys((row) => [planOrder(row[0]!), row[1]!]));

  const byReplicaRows = [...groupBy(included, (r) => `${activeOf(r)}\u0000${r.method}`)]
    .map(([key, rows]) => [...key.split("\u0000"), ...rateCells(rows)])
    .sort(byKeys((row) => [-Number(row[0]), row[1]!]));

  const topRows = included.filter((r) => activeOf(r) === maxActiveReplicas);
  const top = acceptanceOf(topRows);
  const threeReplicaAcceptance = top && { activeReplicas: maxActiveReplicas, ...top };
  const directOnlyAcceptance = acceptanceOf(topRows.filter((r) => r.method === "direct"));
  const one = acceptanceOf(included.filter((r) => r.method === "direct" && activeOf(r) === 1));
  const oneReplicaDirect =
    one === null
      ? null
      : { successes: one.successes, denominator: one.denominator, rate: one.rate };

  const latencyRows = [
    ...groupBy(
      included.filter((r) => r.outcome === "success"),
      (r) => `${kindOf(r)}\u0000${r.size_band}\u0000${r.method}`,
    ),
  ]
    .map(([key, rows]) => {
      const values = rows.map((r) => r.latency_ms);
      const mean = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
      return [
        ...key.split("\u0000"),
        String(values.length),
        String(mean),
        String(percentile(values, 50)),
        String(percentile(values, 95)),
      ];
    })
    .sort(
      byKeys((row) => [KIND_ORDER.indexOf(row[0]!), SIZE_BAND_ORDER.indexOf(row[1]!), row[2]!]),
    );

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
    byReplicaRows,
    maxActiveReplicas,
    threeReplicaAcceptance,
    directOnlyAcceptance,
    oneReplicaDirect,
    latencyRows,
    failureRows,
    included: included.length,
    excludedUnconfirmed,
    excludedNoEnd: own.length - included.length - excludedUnconfirmed,
    directSuccessAtZero,
    directCacheAtZero,
    extraGenerations: runBlocks
      .filter(isExtraGeneration)
      .map((b) => scenarioFor(b.block_name, b.generation)),
  };
}

export function provenanceAudit(
  records: ResultRecord[],
  blocks: BlockRecord[],
  runId: string,
  evidence: H2Evidence[],
): { n: number; missingEvidence: number; pctExcluded: number; rows: string[][] } {
  const valid = validGenerations(blocks, runId);
  const byKey = new Map(
    evidence
      .filter((e) => e.run_id === runId)
      .map((e) => [`${e.attempt_id}#${e.generation}`, e.provenance]),
  );
  const audited = records.filter(
    (r) =>
      r.run_id === runId &&
      valid.has(r.scenario) &&
      r.method === "direct" &&
      r.outcome === "success",
  );
  const found = audited.flatMap((r) => {
    const { block, generation } = parseScenario(r.scenario)!;
    const attemptId = `${block}/${r.work_id}/${r.method}/r${r.attempt}`;
    const p = byKey.get(`${attemptId}#${generation}`);
    if (p?.dag_size != null && p.dag_size <= 0)
      throw new Error(
        `evidence for ${attemptId} (generation ${generation}): dag_size is ≤ 0 on a direct success`,
      );
    return p ? [p] : [];
  });
  const bytes = found.map((p) => p.unattributed);
  const pcts = found
    .filter((p) => p.dag_size !== null)
    .map((p) => Math.round((p.unattributed / p.dag_size!) * 10_000) / 100);
  const stats = (values: number[], show: (v: number) => string) =>
    values.length === 0
      ? ["—", "—", "—", "—"]
      : [
          Math.min(...values),
          percentile(values, 50),
          percentile(values, 95),
          Math.max(...values),
        ].map(show);
  return {
    n: found.length,
    missingEvidence: audited.length - found.length,
    pctExcluded: found.length - pcts.length,
    rows:
      found.length === 0
        ? []
        : [
            ["unattributed_bytes", ...stats(bytes, String)],
            ["unattributed_pct_of_dag", ...stats(pcts, (v) => v.toFixed(2))],
          ],
  };
}
