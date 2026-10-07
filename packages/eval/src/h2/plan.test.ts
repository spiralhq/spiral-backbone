import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { campaignSpecSchema, loadCampaign, validateCampaign, type CampaignSpec } from "./campaign";
import {
  attemptId,
  ColdCidViolation,
  generatePlan,
  plannedAttemptCount,
  planPath,
  readPlan,
  timeoutFor,
  writePlan,
} from "./plan";
import { goldenFixture } from "./testing/fixtures";

const PRESET = join(import.meta.dirname, "..", "..", "campaigns", "h2-dry-run.json");
const warm = goldenFixture({ work_id: "pd-901", film_pda: "FilmWarm", cold_cid: false });
const cold = goldenFixture({
  work_id: "pd-902",
  film_pda: "FilmCold",
  cold_cid: true,
  byte_size: "500000",
});

async function preset(): Promise<CampaignSpec> {
  return loadCampaign(PRESET);
}

describe("campaign validation", () => {
  it("accepts the dry-run preset", async () => {
    expect(validateCampaign(await preset())).toEqual([]);
  });

  it("rejects degradation that is not N..0, nested and contiguous", async () => {
    const spec = await preset();
    const reordered: CampaignSpec = {
      ...spec,
      blocks: [spec.blocks[0]!, spec.blocks[3]!, spec.blocks[2]!, spec.blocks[4]!, spec.blocks[5]!],
    };
    expect(validateCampaign(reordered).join("\n")).toMatch(/must have 3 active replicas/);

    const reEnabled = structuredClone(spec);
    reEnabled.blocks[4]!.active_replicas = ["c"];
    expect(validateCampaign(reEnabled).join("\n")).toMatch(/turns a replica back on/);

    const split = structuredClone(spec);
    split.blocks.splice(3, 0, { ...spec.blocks[0]!, name: "between" });
    expect(validateCampaign(split).join("\n")).toMatch(/contiguous/);
  });

  it("rejects unknown replicas and duplicate block names", async () => {
    const spec = structuredClone(await preset());
    spec.blocks[0]!.active_replicas = ["a", "z"];
    spec.blocks[1]!.name = "main";
    const errors = validateCampaign(spec).join("\n");
    expect(errors).toMatch(/unknown replica z/);
    expect(errors).toMatch(/duplicate name main/);
  });

  it("rejects a zero-replica block that is not a degradation block", async () => {
    const spec = structuredClone(await preset());
    spec.blocks[0]!.active_replicas = [];
    expect(validateCampaign(spec).join("\n")).toMatch(
      /block main: zero active replicas is only allowed in a degradation block/,
    );
  });

  it("schema refuses unknown keys", () => {
    expect(campaignSpecSchema.safeParse({ campaign_version: 1, extra: 1 }).success).toBe(false);
  });
});

describe("generatePlan", () => {
  it("expands the dry-run preset deterministically", async () => {
    const plan = generatePlan({
      campaign: await preset(),
      golden: [warm, cold],
      runId: "2026-10-06T12:00:00Z-h2-t",
      now: new Date("2026-10-06T12:00:00Z"),
    });
    expect(plan.blocks.map((b) => [b.name, b.attempts.length])).toEqual([
      ["main", 2],
      ["cold-start", 2],
      ["replicas=3", 2],
      ["replicas=2", 2],
      ["replicas=1", 2],
      ["replicas=0", 4],
    ]);
    expect(plannedAttemptCount(plan)).toBe(14);
    const ids = plan.blocks.flatMap((b) => b.attempts.map((a) => a.attempt_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(attemptId("main", "pd-901", "direct", 1));
  });

  it("marks cold works gateway-ineligible before the zero-replica block and eligible from it on", async () => {
    const plan = generatePlan({ campaign: await preset(), golden: [warm, cold], runId: "r" });
    const coldAttempts = plan.blocks.flatMap((b) =>
      b.attempts
        .filter((a) => a.work_id === "pd-902")
        .map((a) => [b.name, a.method, a.gateway_eligible]),
    );
    expect(coldAttempts).toContainEqual(["replicas=1", "direct", false]);
    expect(coldAttempts).toContainEqual(["replicas=0", "gateway", true]);
  });

  it("refuses a campaign that sends a cold CID through the gateway before the zero leg", async () => {
    const spec = structuredClone(await preset());
    spec.blocks[0]!.works = "all";
    expect(() => generatePlan({ campaign: spec, golden: [warm, cold], runId: "r" })).toThrow(
      ColdCidViolation,
    );
    expect(() => generatePlan({ campaign: spec, golden: [warm, cold], runId: "r" })).toThrow(
      /main\/pd-902\/gateway\/r1/,
    );
  });

  it("computes timeouts as base + per started MB", () => {
    expect(timeoutFor(57_591_076, { base_ms: 60_000, per_mb_ms: 1_000 })).toBe(118_000);
    expect(timeoutFor(1, { base_ms: 60_000, per_mb_ms: 1_000 })).toBe(61_000);
  });

  it("fails on a block that names an unknown work or selects nothing", async () => {
    const spec = structuredClone(await preset());
    spec.blocks[0]!.works = ["pd-999"];
    expect(() => generatePlan({ campaign: spec, golden: [warm, cold], runId: "r" })).toThrow(
      /pd-999/,
    );
    const base = await preset();
    expect(() => generatePlan({ campaign: base, golden: [cold], runId: "r" })).toThrow(
      /selects no works/,
    );
  });
});

describe("plan uniqueness", () => {
  it("throws on duplicate attempt ids from a duplicate work_id", async () => {
    const base = await preset();
    expect(() =>
      generatePlan({ campaign: base, golden: [warm, cold, { ...warm }], runId: "r" }),
    ).toThrow(/duplicate attempt_id main\/pd-901\/direct\/r1/);
    const spec = structuredClone(base);
    spec.blocks[0]!.works = ["pd-901", "pd-901"];
    expect(() => generatePlan({ campaign: spec, golden: [warm, cold], runId: "r" })).toThrow(
      /duplicate attempt_id/,
    );
  });
});

describe("plan files", () => {
  it("writes once and reads back; never overwrites a frozen plan", async () => {
    const plan = generatePlan({
      campaign: await preset(),
      golden: [warm, cold],
      runId: "2026-10-06T12:00:00Z-h2-t",
    });
    const path = planPath(mkdtempSync(join(tmpdir(), "plans-")), plan.run_id);
    await writePlan(path, plan);
    expect(path.endsWith("h2-2026-10-06T12:00:00Z-h2-t.json")).toBe(true);
    expect(await readPlan(path)).toEqual(plan);
    await expect(writePlan(path, plan)).rejects.toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).golden_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
