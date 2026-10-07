import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopProcess } from "./local-node";

describe("stopProcess", () => {
  it("resolves at once when the process has already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    await expect(stopProcess(child)).resolves.toBeUndefined();
  }, 5_000);

  it("terminates a running process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await stopProcess(child);
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  }, 5_000);
});
