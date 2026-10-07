import { resultRecordSchema } from "@spiral-backbone/protocol";
import { z } from "zod";

export const attemptPayloadSchema = z
  .object({
    run_id: z.string(),
    attempt_id: z.string(),
    scenario: z.string(),
    work_id: z.string(),
    film_pda: z.string(),
    size_bytes: z.number().int().nonnegative(),
    size_band: z.string(),
    method: z.enum(["direct", "gateway"]),
    repetition: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    gateway_eligible: z.boolean(),
    active_replicas: z.number().int().nonnegative(),
    rpc_url: z.url(),
    gateway_url: z.url(),
    bootstrap_multiaddr: z.string().nullable(),
    private_network: z.boolean(),
    artifact_versions: z.record(z.string(), z.string()),
  })
  .strict();

export type AttemptPayload = z.infer<typeof attemptPayloadSchema>;

export const executorOutputSchema = z
  .object({ record: resultRecordSchema, evidence: z.record(z.string(), z.unknown()) })
  .strict();

export type ExecutorOutput = z.infer<typeof executorOutputSchema>;

export const EXECUTOR_EXIT = { fault: 2, refused: 3 } as const;
