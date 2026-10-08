import { globSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

export interface BoundaryRule {
  name: string;
  glob: string;
  exclude?: string[];
  forbidden?: string[];
  forbiddenNames?: { from: string[]; names: string[] }[];
}

export const boundaryRules: BoundaryRule[] = [
  {
    name: "eval-verifier-isolation",
    glob: "packages/eval/verifier/**/*.ts",
    forbidden: [
      "@spiral-backbone/protocol",
      "kubo-rpc-client",
      "ipfs-http-client",
      "helia",
      "../src",
    ],
  },
  {
    name: "eval-db-isolation",
    glob: "packages/eval/src/**/*.ts",
    exclude: ["packages/eval/src/h4/**"],
    forbidden: ["@spiral-backbone/db", "@spiral-backbone/indexer"],
  },
  {
    name: "cli-fetch-isolation",
    glob: "packages/cli/src/commands/fetch.ts",
    forbidden: [
      "@spiral-backbone/db",
      "@spiral-backbone/indexer",
      "../../../db",
      "../../../indexer",
    ],
  },
  {
    name: "cli-fetch-isolation",
    glob: "packages/cli/src/commands/fetch/**/*.ts",
    forbidden: [
      "@spiral-backbone/db",
      "@spiral-backbone/indexer",
      "../../../../db",
      "../../../../indexer",
    ],
  },
  {
    name: "membership-pda-from-organization",
    glob: "{packages/*/{src,scripts},scripts}/**/*.ts",
    exclude: ["packages/protocol/src/generated/**", "scripts/check-boundaries.test.ts"],
    forbiddenNames: [
      {
        from: ["@spiral-backbone/protocol/generated/film", "./generated/film"],
        names: ["findMembershipPda"],
      },
    ],
  },
];

const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function matchesSpecifier(specifier: string, target: string): boolean {
  return specifier === target || specifier.startsWith(`${target}/`);
}

function importedNames(statement: string): string[] {
  const clause = /\{([^}]*)\}/.exec(statement)?.[1] ?? "";
  return clause
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim(),
    )
    .filter((name) => name.length > 0);
}

export function findViolations(rules: BoundaryRule[], cwd: string = process.cwd()): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    const files = globSync(rule.glob, { cwd }).filter(
      (file) => !(rule.exclude ?? []).some((pattern) => matchesGlob(file, pattern)),
    );
    for (const file of files) {
      const source = readFileSync(`${cwd}/${file}`, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        const hit = (rule.forbidden ?? []).find((forbidden) =>
          matchesSpecifier(specifier, forbidden),
        );
        if (hit) {
          violations.push(`${file}: imports "${specifier}", forbidden by rule "${rule.name}"`);
        }
        for (const { from, names } of rule.forbiddenNames ?? []) {
          if (!from.some((target) => matchesSpecifier(specifier, target))) continue;
          for (const name of importedNames(match[0]).filter((n) => names.includes(n))) {
            violations.push(
              `${file}: imports "${name}" from "${specifier}", forbidden by rule "${rule.name}"`,
            );
          }
        }
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findViolations(boundaryRules);
  if (violations.length > 0) {
    console.error(`Boundary check failed:\n${violations.join("\n")}`);
    process.exit(1);
  }
  console.log("Boundary check passed.");
}
