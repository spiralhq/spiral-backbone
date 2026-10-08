import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RunLockHeld extends Error {}

export const lockPath = (outPath: string) => `${outPath}.lock`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): { pid: number; at: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    return Number.isInteger(value.pid) && (value.pid as number) > 0
      ? { pid: value.pid as number, at: String(value.at) }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return null;
  }
}

export function acquireRunLock(
  outPath: string,
  log: (message: string) => void,
): { release(): void } {
  const path = lockPath(outPath);
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let tries = 0; ; tries++) {
    try {
      writeFileSync(path, content, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 3) throw error;
    }
    let holder: { pid: number; at: string } | null;
    try {
      holder = readHolder(path);
    } catch {
      continue;
    }
    if (holder === null) {
      throw new Error(`${path} cannot be read; if no eval:h2 run is running, remove it`);
    }
    if (holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new RunLockHeld(
        `${path} is held by running PID ${holder.pid} since ${holder.at}; another eval:h2 run holds it`,
      );
    }
    log(
      `taking over ${path} from PID ${holder.pid} (no longer running, locked since ${holder.at})`,
    );
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    release: () => {
      try {
        if (readHolder(path)?.pid === process.pid) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
