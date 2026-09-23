import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROGRAM_NAMES = ["organization", "film"] as const;

const PROTOCOL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const IDL_OUT_DIR = join(PROTOCOL_DIR, "src", "idl");

export function resolveSpiralProgramsDir(): string {
  return (
    process.env["SPIRAL_PROGRAMS_DIR"] ??
    // packages/protocol -> packages -> spiral-backbone (repo root) -> spiral (parent) -> spiral-programs
    join(PROTOCOL_DIR, "..", "..", "..", "spiral-programs")
  );
}

export function syncIdl(
  spiralProgramsDir: string = resolveSpiralProgramsDir(),
  destDir: string = IDL_OUT_DIR,
): void {
  mkdirSync(destDir, { recursive: true });

  let sourceCommit: string;
  try {
    sourceCommit = execFileSync("git", ["-C", spiralProgramsDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    throw new Error(
      `could not read spiral-programs' HEAD commit at ${spiralProgramsDir} — is it a git checkout? (${String(error)})`,
    );
  }

  const metadata: Record<string, { programVersion: string; sourceCommit: string }> = {};

  for (const name of PROGRAM_NAMES) {
    const sourcePath = join(spiralProgramsDir, "idl", `${name}.json`);
    if (!existsSync(sourcePath)) {
      throw new Error(
        `IDL not found at ${sourcePath} — run \`anchor build\` in spiral-programs first`,
      );
    }
    const raw = readFileSync(sourcePath, "utf8");
    const idl = JSON.parse(raw) as { metadata?: { version?: string } };
    writeFileSync(join(destDir, `${name}.json`), raw);
    metadata[name] = {
      programVersion: idl.metadata?.version ?? "unknown",
      sourceCommit,
    };
  }

  writeFileSync(join(destDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncIdl();
  console.log(`Synced IDL for: ${PROGRAM_NAMES.join(", ")}`);
}
