import { getAddressEncoder } from "@solana/kit";
import { FILM_DISCRIMINATOR, FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { describe, expect, it } from "vitest";
import { snapshotFromChain } from "./chain";
import { InvalidAccountError } from "./project";
import { createIndexerRpc } from "./rpc";
import { diffSnapshots } from "./snapshot";
import { createFakeChainTransport, fakeAddress, sampleChain } from "./testing/fake-chain";

describe("snapshotFromChain", () => {
  it("rebuilds every record of the sample chain exactly", async () => {
    const { accounts, expected } = sampleChain();
    const { transport } = createFakeChainTransport(accounts);
    const { rpc, stats } = createIndexerRpc("http://unused", { transport });

    const snapshot = await snapshotFromChain(rpc);

    expect(diffSnapshots(expected, snapshot)).toEqual([]);
    expect(stats.calls).toEqual({ getProgramAccounts: 3, getMultipleAccounts: 3 });
  });

  it("aborts with the address when an account under a live discriminator cannot be decoded", async () => {
    const { accounts } = sampleChain();
    const legacy = fakeAddress(77);
    accounts.push({
      address: legacy,
      owner: FILM_PROGRAM_ADDRESS,
      data: new Uint8Array([...FILM_DISCRIMINATOR, 1, 2, 3]),
    });
    const { transport } = createFakeChainTransport(accounts);
    const { rpc } = createIndexerRpc("http://unused", { transport });

    await expect(snapshotFromChain(rpc)).rejects.toThrow(InvalidAccountError);
    await expect(snapshotFromChain(rpc)).rejects.toThrow(legacy);
    await expect(snapshotFromChain(rpc)).rejects.toMatchObject({
      scope: { kind: "film", address: legacy },
    });
  });

  it("reads the organization from the raw bytes of an undecodable Film, when long enough", async () => {
    const organization = fakeAddress(5);
    const organizationBytes = getAddressEncoder().encode(organization);
    const cases = [
      {
        address: fakeAddress(78),
        data: [...FILM_DISCRIMINATOR, ...organizationBytes, 9],
        expected: organization,
      },
      { address: fakeAddress(79), data: [...FILM_DISCRIMINATOR, 1, 2, 3], expected: undefined },
    ];
    for (const { address, data, expected } of cases) {
      const { accounts } = sampleChain();
      accounts.push({ address, owner: FILM_PROGRAM_ADDRESS, data: new Uint8Array(data) });
      const { transport } = createFakeChainTransport(accounts);
      const { rpc } = createIndexerRpc("http://unused", { transport });
      const error = (await snapshotFromChain(rpc).catch((e: unknown) => e)) as InvalidAccountError;
      expect(error.scope).toEqual({ kind: "film", address, organization: expected });
    }
  });
});
