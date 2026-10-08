import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSolanaRpc } from "@solana/kit";
import type { InventoryRecord } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { secretsOf } from "../h2/command";
import { peerIdFromBytes } from "../h2/executor/provenance";
import { buildExecutorImage } from "../h2/executor/image";
import { peerIdBytes } from "../h2/testing/fixtures";
import { startLocalTopology, type LocalTopology } from "../h2/testing/local-topology";
import { HOST_GATEWAY_ADD_HOST, startRpcRelay } from "../h2/testing/rpc-relay";
import type { Topology } from "../h2/topology";
import { shouldSkipE2e, SPIRAL_PROGRAMS_DEPLOY_DIR, startLocalChain } from "../testing/chain";
import type { LocalChain } from "../testing/chain";
import { createOrg, submitForTest } from "../testing/submit";
import { DEVNET_GENESIS } from "./chain-checks";
import { runChecks, type CheckResult } from "./checks";
import { campaignCommand } from "./command";
import { buildChecks, type PreflightInputs, type PreflightStage } from "./preflight";
import { networkNodeCheck, replicaChecks } from "./node-checks";

const execFileAsync = promisify(execFile);
const docker = (args: string[]) => execFileAsync("docker", args, { timeout: 120_000 });

const skip = shouldSkipE2e("campaign pre-flight");
const PRESET = join(import.meta.dirname, "..", "..", "campaigns", "h2-dry-run.json");
const BASELINE = ["manifest (--final)", "chunking conformance"];
const H2_ROWS = ["golden ↔ manifest", "Films ↔ golden ↔ topology", "campaign plan"];

function manifestWork(record: InventoryRecord) {
  return {
    work_id: record.work_id,
    title: record.title,
    source: "Prelinger Archives",
    url: `https://archive.org/details/${record.work_id}`,
    file_url: `https://archive.org/download/${record.work_id}/${record.work_id}.mp4`,
    file_name: `${record.work_id}.mp4`,
    license: {
      status: "public_domain",
      basis: "Fixture work catalogued as public domain for this test.",
      reference_url: `https://archive.org/details/${record.work_id}`,
    },
    resolution: "640x480",
    duration_seconds: 10,
    size_bytes: Number(record.byte_size),
    size_band: "small",
    cold_cid: record.cold_cid,
    sha256: createHash("sha256").update(record.work_id).digest("hex"),
    placeholder: false,
  };
}

describe.skipIf(skip)("campaign:preflight against Surfpool and the local Docker topology", () => {
  let chain: LocalChain;
  let relay: Awaited<ReturnType<typeof startRpcRelay>>;
  let local: LocalTopology;
  let topology: Topology;
  let dir: string;
  let genesis: string;
  const paths = { manifest: "", files: "", golden: "", goldenMissing: "", topology: "" };

  const inputs = (over: Partial<PreflightInputs> = {}): PreflightInputs => ({
    topology,
    payer: chain.payer,
    manifestPath: paths.manifest,
    filesDir: paths.files,
    goldenPath: paths.golden,
    campaignPath: PRESET,
    expectedGenesis: genesis,
    minLamports: 2_000_000_000n,
    pingTimeoutMs: 5_000,
    skipConformance: true,
    ...over,
  });

  const check = async (
    stage: PreflightStage,
    over: Partial<PreflightInputs> = {},
  ): Promise<CheckResult[]> =>
    runChecks(await buildChecks(stage, inputs(over)), secretsOf(over.topology ?? topology));

  const expectBlocked = (results: CheckResult[], expected: string[]) => {
    const blocked = results.filter((r) => !r.ok).map((r) => r.name);
    expect(new Set(blocked), JSON.stringify(results, null, 1)).toEqual(new Set(expected));
  };
  const detailOf = (results: CheckResult[], name: string) =>
    results.find((r) => r.name === name)?.detail;

  const containerOf = async (name: string): Promise<string> => {
    const port = topology.replicas.find((r) => r.name === name)!.ssh.port;
    const { stdout } = await docker(["ps", "-q", "--filter", `network=${local.networkName}`]);
    for (const id of stdout.trim().split("\n")) {
      const mapped = await docker(["port", id, "22/tcp"]).catch(() => ({ stdout: "" }));
      if (mapped.stdout.trim().endsWith(`:${port}`)) return id;
    }
    throw new Error(`no container for replica ${name}`);
  };

  const waitHealthy = () =>
    vi.waitFor(
      async () => {
        const results = await runChecks(
          [...replicaChecks(topology, { pingTimeoutMs: 5_000 }), networkNodeCheck(topology, 5_000)],
          [],
        );
        expect(results.filter((r) => !r.ok)).toEqual([]);
      },
      { timeout: 180_000, interval: 3_000 },
    );

  beforeAll(async () => {
    chain = await startLocalChain();
    relay = await startRpcRelay(chain.rpcUrl);
    local = await startLocalTopology({
      rpcUrlForContainers: relay.urlForContainers,
      addHosts: [HOST_GATEWAY_ADD_HOST],
    });
    topology = { ...local.topology, rpc_url: chain.rpcUrl, gateway_url: local.gatewayHostUrl };
    await buildExecutorImage();
    genesis = await createSolanaRpc(chain.rpcUrl).getGenesisHash().send();

    await createOrg(chain, "preflight");
    const urls = Object.values(local.replicaApiUrls);
    const golden = [
      await submitForTest({
        chain,
        slug: "preflight",
        workId: "pd-901",
        content: randomBytes(300_000),
        title: "warm",
        kuboUrls: urls,
      }),
      await submitForTest({
        chain,
        slug: "preflight",
        workId: "pd-902",
        content: randomBytes(200_000),
        title: "cold",
        kuboUrls: urls,
        coldCid: true,
      }),
    ];
    dir = mkdtempSync(join(tmpdir(), "spiral-preflight-e2e-"));
    const ndjson = (records: InventoryRecord[]) =>
      records.map((r) => `${JSON.stringify(r)}\n`).join("");
    paths.golden = join(dir, "golden.ndjson");
    writeFileSync(paths.golden, ndjson(golden));
    paths.goldenMissing = join(dir, "golden-missing.ndjson");
    writeFileSync(paths.goldenMissing, ndjson(golden.slice(0, 1)));
    paths.manifest = join(dir, "manifest.json");
    writeFileSync(
      paths.manifest,
      JSON.stringify({ manifest_version: 1, notice: "e2e", works: golden.map(manifestWork) }),
    );
    paths.files = join(dir, "files");
    mkdirSync(paths.files);
    paths.topology = join(dir, "topology.json");
    writeFileSync(paths.topology, JSON.stringify(topology));
  }, 1_200_000);

  afterAll(async () => {
    await local?.stop();
    await relay?.stop();
    chain?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("baseline: the command blocks only on the non-final manifest and the skipped conformance", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await campaignCommand.parseAsync(
        [
          "preflight",
          "--stage",
          "all",
          "--topology",
          paths.topology,
          "--keypair",
          chain.keypairPath,
          "--manifest",
          paths.manifest,
          "--files-dir",
          paths.files,
          "--golden",
          paths.golden,
          "--campaign",
          PRESET,
          "--expected-genesis",
          genesis,
          "--ping-timeout-ms",
          "5000",
          "--skip-conformance",
        ],
        { from: "user" },
      );
      const stdout = out.mock.calls.flat().join("\n");
      expect(err).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const rows = stdout
        .split("\n")
        .filter((l) => /^\| (infra|h2) \|/.test(l))
        .map((l) => l.split(" | ").map((c) => c.replace(/^\| |\s*\|$/g, "")));
      expect(rows.map((r) => r[1])).toEqual([
        "rpc genesis",
        "program organization",
        "program film",
        "payer balance",
        "manifest (--final)",
        "chunking conformance",
        "replica a",
        "replica b",
        "replica c",
        "network node",
        "gateway",
        "executor image",
        ...H2_ROWS,
      ]);
      expect(rows.filter((r) => r[2] === "BLOCKED").map((r) => r[1])).toEqual(BASELINE);
      expect(stdout).toContain("| infra | chunking conformance | BLOCKED | skipped by flag |");
      expect(stdout).toContain("Pre-flight: BLOCKED (2 of 15 checks failed)");
      expect(stdout).not.toContain("Pre-flight: READY");
      expect(stdout).not.toContain(chain.rpcUrl);
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.exitCode = undefined;
    }
  }, 300_000);

  it("a replica with ipfs stopped blocks that replica and the network node ping", async () => {
    const b = await containerOf("b");
    await docker(["exec", b, "systemctl", "stop", "ipfs"]);
    try {
      const results = await check("all");
      expectBlocked(results, [...BASELINE, "replica b", "network node"]);
      expect(detailOf(results, "replica b")).toMatch(/not active/);
      const peerB = topology.replicas.find((r) => r.name === "b")!.peer_id;
      expect(detailOf(results, "network node")).toBe(`no ping answer from ${peerB}`);
    } finally {
      await docker(["exec", b, "systemctl", "start", "ipfs"]);
      await waitHealthy();
    }
  }, 300_000);

  it("a paused replica blocks over SSH without hanging past the timeout", async () => {
    const c = await containerOf("c");
    await docker(["pause", c]);
    try {
      const started = Date.now();
      const results = await check("all");
      expect(Date.now() - started).toBeLessThan(90_000);
      expectBlocked(results, [...BASELINE, "replica c", "network node"]);
      expect(detailOf(results, "replica c")).toMatch(/SSH to 127\.0\.0\.1:\d+ failed/);
    } finally {
      await docker(["unpause", c]);
      await waitHealthy();
    }
  }, 300_000);

  it("a wrong executor image name blocks the executor image", async () => {
    const results = await check("all", {
      topology: {
        ...topology,
        executor: { ...topology.executor, image: "spiral-h2-executor:absent" },
      },
    });
    expectBlocked(results, [...BASELINE, "executor image"]);
    expect(detailOf(results, "executor image")).toMatch(/not found/);
  }, 300_000);

  it("a wrong expected genesis blocks rpc genesis", async () => {
    const results = await check("all", { expectedGenesis: DEVNET_GENESIS });
    expectBlocked(results, [...BASELINE, "rpc genesis"]);
    expect(detailOf(results, "rpc genesis")).toContain(`does not match expected ${DEVNET_GENESIS}`);
  }, 300_000);

  it("a payer below the minimum blocks payer balance", async () => {
    const results = await check("all", { minLamports: 1_000_000n * 1_000_000_000n });
    expectBlocked(results, [...BASELINE, "payer balance"]);
    expect(detailOf(results, "payer balance")).toMatch(/below the minimum 1000000 SOL/);
  }, 300_000);

  it("a local film.so differing by one byte blocks only program film", async () => {
    const programs = join(dir, "programs");
    const source = join(SPIRAL_PROGRAMS_DEPLOY_DIR, "..");
    for (const sub of ["deploy", "idl"]) {
      cpSync(join(source, sub), join(programs, "target", sub), { recursive: true });
    }
    const film = join(programs, "target", "deploy", "film.so");
    const bytes = readFileSync(film);
    const mid = bytes.length >> 1;
    bytes.writeUInt8(bytes[mid]! ^ 0xff, mid);
    writeFileSync(film, bytes);
    const results = await check("all", { programsDir: programs });
    expectBlocked(results, [...BASELINE, "program film"]);
    expect(detailOf(results, "program film")).toMatch(/deployed bytecode differs from film\.so/);
  }, 300_000);

  it("a topology with a fake fourth replica PeerID blocks Films ↔ golden ↔ topology", async () => {
    const fake = peerIdFromBytes(peerIdBytes(7), 38);
    const results = await check("h2", {
      topology: {
        ...topology,
        replicas: [...topology.replicas, { ...topology.replicas[0]!, name: "d", peer_id: fake }],
      },
    });
    expect(results.map((r) => r.name)).toEqual(H2_ROWS);
    expectBlocked(results, ["Films ↔ golden ↔ topology"]);
    expect(detailOf(results, "Films ↔ golden ↔ topology")).toBe(
      `pd-901: missing ${fake}; pd-902: missing ${fake}`,
    );
  }, 300_000);

  it("a golden missing one manifest work blocks golden ↔ manifest", async () => {
    const results = await check("all", { goldenPath: paths.goldenMissing });
    expectBlocked(results, [...BASELINE, "golden ↔ manifest"]);
    expect(detailOf(results, "golden ↔ manifest")).toBe("missing in golden: pd-902");
  }, 300_000);
});
