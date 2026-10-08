import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { topologyFixture } from "../h2/testing/fixtures";
import type { ChainRpc } from "./chain-checks";
import { runChecks } from "./checks";
import { buildChecks, type PreflightInputs } from "./preflight";

const inputs: PreflightInputs = {
  topology: topologyFixture([
    { name: "a", peer_id: "PeerA" },
    { name: "b", peer_id: "PeerB" },
  ]),
  payer: address("11111111111111111111111111111111"),
  manifestPath: "m.json",
  filesDir: "files",
  goldenPath: "g.ndjson",
  campaignPath: "c.json",
  expectedGenesis: "GEN",
  minLamports: 1n,
  pingTimeoutMs: 1000,
  skipConformance: false,
};
const rpc = {} as ChainRpc;
const names = async (...args: Parameters<typeof buildChecks>) =>
  (await buildChecks(...args)).map((c) => `${c.stage}:${c.name}`);

const INFRA = [
  "infra:rpc genesis",
  "infra:program organization",
  "infra:program film",
  "infra:payer balance",
  "infra:manifest (--final)",
  "infra:chunking conformance",
  "infra:replica a",
  "infra:replica b",
  "infra:replica a sudo",
  "infra:replica b sudo",
  "infra:network node",
  "infra:gateway",
  "infra:executor image",
];
const H2 = [
  "h2:golden ↔ manifest",
  "h2:Films ↔ golden ↔ topology",
  "h2:replica a pins",
  "h2:replica b pins",
  "h2:campaign plan",
];

describe("buildChecks", () => {
  it("assembles the infra stage in order", async () => {
    expect(await names("infra", inputs, { rpc })).toEqual(INFRA);
  });

  it("assembles the h2 stage", async () => {
    expect(await names("h2", inputs, { rpc })).toEqual(H2);
  });

  it("adds plan ↔ golden last when a plan is given", async () => {
    expect(await names("h2", { ...inputs, planPath: "p.json" }, { rpc })).toEqual([
      ...H2,
      "h2:plan ↔ golden",
    ]);
  });

  it("runs both stages for all", async () => {
    expect(await names("all", inputs, { rpc })).toEqual([...INFRA, ...H2]);
  });

  it("requires a golden path for h2 and all, not for infra", async () => {
    const noGolden = { ...inputs, goldenPath: undefined };
    await expect(buildChecks("h2", noGolden, { rpc })).rejects.toThrow(
      "--golden is required for --stage h2",
    );
    await expect(buildChecks("all", noGolden, { rpc })).rejects.toThrow(/--stage all/);
    expect(await names("infra", noGolden, { rpc })).toEqual(INFRA);
  });

  it("reports a skipped conformance as BLOCKED", async () => {
    const checks = await buildChecks("infra", { ...inputs, skipConformance: true }, { rpc });
    const conformance = checks.filter((c) => c.name === "chunking conformance");
    expect(await runChecks(conformance, [])).toEqual([
      { stage: "infra", name: "chunking conformance", ok: false, detail: "skipped by flag" },
    ]);
  });
});
