import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readGolden } from "../common/golden";
import { DEVNET_GENESIS } from "../common/cluster";
import { makeRunId } from "../common/run-id";
import { runH1 } from "./run";

const optionsSchema = z.object({
  golden: z.string().min(1),
  rpcUrl: z.url({ protocol: /^https?$/ }),
  expectedGenesis: z.string().min(1),
  kuboUrl: z.url({ protocol: /^https?$/ }),
  out: z.string().min(1),
  workDir: z.string().min(1),
  timeoutMs: z.coerce.number().int().positive(),
  label: z.string().min(1),
});

export const h1Command = new Command("h1")
  .description(
    "H1: recompute each registered CID with the isolated verifier and detect a one-byte change",
  )
  .requiredOption("--golden <path>", "golden inventory written by spiral submit")
  .option("--rpc-url <url>", "Solana RPC (default: $SPIRAL_RPC_URL)")
  .option("--expected-genesis <hash>", "expected cluster genesis hash", DEVNET_GENESIS)
  .option(
    "--kubo-url <url>",
    "Kubo RPC used for retrieval (never a public gateway)",
    "http://127.0.0.1:5001",
  )
  .option("--out <path>", "results NDJSON", "results/h1.ndjson")
  .option("--work-dir <dir>", "scratch directory for retrieved files", join(tmpdir(), "spiral-h1"))
  .option("--timeout-ms <n>", "retrieval timeout per work", "600000")
  .option("--label <label>", "run label", "run")
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
      const runId = makeRunId("h1", options.label);
      const summary = await runH1({
        golden: await readGolden(options.golden),
        rpcUrl: options.rpcUrl,
        expectedGenesis: options.expectedGenesis,
        kuboUrl: options.kuboUrl,
        outPath: options.out,
        workDir: options.workDir,
        runId,
        timeoutMs: options.timeoutMs,
      });
      console.log(JSON.stringify({ run_id: runId, ...summary }));
    } catch (error) {
      console.error(`H1 failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });
