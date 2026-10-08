import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pings: ("ok" | "fail" | "throw" | "timeout" | "down" | "dns")[] = [];
const ids: ("ok" | "throw" | "http" | "dns")[] = [];
let pingCalls = 0;
let idCalls = 0;

vi.mock("kubo-rpc-client", () => ({
  create: () => ({
    ping: async function* () {
      pingCalls++;
      const next = pings.shift() ?? "fail";
      if (next === "throw") throw new Error("context deadline exceeded");
      if (next === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (next === "down")
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      if (next === "dns")
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
        });
      yield { success: next === "ok", time: next === "ok" ? 12 : 0, text: "" };
    },
    id: async () => {
      idCalls++;
      const next = ids.shift() ?? "throw";
      if (next === "throw")
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      if (next === "http")
        throw Object.assign(new Error("Internal Server Error"), { name: "HTTPError" });
      if (next === "dns")
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
        });
      return {};
    },
  }),
}));

vi.mock("../../../../scripts/kubo-node-control", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertSshReachable: async () => {},
  checkSystemdActive: async () => true,
}));

const { assertNetworkNodeAlive, NetworkNodeUnreachable, pingPeer } = await import("./probes");
const { EXIT_RESUMABLE, h2ExitCode } = await import("./exit-code");
const { nodeDrift, sshReplicaController } = await import("./state");
const { topologySchema } = await import("./topology");

const api = "http://127.0.0.1:5001";

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  const result = promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  pings.length = 0;
  ids.length = 0;
  pingCalls = 0;
  idCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pingPeer", () => {
  it("answers true at once when the first ping succeeds", async () => {
    pings.push("ok");
    expect((await settle(pingPeer(api, "PeerA", 1_000))).value).toBe(true);
    expect(pingCalls).toBe(1);
  });

  it("retries a failed ping and answers true when a later try succeeds", async () => {
    pings.push("throw", "fail", "ok");
    expect((await settle(pingPeer(api, "PeerA", 1_000))).value).toBe(true);
    expect(pingCalls).toBe(3);
  });

  it("answers false only after every try fails", async () => {
    pings.push("fail", "throw", "fail");
    expect((await settle(pingPeer(api, "PeerA", 1_000))).value).toBe(false);
    expect(pingCalls).toBe(3);
  });

  it("answers false when the ping ran and timed out every try", async () => {
    pings.push("timeout", "timeout", "timeout");
    expect((await settle(pingPeer(api, "PeerA", 1_000))).value).toBe(false);
    expect(pingCalls).toBe(3);
  });

  it("raises a resumable fault, not false, when the API stays unreachable", async () => {
    pings.push("down", "down", "down");
    const { value, error } = await settle(pingPeer(api, "PeerA", 1_000));
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(NetworkNodeUnreachable);
    expect(error?.message).toMatch(
      /network node API unreachable \(127\.0\.0\.1:5001\) during ping/,
    );
    expect(h2ExitCode(error)).toBe(EXIT_RESUMABLE);
    expect(pingCalls).toBe(3);
  });

  it("recovers when the API comes back within the retries", async () => {
    pings.push("down", "ok");
    expect((await settle(pingPeer(api, "PeerA", 1_000))).value).toBe(true);
    expect(pingCalls).toBe(2);
  });

  it("fails at once with exit 1, not as unreachable, on an unresolvable host", async () => {
    pings.push("dns");
    const { error } = await settle(pingPeer(api, "PeerA", 1_000));
    expect(error).not.toBeInstanceOf(NetworkNodeUnreachable);
    expect(error?.message).toMatch(/^network node API at 127\.0\.0\.1:5001 failed during ping: /);
    expect(h2ExitCode(error)).toBe(1);
    expect(pingCalls).toBe(1);
  });
});

describe("assertNetworkNodeAlive", () => {
  it("retries a transient failure", async () => {
    ids.push("throw", "ok");
    expect((await settle(assertNetworkNodeAlive(api, 1_000))).error).toBeUndefined();
    expect(idCalls).toBe(2);
  });

  it("throws after three failed tries", async () => {
    const { error } = await settle(assertNetworkNodeAlive(api, 1_000));
    expect(error).toBeInstanceOf(NetworkNodeUnreachable);
    expect(error?.message).toMatch(/network node API unreachable \(127\.0\.0\.1:5001\)/);
    expect(idCalls).toBe(3);
  });

  it("faults at once, not as unreachable, on an HTTP error or an unresolvable host", async () => {
    for (const kind of ["http", "dns"] as const) {
      idCalls = 0;
      ids.length = 0;
      ids.push(kind);
      const { error } = await settle(assertNetworkNodeAlive(api, 1_000));
      expect(error).not.toBeInstanceOf(NetworkNodeUnreachable);
      expect(error?.message).toMatch(/^network node API at 127\.0\.0\.1:5001 failed: /);
      expect(idCalls).toBe(1);
    }
  });
});

describe("sshReplicaController.observe", () => {
  const topology = topologySchema.parse({
    topology_version: 1,
    replicas: [
      {
        name: "a",
        peer_id: "PeerA",
        ssh: { host: "127.0.0.1", port: 2200, user: "spiral", identity_file: "/k" },
      },
    ],
    network_node: { api_url: api, bootstrap_multiaddr: null },
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

  it("raises the API fault instead of observing the replica unreachable", async () => {
    pings.push("down", "down", "down");
    const { value, error } = await settle(
      sshReplicaController(topology, { pingTimeoutMs: 1_000 }).observe("a"),
    );
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(NetworkNodeUnreachable);
    expect(h2ExitCode(error)).toBe(EXIT_RESUMABLE);
  });

  it("does not report drift when a ping fails once and then succeeds", async () => {
    pings.push("throw", "ok");
    const { value } = await settle(
      sshReplicaController(topology, { pingTimeoutMs: 1_000 }).observe("a"),
    );
    expect(value).toEqual({ node: "a", systemd_active: true, swarm_reachable: true });
    expect(nodeDrift(["a"], [value!])).toBe(false);
  });
});
