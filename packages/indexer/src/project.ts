import type { Address } from "@solana/kit";
import type {
  FilmRecord,
  FilmReplicaRecord,
  MembershipRecord,
  OrganizationRecord,
} from "@spiral-backbone/db";
import { AccessPolicy, type Film } from "@spiral-backbone/protocol/generated/film";
import {
  MembershipStatus,
  Role,
  type Membership,
  type Organization,
} from "@spiral-backbone/protocol/generated/organization";

const MAX_CID_LEN = 64;
const MAX_REPLICAS = 8;
const MAX_PEER_ID_LEN = 38;
const SUPPORTED_SCHEMA_VERSION = 1;

export class InvalidAccountError extends Error {}

function assertSchemaVersion(kind: string, address: Address, schemaVersion: number): void {
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new InvalidAccountError(
      `${kind} ${address}: schema_version ${schemaVersion} is not supported (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  }
}

export function projectOrganization(address: Address, account: Organization): OrganizationRecord {
  assertSchemaVersion("organization", address, account.schemaVersion);
  return {
    address,
    authority: account.authority,
    slug: account.slug,
    name: account.name,
    createdAt: account.createdAt,
    memberCount: account.memberCount,
    schemaVersion: account.schemaVersion,
    bump: account.bump,
  };
}

export function projectMembership(address: Address, account: Membership): MembershipRecord {
  return {
    address,
    organization: account.organization,
    member: account.member,
    role: Role[account.role] as MembershipRecord["role"],
    status: MembershipStatus[account.status] as MembershipRecord["status"],
    grantedBy: account.grantedBy,
    grantedAt: account.grantedAt,
    revokedAt: account.revokedAt,
    bump: account.bump,
  };
}

export function projectFilm(
  address: Address,
  account: Film,
): { film: FilmRecord; replicas: FilmReplicaRecord[] } {
  assertSchemaVersion("film", address, account.schemaVersion);
  if (account.cidLen < 1 || account.cidLen > MAX_CID_LEN) {
    throw new InvalidAccountError(
      `film ${address}: cid_len ${account.cidLen} outside 1..${MAX_CID_LEN}`,
    );
  }
  if (account.replicaCount > MAX_REPLICAS) {
    throw new InvalidAccountError(
      `film ${address}: replica_count ${account.replicaCount} exceeds ${MAX_REPLICAS}`,
    );
  }
  const replicas = account.replicas.slice(0, account.replicaCount).map((replica, slot) => {
    if (replica.peerIdLen > MAX_PEER_ID_LEN) {
      throw new InvalidAccountError(
        `film ${address}: replica ${slot} peer_id_len ${replica.peerIdLen} exceeds ${MAX_PEER_ID_LEN}`,
      );
    }
    return {
      film: address,
      slot,
      peerId: new Uint8Array(replica.peerId.slice(0, replica.peerIdLen)),
      peerIdLen: replica.peerIdLen,
      declaredAt: replica.declaredAt,
      active: replica.active,
    };
  });
  return {
    film: {
      address,
      organization: account.organization,
      submitter: account.submitter,
      cid: new Uint8Array(account.cid.slice(0, account.cidLen)),
      cidLen: account.cidLen,
      byteSize: account.byteSize,
      chunkingProfile: account.chunkingProfile,
      title: account.title,
      submittedAt: account.submittedAt,
      accessPolicy: AccessPolicy[account.accessPolicy] as FilmRecord["accessPolicy"],
      replicaCount: account.replicaCount,
      schemaVersion: account.schemaVersion,
      bump: account.bump,
    },
    replicas,
  };
}
