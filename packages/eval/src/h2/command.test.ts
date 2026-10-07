import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h2Command, redact, resolveRunTarget, secretsOf } from "./command";
import { topologySchema } from "./topology";
import { goldenFixture } from "./testing/fixtures";

const PRESET = join(import.meta.dirname, "..", "..", "campaigns", "h2-dry-run.json");
const SECRET_RPC = "https://rpc.example.invalid/secret-api-key";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function makePlan(dir: string): Promise<{ run_id: string; plan: string; attempts: number }> {
  const golden = join(dir, "golden.ndjson");
  writeFileSync(
    golden,
    [
      goldenFixture({ work_id: "pd-901", film_pda: "F1" }),
      goldenFixture({ work_id: "pd-902", film_pda: "F2", cold_cid: true }),
    ]
      .map((g) => JSON.stringify(g))
      .join("\n") + "\n",
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await h2Command.parseAsync(
    [
      "plan",
      "--campaign",
      PRESET,
      "--golden",
      golden,
      "--label",
      "unit",
      "--plans-dir",
      join(dir, "plans"),
    ],
    { from: "user" },
  );
  const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  log.mockRestore();
  return printed;
}

describe("resolveRunTarget", () => {
  it("requires exactly one of --plan and --resume", () => {
    expect(() => resolveRunTarget({ plansDir: "plans" })).toThrow(/exactly one/);
    expect(() => resolveRunTarget({ plan: "p.json", resume: "r", plansDir: "plans" })).toThrow(
      /exactly one/,
    );
    expect(resolveRunTarget({ plan: "p.json", plansDir: "plans" })).toBe("p.json");
    expect(resolveRunTarget({ resume: "2026-10-06T12:00:00Z-h2-x", plansDir: "plans" })).toBe(
      join("plans", "h2-2026-10-06T12:00:00Z-h2-x.json"),
    );
  });
});

describe("eval:h2 plan", () => {
  it("writes a frozen plan from a campaign and a golden inventory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h2-cmd-"));
    const printed = await makePlan(dir);
    expect(printed.attempts).toBe(14);
    expect(readdirSync(join(dir, "plans"))).toEqual([`h2-${printed.run_id}.json`]);
  });
});

describe("eval:h2 run", () => {
  it("rejects a malformed topology with exit 1 and never prints its contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h2-cmd-"));
    const { plan } = await makePlan(dir);
    const topology = join(dir, "topology.json");
    writeFileSync(topology, `{"rpc_url": "${SECRET_RPC}", oops}`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await h2Command.parseAsync(
      ["run", "--plan", plan, "--topology", topology, "--out", join(dir, "h2.ndjson")],
      {
        from: "user",
      },
    );
    const output = err.mock.calls.flat().join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/H2 run failed/);
    expect(output).not.toContain("secret-api-key");
    expect(output).not.toContain("rpc.example.invalid");
  });

  it("rejects a schema-invalid topology without echoing values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h2-cmd-"));
    const { plan } = await makePlan(dir);
    const topology = join(dir, "topology.json");
    writeFileSync(
      topology,
      JSON.stringify({ topology_version: 1, rpc_url: SECRET_RPC, gateway_url: 42 }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await h2Command.parseAsync(["run", "--plan", plan, "--topology", topology], { from: "user" });
    const output = err.mock.calls.flat().join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).not.toContain("secret-api-key");
  });

  it("rejects a non-numeric timeout with exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h2-cmd-"));
    const { plan } = await makePlan(dir);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await h2Command.parseAsync(
      ["run", "--plan", plan, "--topology", join(dir, "absent.json"), "--ping-timeout-ms", "soon"],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toMatch(/ping-timeout-ms/);
  });

  it("requires exactly one of --plan and --resume", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await h2Command.parseAsync(["run", "--topology", "t.json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toMatch(/exactly one/);
  });
});

describe("error redaction", () => {
  it("strips topology URLs and hosts from fault messages", () => {
    const topology = topologySchema.parse({
      topology_version: 1,
      replicas: [
        {
          name: "a",
          peer_id: "PeerA",
          ssh: { host: "127.0.0.1", port: 2200, user: "s", identity_file: "/k" },
        },
      ],
      network_node: { api_url: "http://10.9.8.7:5001", bootstrap_multiaddr: null },
      gateway_url: "https://ipfs.io",
      rpc_url: SECRET_RPC,
      executor: {
        image: "img",
        docker_network: null,
        add_hosts: [],
        swarm_key_path: null,
        block_cidrs: [],
        repo_root: "/repo",
      },
    });
    const message = redact(
      `fetch ${SECRET_RPC} failed; connect ECONNREFUSED rpc.example.invalid; api ${topology.network_node.api_url}/api/v0/id`,
      secretsOf(topology),
    );
    expect(message).not.toContain("secret-api-key");
    expect(message).not.toContain("rpc.example.invalid");
    expect(message).not.toContain("10.9.8.7");
  });

  it("strips an API key carried in the path or query, in any URL form", () => {
    const topology = topologySchema.parse({
      topology_version: 1,
      replicas: [
        {
          name: "a",
          peer_id: "PeerA",
          ssh: { host: "127.0.0.1", port: 2200, user: "s", identity_file: "/k" },
        },
      ],
      network_node: { api_url: "http://10.9.8.7:5001", bootstrap_multiaddr: null },
      gateway_url: "https://ipfs.io",
      rpc_url: "https://rpc.x?api-key=K3Y",
      executor: {
        image: "img",
        docker_network: null,
        add_hosts: [],
        swarm_key_path: null,
        block_cidrs: [],
        repo_root: "/repo",
      },
    });
    const message = redact(
      "GET https://rpc.x/?api-key=K3Y failed; raw https://rpc.x?api-key=K3Y; query ?api-key=K3Y; /?api-key=K3Y",
      secretsOf(topology),
    );
    expect(message).not.toContain("K3Y");
    expect(message).not.toContain("rpc.x");
  });
});
