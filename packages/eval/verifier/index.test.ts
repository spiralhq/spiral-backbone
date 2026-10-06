import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { computeSpiralCid, computeSpiralCidFromFile } from "./index";

describe("computeSpiralCid", () => {
  it("produces a CIDv1 with a raw codec for content smaller than one chunk", async () => {
    const content = new TextEncoder().encode("spiral chunking profile v1");
    const cid = await computeSpiralCid(content);
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(0x55); // raw
    expect(cid.multihash.code).toBe(0x12); // sha2-256
    expect(cid.multihash.digest).toHaveLength(32);
  });

  it("produces a CIDv1 with a dag-pb codec once content exceeds the chunk-size threshold", async () => {
    const content = new Uint8Array(262_144 + 1).fill(7);
    const cid = await computeSpiralCid(content);
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(0x70); // dag-pb
  });

  it("is deterministic: identical content produces identical CIDs", async () => {
    const content = new Uint8Array(1024).fill(42);
    const cidA = await computeSpiralCid(content);
    const cidB = await computeSpiralCid(content);
    expect(cidA.toString()).toBe(cidB.toString());
  });
});

describe("computeSpiralCidFromFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "verifier-stream-"));

  it.each([1, 262_143, 262_144, 262_145, 5 * 262_144 + 12_345])(
    "matches the in-memory CID for a %i-byte file",
    async (size) => {
      const content = randomBytes(size);
      const path = join(dir, `f-${size}.bin`);
      writeFileSync(path, content);
      expect((await computeSpiralCidFromFile(path)).toString()).toBe(
        (await computeSpiralCid(content)).toString(),
      );
    },
  );

  it("rejects a missing file", async () => {
    await expect(computeSpiralCidFromFile(join(dir, "absent.bin"))).rejects.toThrow();
  });
});
