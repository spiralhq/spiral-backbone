import { execFileSync } from "node:child_process";
import metadata from "./idl/metadata.json";

let backboneCommit: string | undefined;

function currentCommit(): string {
  if (backboneCommit === undefined) {
    try {
      backboneCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: import.meta.dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      backboneCommit = "unknown";
    }
  }
  return backboneCommit;
}

export function artifactVersions(): Record<string, string> {
  return {
    organization: `${metadata.organization.programVersion}@${metadata.organization.sourceCommit.slice(0, 7)}`,
    film: `${metadata.film.programVersion}@${metadata.film.sourceCommit.slice(0, 7)}`,
    backbone: currentCommit(),
  };
}
