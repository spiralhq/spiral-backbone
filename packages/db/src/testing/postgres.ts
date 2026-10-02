import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);

const POSTGRES_IMAGE = "postgres:18";
const PASSWORD = "spiral-test";

export interface PostgresContainer {
  url: string;
  stop: () => Promise<void>;
}

/** Ephemeral Postgres on a random host port, same image as docker-compose.yml. */
export async function startPostgresContainer(): Promise<PostgresContainer> {
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);
  const containerId = stdout.trim();
  const stop = async () => {
    await execFileAsync("docker", ["stop", containerId]);
  };
  try {
    const { stdout: portOutput } = await execFileAsync("docker", ["port", containerId, "5432/tcp"]);
    const port = portOutput.trim().split("\n")[0]?.split(":").at(-1);
    if (!port) {
      throw new Error(`could not resolve published port from: ${portOutput}`);
    }
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
    await waitUntilReady(url);
    return { url, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

async function waitUntilReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch {
      // The image's init phase only listens on a unix socket; TCP succeeds once it's really up.
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`postgres at ${url} did not become ready within ${timeoutMs}ms`);
}
