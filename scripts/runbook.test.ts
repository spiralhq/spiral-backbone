import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const runbook = () => readFileSync(join(ROOT, "docs/campaign-runbook.md"), "utf8");
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;

describe("docs/campaign-runbook.md", () => {
  it("only references npm scripts that exist", () => {
    const used = [...runbook().matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((s) => !(s in scripts))).toEqual([]);
  });

  it("mentions every campaign command", () => {
    for (const command of [
      "campaign:preflight",
      "campaign:archive-day",
      "eval:h1",
      "eval:h2",
      "eval:h3",
      "eval:h4",
      "eval:report",
      "spiral",
    ])
      expect(runbook()).toContain(`npm run ${command}`);
  });

  it("points only at paths that exist", () => {
    const paths = [...runbook().matchAll(/`((?:docs|packages|infra|scripts)\/[\w./-]+)`/g)].map(
      (m) => m[1]!,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });
});

const GOLDEN_WRITE = /(?:>>?\s*|\btee\b[^|\n]*?\s)\S*inventory-golden\.ndjson/;

function goldenWrites(markdown: string): string[] {
  return markdown.split(/(?<!\\)\n/).filter((command) => GOLDEN_WRITE.test(command));
}

describe("golden inventory writes", () => {
  it("detects every way of writing the golden", () => {
    expect(
      goldenWrites(
        [
          "npm run spiral -- submit >> results/inventory-golden.ndjson",
          "npm run spiral -- submit >>results/inventory-golden.ndjson",
          "npm run spiral -- submit | tee -a results/inventory-golden.ndjson",
          "npm run spiral -- submit \\\n  > results/inventory-golden.ndjson",
          "scp results/inventory-golden.ndjson host:",
        ].join("\n"),
      ),
    ).toHaveLength(4);
  });

  for (const doc of ["docs/campaign-runbook.md", "docs/eval-harness.md"]) {
    it(`${doc} keeps npm's banner out of the golden`, () => {
      const writes = goldenWrites(readFileSync(join(ROOT, doc), "utf8"));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.filter((c) => !c.includes("npm run spiral --silent --"))).toEqual([]);
    });
  }
});
