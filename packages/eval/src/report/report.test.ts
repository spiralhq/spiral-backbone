import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRecord } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import { frozenPlanSchema, planPath } from "../h2/plan";
import { csv, markdownTable } from "./render";
import { generateReport, latestRunId } from "./run";

function rec(o: Partial<ResultRecord>): ResultRecord {
  return {
    run_id: "2026-10-02T12:00:00Z-h1-a",
    hypothesis: "H1",
    film_pda: "film",
    work_id: "pd-001",
    size_bytes: 10,
    size_band: "small",
    scenario: "intact",
    method: "kubo-rpc",
    attempt: 1,
    started_at: "2026-10-02T12:00:00.000Z",
    finished_at: "2026-10-02T12:00:01.000Z",
    latency_ms: 1000,
    cid_expected: "bafyA",
    cid_observed: "bafyA",
    outcome: "success",
    failure_class: null,
    tx_signature: null,
    rpc_endpoint: "h",
    verifier_impl: "ipfs-unixfs-importer@17.1.1",
    artifact_versions: {},
    ...o,
  };
}

const lines = (values: unknown[]) => `${values.map((v) => JSON.stringify(v)).join("\n")}\n`;

function writeH2Plan(
  runId: string,
  blocks: { name: string; kind: "main" | "cold-start" | "degradation"; active: string[] }[],
): string {
  const plansDir = mkdtempSync(join(tmpdir(), "report-plans-"));
  const plan = frozenPlanSchema.parse({
    plan_version: 1,
    run_id: runId,
    created_at: "2026-10-06T12:00:00.000Z",
    golden_sha256: "0".repeat(64),
    campaign: {
      campaign_version: 1,
      replica_nodes: ["r1", "r2", "r3"],
      stabilization_ms: 0,
      max_gate_attempts: 1,
      max_block_generations: 1,
      timeout: { base_ms: 1, per_mb_ms: 0 },
      blocks: blocks.map((b) => ({
        name: b.name,
        kind: b.kind,
        active_replicas: b.active,
        methods: ["direct"],
        works: "all",
        repetitions: 1,
      })),
    },
    blocks: blocks.map((b, i) => ({
      block_index: i,
      name: b.name,
      kind: b.kind,
      active_replicas: b.active,
      attempts: [],
    })),
  });
  writeFileSync(planPath(plansDir, runId), JSON.stringify(plan));
  return plansDir;
}

describe("render", () => {
  it("renders markdown tables and quoted CSV", () => {
    expect(markdownTable(["a", "b"], [["1", "x|y"]])).toBe("| a | b |\n|---|---|\n| 1 | x\\|y |\n");
    expect(csv(["a", "b"], [["1", 'he said "hi", ok']])).toBe('a,b\n1,"he said ""hi"", ok"\n');
  });
});

describe("latestRunId", () => {
  it("picks the most recent run by its ISO prefix", () => {
    expect(
      latestRunId([
        rec({ run_id: "2026-10-01T00:00:00Z-h1-a" }),
        rec({ run_id: "2026-10-02T00:00:00Z-h1-b" }),
      ]),
    ).toBe("2026-10-02T00:00:00Z-h1-b");
  });
});

describe("generateReport", () => {
  it("emits H1, H3 and H4 sections and CSVs from the latest runs", async () => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    writeFileSync(
      join(results, "h1.ndjson"),
      lines([
        rec({ run_id: "2026-10-01T00:00:00Z-h1-old", work_id: "pd-old" }),
        rec({}),
        rec({ scenario: "tampered", cid_observed: "bafyB" }),
      ]),
    );
    writeFileSync(
      join(results, "h3.ndjson"),
      lines([
        rec({
          run_id: "2026-10-02T12:00:00Z-h3-a",
          hypothesis: "H3",
          work_id: "h3-s3",
          scenario: "s3-reader-role",
          tx_signature: "SIG3",
          cid_observed: null,
        }),
      ]),
    );
    writeFileSync(
      join(results, "h3.evidence.ndjson"),
      lines([
        {
          run_id: "2026-10-02T12:00:00Z-h3-a",
          scenario_id: 3,
          expected_code: 6002,
          observed: { index: 0, code: 6002 },
          failing_program: "2JWb",
        },
      ]),
    );
    writeFileSync(
      join(results, "h4.ndjson"),
      lines([
        rec({ run_id: "2026-10-02T12:00:00Z-h4-a", hypothesis: "H4", scenario: "cold-rebuild" }),
      ]),
    );
    writeFileSync(
      join(results, "h4.run.json"),
      JSON.stringify({
        run_id: "2026-10-02T12:00:00Z-h4-a",
        backfill: { duration_ms: 1234, rpc_calls_total: 6, rate_limit_retries: 0 },
        golden_count: 1,
        rebuilt_count: 1,
        missing_organizations: [],
        diffs: [
          { table: "films", key: "f", kind: "field", field: "title", expected: "a", actual: "b" },
          { table: "films", key: "g", kind: "field", field: "title", expected: "a", actual: "b" },
        ],
      }),
    );

    const { markdownPath, csvPaths } = await generateReport({ resultsDir: results, outDir: out });
    const md = readFileSync(markdownPath, "utf8");

    expect(md).toContain("2026-10-02T12:00:00Z-h1-a");
    expect(md).not.toContain("pd-old");
    expect(md).toContain(
      "| pd-001 | intact | bafyA | bafyA | ipfs-unixfs-importer@17.1.1 | success |",
    );
    expect(md).toContain(
      "| pd-001 | tampered | bafyA | bafyB | ipfs-unixfs-importer@17.1.1 | success |",
    );
    expect(md).toContain("| s3-reader-role | 6002 | 6002 | 0 | 2JWb | SIG3 | success |");
    expect(md).toContain("| films.title | 2 |");
    expect(md).toContain("1234");
    expect(csvPaths.map((p) => p.split("/").pop()).sort()).toEqual([
      "h1.csv",
      "h3.csv",
      "h4-divergences.csv",
    ]);
    expect(readFileSync(join(out, "h3.csv"), "utf8").split("\n")[0]).toBe(
      "scenario,expected_code,observed_code,instruction_index,refusing_program,tx_signature,outcome",
    );
  });

  it("renders 'No results.' for hypotheses without files", async () => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    const { markdownPath, csvPaths } = await generateReport({ resultsDir: results, outDir: out });
    expect(readFileSync(markdownPath, "utf8").match(/No results\./g)).toHaveLength(4);
    expect(csvPaths).toEqual([]);
    expect(existsSync(join(out, "h1.csv"))).toBe(false);
  });
});

describe("H2 section", () => {
  it("emits the H2 section with status line and CSVs", async () => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    const run = "2026-10-06T12:00:00Z-h2-a";
    const block = (generation: number, confirmed: boolean) => ({
      run_id: run,
      block_index: 0,
      block_name: "replicas=1",
      generation,
      phase: "end",
      check_number: generation,
      intended_active: ["r1"],
      observed: [],
      missing_providers: {},
      confirmed,
      reasons: [],
      at: "t",
    });
    const h2 = (o: Partial<ResultRecord>) =>
      rec({ run_id: run, hypothesis: "H2", scenario: "replicas=1@g2", method: "direct", ...o });
    writeFileSync(
      join(results, "h2.ndjson"),
      lines([
        h2({ scenario: "replicas=1@g1", outcome: "failure", failure_class: "timeout" }),
        h2({ latency_ms: 400 }),
      ]),
    );
    writeFileSync(join(results, "h2-blocks.ndjson"), lines([block(1, false), block(2, true)]));
    const provenance = (unattributed: number) => ({
      peers: [],
      data_received: 700158 + unattributed,
      dup_data_received: 0,
      dag_size: 700158,
      ledger_declared_total: 700158,
      ledger_undeclared_total: 0,
      unattributed,
    });
    const evidence = (generation: number, unattributed: number) => ({
      run_id: run,
      attempt_id: "replicas=1/pd-001/direct/r1",
      scenario: `replicas=1@g${generation}`,
      generation,
      block_index: 0,
      provenance: provenance(unattributed),
    });
    writeFileSync(
      join(results, "h2.evidence.ndjson"),
      lines([evidence(1, 50_000), evidence(2, 7), evidence(2, 158)]),
    );
    writeFileSync(
      join(results, "h2.runs.ndjson"),
      lines([
        { run_id: run, status: "started", expected_attempts: 1, started_at: "t" },
        { run_id: run, status: "completed", recorded_attempts: 2, finished_at: "t" },
      ]),
    );
    const plansDir = writeH2Plan(run, [
      { name: "replicas=1", kind: "degradation", active: ["r1"] },
    ]);
    const { markdownPath, csvPaths } = await generateReport({
      resultsDir: results,
      outDir: out,
      plansDir,
    });
    const md = readFileSync(markdownPath, "utf8");
    expect(md).toContain("## H2");
    expect(md).toContain(
      "**Success with 1 active replica: 100.00% (1 of 1, excluding 0 external_cache) — criterion ≥ 95%: met**\n",
    );
    expect(md).toContain("### By active replicas");
    expect(md).toContain("| active_replicas |");
    expect(md).toContain("| 1 | direct | 1 | 1 | 0 | 100.0% |");
    expect(md).toContain("| block_kind |");
    expect(md).toContain("| degradation | small | direct | 1 | 400 | 400 | 400 |");
    expect(readFileSync(join(out, "h2-by-replicas.csv"), "utf8")).toBe(
      "active_replicas,method,attempts,successes,external_cache,success_rate\n1,direct,1,1,0,100.0%\n",
    );
    expect(readFileSync(join(out, "h2-latency.csv"), "utf8").split("\n")[0]).toBe(
      "block_kind,size_band,method,n,mean_ms,median_ms,p95_ms",
    );
    expect(md).toContain("| replicas=1 | direct | 1 | 1 | 0 | 100.0% |");
    expect(md).toContain(
      "Status: complete (2/1 attempts)\n\nAttempts included: 1 of 1 planned (2 recorded, including re-run generations)\n",
    );
    expect(md).toContain("Attempts excluded (end-of-block replica state not confirmed): 1");
    expect(md).not.toContain("no end-of-block state check recorded");
    expect(md).not.toContain("this refutes H2");
    expect(md).toContain(
      "### Failures\n\nNo failures.\n\n\n### Direct provenance audit\n\nDirect successes audited: 1\n\n| metric | min | median | p95 | max |\n|---|---|---|---|---|\n| unattributed_bytes | 158 | 158 | 158 | 158 |\n| unattributed_pct_of_dag | 0.02 | 0.02 | 0.02 | 0.02 |\n",
    );
    expect(md).not.toContain("without provenance evidence");
    expect(md).not.toContain("Percent row excludes");
    expect(readFileSync(join(out, "h2-provenance-audit.csv"), "utf8")).toBe(
      "metric,min,median,p95,max\nunattributed_bytes,158,158,158,158\nunattributed_pct_of_dag,0.02,0.02,0.02,0.02\n",
    );
    expect(csvPaths.map((p) => p.split("/").pop()).sort()).toEqual([
      "h2-by-replicas.csv",
      "h2-latency.csv",
      "h2-provenance-audit.csv",
      "h2-rates.csv",
    ]);
  });

  const auditRun = "2026-10-06T12:00:00Z-h2-audit";
  const auditReport = async (evidence: string) => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    const h2 = (work: string) =>
      rec({
        run_id: auditRun,
        hypothesis: "H2",
        scenario: "main@g1",
        method: "direct",
        work_id: work,
      });
    writeFileSync(join(results, "h2.ndjson"), lines([h2("pd-001"), h2("pd-002")]));
    writeFileSync(
      join(results, "h2-blocks.ndjson"),
      lines([
        {
          run_id: auditRun,
          block_index: 0,
          block_name: "main",
          generation: 1,
          phase: "end",
          check_number: 1,
          intended_active: ["r1"],
          observed: [],
          missing_providers: {},
          confirmed: true,
          reasons: [],
          at: "t",
        },
      ]),
    );
    writeFileSync(join(results, "h2.evidence.ndjson"), evidence);
    const plansDir = writeH2Plan(auditRun, [{ name: "main", kind: "main", active: ["r1"] }]);
    const { markdownPath } = await generateReport({ resultsDir: results, outDir: out, plansDir });
    return { md: readFileSync(markdownPath, "utf8"), out };
  };

  it("makes direct successes without provenance evidence visible", async () => {
    const { md, out } = await auditReport(
      lines([
        {
          run_id: auditRun,
          attempt_id: "main/pd-001/direct/r1",
          generation: 1,
          provenance: { unattributed: -40, dag_size: null },
        },
        {
          run_id: "2026-10-05T12:00:00Z-h2-old",
          attempt_id: "main/pd-002/direct/r1",
          generation: 1,
          provenance: { unattributed: 5, dag_size: 100 },
        },
      ]),
    );
    expect(md).toContain(
      "### Direct provenance audit\n\n**Direct successes without provenance evidence: 1**\n\nDirect successes audited: 1\n\nPercent row excludes 1 direct successes without dag_size\n\n| metric |",
    );
    expect(md).toContain("| unattributed_bytes | -40 | -40 | -40 | -40 |");
    expect(md).toContain("| unattributed_pct_of_dag | — | — | — | — |");
    expect(readFileSync(join(out, "h2-provenance-audit.csv"), "utf8")).toBe(
      "metric,min,median,p95,max\nunattributed_bytes,-40,-40,-40,-40\nunattributed_pct_of_dag,—,—,—,—\n",
    );
  });

  it("states when no direct success has provenance evidence", async () => {
    const { md, out } = await auditReport("");
    expect(md).toContain(
      "### Direct provenance audit\n\n**Direct successes without provenance evidence: 2**\n\nDirect successes audited: 0\n\nNo direct successes with provenance evidence.\n",
    );
    expect(readFileSync(join(out, "h2-provenance-audit.csv"), "utf8")).toBe(
      "metric,min,median,p95,max\n",
    );
  });

  it("fails on an evidence line that does not match the schema", async () => {
    await expect(
      auditReport(
        lines([
          { run_id: auditRun, attempt_id: "main/pd-001/direct/r1", generation: 1, provenance: {} },
        ]),
      ),
    ).rejects.toThrow(/h2\.evidence\.ndjson:1: provenance\.unattributed/);
  });

  it("fails on an evidence line without run_id or with a non-positive generation", async () => {
    const provenance = { unattributed: 0, dag_size: 100 };
    await expect(
      auditReport(lines([{ attempt_id: "main/pd-001/direct/r1", generation: 1, provenance }])),
    ).rejects.toThrow(/h2\.evidence\.ndjson:1: run_id/);
    await expect(
      auditReport(
        lines([
          { run_id: auditRun, attempt_id: "main/pd-001/direct/r1", generation: 0, provenance },
        ]),
      ),
    ).rejects.toThrow(/h2\.evidence\.ndjson:1: generation/);
    await expect(
      auditReport(
        lines([
          { run_id: auditRun, attempt_id: "main/pd-001/direct/r1", generation: 1.5, provenance },
        ]),
      ),
    ).rejects.toThrow(/h2\.evidence\.ndjson:1: generation/);
  });

  const h2Only = (run: string) => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    writeFileSync(
      join(results, "h2.ndjson"),
      lines([rec({ run_id: run, hypothesis: "H2", scenario: "replicas=1@g1", method: "direct" })]),
    );
    return results;
  };

  it("fails without the run's frozen plan", async () => {
    const run = "2026-10-06T12:00:00Z-h2-noplan";
    const plansDir = mkdtempSync(join(tmpdir(), "report-plans-"));
    await expect(
      generateReport({
        resultsDir: h2Only(run),
        outDir: mkdtempSync(join(tmpdir(), "report-out-")),
        plansDir,
      }),
    ).rejects.toThrow(/frozen plan .* not found — pass --plans-dir/);
  });

  it("fails on an unparseable frozen plan", async () => {
    const run = "2026-10-06T12:00:00Z-h2-badplan";
    const plansDir = mkdtempSync(join(tmpdir(), "report-plans-"));
    writeFileSync(planPath(plansDir, run), "{ not json");
    await expect(
      generateReport({
        resultsDir: h2Only(run),
        outDir: mkdtempSync(join(tmpdir(), "report-out-")),
        plansDir,
      }),
    ).rejects.toThrow(new RegExp(`^frozen plan ${planPath(plansDir, run)} is invalid: .*JSON`));
  });

  it("fails on a frozen plan without blocks", async () => {
    const run = "2026-10-06T12:00:00Z-h2-empty";
    const plansDir = writeH2Plan(run, [
      { name: "replicas=1", kind: "degradation", active: ["r1"] },
    ]);
    const path = planPath(plansDir, run);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), blocks: [] }));
    await expect(
      generateReport({
        resultsDir: h2Only(run),
        outDir: mkdtempSync(join(tmpdir(), "report-out-")),
        plansDir,
      }),
    ).rejects.toThrow(`frozen plan ${path} is invalid: no blocks`);
  });

  it("fails on a frozen plan that belongs to another run", async () => {
    const run = "2026-10-06T12:00:00Z-h2-other";
    const plansDir = writeH2Plan("2026-10-06T12:00:00Z-h2-x", [
      { name: "replicas=1", kind: "degradation", active: ["r1"] },
    ]);
    writeFileSync(
      planPath(plansDir, run),
      readFileSync(planPath(plansDir, "2026-10-06T12:00:00Z-h2-x")),
    );
    await expect(
      generateReport({
        resultsDir: h2Only(run),
        outDir: mkdtempSync(join(tmpdir(), "report-out-")),
        plansDir,
      }),
    ).rejects.toThrow(/belongs to run 2026-10-06T12:00:00Z-h2-x/);
  });
});

describe("H2 flags", () => {
  const run = "2026-10-06T12:00:00Z-h2-b";
  const block = (name: string, index: number, intended: string[]) => ({
    run_id: run,
    block_index: index,
    block_name: name,
    generation: 1,
    phase: "end",
    check_number: 1,
    intended_active: intended,
    observed: [],
    missing_providers: {},
    confirmed: true,
    reasons: [],
    at: "t",
  });
  const h2 = (o: Partial<ResultRecord>) =>
    rec({ run_id: run, hypothesis: "H2", method: "direct", ...o });
  const build = async (records: ResultRecord[], marks: unknown[]) => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    writeFileSync(join(results, "h2.ndjson"), lines(records));
    writeFileSync(
      join(results, "h2-blocks.ndjson"),
      lines([block("replicas=1", 0, ["r1"]), block("replicas=0", 1, [])]),
    );
    writeFileSync(join(results, "h2.runs.ndjson"), lines(marks));
    const plansDir = writeH2Plan(run, [
      { name: "replicas=1", kind: "degradation", active: ["r1"] },
      { name: "replicas=0", kind: "degradation", active: [] },
    ]);
    const { markdownPath } = await generateReport({ resultsDir: results, outDir: out, plansDir });
    return readFileSync(markdownPath, "utf8");
  };
  const started = { run_id: run, status: "started", expected_attempts: 3, started_at: "t" };

  it("prints the refutation line for a confirmed zero-replica direct success", async () => {
    const md = await build([h2({ scenario: "replicas=0@g1" })], [started]);
    expect(md).toContain("**Direct success with zero active replicas: 1** — this refutes H2.\n");
    expect(md).not.toContain("Zero-replica control contaminated");
  });

  it("prints the contamination line for a zero-replica direct external_cache, alongside the refutation", async () => {
    const cache = h2({
      scenario: "replicas=0@g1",
      attempt: 2,
      outcome: "failure",
      failure_class: "external_cache",
    });
    const md = await build([cache], [started]);
    const line =
      "**Zero-replica control contaminated: 1 direct recoveries from undeclared sources** — does not refute H2; the zero-replica control is weakened.\n";
    expect(md).toContain(line);
    expect(md).not.toContain("this refutes H2");
    const both = await build([h2({ scenario: "replicas=0@g1" }), cache], [started]);
    expect(both).toContain(line);
    expect(both).toContain("**Direct success with zero active replicas: 1** — this refutes H2.\n");
  });

  it("reports included attempts in the INCOMPLETE status and prints the no-end exclusion", async () => {
    const md = await build(
      [h2({ scenario: "replicas=1@g1" }), h2({ scenario: "replicas=1@g9" })],
      [started],
    );
    expect(md).toContain(
      "Status: **INCOMPLETE** — run did not finish (1 of 3 expected attempts included)",
    );
    expect(md).toContain(
      "Attempts included: 1 of 3 planned (2 recorded, including re-run generations)",
    );
    expect(md).toContain("Attempts excluded (no end-of-block state check recorded): 1");
    expect(md).not.toContain("this refutes H2");
  });
});

describe("run completeness", () => {
  const h3Run = "2026-10-02T12:00:00Z-h3-a";
  const h3Rec = (id: number) =>
    rec({
      run_id: h3Run,
      hypothesis: "H3",
      work_id: `h3-s${id}`,
      scenario: `s${id}-x`,
      cid_observed: null,
    });
  const build = async (records: ResultRecord[], marks?: unknown[]) => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    writeFileSync(join(results, "h3.ndjson"), lines(records));
    if (marks) writeFileSync(join(results, "h3.runs.ndjson"), lines(marks));
    const { markdownPath } = await generateReport({ resultsDir: results, outDir: out });
    return readFileSync(markdownPath, "utf8");
  };
  const started = { run_id: h3Run, status: "started", expected_attempts: 7, started_at: "t" };
  const all = [1, 2, 3, 4, 5, 6, 7].map(h3Rec);

  it("marks a completed run", async () => {
    const md = await build(all, [
      started,
      { run_id: h3Run, status: "completed", recorded_attempts: 7, finished_at: "t" },
    ]);
    expect(md).toContain("Status: complete (7/7 attempts)");
  });

  it("flags a started-only run as incomplete", async () => {
    const md = await build(all.slice(0, 4), [started]);
    expect(md).toContain("**INCOMPLETE**");
    expect(md).toContain("4 of 7");
  });

  it("reports unknown without a sidecar line for the run", async () => {
    expect(await build(all)).toContain("Status: unknown (no run-status sidecar)");
    expect(await build(all, [{ ...started, run_id: "other" }])).toContain("Status: unknown");
  });

  it("flags an H4 infrastructure failure as incomplete and keeps the error row", async () => {
    const results = mkdtempSync(join(tmpdir(), "report-in-"));
    const out = mkdtempSync(join(tmpdir(), "report-out-"));
    const run = "2026-10-02T12:00:00Z-h4-a";
    writeFileSync(join(results, "h4.ndjson"), "");
    writeFileSync(
      join(results, "h4.run.json"),
      JSON.stringify({ run_id: run, backfill: null, error: "ECONNREFUSED" }),
    );
    writeFileSync(
      join(results, "h4.runs.ndjson"),
      lines([{ run_id: run, status: "started", expected_attempts: 2, started_at: "t" }]),
    );
    const { markdownPath } = await generateReport({ resultsDir: results, outDir: out });
    const md = readFileSync(markdownPath, "utf8");
    expect(md).toContain("**INCOMPLETE**");
    expect(md).toContain("0 of 2");
    expect(md).toContain("| error | ECONNREFUSED |");
  });
});
