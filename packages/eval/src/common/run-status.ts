import { z } from "zod";
import { appendJsonLine } from "./ndjson";
import { sidecarPath } from "./sidecar";

export const runStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      run_id: z.string(),
      status: z.literal("started"),
      expected_attempts: z.number().int().nonnegative(),
      started_at: z.string(),
    })
    .strict(),
  z
    .object({
      run_id: z.string(),
      status: z.literal("completed"),
      recorded_attempts: z.number().int().nonnegative(),
      finished_at: z.string(),
    })
    .strict(),
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export async function markRunStarted(
  outPath: string,
  runId: string,
  expectedAttempts: number,
): Promise<void> {
  await appendJsonLine(sidecarPath(outPath, "runs"), {
    run_id: runId,
    status: "started",
    expected_attempts: expectedAttempts,
    started_at: new Date().toISOString(),
  } satisfies RunStatus);
}

export async function markRunCompleted(
  outPath: string,
  runId: string,
  recordedAttempts: number,
): Promise<void> {
  await appendJsonLine(sidecarPath(outPath, "runs"), {
    run_id: runId,
    status: "completed",
    recorded_attempts: recordedAttempts,
    finished_at: new Date().toISOString(),
  } satisfies RunStatus);
}
