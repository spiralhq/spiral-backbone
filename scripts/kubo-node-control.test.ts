import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkStatus,
  shutdownService,
  startService,
  type NodeStatus,
  type SshTarget,
} from "./kubo-node-control";

const execFileAsync = promisify(execFile);
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/kubo-node-control-test", import.meta.url));
const IMAGE_TAG = "spiral-kubo-node-control-test";

describe("kubo-node-control (SSH end-to-end via Docker)", () => {
  let buildDir: string;
  let containerId: string;
  let target: SshTarget;
  let swarmPort: number;

  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), "kubo-control-build-"));
    copyFileSync(join(FIXTURE_DIR, "Dockerfile"), join(buildDir, "Dockerfile"));
    copyFileSync(join(FIXTURE_DIR, "stand-in.service"), join(buildDir, "stand-in.service"));

    const keyPath = join(buildDir, "id_ed25519");
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    copyFileSync(`${keyPath}.pub`, join(buildDir, "authorized_keys"));

    await execFileAsync("docker", ["build", "-t", IMAGE_TAG, buildDir]);

    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      "--privileged",
      "--cgroupns=host",
      "-v",
      "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "-p",
      "127.0.0.1::22",
      "-p",
      "127.0.0.1::9000",
      IMAGE_TAG,
    ]);
    containerId = stdout.trim();

    const sshPort = Number(await resolvePublishedPort(containerId, 22));
    swarmPort = Number(await resolvePublishedPort(containerId, 9000));
    target = {
      host: "127.0.0.1",
      port: sshPort,
      user: "spiral",
      identityFile: keyPath,
      insecureHostKeyChecking: true, // ephemeral container, freshly-generated key, no stable identity to pin
    };

    await waitForSsh(target);
  }, 120_000);

  afterAll(async () => {
    if (containerId) await execFileAsync("docker", ["rm", "-f", containerId]);
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  it("reports the stand-in service active and the swarm port reachable by default", async () => {
    const status = await checkStatus(target, swarmPort, "stand-in");
    expect(status).toEqual({ systemdActive: true, swarmReachable: true });
  }, 15_000);

  it("shuts the service down and both checks flip to false", async () => {
    await shutdownService(target, "stand-in");
    const status = await checkStatus(target, swarmPort, "stand-in");
    expect(status).toEqual({ systemdActive: false, swarmReachable: false });
  }, 15_000);

  it("starts the service back up and both checks flip to true again", async () => {
    await startService(target, "stand-in");
    // Type=simple gives systemd no readiness signal, so `start` returns before the
    // process is actually listening — poll instead of asserting on an instant.
    const status = await waitForStatus(
      target,
      swarmPort,
      "stand-in",
      (s) => s.systemdActive && s.swarmReachable,
    );
    expect(status).toEqual({ systemdActive: true, swarmReachable: true });
  }, 15_000);
});

async function resolvePublishedPort(containerId: string, containerPort: number): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["port", containerId, `${containerPort}/tcp`]);
  const port = stdout.trim().split(":").at(-1);
  if (!port) throw new Error(`could not resolve published port ${containerPort} from: ${stdout}`);
  return port;
}

async function waitForStatus(
  target: SshTarget,
  swarmPort: number,
  serviceName: string,
  predicate: (status: NodeStatus) => boolean,
  timeoutMs = 10_000,
): Promise<NodeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status: NodeStatus;
  do {
    status = await checkStatus(target, swarmPort, serviceName);
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return status;
}

async function waitForSsh(target: SshTarget, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execFileAsync("ssh", [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=3",
        "-p",
        String(target.port),
        "-i",
        target.identityFile,
        `${target.user}@${target.host}`,
        "true",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(
    `SSH to ${target.host}:${target.port} did not become ready within ${timeoutMs}ms`,
  );
}
