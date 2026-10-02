import {
  fetchEncodedAccounts,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
  type EncodedAccount,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { IndexerRpc } from "./rpc";

export const GET_MULTIPLE_ACCOUNTS_LIMIT = 100;

export class AccountVanishedError extends Error {}

export async function listProgramAccountAddresses(
  rpc: IndexerRpc,
  programAddress: Address,
  discriminator: ReadonlyUint8Array,
): Promise<Address[]> {
  const accounts = await rpc
    .getProgramAccounts(programAddress, {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(discriminator) as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  return accounts.map((account) => account.pubkey);
}

export async function fetchAccountsInBatches(
  rpc: IndexerRpc,
  addresses: Address[],
  batchSize: number = GET_MULTIPLE_ACCOUNTS_LIMIT,
): Promise<EncodedAccount[]> {
  const fetched: EncodedAccount[] = [];
  for (let start = 0; start < addresses.length; start += batchSize) {
    const batch = await fetchEncodedAccounts(rpc, addresses.slice(start, start + batchSize));
    for (const account of batch) {
      if (!account.exists) {
        throw new AccountVanishedError(
          `account ${account.address} was listed by getProgramAccounts but no longer exists`,
        );
      }
      fetched.push(account);
    }
  }
  return fetched;
}
