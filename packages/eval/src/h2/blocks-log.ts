import { existsSync } from "node:fs";
import { z } from "zod";
import { appendJsonLine, readJsonLines, RESUME_H2 } from "../common/ndjson";

export const blockCheckRecordSchema = z
  .object({
    run_id: z.string(),
    block_index: z.number().int().nonnegative(),
    block_name: z.string(),
    generation: z.number().int().positive(),
    phase: z.enum(["gate", "end"]),
    check_number: z.number().int().positive(),
    intended_active: z.array(z.string()),
    observed: z.array(
      z
        .object({ node: z.string(), systemd_active: z.boolean(), swarm_reachable: z.boolean() })
        .strict(),
    ),
    missing_providers: z.record(z.string(), z.array(z.string())),
    confirmed: z.boolean(),
    reasons: z.array(z.string()),
    at: z.string(),
  })
  .strict();

export const extraGenerationRecordSchema = z
  .object({
    run_id: z.string(),
    block_index: z.number().int().nonnegative(),
    block_name: z.string(),
    generation: z.number().int().positive(),
    phase: z.literal("extra_generation"),
    max_block_generations: z.number().int().positive(),
    intended_active: z.array(z.string()),
    reason: z.string().min(1),
    at: z.string(),
  })
  .strict();

export const blockRecordSchema = z.union([blockCheckRecordSchema, extraGenerationRecordSchema]);

export type BlockCheckRecord = z.infer<typeof blockCheckRecordSchema>;
export type ExtraGenerationRecord = z.infer<typeof extraGenerationRecordSchema>;
export type BlockRecord = z.infer<typeof blockRecordSchema>;

export const isCheck = (r: BlockRecord): r is BlockCheckRecord => r.phase !== "extra_generation";
export const isExtraGeneration = (r: BlockRecord): r is ExtraGenerationRecord =>
  r.phase === "extra_generation";

export function blocksPath(outPath: string): string {
  const base = outPath.endsWith(".ndjson") ? outPath.slice(0, -".ndjson".length) : outPath;
  return `${base}-blocks.ndjson`;
}

export async function appendBlockRecord(path: string, record: BlockRecord): Promise<void> {
  await appendJsonLine(path, blockRecordSchema.parse(record));
}

export async function readBlockRecords(path: string): Promise<BlockRecord[]> {
  return existsSync(path) ? readJsonLines(path, blockRecordSchema, RESUME_H2) : [];
}

export function scenarioFor(blockName: string, generation: number): string {
  return `${blockName}@g${generation}`;
}

export function parseScenario(scenario: string): { block: string; generation: number } | null {
  const match = /^(.+)@g(\d+)$/.exec(scenario);
  return match ? { block: match[1]!, generation: Number(match[2]) } : null;
}

export function validGenerations(records: BlockRecord[], runId: string): Set<string> {
  const lastEnd = new Map<string, BlockCheckRecord>();
  for (const record of records) {
    if (record.run_id === runId && record.phase === "end")
      lastEnd.set(scenarioFor(record.block_name, record.generation), record);
  }
  return new Set([...lastEnd].filter(([, record]) => record.confirmed).map(([key]) => key));
}
