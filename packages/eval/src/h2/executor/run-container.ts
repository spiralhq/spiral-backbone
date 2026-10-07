import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Topology } from "../topology";
import {
  EXECUTOR_EXIT,
  executorOutputSchema,
  type AttemptPayload,
  type ExecutorOutput,
} from "./attempt";

const execFileAsync = promisify(execFile);

export class ExecutorFault extends Error {}
export class ExecutorRefused extends Error {}

export function faultDetail(error: unknown): string {
  const failed = error as { code?: unknown; stderr?: string; killed?: boolean; signal?: unknown };
  if (failed.stderr) return failed.stderr.slice(-500);
  if (failed.stderr === undefined) return (error as Error).message.slice(-500);
  return `no stderr (killed=${failed.killed}, signal=${failed.signal}, code=${failed.code})`;
}

export function dockerArgs(
  payload: AttemptPayload,
  executor: Topology["executor"],
  name?: string,
): string[] {
  const args = ["run", "--rm"];
  if (name) args.push("--name", name);
  if (executor.docker_network) args.push("--network", executor.docker_network);
  for (const host of executor.add_hosts) args.push("--add-host", host);
  if (executor.swarm_key_path) {
    args.push(
      "-v",
      `${executor.swarm_key_path}:/run/spiral/swarm.key:ro`,
      "-e",
      "LIBP2P_FORCE_PNET=1",
      "-e",
      "SPIRAL_SWARM_KEY=/run/spiral/swarm.key",
    );
  }
  if (executor.block_cidrs.length > 0) {
    args.push(
      "--cap-add",
      "NET_ADMIN",
      "-e",
      `SPIRAL_BLOCK_CIDRS=${executor.block_cidrs.join(" ")}`,
    );
  }
  args.push(
    "-v",
    `${executor.repo_root}:/app:ro`,
    "-e",
    `SPIRAL_ATTEMPT=${JSON.stringify(payload)}`,
    executor.image,
  );
  return args;
}

export async function runExecutorContainer(
  payload: AttemptPayload,
  executor: Topology["executor"],
  graceMs = 120_000,
): Promise<ExecutorOutput> {
  const name = `spiral-h2-exec-${randomBytes(6).toString("hex")}`;
  try {
    const { stdout } = await execFileAsync("docker", dockerArgs(payload, executor, name), {
      timeout: payload.timeout_ms + graceMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = stdout.trim().split("\n");
    if (lines.length !== 1) throw new Error(`expected one output line, got ${lines.length}`);
    return executorOutputSchema.parse(JSON.parse(lines[0] ?? ""));
  } catch (error) {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
    const detail = faultDetail(error);
    if ((error as { code?: unknown }).code === EXECUTOR_EXIT.refused)
      throw new ExecutorRefused(`${payload.attempt_id}: ${detail}`);
    throw new ExecutorFault(`executor for ${payload.attempt_id} failed: ${detail}`);
  }
}
