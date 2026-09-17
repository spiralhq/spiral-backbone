import { describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

const execFileMock = vi.fn((_cmd: string, args: readonly string[], callback: ExecFileCallback) => {
  if (args[0] === "run") {
    callback(null, { stdout: "fake-container-id\n", stderr: "" });
    return;
  }
  if (args[0] === "port") {
    callback(new Error("docker port failed: no such container"));
    return;
  }
  if (args[0] === "stop") {
    callback(null, { stdout: "", stderr: "" });
    return;
  }
  callback(new Error(`unexpected docker subcommand: ${args[0]}`));
});

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => (execFileMock as unknown as (...a: unknown[]) => void)(...args),
}));

describe("startKuboContainer startup failure", () => {
  it("stops the already-started container when port resolution fails, instead of leaking it", async () => {
    const { startKuboContainer } = await import("./kubo-node");

    await expect(startKuboContainer()).rejects.toThrow("docker port failed: no such container");

    const stopCall = execFileMock.mock.calls.find(([, args]) => args[0] === "stop");
    expect(stopCall).toBeDefined();
    expect(stopCall?.[1]).toEqual(["stop", "fake-container-id"]);
  });
});
