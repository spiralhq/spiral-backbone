import type { CatalogSnapshot } from "@spiral-backbone/db";
import { inventoryRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import { compareWithGolden, filmRecordsFromGolden } from "./compare";

const CID = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";
const PEER = "00240801122001010101010101010101010101010101010101010101010101010101";

function golden(overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  return inventoryRecordSchema.parse({
    work_id: "pd-001",
    film_pda: "film-1",
    organization: "org-1",
    submitter: "sub",
    cid: CID,
    cid_len: 36,
    byte_size: "9007199254740993",
    chunking_profile: 1,
    title: "Duck and Cover",
    submitted_at: "1790000003",
    access_policy: "Public",
    replica_count: 1,
    replicas: [
      { slot: 0, peer_id_hex: PEER, peer_id_len: 38, declared_at: "1790000004", active: true },
    ],
    schema_version: 1,
    bump: 252,
    size_band: "small",
    sha256: "0".repeat(64),
    register_signature: "sig",
    replica_signatures: ["sig-r"],
    rpc_endpoint: "h",
    captured_at: "2026-10-02T12:00:00.000Z",
    artifact_versions: {},
    ...overrides,
  });
}

function catalogFrom(records: InventoryRecord[]): CatalogSnapshot {
  const { films, filmReplicas } = filmRecordsFromGolden(records);
  return {
    organizations: [...new Set(records.map((r) => r.organization))].map((address) => ({
      address,
      authority: "a",
      slug: address,
      name: address,
      createdAt: 1n,
      memberCount: 1,
      schemaVersion: 1,
      bump: 255,
    })),
    memberships: [],
    films,
    filmReplicas,
  };
}

describe("filmRecordsFromGolden", () => {
  it("rebuilds exact bytes and bigints", () => {
    const { films, filmReplicas } = filmRecordsFromGolden([golden()]);
    expect(films[0]!.cid).toHaveLength(36);
    expect(films[0]!.byteSize).toBe(9_007_199_254_740_993n);
    expect(Buffer.from(filmReplicas[0]!.peerId).toString("hex")).toBe(PEER);
    expect(filmReplicas[0]!.declaredAt).toBe(1_790_000_004n);
  });
});

describe("compareWithGolden", () => {
  it("finds nothing when the rebuild matches", () => {
    const result = compareWithGolden([golden()], catalogFrom([golden()]));
    expect(result.diffs).toEqual([]);
    expect(result.missingOrganizations).toEqual([]);
    expect(result.rebuiltCount).toBe(1);
    expect(result.failingFilms.size).toBe(0);
  });

  it("reports a field divergence and marks the film failing", () => {
    const result = compareWithGolden([golden()], catalogFrom([golden({ title: "tampered" })]));
    expect(result.diffs).toEqual([
      {
        table: "films",
        key: "film-1",
        kind: "field",
        field: "title",
        expected: '"Duck and Cover"',
        actual: '"tampered"',
      },
    ]);
    expect([...result.failingFilms]).toEqual(["film-1"]);
  });

  it("reports a deactivated replica as a divergence", () => {
    const deactivated = golden({
      replicas: [
        { slot: 0, peer_id_hex: PEER, peer_id_len: 38, declared_at: "1790000004", active: false },
      ],
    });
    expect(compareWithGolden([golden()], catalogFrom([deactivated])).diffs).toEqual([
      {
        table: "filmReplicas",
        key: "film-1#0",
        kind: "field",
        field: "active",
        expected: "true",
        actual: "false",
      },
    ]);
  });

  it("flags extra films in a golden organization as unexpected", () => {
    const extra = golden({ work_id: "pd-002", film_pda: "film-2" });
    const result = compareWithGolden([golden()], catalogFrom([golden(), extra]));
    expect(result.diffs).toContainEqual({ table: "films", key: "film-2", kind: "unexpected" });
  });

  it("fails every work of a golden from another deployment and lists its organizations", () => {
    const result = compareWithGolden([golden()], {
      organizations: [],
      memberships: [],
      films: [],
      filmReplicas: [],
    });
    expect(result.missingOrganizations).toEqual(["org-1"]);
    expect(result.rebuiltCount).toBe(0);
    expect([...result.failingFilms]).toEqual(["film-1"]);
    expect(result.diffs).toContainEqual({ table: "films", key: "film-1", kind: "missing" });
  });
});
