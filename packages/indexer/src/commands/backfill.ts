import { writeFile } from "node:fs/promises";
import { createDb } from "@spiral-backbone/db";
import { Command } from "commander";
import { z } from "zod";
import { backfill, BackfillError } from "../backfill";

const PUBLIC_DEVNET_HOST = "api.devnet.solana.com";

export interface BackfillFlags {
  rpcUrl?: string;
  databaseUrl?: string;
  reset?: boolean;
  report?: string;
}

export function resolveBackfillOptions(
  flags: BackfillFlags,
  env: Record<string, string | undefined>,
) {
  const rpcUrl = flags.rpcUrl ?? env["SPIRAL_RPC_URL"];
  const databaseUrl = flags.databaseUrl ?? env["DATABASE_URL"];
  if (!rpcUrl) throw new Error("--rpc-url (or SPIRAL_RPC_URL) is required");
  if (!databaseUrl) throw new Error("--database-url (or DATABASE_URL) is required");
  if (!z.url({ protocol: /^https?$/ }).safeParse(rpcUrl).success) {
    throw new Error("--rpc-url is not a valid http(s) URL");
  }
  const warnings =
    new URL(rpcUrl).host === PUBLIC_DEVNET_HOST
      ? [
          "Using the public Devnet endpoint: it is aggressively rate-limited and getProgramAccounts is expensive. Use a dedicated endpoint for campaign runs.",
        ]
      : [];
  return { rpcUrl, databaseUrl, reset: flags.reset ?? false, report: flags.report, warnings };
}

export const backfillCommand = new Command("backfill")
  .description("rebuild the relational catalog from getProgramAccounts alone")
  .option("--rpc-url <url>", "dedicated RPC endpoint (default: $SPIRAL_RPC_URL)")
  .option("--database-url <url>", "Postgres connection URL (default: $DATABASE_URL)")
  .option("--reset", "DROP SCHEMA public CASCADE before rebuilding")
  .option("--report <path>", "also write the JSON run report to this file")
  .action(async (flags: BackfillFlags) => {
    let options: ReturnType<typeof resolveBackfillOptions>;
    try {
      options = resolveBackfillOptions(flags, process.env);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    for (const warning of options.warnings) console.error(`Warning: ${warning}`);

    const db = createDb({ DATABASE_URL: options.databaseUrl });
    try {
      const report = await backfill({ db, rpcUrl: options.rpcUrl, reset: options.reset });
      const line = JSON.stringify(report);
      console.log(line);
      if (options.report) await writeFile(options.report, `${line}\n`);
    } catch (error) {
      if (error instanceof BackfillError) {
        const line = JSON.stringify(error.report);
        console.log(line);
        if (options.report) await writeFile(options.report, `${line}\n`);
      }
      console.error(`Backfill failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await db.$client.end();
    }
  });
