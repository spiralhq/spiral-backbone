import { readFile } from "node:fs/promises";
import { address } from "@solana/kit";
import { bytesToCidString, computeSpiralCid } from "@spiral-backbone/protocol";
import { fetchMaybeFilm } from "@spiral-backbone/protocol/generated/film";
import { Command } from "commander";
import { z } from "zod";
import { createReadOnlySpiralClient } from "../lib/client";
import { CliError, handleCliError } from "../lib/errors";

export const verifyOptionsSchema = z.object({
  film: z.string().min(1),
  file: z.string().min(1),
  cluster: z.enum(["devnet", "local"]),
  rpcUrl: z.string().optional(),
});

export const verify = new Command()
  .name("verify")
  .description("recompute a recovered file's CID and compare it against the on-chain record")
  .requiredOption("--film <pda>", "the Film account address")
  .requiredOption("--file <path>", "path to the already-recovered file")
  .option("--cluster <cluster>", "devnet or local", "devnet")
  .option("--rpc-url <url>", "override RPC URL (takes precedence over --cluster)")
  .action(async (opts) => {
    try {
      const options = verifyOptionsSchema.parse(opts);
      const client = await createReadOnlySpiralClient({
        cluster: options.cluster,
        rpcUrl: options.rpcUrl,
      });
      const filmAddress = address(options.film);

      const filmAccount = await fetchMaybeFilm(client.rpc, filmAddress);
      if (!filmAccount.exists) {
        throw new CliError(`No Film account found at ${options.film}.`);
      }

      const expectedCid = bytesToCidString(
        Uint8Array.from(filmAccount.data.cid),
        filmAccount.data.cidLen,
      );

      const content = await readFile(options.file);
      const observedCid = (await computeSpiralCid(content)).toString();
      const matches = observedCid === expectedCid;

      console.log(`On-chain CID: ${expectedCid}`);
      console.log(`Recomputed:   ${observedCid}`);
      console.log(matches ? "Match." : "MISMATCH.");
      if (!matches) process.exitCode = 1;
    } catch (error) {
      handleCliError(error);
    }
  });
