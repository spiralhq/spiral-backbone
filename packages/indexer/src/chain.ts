import type { Address, Decoder, EncodedAccount, ReadonlyUint8Array } from "@solana/kit";
import type { CatalogSnapshot } from "@spiral-backbone/db";
import {
  FILM_DISCRIMINATOR,
  FILM_PROGRAM_ADDRESS,
  getFilmDecoder,
} from "@spiral-backbone/protocol/generated/film";
import {
  getMembershipDecoder,
  getOrganizationDecoder,
  MEMBERSHIP_DISCRIMINATOR,
  ORGANIZATION_DISCRIMINATOR,
  ORGANIZATION_PROGRAM_ADDRESS,
} from "@spiral-backbone/protocol/generated/organization";
import { fetchAccountsInBatches, listProgramAccountAddresses } from "./fetch-accounts";
import {
  InvalidAccountError,
  projectFilm,
  projectMembership,
  projectOrganization,
} from "./project";
import type { IndexerRpc } from "./rpc";
import { sortSnapshot } from "./snapshot";

async function fetchProgramAccounts(
  rpc: IndexerRpc,
  programAddress: Address,
  discriminator: ReadonlyUint8Array,
): Promise<EncodedAccount[]> {
  return fetchAccountsInBatches(
    rpc,
    await listProgramAccountAddresses(rpc, programAddress, discriminator),
  );
}

function decodeWith<T>(decoder: Decoder<T>, kind: string, account: EncodedAccount): T {
  try {
    return decoder.decode(account.data);
  } catch (error) {
    throw new InvalidAccountError(
      `${kind} account ${account.address} could not be decoded: ${(error as Error).message}`,
    );
  }
}

export async function snapshotFromChain(rpc: IndexerRpc): Promise<CatalogSnapshot> {
  const organizationAccounts = await fetchProgramAccounts(
    rpc,
    ORGANIZATION_PROGRAM_ADDRESS,
    ORGANIZATION_DISCRIMINATOR,
  );
  const membershipAccounts = await fetchProgramAccounts(
    rpc,
    ORGANIZATION_PROGRAM_ADDRESS,
    MEMBERSHIP_DISCRIMINATOR,
  );
  const filmAccounts = await fetchProgramAccounts(rpc, FILM_PROGRAM_ADDRESS, FILM_DISCRIMINATOR);

  const organizationDecoder = getOrganizationDecoder();
  const membershipDecoder = getMembershipDecoder();
  const filmDecoder = getFilmDecoder();
  const projectedFilms = filmAccounts.map((account) =>
    projectFilm(account.address, decodeWith(filmDecoder, "film", account)),
  );

  return sortSnapshot({
    organizations: organizationAccounts.map((account) =>
      projectOrganization(
        account.address,
        decodeWith(organizationDecoder, "organization", account),
      ),
    ),
    memberships: membershipAccounts.map((account) =>
      projectMembership(account.address, decodeWith(membershipDecoder, "membership", account)),
    ),
    films: projectedFilms.map((projected) => projected.film),
    filmReplicas: projectedFilms.flatMap((projected) => projected.replicas),
  });
}
