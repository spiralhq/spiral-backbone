import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertContentMatchesWork, findManifestWork, type ManifestWork } from "./manifest";

const content = new TextEncoder().encode("spiral manifest test");
const sha = createHash("sha256").update(content).digest("hex");
const work: ManifestWork = {
  work_id: "pd-901",
  size_bytes: content.byteLength,
  size_band: "small",
  cold_cid: false,
  sha256: sha,
};

function manifestFile(works: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ manifest_version: 1, notice: "t", works }));
  return path;
}

describe("findManifestWork", () => {
  it("returns the entry for a known work_id, ignoring fields it does not need", async () => {
    const path = manifestFile([{ ...work, title: "x", placeholder: true }]);
    expect(await findManifestWork(path, "pd-901")).toEqual(work);
  });

  it("returns cold_cid true when the manifest says so", async () => {
    const path = manifestFile([{ ...work, cold_cid: true }]);
    expect((await findManifestWork(path, "pd-901")).cold_cid).toBe(true);
  });

  it("fails clearly for an unknown work_id", async () => {
    await expect(findManifestWork(manifestFile([work]), "pd-999")).rejects.toThrow(
      /pd-999.*not found/,
    );
  });
});

describe("assertContentMatchesWork", () => {
  it("returns the sha256 when size and hash match", () => {
    expect(assertContentMatchesWork(work, content)).toBe(sha);
  });

  it("refuses a file whose size differs from the manifest", () => {
    expect(() => assertContentMatchesWork({ ...work, size_bytes: 1 }, content)).toThrow(/size/);
  });

  it("refuses a file whose sha256 differs from the manifest", () => {
    expect(() => assertContentMatchesWork({ ...work, sha256: "0".repeat(64) }, content)).toThrow(
      /sha256/,
    );
  });
});
