import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCampaign, validateCampaign } from "./campaign";
import { generatePlan, plannedAttemptCount } from "./plan";
import { goldenFixtures20 } from "./testing/fixtures";

const FINAL = join(import.meta.dirname, "..", "..", "campaigns", "h2-final.json");

describe("campaigns/h2-final.json", () => {
  it("is a valid campaign", async () => {
    expect(validateCampaign(await loadCampaign(FINAL))).toEqual([]);
  });

  it("expands to 210 + 60 + 100 = 370 attempts against 15 warm + 5 cold works", async () => {
    const plan = generatePlan({
      campaign: await loadCampaign(FINAL),
      golden: goldenFixtures20(),
      runId: "r",
    });
    const byBlock = Object.fromEntries(plan.blocks.map((b) => [b.name, b.attempts.length]));
    expect(byBlock).toEqual({
      main: 210,
      "cold-start": 60,
      "replicas=3": 20,
      "replicas=2": 20,
      "replicas=1": 20,
      "replicas=0": 40,
    });
    expect(plannedAttemptCount(plan)).toBe(370);
  });

  it("sends cold works through a gateway only in the zero-replica block", async () => {
    const plan = generatePlan({
      campaign: await loadCampaign(FINAL),
      golden: goldenFixtures20(),
      runId: "r",
    });
    const coldGateway = plan.blocks.flatMap((b) =>
      b.attempts.filter((a) => a.cold_cid && a.method === "gateway").map(() => b.name),
    );
    expect(new Set(coldGateway)).toEqual(new Set(["replicas=0"]));
  });

  it("uses the campaign timeout of 60 s + 1 s per started MB", async () => {
    const spec = await loadCampaign(FINAL);
    expect(spec.timeout).toEqual({ base_ms: 60_000, per_mb_ms: 1_000 });
  });
});
