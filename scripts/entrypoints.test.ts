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
});
