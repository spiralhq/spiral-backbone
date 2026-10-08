import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  renameSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveDay, verifyArchive } from "./archive-day";

const SCRIPT = join(import.meta.dirname, "archive-day.ts");
const h2Content = '{"a":1}\n{"a":2}\n';

let root: string;
let results: string;
let plans: string;
let archiveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archive-day-"));
  results = join(root, "results");
  plans = join(root, "plans");
  archiveRoot = join(root, "archive");
  mkdirSync(join(results, "report"), { recursive: true });
  mkdirSync(plans);
  writeFileSync(join(results, "h2.ndjson"), h2Content);
  writeFileSync(join(results, "h2-blocks.ndjson"), '{"b":1}\n');
  writeFileSync(join(results, "report", "report.md"), "# report\n");
  writeFileSync(join(plans, "h2-x.json"), "{}");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("archiveDay", () => {
  it("archives every file with verifiable checksums", async () => {
    const { dir, files } = await archiveDay({
      sources: [results, plans],
      archiveRoot,
      date: "2026-11-03",
    });
    expect(files).toBe(4);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.archive_version).toBe(1);
    expect(manifest.date).toBe("2026-11-03");
    expect(typeof manifest.created_at).toBe("string");
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "plans/h2-x.json",
      "results/h2-blocks.ndjson",
      "results/h2.ndjson",
      "results/report/report.md",
    ]);
    expect(manifest.files[2].sha256).toBe(createHash("sha256").update(h2Content).digest("hex"));
    expect(manifest.files[2].bytes).toBe(Buffer.byteLength(h2Content));
    expect(readFileSync(join(dir, "results", "h2.ndjson"), "utf8")).toBe(h2Content);
    expect(await verifyArchive(dir)).toEqual({ ok: true, problems: [] });
  });

  it("refuses to overwrite an existing date", async () => {
    const options = { sources: [results, plans], archiveRoot, date: "2026-11-03" };
    const { dir } = await archiveDay(options);
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    writeFileSync(join(results, "h2.ndjson"), "changed");
    await expect(archiveDay(options)).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "results", "h2.ndjson"), "utf8")).toBe(h2Content);
  });

  it("verify reports a modified, a missing and an extra file", async () => {
    const { dir } = await archiveDay({
      sources: [results, plans],
      archiveRoot,
      date: "2026-11-03",
    });
    appendFileSync(join(dir, "results", "h2.ndjson"), "x");
    rmSync(join(dir, "plans", "h2-x.json"));
    writeFileSync(join(dir, "results", "stray.txt"), "stray");
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/results\/h2\.ndjson.*(changed|mismatch)/);
    expect(problems.join("\n")).toMatch(/plans\/h2-x\.json.*missing/);
    expect(problems.join("\n")).toMatch(/results\/stray\.txt.*extra/);
  });

  it("verify reports a malformed manifest", async () => {
    const { dir } = await archiveDay({
      sources: [results, plans],
      archiveRoot,
      date: "2026-11-03",
    });
    writeFileSync(join(dir, "manifest.json"), '{"archive_version":2}');
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/manifest/);
  });

  it("leaves no partial archive under the final name when a copy fails", async () => {
    const link = join(root, "plans-link");
    symlinkSync(plans, link);
    await expect(
      archiveDay({
        sources: [results, link],
        archiveRoot,
        date: "2026-11-03",
      }),
    ).rejects.toThrow(/symlink/i);
    expect(existsSync(join(archiveRoot, "2026-11-03"))).toBe(false);
    expect(readdirSync(archiveRoot)).toEqual([]);
  });

  it("skips an absent plans/ and reports it", async () => {
    rmSync(plans, { recursive: true });
    const { dir, files, skipped } = await archiveDay({
      sources: [results, plans],
      archiveRoot,
      date: "2026-11-03",
    });
    expect(files).toBe(3);
    expect(skipped).toEqual(["plans (absent)"]);
    expect(await verifyArchive(dir)).toEqual({ ok: true, problems: [] });
  });

  it("errors when no source directory exists", async () => {
    rmSync(plans, { recursive: true });
    rmSync(results, { recursive: true });
    await expect(
      archiveDay({ sources: [results, plans], archiveRoot, date: "2026-11-03" }),
    ).rejects.toThrow(/no source/i);
    expect(existsSync(join(archiveRoot, "2026-11-03"))).toBe(false);
  });

  it("leaves another run's stale temp dir untouched", async () => {
    const stale = join(archiveRoot, ".2026-11-03.tmp-other");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "partial"), "x");
    const { dir } = await archiveDay({ sources: [results], archiveRoot, date: "2026-11-03" });
    expect(readFileSync(join(stale, "partial"), "utf8")).toBe("x");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("rejects symlinks in a source", async () => {
    symlinkSync(join(results, "h2.ndjson"), join(results, "link.ndjson"));
    await expect(
      archiveDay({ sources: [results, plans], archiveRoot, date: "2026-11-03" }),
    ).rejects.toThrow(/symlink/i);
    expect(existsSync(join(archiveRoot, "2026-11-03"))).toBe(false);
  });

  it("rejects a malformed date", async () => {
    await expect(archiveDay({ sources: [results], archiveRoot, date: "../evil" })).rejects.toThrow(
      /date/i,
    );
  });
});

describe("archive integrity", () => {
  const make = () => archiveDay({ sources: [results, plans], archiveRoot, date: "2026-11-03" });
  const writeManifest = (dir: string, patch: Record<string, unknown>) => {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, ...patch }));
    return manifest;
  };

  it("reports a planted file symlink", async () => {
    const { dir } = await make();
    symlinkSync(join(dir, "results", "h2.ndjson"), join(dir, "results", "link.ndjson"));
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/unexpected symlink: results\/link\.ndjson/);
  });

  it("reports a planted directory symlink", async () => {
    const { dir } = await make();
    symlinkSync(join(dir, "plans"), join(dir, "plans-link"));
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/unexpected symlink: plans-link/);
  });

  it("reports results/ replaced by a symlink to an identical copy", async () => {
    const { dir } = await make();
    cpSync(join(dir, "results"), join(root, "results-copy"), { recursive: true });
    rmSync(join(dir, "results"), { recursive: true });
    symlinkSync(join(root, "results-copy"), join(dir, "results"));
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/results.*symlink/);
  });

  it("rejects a manifest date that differs from the directory name", async () => {
    const { dir } = await make();
    writeManifest(dir, { date: "2026-11-04" });
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/date/);
  });

  it("rejects a manifest with duplicate paths", async () => {
    const { dir } = await make();
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeManifest(dir, { files: [...manifest.files, manifest.files[0]] });
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/duplicate/);
  });

  it("rejects a manifest path that escapes the archive", async () => {
    const { dir } = await make();
    writeFileSync(join(root, "outside.txt"), "x");
    const sha256 = createHash("sha256").update("x").digest("hex");
    writeManifest(dir, { files: [{ path: "../../outside.txt", bytes: 1, sha256 }] });
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.join("\n")).toMatch(/escapes/);
  });

  it("reports I/O errors as problems instead of throwing", async () => {
    const { dir } = await make();
    renameSync(join(dir, "manifest.json"), join(dir, "manifest.bak"));
    const { ok, problems } = await verifyArchive(dir);
    expect(ok).toBe(false);
    expect(problems.length).toBeGreaterThan(0);
    const missing = await verifyArchive(join(root, "nowhere"));
    expect(missing.ok).toBe(false);
  });

  it("rejects sources that share a basename", async () => {
    mkdirSync(join(root, "other", "results"), { recursive: true });
    writeFileSync(join(root, "other", "results", "a.txt"), "a");
    await expect(
      archiveDay({
        sources: [results, join(root, "other", "results")],
        archiveRoot,
        date: "2026-11-03",
      }),
    ).rejects.toThrow(/basename/);
  });

  it("rejects a non-regular entry in a source", async () => {
    const fifo = join(results, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await expect(make()).rejects.toThrow(/non-regular/);
    expect(existsSync(join(archiveRoot, "2026-11-03"))).toBe(false);
  });

  it("rejects a source path that is itself a symlink", async () => {
    const link = join(root, "plans-link");
    symlinkSync(plans, link);
    await expect(
      archiveDay({ sources: [results, link], archiveRoot, date: "2026-11-03" }),
    ).rejects.toThrow(/symlink/i);
  });

  it("rejects archiving zero files", async () => {
    rmSync(join(plans, "h2-x.json"));
    rmSync(results, { recursive: true });
    mkdirSync(results);
    await expect(make()).rejects.toThrow(/no files/);
    expect(existsSync(join(archiveRoot, "2026-11-03"))).toBe(false);
  });
});

describe("archive-day CLI", () => {
  const run = (args: string[]) =>
    spawnSync("node", [SCRIPT, ...args], { cwd: root, encoding: "utf8" });

  it("archives with defaults and --verify passes", () => {
    const made = run(["--date", "2026-11-03"]);
    expect(made.status).toBe(0);
    expect(JSON.parse(made.stdout)).toEqual({ dir: join("archive", "2026-11-03"), files: 4 });
    const verified = run(["--verify", join("archive", "2026-11-03")]);
    expect(verified.status).toBe(0);
  });

  it("--verify exits 1 on a problem", () => {
    expect(run(["--date", "2026-11-03"]).status).toBe(0);
    writeFileSync(join(root, "archive", "2026-11-03", "results", "h2.ndjson"), "tampered");
    const verified = run(["--verify", join("archive", "2026-11-03")]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("results/h2.ndjson");
  });

  it("--verify on a missing directory exits 1 with a clean message", () => {
    const result = run(["--verify", "nowhere"]);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("    at ");
  });

  it("skips an absent plans/ with a visible report and exits 0", () => {
    rmSync(plans, { recursive: true });
    const result = run(["--date", "2026-11-03"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped: plans (absent)");
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      dir: join("archive", "2026-11-03"),
      files: 3,
    });
  });

  it("exits 1 when both sources are absent", () => {
    rmSync(plans, { recursive: true });
    rmSync(results, { recursive: true });
    const result = run(["--date", "2026-11-03"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no source/i);
  });
});
