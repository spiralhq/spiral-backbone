import { describe, expect, it } from "vitest";
import { collectProviders, type ProviderEvent } from "./probes";
import {
  applyState,
  checkState,
  decideState,
  nodeDrift,
  PROVIDER_LOOKUP_CONCURRENCY,
  type NodeObservation,
  type ReplicaController,
} from "./state";
import { checkTopologyMatchesCampaign, topologySchema, type TopologyInput } from "./topology";

const topo = topologySchema.parse({
  topology_version: 1,
  replicas: ["a", "b", "c"].map((name) => ({
    name,
    peer_id: `Peer${name}`,
    ssh: { host: "127.0.0.1", port: 2200, user: "spiral", identity_file: "/k" },
  })),
  network_node: { api_url: "http://127.0.0.1:5001", bootstrap_multiaddr: null },
  gateway_url: "https://ipfs.io",
  rpc_url: "https://rpc.example.com",
  executor: {
    image: "img",
    docker_network: null,
    add_hosts: [],
    swarm_key_path: null,
    block_cidrs: [],
    repo_root: "/repo",
  },
});

const peers = { a: "PeerA", b: "PeerB", c: "PeerC" };
const on = (node: string): NodeObservation => ({
  node,
  systemd_active: true,
  swarm_reachable: true,
});
const off = (node: string): NodeObservation => ({
  node,
  systemd_active: false,
  swarm_reachable: false,
});

describe("decideState", () => {
  it("confirms when every check matches the intention and providers are present", () => {
    const check = decideState({
      intended: ["a", "b"],
      observed: [on("a"), on("b"), off("c")],
      providersByCid: { cid1: new Set(["PeerA", "PeerB", "PeerC"]) },
      peerIdByNode: peers,
    });
    expect(check).toMatchObject({ confirmed: true, reasons: [], missing_providers: {} });
  });

  it("rejects a node that systemd reports stopped but still answers in the swarm", () => {
    const check = decideState({
      intended: ["a"],
      observed: [on("a"), { node: "b", systemd_active: false, swarm_reachable: true }, off("c")],
      providersByCid: { cid1: new Set(["PeerA"]) },
      peerIdByNode: peers,
    });
    expect(check.confirmed).toBe(false);
    expect(check.reasons.join("\n")).toMatch(/b: swarm reachable, intended off/);
  });

  it("rejects an intended-active node that is down", () => {
    const check = decideState({
      intended: ["a"],
      observed: [off("a"), off("b"), off("c")],
      providersByCid: {},
      peerIdByNode: peers,
    });
    expect(check.reasons.join("\n")).toMatch(/a: systemd inactive, intended on/);
  });

  it("rejects when an intended-active replica is missing from findprovs", () => {
    const check = decideState({
      intended: ["a", "b"],
      observed: [on("a"), on("b"), off("c")],
      providersByCid: { cid1: new Set(["PeerA"]) },
      peerIdByNode: peers,
    });
    expect(check.missing_providers).toEqual({ cid1: ["b"] });
    expect(check.confirmed).toBe(false);
  });

  it("zero intended replicas only requires everything off (stale provider records are ignored)", () => {
    const check = decideState({
      intended: [],
      observed: [off("a"), off("b"), off("c")],
      providersByCid: { cid1: new Set(["PeerA", "PeerB", "PeerC"]) },
      peerIdByNode: peers,
    });
    expect(check.confirmed).toBe(true);
  });
});

describe("checkState", () => {
  const okController: ReplicaController = {
    start: async () => {},
    stop: async () => {},
    observe: async (n) => off(n),
  };

  it("rejects instead of confirming when the liveness check throws", async () => {
    const probe = {
      providers: async () => new Set<string>(),
      liveness: async () => {
        throw new Error("network node API unreachable");
      },
    };
    await expect(checkState(okController, probe, topo, [], [])).rejects.toThrow(/unreachable/);
  });

  it("rejects when observe throws", async () => {
    const controller: ReplicaController = {
      ...okController,
      observe: async () => {
        throw new Error("SSH failed");
      },
    };
    await expect(
      checkState(controller, { providers: async () => new Set() }, topo, [], []),
    ).rejects.toThrow(/SSH failed/);
  });
});

describe("provider lookups", () => {
  const onController: ReplicaController = {
    start: async () => {},
    stop: async () => {},
    observe: async (n) => (n === "c" ? off(n) : on(n)),
  };

  it("runs findprovs for every CID in parallel, at most 5 at a time, asking for the intended peers", async () => {
    const calls: string[] = [];
    const wants: string[][] = [];
    let running = 0;
    let peak = 0;
    const probe = {
      providers: async (cid: string, want: ReadonlySet<string>) => {
        calls.push(`start ${cid}`);
        wants.push([...want].sort());
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        calls.push(`end ${cid}`);
        return new Set(["Peera", "Peerb"]);
      },
    };
    const cids = Array.from({ length: 7 }, (_, i) => `cid${i}`);
    const check = await checkState(onController, probe, topo, ["a", "b"], cids);
    expect(check.confirmed).toBe(true);
    expect(PROVIDER_LOOKUP_CONCURRENCY).toBe(5);
    expect(peak).toBe(5);
    expect(calls.slice(0, 5)).toEqual([
      "start cid0",
      "start cid1",
      "start cid2",
      "start cid3",
      "start cid4",
    ]);
    expect(calls.filter((c) => c.startsWith("start"))).toHaveLength(7);
    expect(wants.every((w) => JSON.stringify(w) === JSON.stringify(["Peera", "Peerb"]))).toBe(true);
  });

  it("still reports a CID whose lookup misses an intended provider", async () => {
    const probe = {
      providers: async (cid: string) => new Set(cid === "cid1" ? ["Peera"] : ["Peera", "Peerb"]),
    };
    const check = await checkState(onController, probe, topo, ["a", "b"], ["cid0", "cid1", "cid2"]);
    expect(check.missing_providers).toEqual({ cid1: ["b"] });
    expect(check.confirmed).toBe(false);
  });

  it("stops reading findprovs events once every intended provider is found", async () => {
    const pulled: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      const steps: [string, string[]][] = [
        ["QUERY", []],
        ["PROVIDER", ["PeerA"]],
        ["PROVIDER", ["PeerX", "PeerB"]],
        ["PROVIDER", ["PeerC"]],
      ];
      for (const [name, ids] of steps) {
        pulled.push(`${name}:${ids.join(",")}`);
        yield { name, providers: ids.map((id) => ({ id })) };
      }
    }
    const found = await collectProviders(events(), new Set(["PeerA", "PeerB"]));
    expect(found).toEqual(new Set(["PeerA", "PeerX", "PeerB"]));
    expect(pulled).toEqual(["QUERY:", "PROVIDER:PeerA", "PROVIDER:PeerX,PeerB"]);
  });

  it("reads until the stream ends (the timeout) when an intended provider never appears", async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { name: "PROVIDER", providers: [{ id: "PeerA" }] };
      throw new Error("The operation was aborted due to timeout");
    }
    expect(await collectProviders(events(), new Set(["PeerA", "PeerB"]))).toEqual(
      new Set(["PeerA"]),
    );
  });
});

describe("nodeDrift", () => {
  it("is true only for a systemd or ping mismatch, never for a provider miss", () => {
    expect(nodeDrift(["a"], [on("a"), off("b")])).toBe(false);
    expect(nodeDrift(["a"], [{ ...on("a"), systemd_active: false }, off("b")])).toBe(true);
    expect(nodeDrift(["a"], [on("a"), { ...off("b"), swarm_reachable: true }])).toBe(true);
  });
});

describe("applyState", () => {
  it("starts intended nodes and stops the rest", async () => {
    const calls: string[] = [];
    const controller: ReplicaController = {
      start: async (n) => void calls.push(`start ${n}`),
      stop: async (n) => void calls.push(`stop ${n}`),
      observe: async (n) => on(n),
    };
    await applyState(controller, ["a", "b", "c"], ["a"]);
    expect(calls).toEqual(["start a", "stop b", "stop c"]);
  });
});

describe("topology", () => {
  const input: TopologyInput = {
    topology_version: 1,
    replicas: ["a", "b", "c"].map((name) => ({
      name,
      peer_id: `Peer${name}`,
      ssh: { host: "127.0.0.1", port: 2200, user: "spiral", identity_file: "/k" },
    })),
    network_node: { api_url: "http://127.0.0.1:5001", bootstrap_multiaddr: null },
    gateway_url: "https://ipfs.io",
    rpc_url: "https://rpc.example.com",
    executor: {
      image: "img",
      docker_network: null,
      add_hosts: [],
      swarm_key_path: null,
      block_cidrs: [],
      repo_root: "/repo",
    },
  };

  it("defaults service to ipfs and host-key checking on", () => {
    const topology = topologySchema.parse(input);
    expect(topology.replicas[0]).toMatchObject({
      service: "ipfs",
      ssh: { insecure_host_key_checking: false },
    });
  });

  it("reports campaign replicas missing from the topology", () => {
    expect(checkTopologyMatchesCampaign(topologySchema.parse(input), ["a", "b", "d"])).toEqual([
      "campaign replica d is not in the topology",
    ]);
  });
});
