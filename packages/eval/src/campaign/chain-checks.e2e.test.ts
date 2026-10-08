import { createSolanaRpc } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { shouldSkipE2e, startLocalChain } from "../testing/chain";
import { defaultProgramSpecs, programChecks } from "./chain-checks";
import { runChecks } from "./checks";

const skip = shouldSkipE2e("campaign program checks against Surfpool");

describe.skipIf(skip)("programChecks against Surfpool", () => {
  it("accepts the programs startLocalChain deploys from spiral-programs/target/deploy", async () => {
    const chain = await startLocalChain();
    try {
      const rpc = createSolanaRpc(chain.rpcUrl);
      const results = await runChecks(programChecks(rpc, defaultProgramSpecs()), [chain.rpcUrl]);
      expect(results.map((r) => [r.name, r.ok, r.detail])).toEqual([
        [
          "program organization",
          true,
          expect.stringMatching(
            /^organization: deployed bytecode = local build \w{8}, protocol IDL matches build$/,
          ),
        ],
        [
          "program film",
          true,
          expect.stringMatching(
            /^film: deployed bytecode = local build \w{8}, protocol IDL matches build$/,
          ),
        ],
      ]);
    } finally {
      chain.stop();
    }
  }, 120_000);
});
