import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryRecord } from "@spiral-backbone/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startGenesisServer } from "./testing/genesis-server";
import { runH1 } from "./h1/run";
import type { H3Client } from "./h3/client";
import { runH3 } from "./h3/run";
import { runH4 } from "./h4/run";

const EXPECTED = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const WRONG = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const dir = () => mkdtempSync(join(tmpdir(), "cluster-guard-"));
const golden = [] as InventoryRecord[];

async function wrongCluster() {
  const server = await startGenesisServer(WRONG);
  close = server.close;
  return server.url;
}

describe("wrong cluster", () => {
  it("H1 exits before writing anything", async () => {
    const root = dir();
    const outPath = join(root, "h1.ndjson");
    await expect(
      runH1({
        golden,
        rpcUrl: await wrongCluster(),
        expectedGenesis: EXPECTED,
        kuboUrl: "http://127.0.0.1:1",
        outPath,
        workDir: join(root, "work"),
        runId: "r",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/does not match/);
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(join(root, "work"))).toBe(false);
    expect(existsSync(join(root, "h1.runs.ndjson"))).toBe(false);
  });

  it("H3 exits before writing anything", async () => {
    const outPath = join(dir(), "h3.ndjson");
    await expect(
      runH3({
        client: {} as H3Client,
        rpcUrl: await wrongCluster(),
        expectedGenesis: EXPECTED,
        outPath,
        runId: "r",
        label: "x",
      }),
    ).rejects.toThrow(/does not match/);
    expect(existsSync(outPath)).toBe(false);
  });

  it("H4 exits before writing anything", async () => {
    const root = dir();
    await expect(
      runH4({
        golden,
        db: {} as never,
        rpcUrl: await wrongCluster(),
        expectedGenesis: EXPECTED,
        outPath: join(root, "h4.ndjson"),
        runId: "r",
      }),
    ).rejects.toThrow(/does not match/);
    expect(existsSync(root) && readdirSync(root)).toEqual([]);
  });
});

describe("H1 Kubo check", () => {
  it("exits 1 when the Kubo API is unreachable, before writing", async () => {
    const root = dir();
    const server = await startGenesisServer(EXPECTED);
    close = server.close;
    await expect(
      runH1({
        golden,
        rpcUrl: server.url,
        expectedGenesis: EXPECTED,
        kuboUrl: "http://127.0.0.1:1",
        outPath: join(root, "h1.ndjson"),
        workDir: join(root, "work"),
        runId: "r",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Kubo API unreachable at 127.0.0.1:1 — is the tunnel open?");
    expect(readdirSync(root)).toEqual([]);
  });
});
