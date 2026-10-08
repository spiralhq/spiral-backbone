import { execFileSync } from "node:child_process";
import metadata from "./idl/metadata.json";

let backboneCommit: string | undefined;

const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

export function resetBackboneStamp(): void {
  backboneCommit = undefined;
}

function currentCommit(): string {
  if (backboneCommit === undefined) {
    try {
      const commit = git(["rev-parse", "--short", "HEAD"]).trim();
      const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
      backboneCommit = dirty ? `${commit}-dirty` : commit;
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
