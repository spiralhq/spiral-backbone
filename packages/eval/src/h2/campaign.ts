import { readFile } from "node:fs/promises";
import { z } from "zod";

const nodeName = z.string().regex(/^[a-z0-9-]+$/);

export const campaignBlockSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9=-]+$/),
    kind: z.enum(["main", "cold-start", "degradation"]),
    active_replicas: z.array(nodeName),
    methods: z.array(z.enum(["direct", "gateway"])).min(1),
    works: z.union([z.enum(["all", "cold", "warm"]), z.array(z.string().min(1)).min(1)]),
    repetitions: z.number().int().positive(),
  })
  .strict();

export const campaignSpecSchema = z
  .object({
    campaign_version: z.literal(1),
    replica_nodes: z.array(nodeName).min(1),
    stabilization_ms: z.number().int().nonnegative(),
    max_gate_attempts: z.number().int().positive(),
    max_end_attempts: z.number().int().positive(),
    max_block_generations: z.number().int().positive(),
    timeout: z
      .object({ base_ms: z.number().int().positive(), per_mb_ms: z.number().int().nonnegative() })
      .strict(),
    blocks: z.array(campaignBlockSchema).min(1),
  })
  .strict();

export type CampaignSpec = z.infer<typeof campaignSpecSchema>;
export type CampaignBlock = z.infer<typeof campaignBlockSchema>;

export function validateCampaign(spec: CampaignSpec): string[] {
  const errors: string[] = [];
  const nodes = new Set(spec.replica_nodes);
  if (nodes.size !== spec.replica_nodes.length) errors.push("replica_nodes has duplicates");

  const names = new Set<string>();
  for (const block of spec.blocks) {
    if (names.has(block.name)) errors.push(`duplicate name ${block.name}`);
    names.add(block.name);
    if (new Set(block.active_replicas).size !== block.active_replicas.length) {
      errors.push(`block ${block.name}: active_replicas has duplicates`);
    }
    for (const node of block.active_replicas) {
      if (!nodes.has(node)) errors.push(`block ${block.name}: unknown replica ${node}`);
    }
    if (block.kind !== "degradation" && block.active_replicas.length === 0)
      errors.push(
        `block ${block.name}: zero active replicas is only allowed in a degradation block`,
      );
    if (new Set(block.methods).size !== block.methods.length)
      errors.push(`block ${block.name}: duplicate methods`);
  }

  const degradation = spec.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind === "degradation");
  if (degradation.length > 0) {
    const first = degradation[0]!.index;
    if (degradation.some(({ index }, k) => index !== first + k))
      errors.push("degradation blocks must be contiguous");
    const total = spec.replica_nodes.length;
    if (degradation.length !== total + 1) {
      errors.push(
        `degradation must have ${total + 1} blocks (${total} → 0), has ${degradation.length}`,
      );
    }
    degradation.forEach(({ block }, k) => {
      if (block.active_replicas.length !== total - k) {
        errors.push(
          `degradation block ${block.name} must have ${total - k} active replicas, has ${block.active_replicas.length}`,
        );
      }
      const previous = degradation[k - 1]?.block;
      if (
        previous &&
        block.active_replicas.some((node) => !previous.active_replicas.includes(node))
      ) {
        errors.push(`degradation block ${block.name} turns a replica back on`);
      }
    });
  }
  return errors;
}

export async function loadCampaign(path: string): Promise<CampaignSpec> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw === "object" && raw !== null && !("max_end_attempts" in raw)) {
    throw new Error(
      `invalid campaign ${path}: max_end_attempts is required (a positive integer: how many end-of-block checks may run before a generation is invalidated)`,
    );
  }
  const spec = campaignSpecSchema.parse(raw);
  const errors = validateCampaign(spec);
  if (errors.length > 0) {
    throw new Error(
      `invalid campaign ${path}:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
    );
  }
  return spec;
}
