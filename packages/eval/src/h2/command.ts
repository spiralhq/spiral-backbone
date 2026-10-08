import { Command } from "commander";
import { readGolden } from "../common/golden";
import { makeRunId } from "../common/run-id";
import { loadCampaign } from "./campaign";
import { expectedDeclaredOf, payloadContextOf, realDeps } from "./deps";
import { runPlan } from "./orchestrator";
import { generatePlan, plannedAttemptCount, planPath, readPlan, writePlan } from "./plan";
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

export function secretsOfUrls(urls: string[], extra: string[] = []): string[] {
  const parts = urls.flatMap((u) => {
    const url = new URL(u);
    const tail = url.pathname + url.search;
    return [u, url.href, url.origin, url.host, url.search, ...(tail !== "/" ? [tail] : [])];
  });
  parts.push(...extra);
  return [...new Set(parts.filter((p) => p.length > 0))].sort((a, b) => b.length - a.length);
}

export function secretsOf(topology: Topology): string[] {
  return secretsOfUrls(
    [topology.rpc_url, topology.gateway_url, topology.network_node.api_url],
    topology.network_node.bootstrap_multiaddr ? [topology.network_node.bootstrap_multiaddr] : [],
  );
}

export function redact(message: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("<redacted>"), message);
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const fail = (what: string, error: unknown, secrets: string[] = []) => {
  console.error(`H2 ${what} failed: ${redact((error as Error).message, secrets)}`);
  process.exitCode = 1;
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
  .option("--resume <run_id>", "resume the plan of this run_id from --plans-dir")
  .requiredOption(
    "--topology <path>",
    "topology JSON (replicas, network node, gateway, RPC, executor)",
  )
  .option("--out <path>", "results NDJSON", "results/h2.ndjson")
  .option("--plans-dir <dir>", "where frozen plans live", "plans")
  .option("--ping-timeout-ms <n>", "swarm ping timeout", "10000")
  .option("--providers-timeout-ms <n>", "findprovs timeout", "30000")
  .action(
    async (flags: {
      plan?: string;
      resume?: string;
      topology: string;
      out: string;
      plansDir: string;
      pingTimeoutMs: string;
      providersTimeoutMs: string;
    }) => {
      let secrets: string[] = [];
      try {
        const pingTimeoutMs = positiveInt("--ping-timeout-ms", flags.pingTimeoutMs);
        const providersTimeoutMs = positiveInt("--providers-timeout-ms", flags.providersTimeoutMs);
        const plan = await readPlan(resolveRunTarget(flags));
        const topology = await loadTopology(flags.topology);
        secrets = secretsOf(topology);
        const mismatch = checkTopologyMatchesCampaign(topology, plan.campaign.replica_nodes);
        if (mismatch.length > 0) throw new Error(mismatch.join("; "));
        const deps = realDeps(topology, { pingTimeoutMs, providersTimeoutMs });
        const result = await runPlan({
          plan,
          outPath: flags.out,
          deps,
          context: payloadContextOf(topology),
          expectedDeclared: expectedDeclaredOf(topology),
        });
        console.log(JSON.stringify({ run_id: plan.run_id, ...result }));
      } catch (error) {
        fail("run", error, secrets);
      }
    },
  );
