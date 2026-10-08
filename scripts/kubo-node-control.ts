import { execFile } from "node:child_process";
import { createConnection } from "node:net";

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  identityFile: string;
  /** Skips host-key verification. Only for ephemeral/throwaway hosts — real nodes must not opt in. */
  insecureHostKeyChecking?: boolean;
}

export interface NodeStatus {
  systemdActive: boolean;
  swarmReachable: boolean;
}

// Bounds a hung SSH session after the TCP/banner phase, which ConnectTimeout doesn't cover.
const SSH_TIMEOUT_MS = 15_000;

export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

export async function withRetry<T>(
  fn: () => Promise<T>,
  isTransient: (error: unknown) => boolean = () => true,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** SSH could not reach the host for a reason that may pass: a timeout, a kill or a connection-level failure. */
export class SshProbeFault extends Error {}

/** SSH failed for a reason that retrying will not fix: auth, host key, name resolution, no ssh binary. */
export class SshFault extends Error {}

const CONNECTION_FAILURE =
  /Connection refused|Connection timed out|Operation timed out|Connection reset|No route to host|Connection closed|kex_exchange_identification/;

const PERMANENT_FAILURES: [RegExp, string][] = [
  [
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/,
    "host key verification failed",
  ],
  [/Permission denied|Too many authentication failures/, "authentication failed"],
  [/Could not resolve hostname/, "cannot resolve the host name"],
];

// OpenSSH warnings that quote the local identity file path.
const PATH_BEARING_LINE =
  /^(Warning: Identity file .*|no such identity: .*|Load key .*|Permissions .* are too open\.|This private key will be ignored\.|@+|@\s*WARNING: UNPROTECTED PRIVATE KEY FILE!\s*@)$/;

export function stderrTail(stderr: string, identityFile?: string): string {
  let kept = stderr
    .split("\n")
    .filter((line) => !PATH_BEARING_LINE.test(line.trim()))
    .join("\n")
    .trim();
  if (identityFile) kept = kept.replaceAll(identityFile, "<identity file>");
  return kept.slice(-300);
}

export function sshFailure(
  target: Pick<SshTarget, "host" | "port"> & Partial<Pick<SshTarget, "identityFile">>,
  failed: { code?: unknown; killed?: boolean; signal?: unknown },
  stderr: string,
): SshProbeFault | SshFault {
  const where = `${target.host}:${target.port}`;
  const tail = stderrTail(stderr, target.identityFile);
  if (failed.killed || failed.signal) {
    return new SshProbeFault(
      `probe fault: SSH to ${where} timed out or was killed (signal ${String(failed.signal)})`,
    );
  }
  if (typeof failed.code !== "number") {
    return new SshFault(
      `ssh could not run for ${where} (${String(failed.code ?? "unknown error")})`,
    );
  }
  const permanent = PERMANENT_FAILURES.find(([pattern]) => pattern.test(stderr));
  if (permanent) return new SshFault(`SSH to ${where}: ${permanent[1]}: ${tail}`);
  if (CONNECTION_FAILURE.test(stderr)) {
    return new SshProbeFault(`probe fault: SSH to ${where} could not connect: ${tail}`);
  }
  return new SshFault(`SSH to ${where} exited 255: ${tail}`);
}

interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execSsh(target: SshTarget, remoteCommand: string): Promise<SshResult> {
  const options = [
    // BatchMode=yes: fail immediately on rejected key auth instead of hanging on a password prompt.
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
  ];
  if (target.insecureHostKeyChecking) {
    options.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  const args = [
    ...options,
    "-p",
    String(target.port),
    "-i",
    target.identityFile,
    `${target.user}@${target.host}`,
    remoteCommand,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: SSH_TIMEOUT_MS }, (error, stdout, stderr) => {
      const out = String(stdout).trim();
      const err = String(stderr).trim();
      if (!error) return resolve({ code: 0, stdout: out, stderr: err });
      const failed = error as { code?: unknown; killed?: boolean; signal?: unknown };
      if (typeof failed.code === "number" && failed.code !== 255 && !failed.killed) {
        return resolve({ code: failed.code, stdout: out, stderr: err });
      }
      reject(sshFailure(target, failed, err));
    });
  });
}

const isProbeFault = (error: unknown) => error instanceof SshProbeFault;

async function runSsh(target: SshTarget, remoteCommand: string): Promise<string> {
  const result = await execSsh(target, remoteCommand);
  if (result.code !== 0) {
    throw new Error(
      `\`${remoteCommand}\` on ${target.host}:${target.port} exited ${result.code}: ${stderrTail(result.stderr, target.identityFile)}`,
    );
  }
  return result.stdout;
}

export async function assertSshReachable(target: SshTarget): Promise<void> {
  try {
    await withRetry(() => runSsh(target, "true"), isProbeFault);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SSH to ${target.host}:${target.port} failed: ${message}`, { cause: error });
  }
}

const PINS_COMMAND = "ipfs --api /ip4/127.0.0.1/tcp/5001 pin ls --type=recursive --quiet";

export async function remoteRecursivePins(target: SshTarget): Promise<string[]> {
  const out = await withRetry(() => runSsh(target, PINS_COMMAND), isProbeFault);
  return out.split("\n").filter((line) => line.length > 0);
}

export async function remoteKuboVersion(target: SshTarget): Promise<string> {
  return runSsh(target, "ipfs version --number");
}

// --no-block queues the job and returns, so a slow Kubo shutdown never hits the SSH timeout;
// the state check observes the outcome.
export async function startService(target: SshTarget, serviceName = "ipfs"): Promise<void> {
  await withRetry(
    () => runSsh(target, `sudo systemctl --no-block start ${serviceName}`),
    isProbeFault,
  );
}

export async function shutdownService(target: SshTarget, serviceName = "ipfs"): Promise<void> {
  await withRetry(
    () => runSsh(target, `sudo systemctl --no-block stop ${serviceName}`),
    isProbeFault,
  );
}

export const SYSTEMCTL_PATH = "/usr/bin/systemctl";

/** The two commands the replica sudoers must permit without a password. */
export function serviceControlCommands(serviceName = "ipfs"): string[] {
  return ["start", "stop"].map((verb) => `${SYSTEMCTL_PATH} --no-block ${verb} ${serviceName}`);
}

/**
 * Returns the service-control commands that `sudo -n -l` says the SSH user may not run.
 * A pre-flight check, so an SSH fault throws without retries and the operator reruns it.
 */
export async function remoteSudoRefusals(
  target: SshTarget,
  serviceName = "ipfs",
): Promise<string[]> {
  const refused: string[] = [];
  for (const command of serviceControlCommands(serviceName)) {
    const result = await execSsh(target, `sudo -n -l ${command}`);
    if (result.code !== 0) refused.push(command);
  }
  return refused;
}

// `systemctl is-active` exits 3 for every not-active state (inactive, failed, activating,
// deactivating); any other answer is not a statement that the unit is off.
const INACTIVE_EXIT = 3;

export async function checkSystemdActive(
  target: SshTarget,
  serviceName = "ipfs",
): Promise<boolean> {
  return withRetry(async () => {
    const result = await execSsh(target, `systemctl is-active ${serviceName}`);
    if (result.code === 0 && result.stdout === "active") return true;
    if (result.code === INACTIVE_EXIT || ["inactive", "failed"].includes(result.stdout)) {
      return false;
    }
    throw new Error(
      `probe fault: \`systemctl is-active ${serviceName}\` on ${target.host}:${target.port} answered exit ${result.code}: ${result.stdout ? result.stdout.slice(-300) : stderrTail(result.stderr, target.identityFile)}`,
    );
  }, isProbeFault);
}

// A bare TCP `connect` isn't proof a real service is listening — Docker's published-port
// proxy (and similar NAT/forwarding layers) can complete the handshake then drop it moments
// later. This grace window waits for that early close before trusting "reachable".
const REACHABILITY_GRACE_MS = 300;

export function checkSwarmReachable(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const graceTimer = setTimeout(() => finish(true), REACHABILITY_GRACE_MS);
      socket.once("close", () => {
        clearTimeout(graceTimer);
        finish(false);
      });
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function checkStatus(
  target: SshTarget,
  swarmPort: number,
  serviceName = "ipfs",
): Promise<NodeStatus> {
  const [systemdActive, swarmReachable] = await Promise.all([
    checkSystemdActive(target, serviceName),
    checkSwarmReachable(target.host, swarmPort),
  ]);
  return { systemdActive, swarmReachable };
}
