import { resolve } from "node:path";
import { Command } from "commander";
import { readGolden } from "../common/golden";
import { redact, secretsOfUrls } from "../common/redact";
import { makeRunId } from "../common/run-id";
import { loadCampaign } from "./campaign";
import { expectedDeclaredOf, payloadContextOf, realDeps } from "./deps";
import { h2ExitCode } from "./exit-code";
import { runPlan } from "./orchestrator";
import {
  generatePlan,
  goldenDigest,
  plannedAttemptCount,
  planPath,
  readPlan,
  writePlan,
} from "./plan";
import { acquireRunLock } from "./run-lock";
import { checkTopologyMatchesCampaign, loadTopology, type Topology } from "./topology";

export function resolveRunTarget(flags: {
  plan?: string;
  resume?: string;
  plansDir: string;
}): string {
  if (Boolean(flags.plan) === Boolean(flags.resume)) {
    throw new Error("give exactly one of --plan or --resume");
  }
  return flags.plan ?? planPath(flags.plansDir, flags.resume!);
}

export function secretsOf(topology: Topology): string[] {
  return secretsOfUrls(
    [topology.rpc_url, topology.gateway_url, topology.network_node.api_url],
    topology.network_node.bootstrap_multiaddr ? [topology.network_node.bootstrap_multiaddr] : [],
  );
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const fail = (what: string, error: unknown, secrets: string[] = [], exitCode = 1) => {
  console.error(`H2 ${what} failed: ${redact((error as Error).message, secrets)}`);
  process.exitCode = exitCode;
};

export const h2Command = new Command("h2").description(
  "H2: recoverability from the registry — frozen plan, state-verified blocks, ephemeral executors",
);

h2Command
  .command("plan")
  .description("expand a campaign spec and the golden inventory into a frozen plan")
  .requiredOption("--campaign <path>", "campaign spec JSON")
  .requiredOption("--golden <path>", "golden inventory written by spiral submit")
  .option("--label <label>", "run label", "run")
  .option("--plans-dir <dir>", "where frozen plans are written", "plans")
  .action(async (flags: { campaign: string; golden: string; label: string; plansDir: string }) => {
    try {
      const runId = makeRunId("h2", flags.label);
      const plan = generatePlan({
        campaign: await loadCampaign(flags.campaign),
        golden: await readGolden(flags.golden),
        runId,
      });
      const path = planPath(flags.plansDir, runId);
      await writePlan(path, plan);
      console.log(
        JSON.stringify({ run_id: runId, plan: path, attempts: plannedAttemptCount(plan) }),
      );
    } catch (error) {
      fail("plan", error);
    }
  });

h2Command
  .command("run")
  .description("execute (or resume) a frozen plan against a topology")
  .option("--plan <path>", "frozen plan file")
  .option("--golden <path>", "golden inventory the plan was frozen from (required)")
  .option("--resume <run_id>", "resume the plan of this run_id from --plans-dir")
  .requiredOption(
    "--topology <path>",
    "topology JSON (replicas, network node, gateway, RPC, executor)",
  )
  .option("--out <path>", "results NDJSON", "results/h2.ndjson")
  .option("--plans-dir <dir>", "where frozen plans live", "plans")
  .option("--ping-timeout-ms <n>", "swarm ping timeout", "10000")
  .option("--providers-timeout-ms <n>", "findprovs timeout", "30000")
  .option(
    "--allow-extra-generation",
    "with --resume: permit one generation beyond max_block_generations for the block that hit it",
  )
  .action(
    async (flags: {
      plan?: string;
      resume?: string;
      golden?: string;
      topology: string;
      out: string;
      plansDir: string;
      pingTimeoutMs: string;
      providersTimeoutMs: string;
      allowExtraGeneration?: boolean;
    }) => {
      let secrets: string[] = [];
      const locks: { release(): void }[] = [];
      try {
        if (flags.allowExtraGeneration && !flags.resume) {
          throw new Error("--allow-extra-generation requires --resume");
        }
        const pingTimeoutMs = positiveInt("--ping-timeout-ms", flags.pingTimeoutMs);
        const providersTimeoutMs = positiveInt("--providers-timeout-ms", flags.providersTimeoutMs);
        const planFile = resolveRunTarget(flags);
        const goldenPath = flags.golden;
        if (!goldenPath) throw new Error("--golden is required");
        const plan = await readPlan(planFile);
        const current = goldenDigest(await readGolden(goldenPath));
        if (current !== plan.golden_sha256) {
          throw new Error(
            `plan golden_sha256 ${plan.golden_sha256} differs from the golden ${goldenPath} (${current})`,
          );
        }
        const topology = await loadTopology(flags.topology);
        secrets = secretsOf(topology);
        const mismatch = checkTopologyMatchesCampaign(topology, plan.campaign.replica_nodes);
        if (mismatch.length > 0) throw new Error(mismatch.join("; "));
        for (const path of [resolve(flags.topology), flags.out]) {
          const lock = acquireRunLock(path, (message) => console.error(message));
          locks.push(lock);
          process.once("exit", lock.release);
        }
        const deps = realDeps(topology, { pingTimeoutMs, providersTimeoutMs });
        const result = await runPlan({
          plan,
          outPath: flags.out,
          deps,
          context: payloadContextOf(topology),
          expectedDeclared: expectedDeclaredOf(topology),
          allowExtraGeneration: flags.allowExtraGeneration === true,
          resume: flags.resume !== undefined,
          log: (message) => console.error(redact(message, secrets)),
        });
        console.log(JSON.stringify({ run_id: plan.run_id, ...result }));
      } catch (error) {
        fail("run", error, secrets, h2ExitCode(error));
      } finally {
        for (const lock of locks) {
          lock.release();
          process.off("exit", lock.release);
        }
      }
    },
  );
