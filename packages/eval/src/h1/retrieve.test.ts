import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWithSpiralProfile } from "../kubo-client";
import { startKuboContainer, type KuboContainer } from "../kubo-node";
import { RetrievalError, retrieveToFile } from "./retrieve";

describe("retrieveToFile", () => {
  let kubo: KuboContainer;
  const dir = mkdtempSync(join(tmpdir(), "h1-retrieve-"));

  beforeAll(async () => {
    kubo = await startKuboContainer();
  }, 90_000);

  afterAll(async () => {
    await kubo?.stop();
  });

  it("streams a stored object to disk byte for byte", async () => {
    const content = randomBytes(700_000);
    const cid = await addWithSpiralProfile(kubo.apiUrl, content);
    const dest = join(dir, "out.bin");
    expect(await retrieveToFile(kubo.apiUrl, cid.toString(), dest, 30_000)).toBe(
      content.byteLength,
    );
    expect(readFileSync(dest)).toEqual(content);
  }, 60_000);

  it("classifies an object the node does not have", async () => {
    const missing = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";
    const attempt = retrieveToFile(kubo.apiUrl, missing, join(dir, "missing.bin"), 15_000);
    await expect(attempt).rejects.toBeInstanceOf(RetrievalError);
    await expect(attempt).rejects.toMatchObject({
      failureClass: expect.stringMatching(/object_unavailable|timeout/),
    });
  }, 60_000);
});
