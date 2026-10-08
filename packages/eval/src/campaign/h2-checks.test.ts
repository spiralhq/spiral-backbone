import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, lamports, type Address } from "@solana/kit";
import { cidStringToBytes, type InventoryRecord } from "@spiral-backbone/protocol";
import { FILM_PROGRAM_ADDRESS, getFilmEncoder } from "@spiral-backbone/protocol/generated/film";
import { afterAll, describe, expect, it } from "vitest";
import { validateManifest } from "../../../../scripts/validate-manifest";
import { peerIdFromBytes } from "../h2/executor/provenance";
import { goldenFixtures20, peerIdBytes, topologyFixture } from "../h2/testing/fixtures";
import {
  campaignFeasibleCheck,
  filmsMatchCheck,
  goldenMatchesManifestCheck,
  manifestFinalCheck,
  type FilmRpc,
} from "./h2-checks";

const dir = mkdtempSync(join(tmpdir(), "spiral-h2-checks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let fileCount = 0;
function write(name: string, content: string): string {
  const path = join(dir, `${fileCount++}-${name}`);
  writeFileSync(path, content);
  return path;
}

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const PLACEHOLDER_MANIFEST = join(REPO, "dataset", "manifest.json");
const FINAL_CAMPAIGN = join(REPO, "packages", "eval", "campaigns", "h2-final.json");

const GOLDEN = goldenFixtures20();
const goldenFile = (records: InventoryRecord[]) =>
  write("golden.ndjson", records.map((r) => `${JSON.stringify(r)}\n`).join(""));

function manifestWork(record: InventoryRecord) {
  return {
    work_id: record.work_id,
    title: `Work ${record.work_id}`,
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
    duration_seconds: 100,
    size_bytes: Number(record.byte_size),
    size_band: record.size_band,
    cold_cid: record.cold_cid,
    sha256: createHash("sha256").update(record.work_id).digest("hex"),
    placeholder: false,
  };
}
const manifestFile = (records: InventoryRecord[]) =>
  write(
    "manifest.json",
    JSON.stringify({ manifest_version: 1, notice: "test", works: records.map(manifestWork) }),
  );
const FINAL_MANIFEST = manifestFile(GOLDEN);
const filesDir = mkdtempSync(join(dir, "files-"));

async function failure(check: { run(): Promise<string> }): Promise<string> {
  return check.run().then(
    (detail) => `unexpected pass: ${detail}`,
    (e: Error) => e.message,
  );
}

describe("manifestFinalCheck", () => {
  it("passes a manifest valid with --final, giving the work and cold counts", async () => {
    const check = manifestFinalCheck(FINAL_MANIFEST, filesDir);
    expect([check.stage, check.name]).toEqual(["infra", "manifest (--final)"]);
    await expect(check.run()).resolves.toBe("20 works, 5 cold, 20 files not verified");
  });

  it("counts only the files absent from filesDir as not verified", async () => {
    const record = GOLDEN[0]!;
    const withFile = mkdtempSync(join(dir, "files-"));
    const filePath = join(withFile, `${record.work_id}.mp4`);
    writeFileSync(filePath, "");
    truncateSync(filePath, Number(record.byte_size));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const manifest = JSON.parse(readFileSync(FINAL_MANIFEST, "utf8"));
    manifest.works[0].sha256 = hash.digest("hex");
    const path = write("manifest.json", JSON.stringify(manifest));
    await expect(manifestFinalCheck(path, withFile).run()).resolves.toBe(
      "20 works, 5 cold, 19 files not verified",
    );
  });

  it("blocks the committed placeholder manifest with the first validator error", async () => {
    const raw: unknown = JSON.parse(readFileSync(PLACEHOLDER_MANIFEST, "utf8"));
    const { errors } = await validateManifest(raw, { filesDir, final: true });
    expect(errors.length).toBeGreaterThan(0);
    const message = await failure(manifestFinalCheck(PLACEHOLDER_MANIFEST, filesDir));
    expect(message).toContain(errors[0]);
    expect(message).toContain(`${errors.length} errors`);
  });

  it("blocks an unreadable manifest naming the path, never the contents", async () => {
    const path = write("broken.json", '{"notice": "top-secret-contents", ');
    const message = await failure(manifestFinalCheck(path, filesDir));
    expect(message).toBe(`manifest ${path} is unreadable or not valid JSON`);
    const absent = await failure(manifestFinalCheck(join(dir, "absent.json"), filesDir));
    expect(absent).toContain("absent.json is unreadable");
  });
});

describe("goldenMatchesManifestCheck", () => {
  it("passes when the golden has exactly the manifest's works with the same cold_cid", async () => {
    const check = goldenMatchesManifestCheck(goldenFile(GOLDEN), FINAL_MANIFEST);
    expect([check.stage, check.name]).toEqual(["h2", "golden ↔ manifest"]);
    await expect(check.run()).resolves.toBe("20 works match, 5 cold");
  });

  it("blocks a golden missing a manifest work", async () => {
    const golden = goldenFile(GOLDEN.filter((r) => r.work_id !== "pd-007"));
    expect(await failure(goldenMatchesManifestCheck(golden, FINAL_MANIFEST))).toBe(
      "missing in golden: pd-007",
    );
  });

  it("blocks a golden with a work the manifest does not have", async () => {
    const manifest = manifestFile(GOLDEN.filter((r) => r.work_id !== "pd-020"));
    expect(await failure(goldenMatchesManifestCheck(goldenFile(GOLDEN), manifest))).toBe(
      "not in manifest: pd-020",
    );
  });

  it("blocks a duplicate golden record", async () => {
    const golden = goldenFile([...GOLDEN, GOLDEN[0]!]);
    const message = await failure(goldenMatchesManifestCheck(golden, FINAL_MANIFEST));
    expect(message).toBe(`${golden}: duplicate work_id pd-001`);
  });

  it("blocks a cold_cid mismatch", async () => {
    const golden = goldenFile(
      GOLDEN.map((r) => (r.work_id === "pd-003" ? { ...r, cold_cid: true } : r)),
    );
    expect(await failure(goldenMatchesManifestCheck(golden, FINAL_MANIFEST))).toBe(
      "pd-003: cold_cid golden true, manifest false",
    );
  });

  it("blocks an unparseable golden line naming the path and line, not the contents", async () => {
    const golden = write("golden.ndjson", `${JSON.stringify(GOLDEN[0])}\n{"oops": "line-secret"\n`);
    const message = await failure(goldenMatchesManifestCheck(golden, FINAL_MANIFEST));
    expect(message).toBe(`${golden}:2: invalid JSON`);
  });
});

const PEERS = [1, 2, 3].map((n) => peerIdBytes(n));
const PEER_IDS = PEERS.map((b) => peerIdFromBytes(b, 38));
const topology = topologyFixture([
  { name: "a", peer_id: PEER_IDS[0]! },
  { name: "b", peer_id: PEER_IDS[1]! },
  { name: "c", peer_id: PEER_IDS[2]! },
]);

interface Declared {
  peer: Uint8Array;
  active: boolean;
}

function filmData(cid: string, declared: Declared[]): Uint8Array {
  const { cid: cidBytes, cidLen } = cidStringToBytes(cid);
  const empty = { peerId: new Uint8Array(38), peerIdLen: 0, declaredAt: 0n, active: false };
  return new Uint8Array(
    getFilmEncoder().encode({
      organization: address("11111111111111111111111111111111"),
      submitter: address("11111111111111111111111111111111"),
      cid: cidBytes,
      cidLen,
      byteSize: 1n,
      chunkingProfile: 1,
      title: "t",
      submittedAt: 1n,
      accessPolicy: 0,
      replicas: [
        ...declared.map((d) => ({
          peerId: d.peer,
          peerIdLen: 38,
          declaredAt: 2n,
          active: d.active,
        })),
        ...Array.from({ length: 8 - declared.length }, () => empty),
      ],
      replicaCount: declared.length,
      schemaVersion: 1,
      bump: 255,
    }),
  );
}

function filmRpc(accounts: Map<string, Uint8Array>, failFirst = 0): FilmRpc {
  let failures = failFirst;
  return {
    getAccountInfo: (addr: Address) => ({
      send: async () => {
        if (failures > 0) {
          failures--;
          throw new TypeError("fetch failed");
        }
        const data = accounts.get(addr);
        if (!data) return { context: { slot: 1n }, value: null };
        return {
          context: { slot: 1n },
          value: {
            executable: false,
            lamports: lamports(1n),
            owner: FILM_PROGRAM_ADDRESS,
            rentEpoch: 0n,
            space: BigInt(data.length),
            data: [Buffer.from(data).toString("base64"), "base64"],
          },
        };
      },
    }),
  } as unknown as FilmRpc;
}

const WORKS = GOLDEN.slice(0, 2);
const WORKS_FILE = goldenFile(WORKS);
const ALL_ACTIVE: Declared[] = PEERS.map((peer) => ({ peer, active: true }));

function films(overrides: Record<string, { cid?: string; declared?: Declared[] }> = {}) {
  return new Map(
    WORKS.map((w) => {
      const o = overrides[w.work_id] ?? {};
      return [w.film_pda, filmData(o.cid ?? w.cid, o.declared ?? ALL_ACTIVE)];
    }),
  );
}

describe("filmsMatchCheck", () => {
  const fast = { baseDelayMs: 0 };

  it("passes when every Film has the golden CID and declares exactly the topology replicas", async () => {
    const check = filmsMatchCheck(filmRpc(films()), WORKS_FILE, topology, fast);
    expect([check.stage, check.name]).toEqual(["h2", "Films ↔ golden ↔ topology"]);
    await expect(check.run()).resolves.toBe(
      "2 Films: CID matches golden, active replicas = 3 topology PeerIDs",
    );
  });

  it("blocks an extra declared peer, naming the work and the PeerID", async () => {
    const extra = peerIdBytes(9);
    const rpc = filmRpc(
      films({ "pd-001": { declared: [...ALL_ACTIVE, { peer: extra, active: true }] } }),
    );
    const message = await failure(filmsMatchCheck(rpc, WORKS_FILE, topology, fast));
    expect(message).toBe(`pd-001: extra ${peerIdFromBytes(extra, 38)}`);
    expect(message).toMatch(/^pd-001: extra 12D3KooW/);
  });

  it("blocks a missing peer", async () => {
    const rpc = filmRpc(films({ "pd-002": { declared: ALL_ACTIVE.slice(0, 2) } }));
    expect(await failure(filmsMatchCheck(rpc, WORKS_FILE, topology, fast))).toBe(
      `pd-002: missing ${PEER_IDS[2]}`,
    );
  });

  it("ignores an inactive declared peer", async () => {
    const declared = [...ALL_ACTIVE, { peer: peerIdBytes(9), active: false }];
    const rpc = filmRpc(films({ "pd-001": { declared } }));
    await expect(filmsMatchCheck(rpc, WORKS_FILE, topology, fast).run()).resolves.toContain(
      "2 Films",
    );
  });

  it("blocks a deactivated topology replica as missing", async () => {
    const declared = ALL_ACTIVE.map((d, i) => (i === 0 ? { ...d, active: false } : d));
    const rpc = filmRpc(films({ "pd-001": { declared } }));
    expect(await failure(filmsMatchCheck(rpc, WORKS_FILE, topology, fast))).toBe(
      `pd-001: missing ${PEER_IDS[0]}`,
    );
  });

  it("blocks a CID difference, and reports every failing work", async () => {
    const rpc = filmRpc(
      films({
        "pd-001": { cid: GOLDEN[5]!.cid },
        "pd-002": { declared: ALL_ACTIVE.slice(1) },
      }),
    );
    expect(await failure(filmsMatchCheck(rpc, WORKS_FILE, topology, fast))).toBe(
      `pd-001: cid differs; pd-002: missing ${PEER_IDS[0]}`,
    );
  });

  it("blocks a Film account that does not exist", async () => {
    const accounts = films();
    accounts.delete(WORKS[1]!.film_pda);
    const message = await failure(filmsMatchCheck(filmRpc(accounts), WORKS_FILE, topology, fast));
    expect(message).toMatch(/^pd-002: Film unreadable/);
  });

  it("retries a transient RPC failure through readFilm", async () => {
    const check = filmsMatchCheck(filmRpc(films(), 2), WORKS_FILE, topology, fast);
    await expect(check.run()).resolves.toContain("2 Films");
  });
});

describe("campaignFeasibleCheck", () => {
  it("expands h2-final.json against a 20-work golden in memory", async () => {
    const workDir = mkdtempSync(join(dir, "plan-"));
    const golden = join(workDir, "golden.ndjson");
    writeFileSync(golden, GOLDEN.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const check = campaignFeasibleCheck(FINAL_CAMPAIGN, golden, topology);
    expect([check.stage, check.name]).toEqual(["h2", "campaign plan"]);
    await expect(check.run()).resolves.toBe("370 attempts in 6 blocks over 20 works");
    expect(readdirSync(workDir)).toEqual(["golden.ndjson"]);
  });

  it("blocks a topology lacking replica c", async () => {
    const twoReplicas = topologyFixture(topology.replicas.slice(0, 2));
    expect(
      await failure(campaignFeasibleCheck(FINAL_CAMPAIGN, goldenFile(GOLDEN), twoReplicas)),
    ).toBe("campaign replica c is not in the topology");
  });

  it("blocks a campaign that fails validateCampaign", async () => {
    const spec = JSON.parse(readFileSync(FINAL_CAMPAIGN, "utf8"));
    spec.blocks[1].name = "main";
    const campaign = write("campaign.json", JSON.stringify(spec));
    expect(await failure(campaignFeasibleCheck(campaign, goldenFile(GOLDEN), topology))).toBe(
      "duplicate name main",
    );
  });

  it("blocks when the plan cannot be generated", async () => {
    const message = await failure(
      campaignFeasibleCheck(FINAL_CAMPAIGN, goldenFile(GOLDEN.slice(15)), topology),
    );
    expect(message).toBe("block main selects no works");
  });

  it("blocks an unreadable campaign naming the path only", async () => {
    const campaign = write("campaign.json", '{"campaign_version": "secret-ish"');
    expect(await failure(campaignFeasibleCheck(campaign, goldenFile(GOLDEN), topology))).toBe(
      `campaign ${campaign} is unreadable or not valid JSON`,
    );
  });
});
