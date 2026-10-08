import { afterEach, describe, expect, it } from "vitest";
import { startGenesisServer } from "../testing/genesis-server";
import { assertExpectedCluster } from "./cluster";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("assertExpectedCluster", () => {
  it("passes when the genesis matches", async () => {
    const server = await startGenesisServer(GENESIS);
    close = server.close;
    await expect(assertExpectedCluster(server.url, GENESIS)).resolves.toBeUndefined();
  });

  it("refuses a mismatch without echoing the endpoint", async () => {
    const server = await startGenesisServer("OtherGenesis1111111111111111111111111111111");
    close = server.close;
    const error = await assertExpectedCluster(server.url, GENESIS).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("does not match");
    expect((error as Error).message).not.toContain("key-abc");
  });

  it("redacts the endpoint from transport errors", async () => {
    const error = await assertExpectedCluster("http://127.0.0.1:1/key-abc", GENESIS).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).not.toContain("key-abc");
  });
});
