import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface ArchiveEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST = "manifest.json";

const USAGE = `Usage: archive-day [--results results] [--plans plans] [--archive archive] [--date YYYY-MM-DD]
       archive-day --verify archive/<date>`;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(
  dir: string,
  onOdd: (path: string, kind: "symlink" | "non-regular") => void,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) onOdd(full, "symlink");
      else if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
      else onOdd(full, "non-regular");
    }
  };
  await walk(dir);
  return found;
}

const rejectOdd = (path: string, kind: "symlink" | "non-regular"): never => {
  throw new Error(
    kind === "symlink" ? `symlink not allowed: ${path}` : `non-regular entry not allowed: ${path}`,
  );
};

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

async function describeFiles(dir: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  for (const file of await listFiles(dir, rejectOdd)) {
    const path = toPosix(relative(dir, file));
    entries.push({ path, bytes: (await lstat(file)).size, sha256: await sha256File(file) });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function archiveDay(options: {
  sources: string[];
  archiveRoot: string;
  date: string;
  now?: Date;
}): Promise<{ dir: string; files: number; skipped: string[] }> {
  const { sources, archiveRoot, date } = options;
  if (!DATE_PATTERN.test(date)) throw new Error(`invalid date "${date}", expected YYYY-MM-DD`);
  const named = sources.map((source) => ({ source, name: basename(resolve(source)) }));
  const names = named.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error(`sources share a basename: ${names.join(", ")}`);
  }

  const present: { source: string; name: string }[] = [];
  const skipped: string[] = [];
  for (const entry of named) {
    if (await lstat(entry.source).catch(() => undefined)) present.push(entry);
    else skipped.push(`${entry.name} (absent)`);
  }
  if (present.length === 0) throw new Error("no source directories exist; nothing to archive");

  const finalDir = join(archiveRoot, date);
  if (existsSync(finalDir)) throw new Error(`archive ${finalDir} already exists`);

  await mkdir(archiveRoot, { recursive: true });
  const tmpDir = await mkdtemp(join(archiveRoot, `.${date}.tmp-`));
  try {
    for (const { source, name } of present) {
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`symlink not allowed: ${source}`);
      if (!stat.isDirectory()) throw new Error(`source ${source} is not a directory`);
      for (const file of await listFiles(source, rejectOdd)) {
        const target = join(tmpDir, name, relative(source, file));
        await mkdir(join(target, ".."), { recursive: true });
        await copyFile(file, target);
      }
    }
    const files = await describeFiles(tmpDir);
    if (files.length === 0) throw new Error("no files found in sources; nothing to archive");
    const manifest = {
      archive_version: 1,
      date,
      created_at: (options.now ?? new Date()).toISOString(),
      files,
    };
    await writeFile(join(tmpDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(tmpDir, finalDir);
    return { dir: finalDir, files: files.length, skipped };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function isEntry(value: unknown): value is ArchiveEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    Number.isInteger(entry.bytes) &&
    typeof entry.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.sha256)
  );
}

async function checkArchive(dir: string): Promise<string[]> {
  let manifest: { archive_version?: unknown; date?: unknown; files?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8"));
  } catch (error) {
    return [`manifest unreadable: ${(error as Error).message}`];
  }
  if (
    manifest?.archive_version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(isEntry)
  ) {
    return ["manifest malformed"];
  }

  const problems: string[] = [];
  const base = resolve(dir);
  if (manifest.date !== basename(base)) {
    problems.push(
      `manifest date ${String(manifest.date)} does not match directory ${basename(base)}`,
    );
  }
  const listed = new Set<string>();
  for (const entry of manifest.files as ArchiveEntry[]) {
    if (listed.has(entry.path)) {
      problems.push(`${entry.path}: duplicate manifest entry`);
      continue;
    }
    listed.add(entry.path);
    const full = resolve(base, entry.path);
    if (!full.startsWith(`${base}${sep}`)) {
      problems.push(`${entry.path}: path escapes the archive`);
      continue;
    }
    let current = base;
    let linked = false;
    for (const part of relative(base, full).split(sep)) {
      current = join(current, part);
      const stat = await lstat(current).catch(() => undefined);
      if (stat?.isSymbolicLink()) {
        linked = true;
        break;
      }
      if (!stat) break;
    }
    if (linked) {
      problems.push(`${entry.path}: path passes through a symlink`);
      continue;
    }
    const stat = await lstat(full).catch(() => undefined);
    if (!stat?.isFile()) {
      problems.push(`${entry.path}: missing`);
    } else if (stat.size !== entry.bytes) {
      problems.push(`${entry.path}: changed (size ${stat.size}, manifest ${entry.bytes})`);
    } else if ((await sha256File(full)) !== entry.sha256) {
      problems.push(`${entry.path}: changed (sha256 mismatch)`);
    }
  }
  const files = await listFiles(base, (path, kind) =>
    problems.push(`unexpected ${kind}: ${toPosix(relative(base, path))}`),
  );
  for (const file of files) {
    const path = toPosix(relative(base, file));
    if (path !== MANIFEST && !listed.has(path))
      problems.push(`${path}: extra file not in manifest`);
  }
  return problems;
}

export async function verifyArchive(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  let problems: string[];
  try {
    problems = await checkArchive(dir);
  } catch (error) {
    problems = [`verification failed: ${(error as Error).message}`];
  }
  return { ok: problems.length === 0, problems };
}

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        results: { type: "string", default: "results" },
        plans: { type: "string", default: "plans" },
        archive: { type: "string", default: "archive" },
        date: { type: "string" },
        verify: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.verify !== undefined) {
    const { ok, problems } = await verifyArchive(values.verify);
    if (!ok) {
      console.error(problems.join("\n"));
      return 1;
    }
    console.log(`Archive verified: ${values.verify}`);
    return 0;
  }
  try {
    const result = await archiveDay({
      sources: [values.results, values.plans],
      archiveRoot: values.archive,
      date: values.date ?? new Date().toISOString().slice(0, 10),
    });
    for (const entry of result.skipped) console.log(`skipped: ${entry}`);
    console.log(JSON.stringify({ dir: result.dir, files: result.files }));
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
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
