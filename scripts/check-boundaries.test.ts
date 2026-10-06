import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryRules, findViolations, type BoundaryRule } from "./check-boundaries";

const testRule: BoundaryRule = {
  name: "test-rule",
  glob: "src/**/*.ts",
  forbidden: ["@forbidden/package"],
};

let cwd: string | undefined;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

describe("findViolations", () => {
  it("reports nothing when the target glob matches no files", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    expect(findViolations([testRule], cwd)).toEqual([]);
  });

  it("reports a violation when a forbidden specifier is imported", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "index.ts"),
      'import { thing } from "@forbidden/package";\nexport { thing };\n',
    );
    const violations = findViolations([testRule], cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@forbidden/package");
  });

  it("reports a violation for a forbidden deep import path", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "index.ts"),
      'import { thing } from "@forbidden/package/deep";\nexport { thing };\n',
    );
    expect(findViolations([testRule], cwd)).toHaveLength(1);
  });

  it("passes when only allowed specifiers are imported", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "index.ts"), 'import { z } from "zod";\nexport { z };\n');
    expect(findViolations([testRule], cwd)).toEqual([]);
  });
});

describe("boundaryRules (project rules)", () => {
  it("catches a kubo-rpc-client import in the eval-verifier-isolation rule", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/eval/verifier"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/eval/verifier", "index.ts"),
      'import { create } from "kubo-rpc-client";\nexport { create };\n',
    );
    const rule = boundaryRules.find((r) => r.name === "eval-verifier-isolation")!;
    const violations = findViolations([rule], cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("kubo-rpc-client");
  });

  it("catches a fetch/index.ts-style path in the cli-fetch-isolation rule", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/cli/src/commands/fetch"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/cli/src/commands/fetch", "index.ts"),
      'import { db } from "@spiral-backbone/db";\nexport { db };\n',
    );
    const rules = boundaryRules.filter((r) => r.name === "cli-fetch-isolation");
    const violations = findViolations(rules, cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@spiral-backbone/db");
  });
});

describe("eval-db-isolation", () => {
  it("flags an H1 harness file importing the database package", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/eval/src/h1"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/eval/src/h1/run.ts"),
      'import { createDb } from "@spiral-backbone/db";\nexport { createDb };\n',
    );
    const violations = findViolations(boundaryRules, cwd);
    expect(violations.some((v) => v.includes("eval-db-isolation"))).toBe(true);
  });

  it("allows the H4 harness to import the database package", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/eval/src/h4"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/eval/src/h4/run.ts"),
      'import { createDb } from "@spiral-backbone/db";\nexport { createDb };\n',
    );
    expect(findViolations(boundaryRules, cwd)).toEqual([]);
  });

  it("flags a future H2 harness file importing the indexer", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/eval/src/h2"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/eval/src/h2/run.ts"),
      'import { backfill } from "@spiral-backbone/indexer";\nexport { backfill };\n',
    );
    const violations = findViolations(boundaryRules, cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("packages/eval/src/h2/run.ts");
    expect(violations[0]).toContain("eval-db-isolation");
  });

  it("flags a top-level eval source file importing the database package", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "packages/eval/src"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/eval/src/x.ts"),
      'import { createDb } from "@spiral-backbone/db";\nexport { createDb };\n',
    );
    const violations = findViolations(boundaryRules, cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("packages/eval/src/x.ts");
  });
});

describe("rule exclusions", () => {
  it("skips files matching an exclude glob", () => {
    cwd = mkdtempSync(join(tmpdir(), "boundaries-"));
    mkdirSync(join(cwd, "src/allowed"), { recursive: true });
    const source = 'import { x } from "@forbidden/package";\nexport { x };\n';
    writeFileSync(join(cwd, "src/a.ts"), source);
    writeFileSync(join(cwd, "src/allowed/b.ts"), source);
    const violations = findViolations([{ ...testRule, exclude: ["src/allowed/**"] }], cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/a.ts");
  });
});
