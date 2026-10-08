import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SshTarget } from "../../../../scripts/kubo-node-control";
import { peerIdFromBytes } from "../h2/executor/provenance";
import type { NodeObservation, ReplicaController } from "../h2/state";
import { peerIdBytes, topologyFixture } from "../h2/testing/fixtures";
import {
  conformanceCheck,
  executorImageCheck,
  gatewayCheck,
  networkNodeCheck,
  replicaChecks,
  replicaSudoChecks,
  vitestSummary,
} from "./node-checks";
import { SshFault } from "../../../../scripts/kubo-node-control";

const PEERS = [1, 2, 3].map((n) => peerIdFromBytes(peerIdBytes(n), 38));
const topology = topologyFixture([
  { name: "a", peer_id: PEERS[0]! },
  { name: "b", peer_id: PEERS[1]! },
  { name: "c", peer_id: PEERS[2]! },
]);

async function failure(check: { run(): Promise<string> }): Promise<string> {
  return check.run().then(
    (detail) => `unexpected pass: ${detail}`,
    (e: Error) => e.message,
  );
}

function controller(
  observe: (node: string) => Partial<NodeObservation> | Error,
): ReplicaController {
  return {
    start: async () => {},
    stop: async () => {},
    observe: async (node) => {
      const seen = observe(node);
      if (seen instanceof Error) throw seen;
      return { node, systemd_active: true, swarm_reachable: true, ...seen };
    },
  };
}

describe("replicaChecks", () => {
  const healthy = controller(() => ({}));
  const kubo = (version: string) => async () => version;

  it("returns one infra check per replica, named after it", () => {
    const checks = replicaChecks(topology, { pingTimeoutMs: 1_000 });
    expect(checks.map((c) => [c.stage, c.name])).toEqual([
      ["infra", "replica a"],
      ["infra", "replica b"],
      ["infra", "replica c"],
    ]);
  });

  it("passes for an active, reachable replica on the expected Kubo, defaulting to 0.43.1", async () => {
    const targets: SshTarget[] = [];
    const [a] = replicaChecks(
      topology,
      { pingTimeoutMs: 1_000 },
      {
        controller: healthy,
        kuboVersion: async (t) => {
          targets.push(t);
          return "0.43.1";
        },
      },
    );
    await expect(a!.run()).resolves.toBe("active, swarm reachable, Kubo 0.43.1");
    expect(targets).toEqual([expect.objectContaining({ host: "127.0.0.1", port: 2200 })]);
  });

  it("blocks when the ipfs service is not active", async () => {
    const [, b] = replicaChecks(
      topology,
      { pingTimeoutMs: 1_000 },
      { controller: controller(() => ({ systemd_active: false })), kuboVersion: kubo("0.43.1") },
    );
    expect(await failure(b!)).toBe("b: ipfs service not active");
  });

  it("blocks when the swarm port does not answer", async () => {
    const [, , c] = replicaChecks(
      topology,
      { pingTimeoutMs: 1_000 },
      { controller: controller(() => ({ swarm_reachable: false })), kuboVersion: kubo("0.43.1") },
    );
    expect(await failure(c!)).toBe("c: swarm port unreachable");
  });

  it("blocks on a Kubo version other than the expected one", async () => {
    const [a] = replicaChecks(
      topology,
      { pingTimeoutMs: 1_000, expectedKubo: "0.43.1" },
      { controller: healthy, kuboVersion: kubo("0.40.0") },
    );
    expect(await failure(a!)).toBe("a: Kubo 0.40.0, expected 0.43.1");
  });

  it("blocks when SSH is unreachable", async () => {
    const [a] = replicaChecks(
      topology,
      { pingTimeoutMs: 1_000 },
      {
        controller: controller(() => new Error("SSH to 127.0.0.1:2200 failed: refused")),
        kuboVersion: kubo("0.43.1"),
      },
    );
    expect(await failure(a!)).toMatch(/SSH to 127\.0\.0\.1:2200 failed/);
  });
});

describe("replicaSudoChecks", () => {
  const START = "/usr/bin/systemctl --no-block start ipfs";
  const STOP = "/usr/bin/systemctl --no-block stop ipfs";

  it("returns one infra row per replica, named after it", () => {
    expect(replicaSudoChecks(topology).map((c) => [c.stage, c.name])).toEqual([
      ["infra", "replica a sudo"],
      ["infra", "replica b sudo"],
      ["infra", "replica c sudo"],
    ]);
  });

  it("passes when sudo permits both commands, asking with the topology service", async () => {
    const asked: [string, string][] = [];
    const [a] = replicaSudoChecks(topology, async (target, service) => {
      asked.push([`${target.host}:${target.port}`, service]);
      return [];
    });
    await expect(a!.run()).resolves.toBe("NOPASSWD systemctl --no-block start and stop ipfs");
    expect(asked).toEqual([["127.0.0.1:2200", "ipfs"]]);
  });

  it("blocks naming the missing rule when one command is refused", async () => {
    const [, b] = replicaSudoChecks(topology, async () => [START]);
    expect(await failure(b!)).toBe(`b: sudoers has no NOPASSWD rule for \`${START}\``);
  });

  it("blocks naming both rules when both are refused", async () => {
    const [, , c] = replicaSudoChecks(topology, async () => [START, STOP]);
    expect(await failure(c!)).toBe(
      `c: sudoers has no NOPASSWD rule for \`${START}\` or \`${STOP}\``,
    );
  });

  it("blocks on an SSH fault", async () => {
    const [a] = replicaSudoChecks(topology, async () => {
      throw new SshFault("SSH to 127.0.0.1:2200: authentication failed: ");
    });
    expect(await failure(a!)).toMatch(/authentication failed/);
  });
});

describe("networkNodeCheck", () => {
  const alive = async () => {};

  it("passes when the API is alive and every replica answers a ping", async () => {
    const pinged: string[] = [];
    const check = networkNodeCheck(topology, 500, {
      alive,
      ping: async (_api, peer, timeout) => {
        expect(timeout).toBe(500);
        pinged.push(peer);
        return true;
      },
    });
    expect([check.stage, check.name]).toEqual(["infra", "network node"]);
    await expect(check.run()).resolves.toBe("API alive, 3 of 3 replicas answer ping");
    expect(pinged.sort()).toEqual([...PEERS].sort());
  });

  it("blocks and lists every PeerID that did not answer", async () => {
    const check = networkNodeCheck(topology, 500, {
      alive,
      ping: async (_api, peer) => peer === PEERS[1],
    });
    expect(await failure(check)).toBe(`no ping answer from ${PEERS[0]}, ${PEERS[2]}`);
  });

  it("blocks when the API is not alive, without pinging", async () => {
    let pinged = false;
    const check = networkNodeCheck(topology, 500, {
      alive: async () => {
        throw new Error("network node API unreachable (127.0.0.1:5001): refused");
      },
      ping: async () => (pinged = true),
    });
    expect(await failure(check)).toMatch(/network node API unreachable/);
    expect(pinged).toBe(false);
  });
});

describe("gatewayCheck", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<{
    url: string;
    paths: string[];
  }> {
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url ?? "");
      handler!(req, res);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
  }

  it("passes when the identity CID returns 200", async () => {
    const { url, paths } = await serve((_req, res) => res.writeHead(200).end());
    const check = gatewayCheck(`${url}/`, 2_000);
    expect([check.stage, check.name]).toEqual(["infra", "gateway"]);
    await expect(check.run()).resolves.toBe("GET /ipfs/bafkqaaa → 200");
    expect(paths).toEqual(["/ipfs/bafkqaaa"]);
  });

  it("blocks on a non-200 status, without the URL in the detail", async () => {
    const { url } = await serve((_req, res) => res.writeHead(502).end("bad gateway"));
    const message = await failure(gatewayCheck(url, 2_000));
    expect(message).toBe("gateway GET /ipfs/bafkqaaa returned 502");
    expect(message).not.toContain(url);
  });

  it("blocks when the gateway hangs past the timeout", async () => {
    const { url } = await serve(() => {});
    const started = Date.now();
    const message = await failure(gatewayCheck(url, 200));
    expect(message).toBe("gateway did not answer GET /ipfs/bafkqaaa within 200 ms");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("blocks when nothing listens", async () => {
    const message = await failure(gatewayCheck("http://127.0.0.1:1", 2_000));
    expect(message).toMatch(/^gateway GET \/ipfs\/bafkqaaa failed/);
    expect(message).not.toContain("127.0.0.1:1");
  });
});

describe("executorImageCheck", () => {
  it("passes when docker image inspect succeeds", async () => {
    const calls: string[][] = [];
    const check = executorImageCheck("spiral-h2-executor:dev", async (args) => {
      calls.push(args);
    });
    expect([check.stage, check.name]).toEqual(["infra", "executor image"]);
    await expect(check.run()).resolves.toBe("spiral-h2-executor:dev present");
    expect(calls).toEqual([["image", "inspect", "spiral-h2-executor:dev"]]);
  });

  it("blocks when docker image inspect fails", async () => {
    const check = executorImageCheck("spiral-h2-executor:dev", async () => {
      throw new Error("No such image");
    });
    expect(await failure(check)).toBe(
      "executor image spiral-h2-executor:dev not found (docker image inspect failed)",
    );
  });
});

describe("conformanceCheck", () => {
  it("passes on exit 0 with the vitest summary as the detail", async () => {
    const check = conformanceCheck(async () => ({ code: 0, summary: "Tests  4 passed (4)" }));
    expect([check.stage, check.name]).toEqual(["infra", "chunking conformance"]);
    await expect(check.run()).resolves.toBe("Tests  4 passed (4)");
  });

  it("blocks on a non-zero exit, carrying the summary", async () => {
    const check = conformanceCheck(async () => ({
      code: 1,
      summary: "Tests  1 failed | 3 passed (4)",
    }));
    expect(await failure(check)).toBe("conformance exited 1: Tests  1 failed | 3 passed (4)");
  });

  it.each([
    "Tests  3 skipped (3)",
    "no vitest summary line",
    "Tests  3 passed | 1 skipped (4)",
    "Tests  3 passed | 1 todo (4)",
    "Tests  0 passed (0)",
    "Tests  3 passed (4)",
  ])("blocks an exit 0 whose summary is %j", async (summary) => {
    const check = conformanceCheck(async () => ({ code: 0, summary }));
    expect(await failure(check)).toBe(`conformance did not pass every test: ${summary}`);
  });
});

describe("vitestSummary", () => {
  it("extracts the Tests line, ignoring colour codes", () => {
    const output =
      " \x1b[32m✓\x1b[39m src/conformance.test.ts (4 tests)\n\n\x1b[2m Test Files \x1b[22m 1 passed (1)\n\x1b[2m      Tests \x1b[22m \x1b[32m4 passed\x1b[39m (4)\n";
    expect(vitestSummary(output)).toBe("Tests  4 passed (4)");
  });

  it("says so when there is no summary line", () => {
    expect(vitestSummary("Error: Cannot find module")).toBe("no vitest summary line");
  });
});
