import {
  createClient,
  generateKeyPairSigner,
  getProgramDerivedAddress,
  type Address,
  type GetAccountInfoApi,
  type Rpc,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";
import type { CatalogSnapshot, MembershipRecord } from "@spiral-backbone/db";
import {
  cidStringToBytes,
  findFilmPda,
  findMembershipPda,
  findOrganizationPda,
} from "@spiral-backbone/protocol";
import {
  FILM_PROGRAM_ADDRESS,
  fetchFilm,
  getDeactivateReplicaInstruction,
  getDeclareReplicaInstruction,
  getRegisterFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import {
  fetchMembership,
  fetchOrganization,
  getGrantMembershipInstructionAsync,
  getInitializeOrganizationInstructionAsync,
  getRevokeMembershipInstructionAsync,
  ORGANIZATION_PROGRAM_ADDRESS,
  Role,
} from "@spiral-backbone/protocol/generated/organization";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { fixturePeerId } from "../testing/fake-chain";

export function createFixtureClient(keypairPath: string, rpcUrl: string, wsUrl: string) {
  return createClient()
    .use(signerFromFile(keypairPath))
    .use(solanaRpc({ rpcUrl, rpcSubscriptionsUrl: wsUrl }));
}

export type FixtureClient = Awaited<ReturnType<typeof createFixtureClient>>;

interface SeededOrganization {
  address: Address;
  slug: string;
  name: string;
  memberCount: number;
}

interface SeededMembership {
  address: Address;
  organization: Address;
  member: Address;
  role: MembershipRecord["role"];
  status: MembershipRecord["status"];
}

interface SeededFilm {
  address: Address;
  organization: Address;
  cid: Uint8Array;
  cidLen: number;
  title: string;
  byteSize: bigint;
  replicas: { peerId: Uint8Array; active: boolean }[];
}

export interface SeededCatalog {
  organizations: SeededOrganization[];
  memberships: SeededMembership[];
  films: SeededFilm[];
}

async function eventAuthority(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [new TextEncoder().encode("__event_authority")],
  });
  return pda;
}

async function fixtureCid(label: string) {
  const digest = await sha256.digest(new TextEncoder().encode(label));
  return cidStringToBytes(CID.create(1, 0x70, digest).toString());
}

async function createOrganization(
  client: FixtureClient,
  slug: string,
  name: string,
): Promise<Address> {
  await client.sendTransaction([
    await getInitializeOrganizationInstructionAsync({ authority: client.payer, slug, name }),
  ]);
  const [address] = await findOrganizationPda({ slug });
  return address;
}

async function grant(
  client: FixtureClient,
  organization: Address,
  member: Address,
  role: Role,
): Promise<Address> {
  await client.sendTransaction([
    await getGrantMembershipInstructionAsync({
      authority: client.payer,
      organization,
      member,
      role,
    }),
  ]);
  const [address] = await findMembershipPda({ organization, member });
  return address;
}

async function revoke(
  client: FixtureClient,
  organization: Address,
  member: Address,
  membership: Address,
) {
  await client.sendTransaction([
    await getRevokeMembershipInstructionAsync({
      authority: client.payer,
      organization,
      member,
      membership,
      eventAuthority: await eventAuthority(ORGANIZATION_PROGRAM_ADDRESS),
      program: ORGANIZATION_PROGRAM_ADDRESS,
    }),
  ]);
}

async function registerFilm(
  client: FixtureClient,
  organization: Address,
  cid: { cid: Uint8Array; cidLen: number },
  title: string,
  byteSize: bigint,
): Promise<Address> {
  const [film] = await findFilmPda({ organization, cid: cid.cid, cidLen: cid.cidLen });
  const [membership] = await findMembershipPda({ organization, member: client.payer.address });
  await client.sendTransaction([
    getRegisterFilmInstruction({
      submitter: client.payer,
      organization,
      membership,
      film,
      eventAuthority: await eventAuthority(FILM_PROGRAM_ADDRESS),
      program: FILM_PROGRAM_ADDRESS,
      cid: cid.cid,
      cidLen: cid.cidLen,
      byteSize,
      chunkingProfile: 1,
      title,
    }),
  ]);
  return film;
}

async function declare(client: FixtureClient, film: Address, peer: number) {
  await client.sendTransaction([
    getDeclareReplicaInstruction({
      film,
      submitter: client.payer,
      peerId: fixturePeerId(peer),
      peerIdLen: 38,
    }),
  ]);
}

export async function seedCatalog(client: FixtureClient): Promise<SeededCatalog> {
  const payer = client.payer.address;
  const alpha = await createOrganization(client, "h4-alpha", "Alpha Archive");
  const beta = await createOrganization(client, "h4-beta", "Beta — Acervo Público");

  const submitter = (await generateKeyPairSigner()).address;
  const reader = (await generateKeyPairSigner()).address;
  const revoked = (await generateKeyPairSigner()).address;
  const submitterMembership = await grant(client, alpha, submitter, Role.Submitter);
  const readerMembership = await grant(client, alpha, reader, Role.Reader);
  const revokedMembership = await grant(client, alpha, revoked, Role.Submitter);
  await revoke(client, alpha, revoked, revokedMembership);

  const cid1 = await fixtureCid("h4-film-1");
  const cid2 = await fixtureCid("h4-film-2");
  const film1 = await registerFilm(client, alpha, cid1, "Duck and Cover (fixture)", 57_591_076n);
  await declare(client, film1, 1);
  await declare(client, film1, 2);
  await declare(client, film1, 3);
  await client.sendTransaction([
    getDeactivateReplicaInstruction({ film: film1, submitter: client.payer, index: 1 }),
  ]);
  const film2 = await registerFilm(client, alpha, cid2, "Sem réplicas — ação", 2n ** 40n);
  const film3 = await registerFilm(client, beta, cid1, "Duck and Cover (beta copy)", 57_591_076n);
  await declare(client, film3, 4);

  const [alphaAdmin] = await findMembershipPda({ organization: alpha, member: payer });
  const [betaAdmin] = await findMembershipPda({ organization: beta, member: payer });
  const trimmed = (cid: { cid: Uint8Array; cidLen: number }) => cid.cid.slice(0, cid.cidLen);

  return {
    organizations: [
      { address: alpha, slug: "h4-alpha", name: "Alpha Archive", memberCount: 4 },
      { address: beta, slug: "h4-beta", name: "Beta — Acervo Público", memberCount: 1 },
    ],
    memberships: [
      { address: alphaAdmin, organization: alpha, member: payer, role: "Admin", status: "Active" },
      {
        address: submitterMembership,
        organization: alpha,
        member: submitter,
        role: "Submitter",
        status: "Active",
      },
      {
        address: readerMembership,
        organization: alpha,
        member: reader,
        role: "Reader",
        status: "Active",
      },
      {
        address: revokedMembership,
        organization: alpha,
        member: revoked,
        role: "Submitter",
        status: "Revoked",
      },
      { address: betaAdmin, organization: beta, member: payer, role: "Admin", status: "Active" },
    ],
    films: [
      {
        address: film1,
        organization: alpha,
        cid: trimmed(cid1),
        cidLen: cid1.cidLen,
        title: "Duck and Cover (fixture)",
        byteSize: 57_591_076n,
        replicas: [
          { peerId: fixturePeerId(1), active: true },
          { peerId: fixturePeerId(2), active: false },
          { peerId: fixturePeerId(3), active: true },
        ],
      },
      {
        address: film2,
        organization: alpha,
        cid: trimmed(cid2),
        cidLen: cid2.cidLen,
        title: "Sem réplicas — ação",
        byteSize: 2n ** 40n,
        replicas: [],
      },
      {
        address: film3,
        organization: beta,
        cid: trimmed(cid1),
        cidLen: cid1.cidLen,
        title: "Duck and Cover (beta copy)",
        byteSize: 57_591_076n,
        replicas: [{ peerId: fixturePeerId(4), active: true }],
      },
    ],
  };
}

export async function buildExpectedSnapshot(
  rpc: Rpc<GetAccountInfoApi>,
  seeded: SeededCatalog,
  payer: Address,
): Promise<CatalogSnapshot> {
  const snapshot: CatalogSnapshot = {
    organizations: [],
    memberships: [],
    films: [],
    filmReplicas: [],
  };
  for (const org of seeded.organizations) {
    const onChain = (await fetchOrganization(rpc, org.address)).data;
    snapshot.organizations.push({
      address: org.address,
      authority: payer,
      slug: org.slug,
      name: org.name,
      createdAt: onChain.createdAt,
      memberCount: org.memberCount,
      schemaVersion: 1,
      bump: onChain.bump,
    });
  }
  for (const membership of seeded.memberships) {
    const onChain = (await fetchMembership(rpc, membership.address)).data;
    if (membership.status === "Revoked" && onChain.revokedAt <= 0n) {
      throw new Error(`fixture: ${membership.address} should have a revoked_at timestamp`);
    }
    snapshot.memberships.push({
      address: membership.address,
      organization: membership.organization,
      member: membership.member,
      role: membership.role,
      status: membership.status,
      grantedBy: payer,
      grantedAt: onChain.grantedAt,
      revokedAt: membership.status === "Revoked" ? onChain.revokedAt : 0n,
      bump: onChain.bump,
    });
  }
  for (const film of seeded.films) {
    const onChain = (await fetchFilm(rpc, film.address)).data;
    snapshot.films.push({
      address: film.address,
      organization: film.organization,
      submitter: payer,
      cid: film.cid,
      cidLen: film.cidLen,
      byteSize: film.byteSize,
      chunkingProfile: 1,
      title: film.title,
      submittedAt: onChain.submittedAt,
      accessPolicy: "Public",
      replicaCount: film.replicas.length,
      schemaVersion: 1,
      bump: onChain.bump,
    });
    film.replicas.forEach((replica, slot) => {
      snapshot.filmReplicas.push({
        film: film.address,
        slot,
        peerId: replica.peerId,
        peerIdLen: 38,
        declaredAt: onChain.replicas[slot]!.declaredAt,
        active: replica.active,
      });
    });
  }
  return snapshot;
}
