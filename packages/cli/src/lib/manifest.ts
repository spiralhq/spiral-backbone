import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CliError } from "./errors";

const manifestWorkSchema = z.object({
  work_id: z.string().min(1),
  size_bytes: z.number().int().positive(),
  size_band: z.enum(["small", "medium", "large"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const manifestSchema = z.object({ works: z.array(manifestWorkSchema) });

export type ManifestWork = z.infer<typeof manifestWorkSchema>;

export async function findManifestWork(
  manifestPath: string,
  workId: string,
): Promise<ManifestWork> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new CliError(`cannot read manifest ${manifestPath}: ${(error as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(`manifest ${manifestPath} is invalid — run npm run validate:manifest`);
  }
  const work = parsed.data.works.find((entry) => entry.work_id === workId);
  if (!work) throw new CliError(`work ${workId} not found in ${manifestPath}`);
  return work;
}

export function assertContentMatchesWork(work: ManifestWork, content: Uint8Array): string {
  if (content.byteLength !== work.size_bytes) {
    throw new CliError(
      `file size ${content.byteLength} differs from manifest size_bytes ${work.size_bytes} for ${work.work_id}`,
    );
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== work.sha256) {
    throw new CliError(
      `file sha256 ${sha256} differs from manifest sha256 ${work.sha256} for ${work.work_id}`,
    );
  }
  return sha256;
}
