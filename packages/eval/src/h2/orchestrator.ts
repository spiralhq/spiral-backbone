import { existsSync } from "node:fs";
import { resultRecordSchema } from "@spiral-backbone/protocol";
import {
  appendJsonLine,
  appendResult,
  assertNoTruncatedTail,
  readJsonLines,
  recoverTruncatedTail,
  RESUME_H2,
} from "../common/ndjson";
import { markRunCompleted, markRunStarted } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import {
  appendBlockRecord,
  blocksPath,
  readBlockRecords,
  isCheck,
  isExtraGeneration,
  scenarioFor,
  type BlockCheckRecord,
  type BlockRecord,
  type ExtraGenerationRecord,
} from "./blocks-log";
import type { AttemptPayload, ExecutorOutput } from "./executor/attempt";
import { plannedAttemptCount, type FrozenPlan, type PlannedBlock } from "./plan";
import { nodeDrift, type StateCheck } from "./state";

export interface OrchestratorDeps {
  applyState(intended: string[]): Promise<void>;
  checkState(intended: string[], cids: string[]): Promise<StateCheck>;
  runAttempt(payload: AttemptPayload): Promise<ExecutorOutput>;
  sleep(ms: number): Promise<void>;
}

export interface PayloadContext {
  rpc_url: string;
  gateway_url: string;
  bootstrap_multiaddr: string | null;
  private_network: boolean;
  artifact_versions: Record<string, string>;
}

export class BlockGateError extends Error {}
export class GenerationLimitError extends Error {}

const keyOf = (r: { scenario: string; work_id: string; method: string; attempt: number }) =>
  `${r.scenario}|${r.work_id}|${r.method}|${r.attempt}`;

function sameSet(value: unknown, expected: Set<string>): boolean {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return false;
  const actual = new Set(value);
  return actual.size === expected.size && [...actual].every((v) => expected.has(v));
}

interface Start {
  generation: number;
  complete: boolean;
  rerun: boolean;
  precheck: boolean;
}

function startingGeneration(log: BlockRecord[], block: PlannedBlock, done: Set<string>): Start {
  const fresh = { complete: false, rerun: false, precheck: false };
  const mine = log.filter((r) => r.block_index === block.block_index);
  if (mine.length === 0) return { ...fresh, generation: 1 };
  const latest = Math.max(...mine.map((r) => r.generation));
  const scenario = scenarioFor(block.name, latest);
  const recorded = block.attempts.filter((a) =>
    done.has(keyOf({ scenario, work_id: a.work_id, method: a.method, attempt: a.repetition })),
  ).length;
  const checks = mine.filter(isCheck).filter((r) => r.generation === latest);
  const lastGate = checks.findLastIndex((r) => r.phase === "gate");
  const ends = checks.slice(lastGate + 1).filter((r) => r.phase === "end");
  const end = ends.at(-1);
  if (!end) return { ...fresh, generation: latest, precheck: recorded > 0 };
  if (!end.confirmed) return { ...fresh, generation: latest + 1, rerun: true };
  if (recorded !== block.attempts.length) {
    throw new Error(
      `block ${block.name} ${scenario}: artifacts are inconsistent — end confirmed but ${block.attempts.length - recorded} planned attempts have no result`,
    );
  }
  return { ...fresh, generation: latest, complete: true };
}

function authorizedGeneration(
  log: BlockRecord[],
  block: PlannedBlock,
  generation: number,
  maxGenerations: number,
): boolean {
  return (
    generation <= maxGenerations ||
    log.some(
      (r) =>
        isExtraGeneration(r) && r.block_index === block.block_index && r.generation === generation,
    )
  );
}

export async function runPlan(options: {
  plan: FrozenPlan;
  outPath: string;
  deps: OrchestratorDeps;
  context: PayloadContext;
  expectedDeclared: string[];
  stopAfterAttempts?: number;
  restoreAllAtEnd?: boolean;
  allowExtraGeneration?: boolean;
  resume?: boolean;
  log?: (message: string) => void;
}): Promise<{ executed: number; skipped: number; interrupted: boolean; generationsRerun: number }> {
  const { plan, outPath, deps, context } = options;
  const expectedDeclared = new Set(options.expectedDeclared);
  const blocksFile = blocksPath(outPath);
  const evidenceFile = sidecarPath(outPath, "evidence");
  const say = options.log ?? ((message: string) => console.error(message));
  for (const file of [outPath, blocksFile, evidenceFile, sidecarPath(outPath, "runs")]) {
    if (options.resume) await recoverTruncatedTail(file, say);
    else await assertNoTruncatedTail(file, RESUME_H2);
  }
  const existing = existsSync(outPath)
    ? (await readJsonLines(outPath, resultRecordSchema)).filter((r) => r.run_id === plan.run_id)
    : [];
  const done = new Set(existing.map(keyOf));
  const log = (await readBlockRecords(blocksFile)).filter((r) => r.run_id === plan.run_id);
  let executed = 0;
  let skipped = 0;
  let generationsRerun = 0;
  const maxEnds = plan.campaign.max_end_attempts ?? 1;
  const maxGenerations = plan.campaign.max_block_generations;

  let extraFor: number | null = null;
  if (options.allowExtraGeneration) {
    const atLimit = plan.blocks.find((block) => {
      const start = startingGeneration(log, block, done);
      return !start.complete && !authorizedGeneration(log, block, start.generation, maxGenerations);
    });
    if (!atLimit) {
      throw new Error(
        `--allow-extra-generation: no block of run ${plan.run_id} is at its generation limit`,
      );
    }
    extraFor = atLimit.block_index;
  }

  await markRunStarted(outPath, plan.run_id, plannedAttemptCount(plan));

  for (const block of plan.blocks) {
    const cids = [...new Set(block.attempts.map((a) => a.cid))];
    const start = startingGeneration(log, block, done);
    if (start.complete) {
      skipped += block.attempts.length;
      continue;
    }
    let generation = start.generation;
    let precheck = start.precheck;
    if (start.rerun) generationsRerun++;

    while (true) {
      if (!authorizedGeneration(log, block, generation, maxGenerations)) {
        if (extraFor !== block.block_index) {
          throw new GenerationLimitError(
            `block ${block.name} exceeded ${maxGenerations} generations; find the cause of the drift, then resume with --allow-extra-generation to permit one more`,
          );
        }
        extraFor = null;
        const previous = log
          .filter(isCheck)
          .filter(
            (r) =>
              r.block_index === block.block_index &&
              r.generation === generation - 1 &&
              r.phase === "end",
          )
          .at(-1);
        const extra: ExtraGenerationRecord = {
          run_id: plan.run_id,
          block_index: block.block_index,
          block_name: block.name,
          generation,
          phase: "extra_generation",
          max_block_generations: maxGenerations,
          intended_active: block.active_replicas,
          reason: `resumed with --allow-extra-generation after generation ${generation - 1} ended unconfirmed: ${previous?.reasons.join("; ") || "no reason recorded"}`,
          at: new Date().toISOString(),
        };
        await appendBlockRecord(blocksFile, extra);
        log.push(extra);
      }
      const record = async (phase: "gate" | "end", check: StateCheck) => {
        const entry: BlockCheckRecord = {
          run_id: plan.run_id,
          block_index: block.block_index,
          block_name: block.name,
          generation,
          phase,
          check_number: nextCheck(phase),
          intended_active: block.active_replicas,
          observed: check.observed,
          missing_providers: check.missing_providers,
          confirmed: check.confirmed,
          reasons: check.reasons,
          at: new Date().toISOString(),
        };
        await appendBlockRecord(blocksFile, entry);
        log.push(entry);
      };
      const nextCheck = (phase: "gate" | "end") =>
        log.filter(
          (r) =>
            r.block_index === block.block_index && r.generation === generation && r.phase === phase,
        ).length + 1;

      const settle = async (tries: number, confirmedPhase: "gate" | "end") => {
        for (let attempt = 1; attempt <= tries; attempt++) {
          if (attempt > 1) await deps.sleep(plan.campaign.stabilization_ms);
          const check = await deps.checkState(block.active_replicas, cids);
          if (check.confirmed) {
            await record(confirmedPhase, check);
            return true;
          }
          await record("end", check);
          if (nodeDrift(block.active_replicas, check.observed)) return false;
        }
        return false;
      };
      if (precheck) {
        precheck = false;
        if (!(await settle(maxEnds, "gate"))) {
          generation++;
          generationsRerun++;
          continue;
        }
      }

      let gateConfirmed = false;
      for (
        let attempt = 1;
        attempt <= plan.campaign.max_gate_attempts && !gateConfirmed;
        attempt++
      ) {
        await deps.applyState(block.active_replicas);
        await deps.sleep(plan.campaign.stabilization_ms);
        const check = await deps.checkState(block.active_replicas, cids);
        await record("gate", check);
        gateConfirmed = check.confirmed;
      }
      if (!gateConfirmed) {
        throw new BlockGateError(
          `block ${block.name}: replica state never confirmed after ${plan.campaign.max_gate_attempts} checks`,
        );
      }

      const scenario = scenarioFor(block.name, generation);
      for (const attempt of block.attempts) {
        const identity = {
          scenario,
          work_id: attempt.work_id,
          method: attempt.method,
          attempt: attempt.repetition,
        };
        if (done.has(keyOf(identity))) {
          skipped++;
          continue;
        }
        if (options.stopAfterAttempts !== undefined && executed >= options.stopAfterAttempts) {
          return { executed, skipped, interrupted: true, generationsRerun };
        }
        const payload: AttemptPayload = {
          run_id: plan.run_id,
          attempt_id: attempt.attempt_id,
          scenario,
          work_id: attempt.work_id,
          film_pda: attempt.film_pda,
          size_bytes: attempt.size_bytes,
          size_band: attempt.size_band,
          method: attempt.method,
          repetition: attempt.repetition,
          timeout_ms: attempt.timeout_ms,
          gateway_eligible: attempt.gateway_eligible,
          active_replicas: block.active_replicas.length,
          ...context,
        };
        const output = await deps.runAttempt(payload);
        const r = output.record;
        if (r.run_id !== plan.run_id || keyOf(r) !== keyOf(identity)) {
          throw new Error(
            `executor returned a record for a different attempt than ${attempt.attempt_id}`,
          );
        }
        if (r.cid_expected !== attempt.cid || r.film_pda !== attempt.film_pda) {
          throw new Error(
            `executor record for ${attempt.attempt_id} does not match the plan: cid_expected ${r.cid_expected} vs ${attempt.cid}, film_pda ${r.film_pda} vs ${attempt.film_pda}`,
          );
        }
        const evidence = output.evidence;
        if (
          evidence["attempt_id"] !== attempt.attempt_id ||
          evidence["run_id"] !== plan.run_id ||
          evidence["scenario"] !== scenario
        ) {
          throw new Error(
            `executor returned evidence for a different attempt than ${attempt.attempt_id}`,
          );
        }
        if (!sameSet(evidence["declared_replicas"], expectedDeclared)) {
          throw new Error(
            `executor evidence for ${attempt.attempt_id}: declared_replicas ${JSON.stringify(evidence["declared_replicas"])} differ from the topology replicas ${JSON.stringify([...expectedDeclared])}`,
          );
        }
        const validated = resultRecordSchema.parse(r);
        await appendJsonLine(evidenceFile, {
          ...evidence,
          run_id: plan.run_id,
          attempt_id: attempt.attempt_id,
          scenario,
          generation,
          block_index: block.block_index,
        });
        await appendResult(outPath, validated);
        done.add(keyOf(identity));
        executed++;
      }

      if (await settle(maxEnds, "end")) break;
      generation++;
      generationsRerun++;
    }
  }

  if (options.restoreAllAtEnd ?? true) await deps.applyState(plan.campaign.replica_nodes);
  const recorded = (await readJsonLines(outPath, resultRecordSchema)).filter(
    (r) => r.run_id === plan.run_id,
  ).length;
  await markRunCompleted(outPath, plan.run_id, recorded);
  return { executed, skipped, interrupted: false, generationsRerun };
}
