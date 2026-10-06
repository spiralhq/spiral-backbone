import { Command } from "commander";
import { z } from "zod";
import { makeRunId } from "../common/run-id";
import { createH3Client } from "./client";
import { runH3 } from "./run";

const optionsSchema = z.object({
  rpcUrl: z.url({ protocol: /^https?$/ }),
  wsUrl: z.url({ protocol: /^wss?$/ }).optional(),
  keypair: z.string().min(1),
  out: z.string().min(1),
  label: z.string().regex(/^[a-z0-9-]{1,25}$/),
});

export const h3Command = new Command("h3")
  .description("H3: submit the seven unauthorized registrations directly to the programs (no CLI)")
  .option("--rpc-url <url>", "Solana RPC (default: $SPIRAL_RPC_URL)")
  .option(
    "--ws-url <url>",
    "WebSocket URL for fixture confirmations, when not derivable from --rpc-url",
  )
  .option(
    "--keypair <path>",
    "funded keypair that owns the fixtures",
    `${process.env["HOME"]}/.config/solana/id.json`,
  )
  .option("--out <path>", "results NDJSON", "results/h3.ndjson")
  .option("--label <label>", "run label, also used in fixture slugs", Date.now().toString(36))
  .action(async (flags: Record<string, string | undefined>) => {
    const parsed = optionsSchema.safeParse({
      ...flags,
      rpcUrl: flags["rpcUrl"] ?? process.env["SPIRAL_RPC_URL"],
    });
    if (!parsed.success) {
      console.error(
        `Error: invalid options (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`,
      );
      process.exitCode = 1;
      return;
    }
    const options = parsed.data;
    try {
      const runId = makeRunId("h3", options.label);
      const client = await createH3Client(options.keypair, options.rpcUrl, options.wsUrl);
      const summary = await runH3({
        client,
        rpcUrl: options.rpcUrl,
        outPath: options.out,
        runId,
        label: options.label,
      });
      console.log(JSON.stringify({ run_id: runId, ...summary }));
    } catch (error) {
      console.error(`H3 failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });
