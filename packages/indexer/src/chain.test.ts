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
  });
});
