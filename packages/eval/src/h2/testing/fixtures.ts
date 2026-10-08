import { createHash } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { inventoryRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { topologySchema, type Topology, type TopologyInput } from "../topology";

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

type Band = NonNullable<InventoryRecord["size_band"]>;

const BANDS: { band: Band; bytes: number }[] = [
  ...Array.from({ length: 7 }, () => ({ band: "small" as const, bytes: 57_591_076 })),
  ...Array.from({ length: 8 }, () => ({ band: "medium" as const, bytes: 250_000_000 })),
  ...Array.from({ length: 5 }, () => ({ band: "large" as const, bytes: 700_000_000 })),
];

export function goldenFixtures20(): InventoryRecord[] {
  return BANDS.map(({ band, bytes }, i) => {
    const seed = createHash("sha256").update(`golden-${i}`).digest();
    const cid = CID.createV1(0x55, createDigest(0x12, seed));
    return goldenFixture({
      work_id: `pd-${String(i + 1).padStart(3, "0")}`,
      film_pda: getAddressDecoder().decode(seed),
      cid: cid.toString(),
      cid_len: cid.bytes.length,
      byte_size: String(bytes + i * 1_000_003),
      size_band: band,
      cold_cid: i >= 15,
    });
  });
}

export function peerIdBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(38);
  bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  bytes.fill(n, 6);
  return bytes;
}

export function topologyFixture(
  replicas: { name: string; peer_id: string }[],
  overrides: Partial<TopologyInput> = {},
): Topology {
  return topologySchema.parse({
    topology_version: 1,
    replicas: replicas.map((r, i) => ({
      ...r,
      ssh: { host: "127.0.0.1", port: 2200 + i, user: "spiral", identity_file: "/k" },
    })),
    network_node: { api_url: "http://127.0.0.1:5001", bootstrap_multiaddr: null },
    gateway_url: "http://127.0.0.1:8080",
    rpc_url: "http://127.0.0.1:8899",
    executor: {
      image: "img",
      docker_network: null,
      add_hosts: [],
      swarm_key_path: null,
      block_cidrs: [],
      repo_root: "/repo",
    },
    ...overrides,
  });
}
