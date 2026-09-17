import { describe, expect, it } from "vitest";
import { computeSpiralCid } from "./index";

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
