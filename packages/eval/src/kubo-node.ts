import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KUBO_IMAGE = "ipfs/kubo:v0.43.1";
const RPC_PORT = 5001;

export interface KuboContainer {
  apiUrl: string;
  stop: () => Promise<void>;
}

/** Starts an ephemeral, offline-mode Kubo container on a random host port. */
export async function startKuboContainer(): Promise<KuboContainer> {
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    `127.0.0.1::${RPC_PORT}`,
    KUBO_IMAGE,
    "daemon",
    "--offline",
    "--migrate=true",
    "--agent-version-suffix=docker",
  ]);
  const containerId = stdout.trim();
  try {
    const apiUrl = `http://127.0.0.1:${await resolveHostPort(containerId)}`;
    await waitUntilReady(apiUrl);
    return {
      apiUrl,
      stop: async () => {
        await execFileAsync("docker", ["stop", containerId]);
      },
    };
  } catch (error) {
    await execFileAsync("docker", ["stop", containerId]).catch(() => {
      // Best-effort cleanup: if this also fails, the original error below
      // is what the caller needs to see.
    });
    throw error;
  }
}

async function resolveHostPort(containerId: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["port", containerId, `${RPC_PORT}/tcp`]);
  const port = stdout.trim().split(":").at(-1);
  if (!port) {
    throw new Error(`could not resolve published port from: ${stdout}`);
  }
  return port;
}

async function waitUntilReady(apiUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/api/v0/version`, { method: "POST" });
      if (response.ok) return;
    } catch {
      // Not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`kubo API at ${apiUrl} did not become ready within ${timeoutMs}ms`);
}
