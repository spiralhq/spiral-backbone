import { existsSync, readFileSync } from "node:fs";
import { resultRecordSchema, type ResultRecord } from "@spiral-backbone/protocol";
import { z } from "zod";
import { readJsonLines } from "../common/ndjson";
import { runStatusSchema, type RunStatus } from "../common/run-status";

export const h3EvidenceSchema = z
  .object({
    run_id: z.string(),
    scenario_id: z.number(),
    expected_code: z.number(),
    observed: z.object({ index: z.number(), code: z.number() }).nullable(),
    failing_program: z.string().nullable(),
  })
  .passthrough();

export const h4RunSchema = z
  .object({
    run_id: z.string(),
    backfill: z
      .object({
        duration_ms: z.number(),
        rpc_calls_total: z.number(),
        rate_limit_retries: z.number(),
      })
      .passthrough()
      .nullable(),
    error: z.string().optional(),
    golden_count: z.number().optional(),
    rebuilt_count: z.number().optional(),
    missing_organizations: z.array(z.string()).optional(),
    diffs: z
      .array(
        z
          .object({
            table: z.string(),
            key: z.string(),
            kind: z.string(),
            field: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export async function loadResults(path: string): Promise<ResultRecord[]> {
  return existsSync(path) ? readJsonLines(path, resultRecordSchema) : [];
}

export async function loadH3Evidence(path: string): Promise<z.infer<typeof h3EvidenceSchema>[]> {
  return existsSync(path) ? readJsonLines(path, h3EvidenceSchema) : [];
}

export function loadH4Run(path: string): z.infer<typeof h4RunSchema> | undefined {
  return existsSync(path) ? h4RunSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

export async function loadRunStatus(path: string): Promise<RunStatus[]> {
  return existsSync(path) ? readJsonLines(path, runStatusSchema) : [];
}
