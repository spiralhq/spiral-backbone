import { createSolanaRpc } from "@solana/kit";
import { artifactVersions, describeEndpoint } from "@spiral-backbone/protocol";
import { assertExpectedCluster } from "../common/cluster";
import { appendJsonLine, appendResult } from "../common/ndjson";
import { markRunCompleted, markRunStarted } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import { buildScenarioAttempt } from "./attempts";
import type { H3Client } from "./client";
import { setupH3Fixtures } from "./fixtures";
import { failingProgram, judge } from "./outcome";
import { sendRawSkipPreflight } from "./raw-send";
import { EXPECTED_INSTRUCTION_INDEX, H3_SCENARIOS } from "./scenarios";

export interface H3Options {
  client: H3Client;
  rpcUrl: string;
  expectedGenesis: string;
  outPath: string;
  runId: string;
  label: string;
}

export async function runH3(options: H3Options): Promise<{ success: number; failure: number }> {
  await assertExpectedCluster(options.rpcUrl, options.expectedGenesis);
  await markRunStarted(options.outPath, options.runId, H3_SCENARIOS.length);
  const fixtures = await setupH3Fixtures(options.client, options.label);
  const rpc = createSolanaRpc(options.rpcUrl);
  const evidencePath = sidecarPath(options.outPath, "evidence");
  const host = describeEndpoint(options.rpcUrl).host;
  const versions = artifactVersions();
  const tally = { success: 0, failure: 0 };

  for (const scenario of H3_SCENARIOS) {
    const attempt = await buildScenarioAttempt(scenario, fixtures, options.label);
    const startedAt = new Date();
    const result = await sendRawSkipPreflight(rpc, attempt.feePayer, attempt.instruction);
    const finishedAt = new Date();
    const verdict = judge(scenario, result);
    tally[verdict.outcome]++;

    await appendResult(options.outPath, {
      run_id: options.runId,
      hypothesis: "H3",
      film_pda: attempt.film,
      work_id: `h3-s${scenario.id}`,
      size_bytes: 0,
      size_band: "n/a",
      scenario: `s${scenario.id}-${scenario.key}`,
      method: "raw-tx-skip-preflight",
      attempt: 1,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      latency_ms: finishedAt.getTime() - startedAt.getTime(),
      cid_expected: attempt.cid,
      cid_observed: null,
      outcome: verdict.outcome,
      failure_class: null,
      tx_signature: result.signature,
      rpc_endpoint: host,
      verifier_impl: "n/a",
      artifact_versions: versions,
    });
    await appendJsonLine(evidencePath, {
      run_id: options.runId,
      scenario_id: scenario.id,
      scenario_key: scenario.key,
      expected_code: scenario.expectedCode,
      expected_instruction_index: EXPECTED_INSTRUCTION_INDEX,
      observed: verdict.observed,
      failing_program: failingProgram(result.logs),
      reason: verdict.reason,
      err: result.err,
      logs: result.logs,
    });
  }
  await markRunCompleted(options.outPath, options.runId, tally.success + tally.failure);
  return tally;
}
