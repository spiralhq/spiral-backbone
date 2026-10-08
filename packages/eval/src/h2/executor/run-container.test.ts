import { describe, expect, it, vi } from "vitest";
import { dockerArgs, executorTimeoutMs, faultDetail, runExecutorContainer } from "./run-container";
import type { AttemptPayload } from "./attempt";
import { topologyFixture } from "../testing/fixtures";

const calls = vi.hoisted(
  () => [] as { file: string; args: string[]; env: Record<string, string> }[],
);
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async (file: string, args: string[], options: { env: never }) => {
      calls.push({ file, args, env: options.env });
      return { stdout: "{}\n", stderr: "" };
    },
  });
  return { execFile };
});

describe("the executor container invocation", () => {
  const executor = topologyFixture([{ name: "a", peer_id: "PeerA" }]).executor;

  it("names SPIRAL_ATTEMPT in the docker arguments without a value", () => {
    const args = dockerArgs(executor, "n");
    expect(args.slice(-3)).toEqual(["-e", "SPIRAL_ATTEMPT", "img"]);
  });

  it("hands the payload, with the RPC URL, to docker through its environment only", async () => {
    const rpc = "https://rpc.example.invalid/secret-api-key";
    const payload = { rpc_url: rpc, attempt_id: "main/pd-901/direct/r0", timeout_ms: 1 };
    await runExecutorContainer(payload as unknown as AttemptPayload, executor).catch(() => {});
    const run = calls.find((c) => c.args[0] === "run")!;
    expect(run.args.join(" ")).not.toContain("secret-api-key");
    expect(JSON.parse(run.env["SPIRAL_ATTEMPT"]!)).toEqual(payload);
  });
});

describe("executorTimeoutMs", () => {
  it("adds the daemon start, the registry worst case and provenance to the attempt timeout", () => {
    expect(executorTimeoutMs(0)).toBe(60_000 + (4 * 30_000 + 7_000) + 60_000);
    expect(executorTimeoutMs(120_000)).toBe(120_000 + 247_000);
  });
});

describe("faultDetail", () => {
  it("uses stderr when there is any", () => {
    expect(
      faultDetail(Object.assign(new Error("Command failed"), { stderr: "boom", code: 2 })),
    ).toBe("boom");
  });

  it("reports killed, signal and code when stderr is empty, without the command line", () => {
    const error = Object.assign(
      new Error("Command failed: docker run -e SPIRAL_ATTEMPT={secret}"),
      {
        stderr: "",
        killed: true,
        signal: "SIGTERM",
        code: null,
      },
    );
    const detail = faultDetail(error);
    expect(detail).toContain("killed=true");
    expect(detail).toContain("signal=SIGTERM");
    expect(detail).toContain("code=null");
    expect(detail).not.toContain("secret");
  });

  it("names the budget when the container was killed by the executor timeout", () => {
    const error = Object.assign(new Error("Command failed: docker run {secret}"), {
      stderr: "partial daemon log",
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    const detail = faultDetail(error, 367_000);
    expect(detail).toBe("executor timed out after 367 s");
    expect(detail).not.toContain("secret");
  });
});
