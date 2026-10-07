import { getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { cidStringToBytes } from "./cid";
import { AccessPolicy, type Film, type ReplicaDeclaration } from "./generated/film";
import { inventoryRecordFromFilm, inventoryRecordSchema } from "./inventory";

const fakeAddress = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const EXAMPLE_CID = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";

function peerId(n: number): Uint8Array {
  const bytes = new Uint8Array(38);
  bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  bytes.fill(n, 6);
  return bytes;
}

const emptyReplica: ReplicaDeclaration = {
  peerId: new Uint8Array(38),
  peerIdLen: 0,
  declaredAt: 0n,
  active: false,
};

function film(): Film {
  return {
    discriminator: new Uint8Array(8),
    organization: fakeAddress(1),
    submitter: fakeAddress(2),
    cid: cidStringToBytes(EXAMPLE_CID).cid,
    cidLen: 36,
    byteSize: 9_007_199_254_740_993n,
    chunkingProfile: 1,
    title: "Duck and Cover",
    submittedAt: 1_790_000_003n,
    accessPolicy: AccessPolicy.Public,
    replicas: [
      { peerId: peerId(1), peerIdLen: 38, declaredAt: 1_790_000_004n, active: true },
      { peerId: peerId(2), peerIdLen: 38, declaredAt: 1_790_000_005n, active: false },
      ...Array.from({ length: 6 }, () => emptyReplica),
    ],
    replicaCount: 2,
    schemaVersion: 1,
    bump: 252,
  };
}

describe("inventoryRecordFromFilm", () => {
  const record = inventoryRecordFromFilm({
    workId: "pd-001",
    filmPda: fakeAddress(5),
    film: film(),
    sizeBand: "small",
    coldCid: true,
    sha256: "4ba23cfc250d9471a7f73aef6000313977e4a16df6ecff4d2eca46ed61f710ed",
    registerSignature: "sig-register",
    replicaSignatures: ["sig-r1", "sig-r2"],
    rpcEndpoint: "127.0.0.1:8899",
    capturedAt: new Date("2026-10-02T12:00:00Z"),
  });

  it("copies every account field, with 64-bit values as decimal strings", () => {
    expect(record).toMatchObject({
      work_id: "pd-001",
      film_pda: fakeAddress(5),
      organization: fakeAddress(1),
      submitter: fakeAddress(2),
      cid: EXAMPLE_CID,
      cid_len: 36,
      byte_size: "9007199254740993",
      chunking_profile: 1,
      title: "Duck and Cover",
      submitted_at: "1790000003",
      access_policy: "Public",
      replica_count: 2,
      schema_version: 1,
      bump: 252,
      captured_at: "2026-10-02T12:00:00.000Z",
    });
  });

  it("carries cold_cid", () => {
    expect(record.cold_cid).toBe(true);
  });

  it("keeps only declared replica slots, deactivated ones included, with hex PeerIDs", () => {
    expect(record.replicas).toEqual([
      {
        slot: 0,
        peer_id_hex: Buffer.from(peerId(1)).toString("hex"),
        peer_id_len: 38,
        declared_at: "1790000004",
        active: true,
      },
      {
        slot: 1,
        peer_id_hex: Buffer.from(peerId(2)).toString("hex"),
        peer_id_len: 38,
        declared_at: "1790000005",
        active: false,
      },
    ]);
  });

  it("stamps artifact versions", () => {
    expect(Object.keys(record.artifact_versions).sort()).toEqual([
      "backbone",
      "film",
      "organization",
    ]);
  });
});

describe("inventoryRecordSchema", () => {
  it("rejects a non-decimal byte_size and unknown keys", () => {
    const base = inventoryRecordFromFilm({
      workId: "pd-001",
      filmPda: fakeAddress(5),
      film: film(),
      sizeBand: "small",
      coldCid: false,
      sha256: "0".repeat(64),
      registerSignature: "s",
      replicaSignatures: [],
      rpcEndpoint: "h",
    });
    expect(inventoryRecordSchema.safeParse({ ...base, byte_size: "12.5" }).success).toBe(false);
    expect(inventoryRecordSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("rejects a record without cold_cid", () => {
    const base = inventoryRecordFromFilm({
      workId: "pd-001",
      filmPda: fakeAddress(5),
      film: film(),
      sizeBand: "small",
      coldCid: false,
      sha256: "0".repeat(64),
      registerSignature: "s",
      replicaSignatures: [],
      rpcEndpoint: "h",
    });
    const { cold_cid: _omitted, ...without } = base;
    expect(inventoryRecordSchema.safeParse(without).success).toBe(false);
  });
});
