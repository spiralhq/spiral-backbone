import { globSync, readFileSync } from "node:fs";

export interface BoundaryRule {
  name: string;
  glob: string;
  forbidden: string[];
}

export const boundaryRules: BoundaryRule[] = [
  {
    name: "eval-verifier-isolation",
    glob: "packages/eval/verifier/**/*.ts",
    forbidden: ["@spiral-backbone/protocol", "kubo-rpc-client", "ipfs-http-client", "helia"],
  },
  {
    name: "cli-fetch-isolation",
    glob: "packages/cli/src/commands/fetch.ts",
    forbidden: ["@spiral-backbone/db", "@spiral-backbone/indexer"],
  },
  {
    name: "cli-fetch-isolation",
    glob: "packages/cli/src/commands/fetch/**/*.ts",
    forbidden: ["@spiral-backbone/db", "@spiral-backbone/indexer"],
  },
];

const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

export function findViolations(rules: BoundaryRule[], cwd: string = process.cwd()): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    const files = globSync(rule.glob, { cwd });
    for (const file of files) {
      const source = readFileSync(`${cwd}/${file}`, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        const hit = rule.forbidden.find(
          (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
        );
        if (hit) {
          violations.push(`${file}: imports "${specifier}", forbidden by rule "${rule.name}"`);
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
