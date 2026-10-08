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
import { DAEMON_READY_TIMEOUT_MS, PROVENANCE_TIMEOUT_MS } from "./local-node";
import { REGISTRY_WORST_CASE_MS } from "./registry";

const execFileAsync = promisify(execFile);

export class ExecutorFault extends Error {}
export class ExecutorRefused extends Error {}

export function executorTimeoutMs(attemptTimeoutMs: number): number {
  return (
    attemptTimeoutMs + DAEMON_READY_TIMEOUT_MS + REGISTRY_WORST_CASE_MS + PROVENANCE_TIMEOUT_MS
  );
}

export function faultDetail(error: unknown, timeoutMs?: number): string {
  const failed = error as { code?: unknown; stderr?: string; killed?: boolean; signal?: unknown };
  if (timeoutMs !== undefined && failed.killed === true && failed.code == null) {
    return `executor timed out after ${timeoutMs / 1000} s`;
  }
  if (failed.stderr) return failed.stderr.slice(-500);
  if (failed.stderr === undefined) return (error as Error).message.slice(-500);
  return `no stderr (killed=${failed.killed}, signal=${failed.signal}, code=${failed.code})`;
}

export function dockerArgs(executor: Topology["executor"], name?: string): string[] {
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
  args.push("-v", `${executor.repo_root}:/app:ro`, "-e", "SPIRAL_ATTEMPT", executor.image);
  return args;
}

export async function runExecutorContainer(
  payload: AttemptPayload,
  executor: Topology["executor"],
): Promise<ExecutorOutput> {
  const name = `spiral-h2-exec-${randomBytes(6).toString("hex")}`;
  const timeoutMs = executorTimeoutMs(payload.timeout_ms);
  try {
    const { stdout } = await execFileAsync("docker", dockerArgs(executor, name), {
      env: { ...process.env, SPIRAL_ATTEMPT: JSON.stringify(payload) },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = stdout.trim().split("\n");
    if (lines.length !== 1) throw new Error(`expected one output line, got ${lines.length}`);
    return executorOutputSchema.parse(JSON.parse(lines[0] ?? ""));
  } catch (error) {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
    const detail = faultDetail(error, timeoutMs);
    if ((error as { code?: unknown }).code === EXECUTOR_EXIT.refused)
      throw new ExecutorRefused(`${payload.attempt_id}: ${detail}`);
    throw new ExecutorFault(`executor for ${payload.attempt_id} failed: ${detail}`);
  }
}
