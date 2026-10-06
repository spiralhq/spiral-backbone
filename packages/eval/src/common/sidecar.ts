export function sidecarPath(outPath: string, kind: "evidence" | "run" | "runs"): string {
  const base = outPath.endsWith(".ndjson") ? outPath.slice(0, -".ndjson".length) : outPath;
  if (kind === "evidence") return `${base}.evidence.ndjson`;
  return kind === "runs" ? `${base}.runs.ndjson` : `${base}.run.json`;
}
