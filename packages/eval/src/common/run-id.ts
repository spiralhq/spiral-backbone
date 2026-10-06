export type HypothesisSlug = "h1" | "h2" | "h3" | "h4";

export function makeRunId(
  hypothesis: HypothesisSlug,
  label: string,
  now: Date = new Date(),
): string {
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`run label must be lowercase letters, digits and dashes: ${label}`);
  }
  return `${now.toISOString().slice(0, 19)}Z-${hypothesis}-${label}`;
}
