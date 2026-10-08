import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { promisify } from "node:util";
import {
  parseBitswapStat,
  parseDagStatSize,
  parseLedgerBytesReceived,
  parseSwarmPeers,
  type PeerBytes,
  summarizeProvenance,
  type Provenance,
} from "./provenance";

const execFileAsync = promisify(execFile);
const ipfs = (args: string[], timeout = 0) =>
  execFileAsync("ipfs", args, { maxBuffer: 16 * 1024 * 1024, timeout });
const repo = () => process.env["IPFS_PATH"] ?? "/tmp/ipfs-repo";

export async function initFreshNode(opts: {
  bootstrapMultiaddr: string | null;
  privateNetwork: boolean;
  swarmKeyPath: string | null;
}): Promise<void> {
  await ipfs(["init", "--algorithm", "ed25519"]);
  if (opts.privateNetwork) {
    if (!opts.swarmKeyPath) throw new Error("private network requested without a swarm key");
    await copyFile(opts.swarmKeyPath, `${repo()}/swarm.key`);
    await ipfs(["config", "--json", "AutoConf.Enabled", "false"]);
    await ipfs(["config", "--json", "AutoTLS.Enabled", "false"]);
    await ipfs(["config", "--json", "Swarm.AddrFilters", "[]"]);
  }
  if (opts.bootstrapMultiaddr) {
    await ipfs(["bootstrap", "rm", "--all"]);
    await ipfs(["bootstrap", "add", opts.bootstrapMultiaddr]);
  }
  await ipfs(["config", "--json", "Routing", '{"Type":"dhtclient"}']);
  await ipfs(["config", "--json", "Provide.Enabled", "false"]);
  await ipfs(["config", "--json", "HTTPRetrieval.Enabled", "false"]);
  await ipfs(["config", "--json", "Discovery.MDNS.Enabled", "false"]);
}

export const DAEMON_READY_TIMEOUT_MS = 60_000;
export const PROVENANCE_TIMEOUT_MS = 60_000;

export async function startDaemon(
  readyTimeoutMs = DAEMON_READY_TIMEOUT_MS,
): Promise<{ stop(): Promise<void> }> {
  const daemon = spawn("ipfs", ["daemon"], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ipfs daemon did not become ready")),
      readyTimeoutMs,
    );
    daemon.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Daemon is ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    daemon.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ipfs daemon exited with ${code}`));
    });
  });
  return { stop: () => stopProcess(daemon) };
}

export function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

export async function catToFile(
  cid: string,
  dest: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; timedOut: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("ipfs", ["cat", cid], { stdio: ["ignore", "pipe", "pipe"] });
    const out = createWriteStream(dest);
    child.stdout.pipe(out);
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() =>
        resolve(
          code === 0 && !timedOut
            ? { ok: true }
            : { ok: false, timedOut, stderr: stderr.slice(0, 500) },
        ),
      );
    });
  });
}

export async function provenance(
  declared: Set<string>,
  retrievedCid: string | null,
  budgetMs = PROVENANCE_TIMEOUT_MS,
): Promise<Provenance> {
  const deadline = Date.now() + budgetMs;
  const read = async (args: string[]) => {
    const remaining = deadline - Date.now();
    try {
      if (remaining <= 0) throw new Error("no time left");
      return (await ipfs(args, remaining)).stdout;
    } catch (error) {
      if (remaining <= 0 || (error as { killed?: boolean }).killed) {
        throw new Error(`provenance exceeded its ${budgetMs / 1000} s budget at ipfs ${args[0]}`);
      }
      throw error;
    }
  };
  const stat = parseBitswapStat(await read(["bitswap", "stat", "--verbose", "--enc=json"]));
  const swarm = parseSwarmPeers(await read(["swarm", "peers"]));
  const rows: PeerBytes[] = [];
  for (const peer of new Set([...swarm, ...stat.peers])) {
    rows.push({
      peer_id: peer,
      bytes_received: parseLedgerBytesReceived(await read(["bitswap", "ledger", peer])),
      declared: declared.has(peer),
    });
  }
  const dagSize = retrievedCid
    ? parseDagStatSize(
        await read(["dag", "stat", "--offline", "--progress=false", "--enc=json", retrievedCid]),
      )
    : null;
  return summarizeProvenance(rows, stat, dagSize);
}
