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
