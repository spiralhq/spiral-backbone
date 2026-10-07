import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResultRecord } from "@spiral-backbone/protocol";
import { sidecarPath } from "../common/sidecar";
import { blocksPath, readBlockRecords } from "../h2/blocks-log";
import {
  H2_FAILURE_HEADERS,
  H2_LATENCY_HEADERS,
  H2_RATE_HEADERS,
  h2AttemptsLine,
  summarizeH2,
} from "./h2";
import { loadH3Evidence, loadH4Run, loadResults, loadRunStatus } from "./load";
import { csv, markdownTable } from "./render";
import {
  H1_HEADERS,
  H3_HEADERS,
  H4_HEADERS,
  h1Rows,
  h3Rows,
  h4DivergenceRows,
  h4Summary,
  statusLine,
} from "./sections";

export function latestRunId(records: ResultRecord[]): string | undefined {
  return records
    .map((r) => r.run_id)
    .sort()
    .at(-1);
}

const onlyRun = (records: ResultRecord[], runId: string | undefined) =>
  records.filter((r) => r.run_id === runId);

export async function generateReport(options: {
  resultsDir: string;
  outDir: string;
  runIds?: { h1?: string; h2?: string; h3?: string; h4?: string };
}): Promise<{ markdownPath: string; csvPaths: string[] }> {
  await mkdir(options.outDir, { recursive: true });
  const csvPaths: string[] = [];
  const parts: string[] = ["# Spiral evaluation report\n"];
  const emitCsv = async (name: string, headers: string[], rows: string[][]) => {
    const path = join(options.outDir, name);
    await writeFile(path, csv(headers, rows));
    csvPaths.push(path);
  };

  const h1Path = join(options.resultsDir, "h1.ndjson");
  const h1All = await loadResults(h1Path);
  const h1Run = options.runIds?.h1 ?? latestRunId(h1All);
  parts.push(`## H1 — Integridade da representação registrada\n`);
  if (h1All.length === 0) parts.push("No results.\n");
  else {
    const own = onlyRun(h1All, h1Run);
    const rows = h1Rows(own);
    const marks = await loadRunStatus(sidecarPath(h1Path, "runs"));
    const intact = own.filter((r) => r.scenario === "intact").length;
    parts.push(
      `Run: \`${h1Run}\`\n`,
      statusLine(marks, h1Run!, intact),
      markdownTable(H1_HEADERS, rows),
    );
    await emitCsv("h1.csv", H1_HEADERS, rows);
  }

  const h2Path = join(options.resultsDir, "h2.ndjson");
  const h2All = await loadResults(h2Path);
  const h2Run = options.runIds?.h2 ?? latestRunId(h2All);
  parts.push(`## H2 — Recuperabilidade a partir do registro\n`);
  if (h2All.length === 0) parts.push("No results.\n");
  else {
    const summary = summarizeH2(h2All, await readBlockRecords(blocksPath(h2Path)), h2Run!);
    const marks = await loadRunStatus(sidecarPath(h2Path, "runs"));
    const started = marks.find((m) => m.run_id === h2Run && m.status === "started");
    const planned = started?.status === "started" ? started.expected_attempts : undefined;
    parts.push(
      `Run: \`${h2Run}\`\n`,
      statusLine(marks, h2Run!, summary.included, "included"),
      h2AttemptsLine(summary.included, planned, onlyRun(h2All, h2Run).length),
    );
    if (summary.excludedUnconfirmed > 0)
      parts.push(
        `Attempts excluded (end-of-block replica state not confirmed): ${summary.excludedUnconfirmed}\n`,
      );
    if (summary.excludedNoEnd > 0)
      parts.push(
        `Attempts excluded (no end-of-block state check recorded): ${summary.excludedNoEnd}\n`,
      );
    if (summary.directSuccessAtZero > 0) {
      parts.push(
        `**Direct success with zero active replicas: ${summary.directSuccessAtZero}** — this refutes H2.\n`,
      );
    }
    if (summary.directCacheAtZero > 0) {
      parts.push(
        `**Zero-replica control contaminated: ${summary.directCacheAtZero} direct recoveries from undeclared sources** — does not refute H2; the zero-replica control is weakened.\n`,
      );
    }
    parts.push(
      markdownTable(H2_RATE_HEADERS, summary.rateRows),
      "\n",
      summary.latencyRows.length === 0
        ? "No successful attempts.\n"
        : markdownTable(H2_LATENCY_HEADERS, summary.latencyRows),
      "\n",
      summary.failureRows.length === 0
        ? "No failures.\n"
        : markdownTable(H2_FAILURE_HEADERS, summary.failureRows),
    );
    await emitCsv("h2-rates.csv", H2_RATE_HEADERS, summary.rateRows);
    await emitCsv("h2-latency.csv", H2_LATENCY_HEADERS, summary.latencyRows);
  }

  const h3Path = join(options.resultsDir, "h3.ndjson");
  const h3All = await loadResults(h3Path);
  const h3Run = options.runIds?.h3 ?? latestRunId(h3All);
  parts.push(`## H3 — Autoridade de submissão\n`);
  if (h3All.length === 0) parts.push("No results.\n");
  else {
    const own = onlyRun(h3All, h3Run);
    const rows = h3Rows(own, await loadH3Evidence(sidecarPath(h3Path, "evidence")));
    const marks = await loadRunStatus(sidecarPath(h3Path, "runs"));
    parts.push(
      `Run: \`${h3Run}\`\n`,
      statusLine(marks, h3Run!, own.length),
      markdownTable(H3_HEADERS, rows),
    );
    await emitCsv("h3.csv", H3_HEADERS, rows);
  }

  const h4Path = join(options.resultsDir, "h4.ndjson");
  const h4All = await loadResults(h4Path);
  const h4RunRecord = loadH4Run(sidecarPath(h4Path, "run"));
  parts.push(`## H4 — Reconstrutibilidade da camada de consulta\n`);
  if (!h4RunRecord) parts.push("No results.\n");
  else {
    const divergences = h4DivergenceRows(h4RunRecord);
    const marks = await loadRunStatus(sidecarPath(h4Path, "runs"));
    parts.push(
      `Run: \`${h4RunRecord.run_id}\`\n`,
      statusLine(marks, h4RunRecord.run_id, onlyRun(h4All, h4RunRecord.run_id).length),
      markdownTable(["metric", "value"], h4Summary(h4RunRecord)),
      "\n",
      divergences.length === 0 ? "No field divergences.\n" : markdownTable(H4_HEADERS, divergences),
    );
    await emitCsv("h4-divergences.csv", H4_HEADERS, divergences);
  }

  const markdownPath = join(options.outDir, "report.md");
  await writeFile(markdownPath, parts.join("\n"));
  return { markdownPath, csvPaths };
}
