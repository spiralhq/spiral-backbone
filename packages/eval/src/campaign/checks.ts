import { redact } from "../h2/command";

export type Stage = "infra" | "h2";

export interface Check {
  stage: Stage;
  name: string;
  run(): Promise<string>;
}

export interface CheckResult {
  stage: Stage;
  name: string;
  ok: boolean;
  detail: string;
}

export async function runChecks(checks: Check[], secrets: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const detail = redact(await check.run(), secrets);
      results.push({ stage: check.stage, name: check.name, ok: true, detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        stage: check.stage,
        name: check.name,
        ok: false,
        detail: redact(message, secrets),
      });
    }
  }
  return results;
}

export function renderChecks(results: CheckResult[]): string {
  const escape = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
  const rows = results.map(
    (r) => `| ${r.stage} | ${r.name} | ${r.ok ? "OK" : "BLOCKED"} | ${escape(r.detail)} |`,
  );
  const failed = results.filter((r) => !r.ok).length;
  const verdict =
    failed === 0
      ? "Pre-flight: READY"
      : `Pre-flight: BLOCKED (${failed} of ${results.length} checks failed)`;
  return [
    "| stage | check | status | detail |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    verdict,
    "",
  ].join("\n");
}
