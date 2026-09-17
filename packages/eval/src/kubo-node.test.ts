import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWithSpiralProfile } from "./kubo-client";
import { startKuboContainer, type KuboContainer } from "./kubo-node";

describe("kubo docker node", () => {
  let node: KuboContainer;

  beforeAll(async () => {
    node = await startKuboContainer();
  }, 60_000);

  afterAll(async () => {
    await node.stop();
  });

  it("accepts an add() call using the Spiral Chunking Profile v1 flags", async () => {
    const content = new TextEncoder().encode("spiral chunking profile v1 smoke test");
    const cid = await addWithSpiralProfile(node.apiUrl, content);
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(0x55); // raw leaf, content smaller than one chunk
  }, 30_000);
});
