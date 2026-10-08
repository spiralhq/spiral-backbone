import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function runSsh(target: SshTarget, remoteCommand: string): Promise<string> {
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
  const { stdout } = await execFileAsync(
    "ssh",
    [
      ...options,
      "-p",
      String(target.port),
      "-i",
      target.identityFile,
      `${target.user}@${target.host}`,
      remoteCommand,
    ],
    { timeout: SSH_TIMEOUT_MS },
  );
  return stdout.trim();
}

export async function assertSshReachable(target: SshTarget): Promise<void> {
  try {
    await runSsh(target, "true");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SSH to ${target.host}:${target.port} failed: ${message}`);
  }
}

export async function remoteKuboVersion(target: SshTarget): Promise<string> {
  return runSsh(target, "ipfs version --number");
}

export async function startService(target: SshTarget, serviceName = "ipfs"): Promise<void> {
  await runSsh(target, `sudo systemctl start ${serviceName}`);
}

export async function shutdownService(target: SshTarget, serviceName = "ipfs"): Promise<void> {
  await runSsh(target, `sudo systemctl stop ${serviceName}`);
}

export async function checkSystemdActive(
  target: SshTarget,
  serviceName = "ipfs",
): Promise<boolean> {
  try {
    const output = await runSsh(target, `systemctl is-active ${serviceName}`);
    return output === "active";
  } catch {
    // `systemctl is-active` exits non-zero for inactive/failed/unknown — all
    // of those mean "not active", so a thrown/non-zero exec is a clean `false`.
    return false;
  }
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
