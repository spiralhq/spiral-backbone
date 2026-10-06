import {
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findMembershipPda, findOrganizationPda } from "@spiral-backbone/protocol";
import {
  getGrantMembershipInstructionAsync,
  getInitializeOrganizationInstructionAsync,
  getRevokeMembershipInstructionAsync,
  ORGANIZATION_PROGRAM_ADDRESS,
  Role,
} from "@spiral-backbone/protocol/generated/organization";
import { eventAuthority, labelCid, type CidBytes } from "./accounts";
import { registerFilmInstruction } from "./attempts";
import type { H3Client } from "./client";

export const SCENARIO_SIGNER_FUNDING = lamports(20_000_000n);

export interface H3Fixtures {
  admin: TransactionSigner;
  adminMembership: Address;
  organization: Address;
  otherOrganization: Address;
  member: KeyPairSigner;
  memberMembership: Address;
  reader: KeyPairSigner;
  readerMembership: Address;
  revoked: KeyPairSigner;
  revokedMembership: Address;
  outsider: KeyPairSigner;
  outsiderMembership: Address;
  impostor: KeyPairSigner;
  existingFilm: Address;
  existingCid: CidBytes;
}

async function initOrganization(client: H3Client, slug: string): Promise<Address> {
  await client.sendTransaction([
    await getInitializeOrganizationInstructionAsync({
      authority: client.payer,
      slug,
      name: `H3 ${slug}`,
    }),
  ]);
  const [organization] = await findOrganizationPda({ slug });
  return organization;
}

async function grant(
  client: H3Client,
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
  const [membership] = await findMembershipPda({ organization, member });
  return membership;
}

export async function setupH3Fixtures(client: H3Client, label: string): Promise<H3Fixtures> {
  const admin = client.payer;
  const organization = await initOrganization(client, `h3-${label}-a`);
  const otherOrganization = await initOrganization(client, `h3-${label}-b`);

  const member = await generateKeyPairSigner();
  const reader = await generateKeyPairSigner();
  const revoked = await generateKeyPairSigner();
  const outsider = await generateKeyPairSigner();
  const impostor = await generateKeyPairSigner();
  await client.sendTransaction(
    [member, reader, revoked, outsider, impostor].map((signer) =>
      getTransferSolInstruction({
        source: admin,
        destination: signer.address,
        amount: SCENARIO_SIGNER_FUNDING,
      }),
    ),
  );

  const memberMembership = await grant(client, organization, member.address, Role.Submitter);
  const readerMembership = await grant(client, organization, reader.address, Role.Reader);
  const revokedMembership = await grant(client, organization, revoked.address, Role.Submitter);
  await client.sendTransaction([
    await getRevokeMembershipInstructionAsync({
      authority: admin,
      organization,
      member: revoked.address,
      membership: revokedMembership,
      eventAuthority: await eventAuthority(ORGANIZATION_PROGRAM_ADDRESS),
      program: ORGANIZATION_PROGRAM_ADDRESS,
    }),
  ]);

  const [outsiderMembership] = await findMembershipPda({ organization, member: outsider.address });
  const [adminMembership] = await findMembershipPda({ organization, member: admin.address });
  const existingCid = await labelCid(`h3-${label}-existing`);
  const existing = await registerFilmInstruction({
    submitter: admin,
    organization,
    membership: adminMembership,
    cid: existingCid,
  });
  await client.sendTransaction([existing.instruction]);

  return {
    admin,
    adminMembership,
    organization,
    otherOrganization,
    member,
    memberMembership,
    reader,
    readerMembership,
    revoked,
    revokedMembership,
    outsider,
    outsiderMembership,
    impostor,
    existingFilm: existing.film,
    existingCid,
  };
}
