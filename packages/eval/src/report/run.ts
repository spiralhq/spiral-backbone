import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResultRecord } from "@spiral-backbone/protocol";
import { sidecarPath } from "../common/sidecar";
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
  runIds?: { h1?: string; h3?: string; h4?: string };
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
