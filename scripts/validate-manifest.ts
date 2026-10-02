import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SIZE_BANDS = {
  small: { min: 20_000_000, max: 100_000_000 },
  medium: { min: 100_000_000, max: 400_000_000 },
  large: { min: 400_000_000, max: 1_000_000_000 },
} as const;

export type SizeBand = keyof typeof SIZE_BANDS;

export const FINAL_BAND_COUNTS: Record<SizeBand, number> = { small: 7, medium: 8, large: 5 };

export const SOURCES = [
  "Prelinger Archives",
  "Internet Archive",
  "Wikimedia Commons",
  "Domínio Público (MEC)",
] as const;

const workSchema = z
  .object({
    work_id: z.string().regex(/^pd-\d{3}$/),
    title: z.string().min(1),
    source: z.enum(SOURCES),
    url: z.url(),
    file_url: z.url(),
    file_name: z.string().regex(/^[\w.-]+$/),
    license: z
      .object({
        status: z.literal("public_domain"),
        basis: z.string().min(20),
        reference_url: z.url(),
      })
      .strict(),
    resolution: z.string().regex(/^\d+x\d+$/),
    duration_seconds: z.number().positive(),
    size_bytes: z.number().int().positive(),
    size_band: z.enum(["small", "medium", "large"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    placeholder: z.boolean(),
  })
  .strict();

export const manifestSchema = z
  .object({
    manifest_version: z.literal(1),
    notice: z.string().min(1),
    works: z.array(workSchema),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

export function bandForSize(bytes: number): SizeBand | undefined {
  return (Object.keys(SIZE_BANDS) as SizeBand[]).find(
    (band) => bytes >= SIZE_BANDS[band].min && bytes < SIZE_BANDS[band].max,
  );
}

function formatPath(path: PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

export async function validateManifest(
  raw: unknown,
  options: { filesDir: string; final: boolean },
): Promise<{ errors: string[]; notes: string[] }> {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
      notes: [],
    };
  }
  const { works } = parsed.data;
  const errors: string[] = [];
  const notes: string[] = [];

  for (const id of duplicates(works.map((w) => w.work_id))) errors.push(`duplicate work_id ${id}`);
  for (const sha of duplicates(works.map((w) => w.sha256))) errors.push(`duplicate sha256 ${sha}`);
  for (const name of duplicates(works.map((w) => w.file_name)))
    errors.push(`duplicate file_name ${name}`);

  for (const work of works) {
    const actualBand = bandForSize(work.size_bytes);
    if (actualBand !== work.size_band) {
      errors.push(
        `${work.work_id}: size_bytes ${work.size_bytes} falls in band ${actualBand ?? "none (outside 20 MB–1 GB)"}, not ${work.size_band}`,
      );
    }
    const localPath = join(options.filesDir, work.file_name);
    if (!existsSync(localPath)) {
      notes.push(
        `${work.work_id}: ${work.file_name} not downloaded; size/sha256 not checked against a file`,
      );
      continue;
    }
    const localSize = statSync(localPath).size;
    if (localSize !== work.size_bytes) {
      errors.push(`${work.work_id}: size_bytes ${work.size_bytes} but local file has ${localSize}`);
      continue;
    }
    const localSha = await sha256File(localPath);
    if (localSha !== work.sha256) {
      errors.push(
        `${work.work_id}: sha256 mismatch (manifest ${work.sha256}, local file ${localSha})`,
      );
    }
  }

  if (options.final) {
    if (works.length !== 20) errors.push(`final manifest must have 20 works, has ${works.length}`);
    for (const band of Object.keys(FINAL_BAND_COUNTS) as SizeBand[]) {
      const count = works.filter((w) => w.size_band === band).length;
      if (count !== FINAL_BAND_COUNTS[band]) {
        errors.push(
          `final manifest must have ${FINAL_BAND_COUNTS[band]} works in band ${band}, has ${count}`,
        );
      }
    }
    for (const work of works.filter((w) => w.placeholder)) {
      errors.push(`${work.work_id}: placeholder entries are not allowed in the final manifest`);
    }
  }

  return { errors, notes };
}

async function main(argv: string[]): Promise<number> {
  const manifestFlag = argv.indexOf("--manifest");
  const manifestPath = resolve(
    manifestFlag >= 0 ? (argv[manifestFlag + 1] ?? "") : "dataset/manifest.json",
  );
  const final = argv.includes("--final");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${manifestPath} as JSON: ${(error as Error).message}`);
    return 1;
  }

  const { errors, notes } = await validateManifest(raw, {
    filesDir: join(dirname(manifestPath), "files"),
    final,
  });
  for (const note of notes) console.log(`note: ${note}`);
  if (errors.length > 0) {
    console.error(`Manifest invalid:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    return 1;
  }
  console.log(`Manifest valid${final ? " (final)" : ""}.`);
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
