import {
  getAddressDecoder,
  getBase58Encoder,
  getBase64Decoder,
  isJsonRpcPayload,
  type Address,
  type RpcTransport,
} from "@solana/kit";
import type { CatalogSnapshot } from "@spiral-backbone/db";
import { cidStringToBytes } from "@spiral-backbone/protocol";
import {
  AccessPolicy,
  FILM_PROGRAM_ADDRESS,
  getFilmEncoder,
  type ReplicaDeclarationArgs,
} from "@spiral-backbone/protocol/generated/film";
import {
  getMembershipEncoder,
  getOrganizationEncoder,
  MembershipStatus,
  ORGANIZATION_PROGRAM_ADDRESS,
  Role,
} from "@spiral-backbone/protocol/generated/organization";

export interface FakeAccount {
  address: Address;
  owner: Address;
  data: Uint8Array;
}

export function fakeAddress(n: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(n));
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

export function createFakeChainTransport(accounts: FakeAccount[]) {
  const requests: { method: string; params: unknown[] }[] = [];
  const base64 = getBase64Decoder();
  const byAddress = new Map(accounts.map((account) => [account.address as string, account]));
  const encode = (account: FakeAccount, data: Uint8Array) => ({
    data: [base64.decode(data), "base64"],
    executable: false,
    lamports: 1_000_000,
    owner: account.owner,
    rentEpoch: 0,
    space: account.data.length,
  });

  const transport = (async ({ payload }: { payload: unknown }) => {
    if (!isJsonRpcPayload(payload)) throw new Error("fake chain: unsupported payload");
    const { method, params } = payload as { method: string; params: unknown[] };
    const id = (payload as { id?: unknown }).id;
    requests.push({ method, params });
    if (method === "getProgramAccounts") {
      const [program, config] = params as [string, { filters: { memcmp: { bytes: string } }[] }];
      const discriminator = getBase58Encoder().encode(config.filters[0]!.memcmp.bytes);
      const result = accounts
        .filter(
          (account) =>
            account.owner === program && startsWith(account.data, new Uint8Array(discriminator)),
        )
        .map((account) => ({
          pubkey: account.address,
          account: encode(account, new Uint8Array(0)),
        }));
      return { jsonrpc: "2.0", id, result };
    }
    if (method === "getMultipleAccounts") {
      const [addresses] = params as [string[]];
      const value = addresses.map((address) => {
        const account = byAddress.get(address);
        return account ? encode(account, account.data) : null;
      });
      return { jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } };
    }
    throw new Error(`fake chain: unsupported method ${method}`);
  }) as unknown as RpcTransport;

  return { transport, requests };
}

const EXAMPLE_CID = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";

export function fixturePeerId(n: number): Uint8Array {
  const bytes = new Uint8Array(38);
  bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  bytes.fill(n, 6);
  return bytes;
}

/** One org, two memberships (one revoked), one film with an active and a deactivated replica. */
export function sampleChain(): { accounts: FakeAccount[]; expected: CatalogSnapshot } {
  const org = fakeAddress(1);
  const admin = fakeAddress(10);
  const revokedMember = fakeAddress(11);
  const { cid } = cidStringToBytes(EXAMPLE_CID);
  const emptyReplica: ReplicaDeclarationArgs = {
    peerId: new Uint8Array(38),
    peerIdLen: 0,
    declaredAt: 0n,
    active: false,
  };

  const accounts: FakeAccount[] = [
    {
      address: org,
      owner: ORGANIZATION_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getOrganizationEncoder().encode({
          authority: admin,
          slug: "alpha",
          name: "Alpha — Acervo",
          createdAt: 1_790_000_000n,
          memberCount: 2,
          schemaVersion: 1,
          bump: 255,
        }),
      ),
    },
    {
      address: fakeAddress(2),
      owner: ORGANIZATION_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getMembershipEncoder().encode({
          organization: org,
          member: admin,
          role: Role.Admin,
          status: MembershipStatus.Active,
          grantedBy: admin,
          grantedAt: 1_790_000_000n,
          revokedAt: 0n,
          bump: 254,
        }),
      ),
    },
    {
      address: fakeAddress(3),
      owner: ORGANIZATION_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getMembershipEncoder().encode({
          organization: org,
          member: revokedMember,
          role: Role.Submitter,
          status: MembershipStatus.Revoked,
          grantedBy: admin,
          grantedAt: 1_790_000_001n,
          revokedAt: 1_790_000_002n,
          bump: 253,
        }),
      ),
    },
    {
      address: fakeAddress(4),
      owner: FILM_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getFilmEncoder().encode({
          organization: org,
          submitter: admin,
          cid,
          cidLen: 36,
          byteSize: 9_007_199_254_740_993n,
          chunkingProfile: 1,
          title: "Duck and Cover",
          submittedAt: 1_790_000_003n,
          accessPolicy: AccessPolicy.Public,
          replicas: [
            { peerId: fixturePeerId(1), peerIdLen: 38, declaredAt: 1_790_000_004n, active: true },
            { peerId: fixturePeerId(2), peerIdLen: 38, declaredAt: 1_790_000_005n, active: false },
            ...Array.from({ length: 6 }, () => emptyReplica),
          ],
          replicaCount: 2,
          schemaVersion: 1,
          bump: 252,
        }),
      ),
    },
  ];

  const expected: CatalogSnapshot = {
    organizations: [
      {
        address: org,
        authority: admin,
        slug: "alpha",
        name: "Alpha — Acervo",
        createdAt: 1_790_000_000n,
        memberCount: 2,
        schemaVersion: 1,
        bump: 255,
      },
    ],
    memberships: [
      {
        address: fakeAddress(2),
        organization: org,
        member: admin,
        role: "Admin",
        status: "Active",
        grantedBy: admin,
        grantedAt: 1_790_000_000n,
        revokedAt: 0n,
        bump: 254,
      },
      {
        address: fakeAddress(3),
        organization: org,
        member: revokedMember,
        role: "Submitter",
        status: "Revoked",
        grantedBy: admin,
        grantedAt: 1_790_000_001n,
        revokedAt: 1_790_000_002n,
        bump: 253,
      },
    ],
    films: [
      {
        address: fakeAddress(4),
        organization: org,
        submitter: admin,
        cid: cid.slice(0, 36),
        cidLen: 36,
        byteSize: 9_007_199_254_740_993n,
        chunkingProfile: 1,
        title: "Duck and Cover",
        submittedAt: 1_790_000_003n,
        accessPolicy: "Public",
        replicaCount: 2,
        schemaVersion: 1,
        bump: 252,
      },
    ],
    filmReplicas: [
      {
        film: fakeAddress(4),
        slot: 0,
        peerId: fixturePeerId(1),
        peerIdLen: 38,
        declaredAt: 1_790_000_004n,
        active: true,
      },
      {
        film: fakeAddress(4),
        slot: 1,
        peerId: fixturePeerId(2),
        peerIdLen: 38,
        declaredAt: 1_790_000_005n,
        active: false,
      },
    ],
  };

  return { accounts, expected };
}
