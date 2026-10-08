import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = /\b(getSignaturesForAddress|getTransaction|getBlock|logsSubscribe)\b/;

describe("backfill never reads transaction history or events", () => {
  it("no indexer source file calls a history or subscription method", () => {
    const sources = globSync("**/*.ts", { cwd: import.meta.dirname }).filter(
      (file) => !file.endsWith(".test.ts") && !file.startsWith("e2e/"),
    );
    expect(sources.length).toBeGreaterThan(0);
    const offenders = sources.filter((file) =>
      FORBIDDEN.test(readFileSync(join(import.meta.dirname, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
