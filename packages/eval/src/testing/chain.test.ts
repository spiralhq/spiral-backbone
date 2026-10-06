import { createSolanaRpc } from "@solana/kit";
import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";
import { describe, expect, it } from "vitest";
import { shouldSkipE2e, startLocalChain } from "./chain";

const skip = shouldSkipE2e("local chain smoke test");

describe.skipIf(skip)("startLocalChain", () => {
  it("deploys both programs and funds the payer", async () => {
    const chain = await startLocalChain();
    try {
      const rpc = createSolanaRpc(chain.rpcUrl);
      for (const program of [ORGANIZATION_PROGRAM_ADDRESS, FILM_PROGRAM_ADDRESS]) {
        const { value } = await rpc.getAccountInfo(program, { encoding: "base64" }).send();
        expect(value?.executable).toBe(true);
      }
      const { value: balance } = await rpc.getBalance(chain.payer).send();
      expect(balance > 0n).toBe(true);
    } finally {
      chain.stop();
    }
  }, 120_000);
});
