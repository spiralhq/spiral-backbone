import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSpiralCid } from "../verifier/index";
import { addWithSpiralProfile } from "./kubo-client";
import { startKuboContainer, type KuboContainer } from "./kubo-node";

const SYNTHETIC_SIZES: Record<string, number> = {
  "1 KiB": 1024,
  "256 KiB + 1 byte": 262_144 + 1,
  "400 MiB": 400 * 1024 * 1024,
};

describe("Spiral Chunking Profile v1 conformance (Kubo vs. ipfs-unixfs-importer)", () => {
  let node: KuboContainer;

  beforeAll(async () => {
    node = await startKuboContainer();
  }, 60_000);

  afterAll(async () => {
    await node.stop();
  });

  for (const [label, size] of Object.entries(SYNTHETIC_SIZES)) {
    it(`produces the same CID for a ${label} file on both paths`, async () => {
      const content = syntheticContent(size);
      const kuboCid = await addWithSpiralProfile(node.apiUrl, content);
      const verifierCid = await computeSpiralCid(content);
      expect(verifierCid.toString()).toBe(kuboCid.toString());
    }, 120_000);
  }
});

function syntheticContent(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const prefixLength = Math.min(size, 65_536);
  crypto.getRandomValues(bytes.subarray(0, prefixLength));
  for (let offset = prefixLength; offset < size; offset += prefixLength) {
    bytes.set(bytes.subarray(0, Math.min(prefixLength, size - offset)), offset);
  }
  return bytes;
}
