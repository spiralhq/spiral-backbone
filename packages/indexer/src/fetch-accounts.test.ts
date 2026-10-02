import { getBase58Decoder } from "@solana/kit";
import { FILM_DISCRIMINATOR, FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { describe, expect, it } from "vitest";
import {
  AccountVanishedError,
  fetchAccountsInBatches,
  listProgramAccountAddresses,
} from "./fetch-accounts";
import { createIndexerRpc } from "./rpc";
import { createFakeChainTransport, fakeAddress, type FakeAccount } from "./testing/fake-chain";

function filmAccounts(count: number): FakeAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    address: fakeAddress(i + 1),
    owner: FILM_PROGRAM_ADDRESS,
    data: new Uint8Array([...FILM_DISCRIMINATOR, i]),
  }));
}

describe("listProgramAccountAddresses", () => {
  it("asks only for addresses, filtered by the discriminator", async () => {
    const { transport, requests } = createFakeChainTransport(filmAccounts(3));
    const { rpc } = createIndexerRpc("http://unused", { transport });

    const addresses = await listProgramAccountAddresses(
      rpc,
      FILM_PROGRAM_ADDRESS,
      FILM_DISCRIMINATOR,
    );

    expect(addresses).toEqual([fakeAddress(1), fakeAddress(2), fakeAddress(3)]);
    expect(requests).toHaveLength(1);
    const [program, config] = requests[0]!.params as [string, Record<string, unknown>];
    expect(program).toBe(FILM_PROGRAM_ADDRESS);
    expect(config["dataSlice"]).toEqual({ offset: 0, length: 0 });
    expect(config["filters"]).toEqual([
      {
        memcmp: {
          offset: 0n,
          bytes: getBase58Decoder().decode(FILM_DISCRIMINATOR),
          encoding: "base58",
        },
      },
    ]);
  });
});

describe("fetchAccountsInBatches", () => {
  it("splits 250 addresses into getMultipleAccounts calls of 100, 100 and 50", async () => {
    const accounts = filmAccounts(250);
    const { transport, requests } = createFakeChainTransport(accounts);
    const { rpc } = createIndexerRpc("http://unused", { transport });

    const fetched = await fetchAccountsInBatches(
      rpc,
      accounts.map((account) => account.address),
    );

    expect(fetched.map((account) => account.address)).toEqual(
      accounts.map((account) => account.address),
    );
    expect(requests.map((request) => (request.params[0] as string[]).length)).toEqual([
      100, 100, 50,
    ]);
  });

  it("makes no RPC call for an empty address list", async () => {
    const { transport, requests } = createFakeChainTransport([]);
    const { rpc } = createIndexerRpc("http://unused", { transport });
    expect(await fetchAccountsInBatches(rpc, [])).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("fails naming the address when a listed account no longer exists", async () => {
    const { transport } = createFakeChainTransport(filmAccounts(1));
    const { rpc } = createIndexerRpc("http://unused", { transport });
    const vanished = fakeAddress(99);
    await expect(fetchAccountsInBatches(rpc, [fakeAddress(1), vanished])).rejects.toThrow(
      AccountVanishedError,
    );
    await expect(fetchAccountsInBatches(rpc, [vanished])).rejects.toThrow(vanished);
  });
});
