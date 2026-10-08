import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { topologyFixture } from "../h2/testing/fixtures";
import type { Check } from "./checks";

const buildChecks = vi.hoisted(() => vi.fn());
vi.mock("./preflight", () => ({ buildChecks }));

const { campaignCommand } = await import("./command");

const SECRET_RPC = "https://rpc.example.invalid/secret-api-key";
const dir = mkdtempSync(join(tmpdir(), "spiral-campaign-cmd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keypair = join(dir, "payer.json");
execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--outfile", keypair]);
const topology = join(dir, "topology.json");
writeFileSync(
  topology,
  JSON.stringify(topologyFixture([{ name: "a", peer_id: "PeerA" }], { rpc_url: SECRET_RPC })),
);

const check = (name: string, outcome: string | Error): Check => ({
  stage: "infra",
  name,
  run: async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
});

let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  out = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  buildChecks.mockReset();
  process.exitCode = undefined;
});

const printed = () => [...out.mock.calls, ...err.mock.calls].flat().join("\n");
const run = (args: string[]) =>
  campaignCommand.parseAsync(["preflight", "--topology", topology, "--keypair", keypair, ...args], {
    from: "user",
  });

describe("campaign preflight", () => {
  it("requires --golden for the h2 stage", async () => {
    await run(["--stage", "h2"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--golden is required for --stage h2/);
    expect(buildChecks).not.toHaveBeenCalled();
  });

  it("rejects --skip-conformance with the h2 stage", async () => {
    await run(["--stage", "h2", "--golden", "g.json", "--skip-conformance"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--skip-conformance does not apply to --stage h2/);
    expect(buildChecks).not.toHaveBeenCalled();
  });

  it("requires --golden for the all stage", async () => {
    await run(["--stage", "all"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--golden is required for --stage all/);
  });

  it("rejects an unknown stage", async () => {
    await run(["--stage", "everything"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--stage must be one of infra, h2, all/);
  });

  it("prints READY and leaves the exit code unset when every check passes", async () => {
    buildChecks.mockResolvedValue([check("rpc genesis", "genesis X"), check("gateway", "200")]);
    await run(["--stage", "infra"]);
    expect(process.exitCode).toBeUndefined();
    expect(out.mock.calls.flat().join("\n")).toContain("Pre-flight: READY");
  });

  it("passes the parsed inputs and the payer derived from --keypair to buildChecks", async () => {
    buildChecks.mockResolvedValue([]);
    await run([
      "--stage",
      "all",
      "--golden",
      "g.ndjson",
      "--min-balance-sol",
      "2.5",
      "--ping-timeout-ms",
      "3000",
      "--expected-genesis",
      "GEN",
      "--skip-conformance",
      "--programs-dir",
      "/progs",
    ]);
    const [stage, inputs] = buildChecks.mock.calls[0]!;
    expect(stage).toBe("all");
    expect(inputs).toMatchObject({
      goldenPath: "g.ndjson",
      manifestPath: "dataset/manifest.json",
      filesDir: "dataset/files",
      campaignPath: "packages/eval/campaigns/h2-final.json",
      expectedGenesis: "GEN",
      minLamports: 2_500_000_000n,
      pingTimeoutMs: 3000,
      skipConformance: true,
      programsDir: "/progs",
    });
    expect(inputs.payer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(inputs.topology.rpc_url).toBe(SECRET_RPC);
  });

  it("exits 1 and shows BLOCKED when one check fails, printing every check", async () => {
    buildChecks.mockResolvedValue([
      check("rpc genesis", new Error(`fetch ${SECRET_RPC} failed`)),
      check("gateway", "200"),
    ]);
    await run(["--stage", "infra"]);
    const output = out.mock.calls.flat().join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("| infra | rpc genesis | BLOCKED |");
    expect(output).toContain("| infra | gateway | OK |");
    expect(output).toContain("Pre-flight: BLOCKED (1 of 2 checks failed)");
    expect(output).not.toContain("secret-api-key");
  });

  it("rejects a malformed topology with exit 1 and never prints its contents", async () => {
    const bad = join(dir, "bad-topology.json");
    writeFileSync(bad, `{"rpc_url": "${SECRET_RPC}", oops}`);
    await campaignCommand.parseAsync(
      ["preflight", "--stage", "infra", "--topology", bad, "--keypair", keypair],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/Pre-flight failed: topology .* is unreadable or not valid JSON/);
    expect(printed()).not.toContain("secret-api-key");
    expect(printed()).not.toContain("rpc.example.invalid");
    expect(buildChecks).not.toHaveBeenCalled();
  });

  it("rejects an unreadable keypair without printing its bytes", async () => {
    const badKey = join(dir, "bad-key.json");
    writeFileSync(badKey, "[1,2,3,secret-bytes]");
    await campaignCommand.parseAsync(
      ["preflight", "--stage", "infra", "--topology", topology, "--keypair", badKey],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
    expect(printed()).toContain("Pre-flight failed: keypair is unreadable or invalid");
    expect(printed()).not.toContain("secret-bytes");
    expect(printed()).not.toContain(badKey);
  });

  it("rejects a non-positive --min-balance-sol and a non-integer --ping-timeout-ms", async () => {
    await run(["--stage", "infra", "--min-balance-sol", "-1"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--min-balance-sol must be a positive number/);
    process.exitCode = undefined;
    await run(["--stage", "infra", "--min-balance-sol", "1e-12"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--min-balance-sol must be at least 1 lamport/);
    process.exitCode = undefined;
    await run(["--stage", "infra", "--ping-timeout-ms", "soon"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/--ping-timeout-ms must be a positive integer/);
  });
});
