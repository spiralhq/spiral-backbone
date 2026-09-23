import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, writeKeyPair } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpiralClient } from "./client";

// A throwaway keypair generated fresh into a temp dir — CI has no ~/.config/solana/id.json.
let workDir: string;
let keypairPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "spiral-client-test-"));
  keypairPath = join(workDir, "id.json");
  const keyPair = await generateKeyPair(/* extractable */ true);
  await writeKeyPair(keyPair, keypairPath);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("createSpiralClient", () => {
  it("returns a client with a payer address, without needing network access", async () => {
    const client = await createSpiralClient({
      cluster: "local",
      keypairPath,
    });
    expect(typeof client.payer.address).toBe("string");
  });
});
