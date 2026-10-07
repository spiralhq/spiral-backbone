import { z } from "zod";
import { artifactVersions } from "./artifacts";
import { bytesToCidString } from "./cid";
import { AccessPolicy, type Film } from "./generated/film";

const decimal = z.string().regex(/^-?\d+$/);

export const inventoryReplicaSchema = z
  .object({
    slot: z.number().int().min(0).max(7),
    peer_id_hex: z.string().regex(/^([0-9a-f]{2})*$/),
    peer_id_len: z.number().int().min(0).max(38),
    declared_at: decimal,
    active: z.boolean(),
  })
  .strict();

export const inventoryRecordSchema = z
  .object({
    work_id: z.string().min(1),
    film_pda: z.string().min(1),
    organization: z.string().min(1),
    submitter: z.string().min(1),
    cid: z.string().min(1),
    cid_len: z.number().int().min(1).max(64),
    byte_size: decimal,
    chunking_profile: z.number().int(),
    title: z.string(),
    submitted_at: decimal,
    access_policy: z.enum(["Public", "OrganizationOnly"]),
    replica_count: z.number().int().min(0).max(8),
    replicas: z.array(inventoryReplicaSchema),
    schema_version: z.number().int(),
    bump: z.number().int(),
    size_band: z.enum(["small", "medium", "large"]),
    cold_cid: z.boolean(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    register_signature: z.string().min(1),
    replica_signatures: z.array(z.string()),
    rpc_endpoint: z.string(),
    captured_at: z.string(),
    artifact_versions: z.record(z.string(), z.string()),
  })
  .strict();

export type InventoryRecord = z.infer<typeof inventoryRecordSchema>;

export function inventoryRecordFromFilm(input: {
  workId: string;
  filmPda: string;
  film: Film;
  sizeBand: "small" | "medium" | "large";
  coldCid: boolean;
  sha256: string;
  registerSignature: string;
  replicaSignatures: string[];
  rpcEndpoint: string;
  capturedAt?: Date;
}): InventoryRecord {
  const { film } = input;
  return inventoryRecordSchema.parse({
    work_id: input.workId,
    film_pda: input.filmPda,
    organization: film.organization,
    submitter: film.submitter,
    cid: bytesToCidString(new Uint8Array(film.cid), film.cidLen),
    cid_len: film.cidLen,
    byte_size: film.byteSize.toString(),
    chunking_profile: film.chunkingProfile,
    title: film.title,
    submitted_at: film.submittedAt.toString(),
    access_policy: AccessPolicy[film.accessPolicy],
    replica_count: film.replicaCount,
    replicas: film.replicas.slice(0, film.replicaCount).map((replica, slot) => ({
      slot,
      peer_id_hex: Buffer.from(replica.peerId.slice(0, replica.peerIdLen)).toString("hex"),
      peer_id_len: replica.peerIdLen,
      declared_at: replica.declaredAt.toString(),
      active: replica.active,
    })),
    schema_version: film.schemaVersion,
    bump: film.bump,
    size_band: input.sizeBand,
    cold_cid: input.coldCid,
    sha256: input.sha256,
    register_signature: input.registerSignature,
    replica_signatures: input.replicaSignatures,
    rpc_endpoint: input.rpcEndpoint,
    captured_at: (input.capturedAt ?? new Date()).toISOString(),
    artifact_versions: artifactVersions(),
  });
}
