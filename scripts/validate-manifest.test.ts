import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bandForSize, validateManifest } from "./validate-manifest";

const TWENTY_MB = 20_000_000;
let filesDir: string;
let zerosSha256: string;

function work(overrides: Record<string, unknown> = {}) {
  return {
    work_id: "pd-001",
    title: "Example",
    source: "Prelinger Archives",
    url: "https://archive.org/details/example",
    file_url: "https://archive.org/download/example/example.mp4",
    file_name: "example.mp4",
    license: {
      status: "public_domain",
      basis: "Produced for a U.S. federal agency; public domain.",
      reference_url: "https://archive.org/details/example",
    },
    resolution: "640x480",
    duration_seconds: 554.95,
    size_bytes: TWENTY_MB,
    size_band: "small",
    cold_cid: false,
    sha256: zerosSha256,
    placeholder: true,
    ...overrides,
  };
}

function manifest(works: unknown[]) {
  return { manifest_version: 1, notice: "test", works };
}

beforeAll(() => {
  filesDir = mkdtempSync(join(tmpdir(), "manifest-files-"));
  const path = join(filesDir, "example.mp4");
  writeFileSync(path, "");
  truncateSync(path, TWENTY_MB);
  zerosSha256 = createHash("sha256").update(Buffer.alloc(TWENTY_MB)).digest("hex");
});

describe("bandForSize (decimal, half-open)", () => {
  it.each([
    [19_999_999, undefined],
    [20_000_000, "small"],
    [99_999_999, "small"],
    [100_000_000, "medium"],
    [399_999_999, "medium"],
    [400_000_000, "large"],
    [999_999_999, "large"],
    [1_000_000_000, undefined],
  ])("%i bytes → %s", (bytes, band) => {
    expect(bandForSize(bytes)).toBe(band);
  });
});

describe("validateManifest", () => {
  it("accepts a complete entry whose local file matches size and sha256", async () => {
    expect(await validateManifest(manifest([work()]), { filesDir, final: false })).toEqual({
      errors: [],
      notes: [],
    });
  });

  it("reports a missing required field with its path", async () => {
    const incomplete: Record<string, unknown> = work();
    delete incomplete["sha256"];
    const { errors } = await validateManifest(manifest([incomplete]), { filesDir, final: false });
    expect(errors.some((error) => error.startsWith("works[0].sha256"))).toBe(true);
  });

  it("reports a sha256 that does not match the local file", async () => {
    const { errors } = await validateManifest(manifest([work({ sha256: "0".repeat(64) })]), {
      filesDir,
      final: false,
    });
    expect(errors).toEqual([expect.stringMatching(/^pd-001: sha256 mismatch/)]);
  });

  it("reports a size_bytes that does not match the local file", async () => {
    const { errors } = await validateManifest(manifest([work({ size_bytes: TWENTY_MB + 1 })]), {
      filesDir,
      final: false,
    });
    expect(errors).toEqual([
      expect.stringMatching(/^pd-001: size_bytes 20000001 but local file has 20000000/),
    ]);
  });

  it("reports a declared band that does not match size_bytes, even without the file", async () => {
    const { errors } = await validateManifest(
      manifest([work({ file_name: "absent.mp4", size_bytes: 150_000_000, size_band: "small" })]),
      { filesDir, final: false },
    );
    expect(errors).toEqual(["pd-001: size_bytes 150000000 falls in band medium, not small"]);
  });

  it("notes, but does not fail on, a file that has not been downloaded", async () => {
    const result = await validateManifest(manifest([work({ file_name: "absent.mp4" })]), {
      filesDir,
      final: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([
      "pd-001: absent.mp4 not downloaded; size/sha256 not checked against a file",
    ]);
  });

  it("reports duplicate work_id, sha256 and file_name", async () => {
    const { errors } = await validateManifest(manifest([work(), work()]), {
      filesDir,
      final: false,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "duplicate work_id pd-001",
        `duplicate sha256 ${zerosSha256}`,
        "duplicate file_name example.mp4",
      ]),
    );
  });

  it("--final requires 20 non-placeholder works split 7/8/5", async () => {
    const { errors } = await validateManifest(manifest([work()]), { filesDir, final: true });
    expect(errors).toEqual(
      expect.arrayContaining([
        "final manifest must have 20 works, has 1",
        "final manifest must have 7 works in band small, has 1",
        "final manifest must have 8 works in band medium, has 0",
        "final manifest must have 5 works in band large, has 0",
        "pd-001: placeholder entries are not allowed in the final manifest",
      ]),
    );
  });
});

describe("committed dataset/manifest.json", () => {
  const manifestPath = join(import.meta.dirname, "..", "dataset", "manifest.json");

  it("is valid (non-final) and only contains placeholders for now", async () => {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { errors } = await validateManifest(raw, {
      filesDir: join(import.meta.dirname, "..", "dataset", "files"),
      final: false,
    });
    expect(errors).toEqual([]);
    expect(raw.works.length).toBeGreaterThanOrEqual(1);
    expect(raw.works.every((w: { placeholder: boolean }) => w.placeholder)).toBe(true);
  });
});

describe("validate-manifest CLI", () => {
  const root = join(import.meta.dirname, "..");
  const script = join(import.meta.dirname, "validate-manifest.ts");

  function run(scriptPath: string, args: string[]) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: "utf8" });
  }

  function malformedManifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "manifest-cli-"));
    const path = join(dir, "manifest.json");
    writeFileSync(path, "{ not json");
    return path;
  }

  it("exits 1 on a malformed manifest", () => {
    const result = run(script, ["--manifest", malformedManifest()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("as JSON");
  });

  it("exits 0 on the committed manifest", () => {
    const result = run(script, ["--manifest", join(root, "dataset", "manifest.json")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Manifest valid");
  });

  it("still runs when invoked through a symlink", () => {
    const link = join(mkdtempSync(join(tmpdir(), "manifest-link-")), "validate-manifest.ts");
    symlinkSync(script, link);
    const result = run(link, ["--manifest", malformedManifest()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("as JSON");
  });
});

describe("cold_cid", () => {
  it("is required on every work", async () => {
    const incomplete: Record<string, unknown> = work();
    delete incomplete["cold_cid"];
    const { errors } = await validateManifest(manifest([incomplete]), { filesDir, final: false });
    expect(errors.some((error) => error.startsWith("works[0].cold_cid"))).toBe(true);
  });

  it("--final requires exactly 5 cold CIDs", async () => {
    const { errors } = await validateManifest(manifest([work({ cold_cid: true })]), {
      filesDir,
      final: true,
    });
    expect(errors).toContain("final manifest must have 5 cold_cid works, has 1");
  });
});
