import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { remoteKuboVersion, type SshTarget } from "../../../../scripts/kubo-node-control";
import { assertNetworkNodeAlive, pingPeer } from "../h2/probes";
import { sshReplicaController, type ReplicaController } from "../h2/state";
import { sshTargetOf, type Topology } from "../h2/topology";
import type { Check } from "./checks";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

export const EXPECTED_KUBO = "0.43.1";

export interface ReplicaCheckDeps {
  controller: ReplicaController;
  kuboVersion: (target: SshTarget) => Promise<string>;
}

export function replicaChecks(
  topology: Topology,
  opts: { pingTimeoutMs: number; expectedKubo?: string },
  deps: Partial<ReplicaCheckDeps> = {},
): Check[] {
  const expectedKubo = opts.expectedKubo ?? EXPECTED_KUBO;
  const controller =
    deps.controller ?? sshReplicaController(topology, { pingTimeoutMs: opts.pingTimeoutMs });
  const kuboVersion = deps.kuboVersion ?? remoteKuboVersion;
  return topology.replicas.map((replica) => ({
    stage: "infra",
    name: `replica ${replica.name}`,
    run: async () => {
      const seen = await controller.observe(replica.name);
      if (!seen.systemd_active) throw new Error(`${replica.name}: ipfs service not active`);
      if (!seen.swarm_reachable) throw new Error(`${replica.name}: swarm port unreachable`);
      const version = await kuboVersion(sshTargetOf(replica));
      if (version !== expectedKubo) {
        throw new Error(`${replica.name}: Kubo ${version}, expected ${expectedKubo}`);
      }
      return `active, swarm reachable, Kubo ${version}`;
    },
  }));
}

export interface NetworkNodeDeps {
  alive: (apiUrl: string, timeoutMs: number) => Promise<void>;
  ping: (apiUrl: string, peerId: string, timeoutMs: number) => Promise<boolean>;
}

export function networkNodeCheck(
  topology: Topology,
  pingTimeoutMs: number,
  deps: Partial<NetworkNodeDeps> = {},
): Check {
  const alive = deps.alive ?? assertNetworkNodeAlive;
  const ping = deps.ping ?? pingPeer;
  const api = topology.network_node.api_url;
  return {
    stage: "infra",
    name: "network node",
    run: async () => {
      await alive(api, pingTimeoutMs);
      const peers = topology.replicas.map((r) => r.peer_id);
      const answers = await Promise.all(peers.map((peer) => ping(api, peer, pingTimeoutMs)));
      const silent = peers.filter((_, i) => !answers[i]);
      if (silent.length > 0) throw new Error(`no ping answer from ${silent.join(", ")}`);
      return `API alive, ${peers.length} of ${peers.length} replicas answer ping`;
    },
  };
}

const IDENTITY_PATH = "/ipfs/bafkqaaa";

export function gatewayCheck(gatewayUrl: string, timeoutMs: number): Check {
  return {
    stage: "infra",
    name: "gateway",
    run: async () => {
      const url = new URL(gatewayUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}${IDENTITY_PATH}`;
      let status: number;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        status = response.status;
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new Error(`gateway did not answer GET ${IDENTITY_PATH} within ${timeoutMs} ms`);
        }
        const name = error instanceof Error ? error.name : "error";
        throw new Error(`gateway GET ${IDENTITY_PATH} failed (${name})`);
      }
      if (status !== 200) throw new Error(`gateway GET ${IDENTITY_PATH} returned ${status}`);
      return `GET ${IDENTITY_PATH} → 200`;
    },
  };
}

async function dockerCli(args: string[]): Promise<void> {
  await execFileAsync("docker", args);
}

export function executorImageCheck(
  image: string,
  docker: (args: string[]) => Promise<void> = dockerCli,
): Check {
  return {
    stage: "infra",
    name: "executor image",
    run: async () => {
      try {
        await docker(["image", "inspect", image]);
      } catch {
        throw new Error(`executor image ${image} not found (docker image inspect failed)`);
      }
      return `${image} present`;
    },
  };
}

export function vitestSummary(output: string): string {
  // oxlint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const line = plain.split("\n").find((l) => /^\s*Tests\s+\d/.test(l));
  return line?.trim() ?? "no vitest summary line";
}

function runConformance(): Promise<{ code: number; summary: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["vitest", "run", "--root", "packages/eval", "src/conformance.test.ts"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, SPIRAL_E2E: "required" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, summary: vitestSummary(output) }));
  });
}

export function conformanceCheck(
  run: () => Promise<{ code: number; summary: string }> = runConformance,
): Check {
  return {
    stage: "infra",
    name: "chunking conformance",
    run: async () => {
      const { code, summary } = await run();
      if (code !== 0) throw new Error(`conformance exited ${code}: ${summary}`);
      const counts = /\b(\d+) passed \((\d+)\)$/.exec(summary);
      const allPassed =
        counts !== null &&
        counts[1] === counts[2] &&
        Number(counts[1]) > 0 &&
        !/skipped|todo/.test(summary);
      if (!allPassed) throw new Error(`conformance did not pass every test: ${summary}`);
      return summary;
    },
  };
}
