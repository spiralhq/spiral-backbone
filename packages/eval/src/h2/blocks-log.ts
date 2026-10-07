import { existsSync } from "node:fs";
import { z } from "zod";
import { appendJsonLine, readJsonLines } from "../common/ndjson";

export const blockRecordSchema = z
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

export type BlockRecord = z.infer<typeof blockRecordSchema>;

export function blocksPath(outPath: string): string {
  const base = outPath.endsWith(".ndjson") ? outPath.slice(0, -".ndjson".length) : outPath;
  return `${base}-blocks.ndjson`;
}

export async function appendBlockRecord(path: string, record: BlockRecord): Promise<void> {
  await appendJsonLine(path, blockRecordSchema.parse(record));
}

export async function readBlockRecords(path: string): Promise<BlockRecord[]> {
  return existsSync(path) ? readJsonLines(path, blockRecordSchema) : [];
}

export function scenarioFor(blockName: string, generation: number): string {
  return `${blockName}@g${generation}`;
}

export function parseScenario(scenario: string): { block: string; generation: number } | null {
  const match = /^(.+)@g(\d+)$/.exec(scenario);
  return match ? { block: match[1]!, generation: Number(match[2]) } : null;
}

export function validGenerations(records: BlockRecord[], runId: string): Set<string> {
  const lastEnd = new Map<string, BlockRecord>();
  for (const record of records) {
    if (record.run_id === runId && record.phase === "end")
      lastEnd.set(scenarioFor(record.block_name, record.generation), record);
  }
  return new Set([...lastEnd].filter(([, record]) => record.confirmed).map(([key]) => key));
}
