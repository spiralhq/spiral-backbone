import { createClient, type Address } from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { Command } from "commander";
import { redact, secretsOf } from "../h2/command";
import { loadTopology } from "../h2/topology";
import { DEVNET_GENESIS } from "./chain-checks";
import { renderChecks, runChecks } from "./checks";
import { buildChecks, type PreflightStage } from "./preflight";

const STAGES: PreflightStage[] = ["infra", "h2", "all"];

function parseStage(value: string): PreflightStage {
  if (!STAGES.includes(value as PreflightStage)) {
    throw new Error(`--stage must be one of ${STAGES.join(", ")}`);
  }
  return value as PreflightStage;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function solToLamports(value: string): bigint {
  const sol = Number(value);
  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error("--min-balance-sol must be a positive number");
  }
  const lamports = BigInt(Math.round(sol * 1_000_000_000));
  if (lamports <= 0n) throw new Error("--min-balance-sol must be at least 1 lamport");
  return lamports;
}

async function payerOf(keypairPath: string): Promise<Address> {
  try {
    const { payer } = await createClient().use(signerFromFile(keypairPath));
    return payer.address;
  } catch {
    throw new Error(`keypair ${keypairPath} is unreadable or not a valid keypair`);
  }
}

interface PreflightFlags {
  stage: string;
  topology: string;
  keypair: string;
  manifest: string;
  filesDir: string;
  golden?: string;
  campaign: string;
  expectedGenesis: string;
  minBalanceSol: string;
  pingTimeoutMs: string;
  skipConformance?: boolean;
  programsDir?: string;
}

export const campaignCommand = new Command("campaign").description(
  "H2 campaign operations: pre-flight blockers before the final run",
);

campaignCommand
  .command("preflight")
  .description("check every campaign precondition; exit 1 if any check is BLOCKED")
  .requiredOption("--stage <stage>", "infra, h2 or all")
  .requiredOption("--topology <path>", "topology JSON; its rpc_url is the RPC checked")
  .requiredOption("--keypair <path>", "payer keypair; only its address is used")
  .option("--manifest <path>", "dataset manifest", "dataset/manifest.json")
  .option("--files-dir <dir>", "downloaded dataset files", "dataset/files")
  .option("--golden <path>", "golden inventory (required for h2 and all)")
  .option("--campaign <path>", "campaign spec", "packages/eval/campaigns/h2-final.json")
  .option("--expected-genesis <hash>", "expected cluster genesis hash", DEVNET_GENESIS)
  .option("--min-balance-sol <n>", "minimum payer balance in SOL", "2")
  .option("--ping-timeout-ms <n>", "swarm ping, SSH probe and gateway timeout", "10000")
  .option(
    "--programs-dir <dir>",
    "spiral-programs checkout holding target/deploy and target/idl (default: ../spiral-programs)",
  )
  .option(
    "--skip-conformance",
    "e2e only, never in a campaign: report conformance as BLOCKED (skipped by flag)",
  )
  .action(async (flags: PreflightFlags) => {
    let secrets: string[] = [];
    try {
      const stage = parseStage(flags.stage);
      if (stage === "h2" && flags.skipConformance) {
        throw new Error("--skip-conformance does not apply to --stage h2");
      }
      const minLamports = solToLamports(flags.minBalanceSol);
      const pingTimeoutMs = positiveInt("--ping-timeout-ms", flags.pingTimeoutMs);
      if (stage !== "infra" && !flags.golden) {
        throw new Error(`--golden is required for --stage ${stage}`);
      }
      const topology = await loadTopology(flags.topology);
      secrets = secretsOf(topology);
      const checks = await buildChecks(stage, {
        topology,
        payer: await payerOf(flags.keypair),
        manifestPath: flags.manifest,
        filesDir: flags.filesDir,
        goldenPath: flags.golden,
        campaignPath: flags.campaign,
        expectedGenesis: flags.expectedGenesis,
        minLamports,
        pingTimeoutMs,
        skipConformance: flags.skipConformance ?? false,
        programsDir: flags.programsDir,
      });
      const results = await runChecks(checks, secrets);
      console.log(renderChecks(results));
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Pre-flight failed: ${redact(message, secrets)}`);
      process.exitCode = 1;
    }
  });
