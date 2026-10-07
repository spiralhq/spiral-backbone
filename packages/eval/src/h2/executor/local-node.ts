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
const ipfs = (args: string[]) => execFileAsync("ipfs", args, { maxBuffer: 16 * 1024 * 1024 });
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

export async function startDaemon(readyTimeoutMs = 60_000): Promise<{ stop(): Promise<void> }> {
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
): Promise<Provenance> {
  const stat = parseBitswapStat(
    (await ipfs(["bitswap", "stat", "--verbose", "--enc=json"])).stdout,
  );
  const swarm = parseSwarmPeers((await ipfs(["swarm", "peers"])).stdout);
  const rows: PeerBytes[] = [];
  for (const peer of new Set([...swarm, ...stat.peers])) {
    const ledger = await ipfs(["bitswap", "ledger", peer]);
    rows.push({
      peer_id: peer,
      bytes_received: parseLedgerBytesReceived(ledger.stdout),
      declared: declared.has(peer),
    });
  }
  const dagSize = retrievedCid
    ? parseDagStatSize(
        (await ipfs(["dag", "stat", "--offline", "--progress=false", "--enc=json", retrievedCid]))
          .stdout,
      )
    : null;
  return summarizeProvenance(rows, stat, dagSize);
}
