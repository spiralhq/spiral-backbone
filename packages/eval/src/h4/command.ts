import { createDb } from "@spiral-backbone/db";
import { Command } from "commander";
import { readGolden } from "../common/golden";
import { DEVNET_GENESIS } from "../common/cluster";
import { makeRunId } from "../common/run-id";
import { resolveH4Options } from "./options";
import { runH4 } from "./run";

export const h4Command = new Command("h4")
  .description(
    "H4: DROP SCHEMA, rebuild the catalog from getProgramAccounts, compare with the golden inventory",
  )
  .requiredOption("--golden <path>", "golden inventory written by spiral submit")
  .option("--rpc-url <url>", "dedicated Solana RPC (default: $SPIRAL_RPC_URL)")
  .requiredOption(
    "--database-url <url>",
    "Postgres URL to DROP and rebuild — required, never read from the environment",
  )
  .option("--out <path>", "results NDJSON", "results/h4.ndjson")
  .option("--expected-genesis <hash>", "expected cluster genesis hash", DEVNET_GENESIS)
  .option("--label <label>", "run label", "run")
  .action(async (flags: Record<string, string | undefined>) => {
    const resolved = resolveH4Options(flags);
    if (!resolved.ok) {
      console.error(`Error: ${resolved.error}`);
      process.exitCode = 1;
      return;
    }
    const options = resolved.options;
    const db = createDb({ DATABASE_URL: options.databaseUrl });
    try {
      const runId = makeRunId("h4", options.label);
      const result = await runH4({
        golden: await readGolden(options.golden),
        db,
        rpcUrl: options.rpcUrl,
        expectedGenesis: options.expectedGenesis,
        outPath: options.out,
        runId,
      });
      console.log(JSON.stringify({ run_id: runId, ...result }));
      if (result.backfillFailed) process.exitCode = 1;
    } catch (error) {
      console.error(`H4 failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await db.$client.end();
    }
  });
