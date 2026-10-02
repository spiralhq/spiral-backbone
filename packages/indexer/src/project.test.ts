import { address, getAddressDecoder } from "@solana/kit";
import { cidStringToBytes } from "@spiral-backbone/protocol";
import {
  AccessPolicy,
  type Film,
  type ReplicaDeclaration,
} from "@spiral-backbone/protocol/generated/film";
import { MembershipStatus, Role } from "@spiral-backbone/protocol/generated/organization";
import { describe, expect, it } from "vitest";
import {
  InvalidAccountError,
  projectFilm,
  projectMembership,
  projectOrganization,
} from "./project";

const fakeAddress = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const DISCRIMINATOR = new Uint8Array(8);
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

function film(overrides: Partial<Film> = {}): Film {
  const { cid } = cidStringToBytes(EXAMPLE_CID);
  return {
    discriminator: DISCRIMINATOR,
    organization: fakeAddress(1),
    submitter: fakeAddress(2),
    cid,
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
    ...overrides,
  };
}

describe("projectOrganization", () => {
  it("copies every account field and adds the address", () => {
    const record = projectOrganization(fakeAddress(9), {
      discriminator: DISCRIMINATOR,
      authority: fakeAddress(1),
      slug: "alpha",
      name: "Alpha — Acervo",
      createdAt: 1_790_000_000n,
      memberCount: 4,
      schemaVersion: 1,
      bump: 255,
    });
    expect(record).toEqual({
      address: fakeAddress(9),
      authority: fakeAddress(1),
      slug: "alpha",
      name: "Alpha — Acervo",
      createdAt: 1_790_000_000n,
      memberCount: 4,
      schemaVersion: 1,
      bump: 255,
    });
  });

  it("rejects an unsupported schema_version, naming the address", () => {
    expect(() =>
      projectOrganization(fakeAddress(9), {
        discriminator: DISCRIMINATOR,
        authority: fakeAddress(1),
        slug: "alpha",
        name: "Alpha",
        createdAt: 1n,
        memberCount: 0,
        schemaVersion: 2,
        bump: 255,
      }),
    ).toThrow(
      new InvalidAccountError(
        `organization ${fakeAddress(9)}: schema_version 2 is not supported (expected 1)`,
      ),
    );
  });
});

describe("projectMembership", () => {
  it("maps enum discriminants to their names", () => {
    const record = projectMembership(fakeAddress(3), {
      discriminator: DISCRIMINATOR,
      organization: fakeAddress(1),
      member: fakeAddress(4),
      role: Role.Submitter,
      status: MembershipStatus.Revoked,
      grantedBy: fakeAddress(2),
      grantedAt: 10n,
      revokedAt: 11n,
      bump: 253,
    });
    expect(record.role).toBe("Submitter");
    expect(record.status).toBe("Revoked");
    expect(record.revokedAt).toBe(11n);
  });
});

describe("projectFilm", () => {
  it("trims the CID to cid_len and keeps it as bytes", () => {
    const { film: record } = projectFilm(fakeAddress(5), film());
    expect(record.cid).toEqual(cidStringToBytes(EXAMPLE_CID).cid.slice(0, 36));
    expect(record.cidLen).toBe(36);
    expect(record.byteSize).toBe(9_007_199_254_740_993n);
    expect(record.accessPolicy).toBe("Public");
  });

  it("emits one replica row per slot below replica_count, including deactivated ones", () => {
    const { replicas } = projectFilm(fakeAddress(5), film());
    expect(replicas).toEqual([
      {
        film: fakeAddress(5),
        slot: 0,
        peerId: peerId(1),
        peerIdLen: 38,
        declaredAt: 1_790_000_004n,
        active: true,
      },
      {
        film: fakeAddress(5),
        slot: 1,
        peerId: peerId(2),
        peerIdLen: 38,
        declaredAt: 1_790_000_005n,
        active: false,
      },
    ]);
  });

  it("rejects an unsupported schema_version, naming the address", () => {
    expect(() => projectFilm(fakeAddress(5), film({ schemaVersion: 2 }))).toThrow(
      new InvalidAccountError(
        `film ${fakeAddress(5)}: schema_version 2 is not supported (expected 1)`,
      ),
    );
  });

  it("emits no replica rows when replica_count is 0", () => {
    expect(projectFilm(fakeAddress(5), film({ replicaCount: 0 })).replicas).toEqual([]);
  });

  it.each([
    ["cid_len 0", { cidLen: 0 }],
    ["cid_len 65", { cidLen: 65 }],
    ["replica_count 9", { replicaCount: 9 }],
  ])("rejects an out-of-range account (%s) naming its address", (_label, overrides) => {
    expect(() => projectFilm(address("11111111111111111111111111111111"), film(overrides))).toThrow(
      InvalidAccountError,
    );
    expect(() => projectFilm(address("11111111111111111111111111111111"), film(overrides))).toThrow(
      "11111111111111111111111111111111",
    );
  });

  it("rejects a replica whose peer_id_len exceeds 38", () => {
    const replicas = film().replicas.map((replica, slot) =>
      slot === 0 ? { ...replica, peerIdLen: 39 } : replica,
    );
    expect(() => projectFilm(fakeAddress(5), film({ replicas }))).toThrow(InvalidAccountError);
  });
});
