import { inventoryRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";

export function goldenFixture(overrides: Partial<InventoryRecord> = {}): InventoryRecord {
  return inventoryRecordSchema.parse({
    work_id: "pd-901",
    film_pda: "Film1111111111111111111111111111111111111111",
    organization: "org",
    submitter: "sub",
    cid: "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem",
    cid_len: 36,
    byte_size: "57591076",
    chunking_profile: 1,
    title: "t",
    submitted_at: "1",
    access_policy: "Public",
    replica_count: 3,
    replicas: [],
    schema_version: 1,
    bump: 255,
    size_band: "small",
    cold_cid: false,
    sha256: "0".repeat(64),
    register_signature: "sig",
    replica_signatures: [],
    rpc_endpoint: "h",
    captured_at: "2026-10-06T12:00:00.000Z",
    artifact_versions: {},
    ...overrides,
  });
}
