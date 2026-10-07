import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InventoryRecord } from "@spiral-backbone/protocol";
import { z } from "zod";
import {
  campaignBlockSchema,
  campaignSpecSchema,
  validateCampaign,
  type CampaignBlock,
  type CampaignSpec,
} from "./campaign";

export const plannedAttemptSchema = z
  .object({
    attempt_id: z.string(),
    work_id: z.string(),
    film_pda: z.string(),
    cid: z.string(),
    size_bytes: z.number().int().nonnegative(),
    size_band: z.string(),
    cold_cid: z.boolean(),
    method: z.enum(["direct", "gateway"]),
    repetition: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    gateway_eligible: z.boolean(),
  })
  .strict();

export const plannedBlockSchema = z
  .object({
    block_index: z.number().int().nonnegative(),
    name: z.string(),
    kind: campaignBlockSchema.shape.kind,
    active_replicas: z.array(z.string()),
    attempts: z.array(plannedAttemptSchema),
  })
  .strict();

export const frozenPlanSchema = z
  .object({
    plan_version: z.literal(1),
    run_id: z.string(),
    created_at: z.string(),
    golden_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    campaign: campaignSpecSchema,
    blocks: z.array(plannedBlockSchema),
  })
  .strict();

export type PlannedAttempt = z.infer<typeof plannedAttemptSchema>;
export type PlannedBlock = z.infer<typeof plannedBlockSchema>;
export type FrozenPlan = z.infer<typeof frozenPlanSchema>;

export class ColdCidViolation extends Error {}

export function timeoutFor(sizeBytes: number, timeout: CampaignSpec["timeout"]): number {
  return timeout.base_ms + Math.ceil(sizeBytes / 1_000_000) * timeout.per_mb_ms;
}

export function attemptId(
  blockName: string,
  workId: string,
  method: "direct" | "gateway",
  repetition: number,
): string {
  return `${blockName}/${workId}/${method}/r${repetition}`;
}

export function goldenDigest(golden: InventoryRecord[]): string {
  return createHash("sha256")
    .update(golden.map((g) => JSON.stringify(g)).join("\n"))
    .digest("hex");
}

function selectWorks(block: CampaignBlock, golden: InventoryRecord[]): InventoryRecord[] {
  if (block.works === "all") return golden;
  if (block.works === "cold") return golden.filter((g) => g.cold_cid);
  if (block.works === "warm") return golden.filter((g) => !g.cold_cid);
  return block.works.map((id) => {
    const work = golden.find((g) => g.work_id === id);
    if (!work) throw new Error(`block ${block.name}: work ${id} is not in the golden inventory`);
    return work;
  });
}

export function generatePlan(input: {
  campaign: CampaignSpec;
  golden: InventoryRecord[];
  runId: string;
  now?: Date;
}): FrozenPlan {
  const errors = validateCampaign(input.campaign);
  if (errors.length > 0) throw new Error(`invalid campaign:\n${errors.join("\n")}`);

  const firstZero = input.campaign.blocks.findIndex((b) => b.active_replicas.length === 0);
  const zeroIndex = firstZero === -1 ? Number.POSITIVE_INFINITY : firstZero;
  const violations: string[] = [];

  const blocks = input.campaign.blocks.map((block, blockIndex) => {
    const works = selectWorks(block, input.golden);
    if (works.length === 0) throw new Error(`block ${block.name} selects no works`);
    const attempts = works.flatMap((work) =>
      block.methods.flatMap((method) =>
        Array.from({ length: block.repetitions }, (_, r) => {
          const repetition = r + 1;
          const id = attemptId(block.name, work.work_id, method, repetition);
          const gatewayEligible = !(work.cold_cid && blockIndex < zeroIndex);
          if (method === "gateway" && !gatewayEligible) violations.push(id);
          const sizeBytes = Number(work.byte_size);
          return {
            attempt_id: id,
            work_id: work.work_id,
            film_pda: work.film_pda,
            cid: work.cid,
            size_bytes: sizeBytes,
            size_band: work.size_band,
            cold_cid: work.cold_cid,
            method,
            repetition,
            timeout_ms: timeoutFor(sizeBytes, input.campaign.timeout),
            gateway_eligible: gatewayEligible,
          };
        }),
      ),
    );
    return {
      block_index: blockIndex,
      name: block.name,
      kind: block.kind,
      active_replicas: block.active_replicas,
      attempts,
    };
  });

  const ids = new Set<string>();
  for (const id of blocks.flatMap((b) => b.attempts.map((a) => a.attempt_id))) {
    if (ids.has(id)) throw new Error(`duplicate attempt_id ${id} (duplicate work_id?)`);
    ids.add(id);
  }

  if (violations.length > 0) {
    throw new ColdCidViolation(
      `cold CIDs requested via gateway before the zero-replica block: ${violations.join(", ")}`,
    );
  }
  return frozenPlanSchema.parse({
    plan_version: 1,
    run_id: input.runId,
    created_at: (input.now ?? new Date()).toISOString(),
    golden_sha256: goldenDigest(input.golden),
    campaign: input.campaign,
    blocks,
  });
}

export function planPath(plansDir: string, runId: string): string {
  return join(plansDir, `h2-${runId}.json`);
}

export async function writePlan(path: string, plan: FrozenPlan): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
}

export async function readPlan(path: string): Promise<FrozenPlan> {
  return frozenPlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function plannedAttemptCount(plan: FrozenPlan): number {
  return plan.blocks.reduce((sum, block) => sum + block.attempts.length, 0);
}
