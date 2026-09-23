import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations, boundaryRules } from "../../../../../scripts/check-boundaries";

let cwd: string | undefined;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

const FORBIDDEN_SPECIFIER = "@spiral-backbone/db";

// Built from parts, not one literal `import` statement — this file lives under
// commands/fetch/**, so a literal offending import here would trip the real boundary scan.
const violatingSource = [
  "im",
  'port { db } from "',
  FORBIDDEN_SPECIFIER,
  '";\nexport { db };\n',
].join("");

describe("fetch command import boundary", () => {
  it("flags an import of @spiral-backbone/db from commands/fetch/**", () => {
    cwd = mkdtempSync(join(tmpdir(), "fetch-boundary-"));
    const fetchDir = join(cwd, "packages", "cli", "src", "commands", "fetch");
    execFileSync("mkdir", ["-p", fetchDir]);
    writeFileSync(join(fetchDir, "index.ts"), violatingSource);
    const rules = boundaryRules.filter((rule) => rule.name === "cli-fetch-isolation");
    const violations = findViolations(rules, cwd);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(FORBIDDEN_SPECIFIER);
  });
});
