import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

function runEntrypoint(entry: string, args: string[]): string {
  return execFileSync(TSX, [join(ROOT, entry), ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("CLI entrypoints run under tsx", () => {
  it("spiral --help", () => {
    expect(runEntrypoint("packages/cli/src/index.ts", ["--help"])).toContain("Usage: spiral");
  }, 30_000);
  it("spiral-indexer --help", () => {
    expect(runEntrypoint("packages/indexer/src/cli.ts", ["--help"])).toContain("backfill");
  }, 30_000);
  it("spiral-eval --help", () => {
    expect(runEntrypoint("packages/eval/src/cli.ts", ["--help"])).toContain("spiral-eval");
  }, 30_000);
  it("spiral-eval h2 --help", () => {
    expect(runEntrypoint("packages/eval/src/cli.ts", ["h2", "--help"])).toMatch(/plan[\s\S]*run/);
  }, 30_000);
  it("spiral-eval campaign preflight --help", () => {
    expect(runEntrypoint("packages/eval/src/cli.ts", ["campaign", "preflight", "--help"])).toMatch(
      /--stage[\s\S]*--skip-conformance/,
    );
  }, 30_000);

  it("campaign:archive-day --help", () => {
    const out = execFileSync("node", [join(ROOT, "scripts/archive-day.ts"), "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("Usage: archive-day");
  }, 30_000);
});
