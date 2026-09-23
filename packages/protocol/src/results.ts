import { z } from "zod";

export const failureClassSchema = z.enum([
  "object_unavailable",
  "timeout",
  "gateway_failure",
  "connection_error",
  "cid_mismatch",
  "external_cache",
]);

export const resultRecordSchema = z.object({
  run_id: z.string(),
  hypothesis: z.enum(["H1", "H2", "H3", "H4"]),
  film_pda: z.string(),
  work_id: z.string(),
  size_bytes: z.number().int().nonnegative(),
  size_band: z.string(),
  scenario: z.string(),
  method: z.string(),
  attempt: z.number().int().positive(),
  started_at: z.string(),
  finished_at: z.string(),
  latency_ms: z.number().nonnegative(),
  cid_expected: z.string(),
  cid_observed: z.string().nullable(),
  outcome: z.enum(["success", "failure"]),
  failure_class: failureClassSchema.nullable(),
  tx_signature: z.string().nullable(),
  rpc_endpoint: z.string(),
  verifier_impl: z.string(),
  artifact_versions: z.record(z.string(), z.string()),
});

export type ResultRecord = z.infer<typeof resultRecordSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
