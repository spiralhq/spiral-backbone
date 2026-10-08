import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock, lockPath, RunLockHeld } from "./run-lock";

const outPath = () => join(mkdtempSync(join(tmpdir(), "h2-lock-")), "results", "h2.ndjson");

function liveProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  return { pid: child.pid!, stop: () => child.kill("SIGKILL") };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

describe("acquireRunLock", () => {
  it("creates <out>.lock with the PID and a timestamp, and removes it on release", () => {
    const out = outPath();
    const lock = acquireRunLock(out, () => {});
    expect(lockPath(out)).toBe(`${out}.lock`);
    const content = JSON.parse(readFileSync(lockPath(out), "utf8"));
    expect(content.pid).toBe(process.pid);
    expect(new Date(content.at).toISOString()).toBe(content.at);
    lock.release();
    expect(existsSync(lockPath(out))).toBe(false);
  });

  it("refuses a lock held by another live process and leaves it in place", () => {
    const out = outPath();
    const other = liveProcess();
    try {
      acquireRunLock(out, () => {}).release();
      const holder = JSON.stringify({ pid: other.pid, at: "2026-10-08T09:00:00.000Z" });
      writeFileSync(lockPath(out), holder);
      expect(() => acquireRunLock(out, () => {})).toThrow(RunLockHeld);
      expect(() => acquireRunLock(out, () => {})).toThrow(
        new RegExp(
          `${out}\\.lock is held by running PID ${other.pid} since 2026-10-08T09:00:00\\.000Z; another eval:h2 run`,
        ),
      );
      expect(readFileSync(lockPath(out), "utf8")).toBe(holder);
    } finally {
      other.stop();
    }
  });

  it("treats a lock carrying this process's own PID as stale", () => {
    const out = outPath();
    acquireRunLock(out, () => {}).release();
    writeFileSync(lockPath(out), JSON.stringify({ pid: process.pid, at: "earlier" }));
    const logs: string[] = [];
    const lock = acquireRunLock(out, (m) => logs.push(m));
    expect(logs).toEqual([
      `taking over ${out}.lock from PID ${process.pid} (no longer running, locked since earlier)`,
    ]);
    lock.release();
    expect(existsSync(lockPath(out))).toBe(false);
  });

  it("takes over a lock left by a dead process and logs it", async () => {
    const out = outPath();
    const first = acquireRunLock(out, () => {});
    first.release();
    const pid = await deadPid();
    writeFileSync(lockPath(out), JSON.stringify({ pid, at: "2026-10-08T09:00:00.000Z" }));
    const logs: string[] = [];
    const lock = acquireRunLock(out, (m) => logs.push(m));
    expect(logs).toEqual([
      `taking over ${out}.lock from PID ${pid} (no longer running, locked since 2026-10-08T09:00:00.000Z)`,
    ]);
    expect(JSON.parse(readFileSync(lockPath(out), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("refuses an unreadable lock instead of guessing", () => {
    const out = outPath();
    acquireRunLock(out, () => {}).release();
    writeFileSync(lockPath(out), "garbage");
    expect(() => acquireRunLock(out, () => {})).toThrow(/cannot be read.*remove it/);
  });

  it("does not remove a lock another process took over", () => {
    const out = outPath();
    const lock = acquireRunLock(out, () => {});
    writeFileSync(lockPath(out), JSON.stringify({ pid: process.pid + 1, at: "t" }));
    lock.release();
    expect(existsSync(lockPath(out))).toBe(true);
  });
});
