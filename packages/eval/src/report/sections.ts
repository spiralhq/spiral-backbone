import type { ResultRecord } from "@spiral-backbone/protocol";
import type { z } from "zod";
import type { RunStatus } from "../common/run-status";
import type { h3EvidenceSchema, h4RunSchema } from "./load";

export interface Section {
  markdown: string;
  csv?: { name: string; headers: string[]; rows: string[][] };
}

export const H1_HEADERS = [
  "work_id",
  "scenario",
  "cid_recorded",
  "cid_recomputed",
  "verifier_impl",
  "outcome",
];
export const H3_HEADERS = [
  "scenario",
  "expected_code",
  "observed_code",
  "instruction_index",
  "refusing_program",
  "tx_signature",
  "outcome",
];
export const H4_HEADERS = ["divergence", "count"];

export function h1Rows(records: ResultRecord[]): string[][] {
  return records.map((r) => [
    r.work_id,
    r.scenario,
    r.cid_expected,
    r.cid_observed ?? "—",
    r.verifier_impl,
    r.outcome,
  ]);
}

export function h3Rows(
  records: ResultRecord[],
  evidence: z.infer<typeof h3EvidenceSchema>[],
): string[][] {
  return records.map((r) => {
    const id = Number(/^h3-s(\d+)$/.exec(r.work_id)?.[1]);
    const e = evidence.find((x) => x.run_id === r.run_id && x.scenario_id === id);
    return [
      r.scenario,
      e ? String(e.expected_code) : "—",
      e?.observed ? String(e.observed.code) : "—",
      e?.observed ? String(e.observed.index) : "—",
      e?.failing_program ?? "—",
      r.tx_signature ?? "—",
      r.outcome,
    ];
  });
}

export function h4Summary(run: z.infer<typeof h4RunSchema>): string[][] {
  return [
    ["golden works", String(run.golden_count ?? "—")],
    ["rebuilt works", String(run.rebuilt_count ?? "—")],
    ["rebuild time (ms)", String(run.backfill?.duration_ms ?? "—")],
    ["RPC calls", String(run.backfill?.rpc_calls_total ?? "—")],
    ["rate-limit retries", String(run.backfill?.rate_limit_retries ?? "—")],
    ["missing organizations", (run.missing_organizations ?? []).join(", ") || "none"],
    ...(run.error ? [["error", run.error]] : []),
  ];
}

export function h4DivergenceRows(run: z.infer<typeof h4RunSchema>): string[][] {
  const counts = new Map<string, number>();
  for (const d of run.diffs ?? []) {
    const key = d.kind === "field" ? `${d.table}.${d.field}` : `${d.table}:${d.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => [k, String(n)]);
}

export function statusLine(
  marks: RunStatus[],
  runId: string,
  recorded: number,
  countLabel: "recorded" | "included" = "recorded",
): string {
  const own = marks.filter((m) => m.run_id === runId);
  const started = own.find((m) => m.status === "started");
  const completed = own.find((m) => m.status === "completed");
  const expected = started?.status === "started" ? started.expected_attempts : undefined;
  if (completed?.status === "completed")
    return `Status: complete (${completed.recorded_attempts}/${expected ?? completed.recorded_attempts} attempts)\n`;
  if (expected !== undefined)
    return `Status: **INCOMPLETE** — run did not finish (${recorded} of ${expected} expected attempts ${countLabel})\n`;
  return "Status: unknown (no run-status sidecar)\n";
}

export function mixedVersionsWarning(records: ResultRecord[]): string | undefined {
  const sorted = (v: Record<string, string>) =>
    JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))));
  const distinct = [...new Set(records.map((r) => sorted(r.artifact_versions)))].sort();
  return distinct.length > 1
    ? `**WARNING: mixed artifact versions in this run: ${distinct.join(", ")}**\n`
    : undefined;
}
