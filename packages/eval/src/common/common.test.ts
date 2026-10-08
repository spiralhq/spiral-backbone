import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryRecord, ResultRecord } from "@spiral-backbone/protocol";
import { describe, expect, it } from "vitest";
import { readGolden } from "./golden";
import {
  appendResult,
  readJsonLines,
  recoverTruncatedTail,
  toJsonLine,
  TruncatedTailError,
} from "./ndjson";
import { makeRunId } from "./run-id";
import { sidecarPath } from "./sidecar";
import { markRunCompleted, markRunStarted, runStatusSchema } from "./run-status";
import { verifierImpl } from "./verifier-impl";
import { inventoryRecordSchema, resultRecordSchema } from "@spiral-backbone/protocol";

const dir = () => mkdtempSync(join(tmpdir(), "eval-common-"));

function result(overrides: Partial<ResultRecord> = {}): ResultRecord {
  return {
    run_id: "2026-10-02T12:00:00Z-h1-test",
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
    cid_expected: "bafy",
    cid_observed: "bafy",
    outcome: "success",
    failure_class: null,
    tx_signature: null,
    rpc_endpoint: "127.0.0.1:8899",
    verifier_impl: "ipfs-unixfs-importer@17.1.1",
    artifact_versions: { film: "0.1.0@04757ba" },
    ...overrides,
  };
}

function golden(workId: string, filmPda: string): InventoryRecord {
  return inventoryRecordSchema.parse({
    work_id: workId,
    film_pda: filmPda,
    organization: "org",
    submitter: "sub",
    cid: "bafy",
    cid_len: 36,
    byte_size: "10",
    chunking_profile: 1,
    title: "t",
    submitted_at: "1",
    access_policy: "Public",
    replica_count: 0,
    replicas: [],
    schema_version: 1,
    bump: 255,
    size_band: "small",
    cold_cid: false,
    sha256: "0".repeat(64),
    register_signature: "sig",
    replica_signatures: [],
    rpc_endpoint: "h",
    captured_at: "2026-10-02T12:00:00.000Z",
    artifact_versions: {},
  });
}

describe("makeRunId", () => {
  it("formats <iso-second>Z-<hypothesis>-<label>", () => {
    expect(makeRunId("h3", "devnet", new Date("2026-10-28T14:03:11.456Z"))).toBe(
      "2026-10-28T14:03:11Z-h3-devnet",
    );
  });

  it("rejects labels outside [a-z0-9-]", () => {
    expect(() => makeRunId("h1", "Dev Net")).toThrow(/label/);
  });
});

describe("NDJSON", () => {
  it("appends schema-valid records, one per line", async () => {
    const path = join(dir(), "out", "h1.ndjson");
    await appendResult(path, result());
    await appendResult(path, result({ work_id: "pd-002" }));
    const records = await readJsonLines(path, resultRecordSchema);
    expect(records.map((r) => r.work_id)).toEqual(["pd-001", "pd-002"]);
  });

  it("refuses to write a record that violates the frozen schema", async () => {
    const path = join(dir(), "h1.ndjson");
    await expect(
      appendResult(path, result({ failure_class: "made_up" as ResultRecord["failure_class"] })),
    ).rejects.toThrow();
  });

  it("serializes bigint as a decimal string", () => {
    expect(toJsonLine({ n: 9_007_199_254_740_993n })).toBe('{"n":"9007199254740993"}');
  });

  it("reports the file and line of a malformed line", async () => {
    const path = join(dir(), "bad.ndjson");
    writeFileSync(path, `${JSON.stringify(result())}\n{not json\n`);
    await expect(readJsonLines(path, resultRecordSchema)).rejects.toThrow(/bad\.ndjson:2/);
  });

  it("refuses a truncated final line and says how to recover", async () => {
    const path = join(dir(), "h2.ndjson");
    writeFileSync(path, `${JSON.stringify(result())}\n{"run_id":"2026-10`);
    const error = await readJsonLines(path, resultRecordSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TruncatedTailError);
    expect((error as Error).message).toMatch(/h2\.ndjson:2: truncated final line .*partial-/);
    expect((error as Error).message).not.toMatch(/eval:h2|--resume/);
  });

  it("still throws on a truncated line that is not the last", async () => {
    const path = join(dir(), "h2.ndjson");
    writeFileSync(path, `{"run_id":"2026-10\n${JSON.stringify(result())}\n`);
    const error = await readJsonLines(path, resultRecordSchema).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TruncatedTailError);
    expect((error as Error).message).toMatch(/h2\.ndjson:1: invalid JSON/);
  });
});

describe("recoverTruncatedTail", () => {
  it("moves an unparseable final line without a newline aside and logs it", async () => {
    const d = dir();
    const path = join(d, "h2.ndjson");
    const good = `${JSON.stringify(result())}\n`;
    writeFileSync(path, `${good}{"run_id":"2026-10`);
    const logs: string[] = [];
    const moved = await recoverTruncatedTail(
      path,
      (m) => logs.push(m),
      () => "20261008T100000Z",
    );
    expect(moved).toBe(`${path}.partial-20261008T100000Z`);
    expect(readFileSync(path, "utf8")).toBe(good);
    expect(readFileSync(moved!, "utf8")).toBe('{"run_id":"2026-10');
    expect(logs).toEqual([`${path}: truncated final line (18 bytes) moved to ${moved}`]);
    expect(await readJsonLines(path, resultRecordSchema)).toHaveLength(1);
  });

  it("leaves complete files and missing files alone", async () => {
    const d = dir();
    const path = join(d, "h2.ndjson");
    expect(await recoverTruncatedTail(path, () => {})).toBeNull();
    writeFileSync(path, `${JSON.stringify(result())}\n`);
    expect(await recoverTruncatedTail(path, () => {})).toBeNull();
    writeFileSync(path, "");
    expect(await recoverTruncatedTail(path, () => {})).toBeNull();
    expect(readdirSync(d)).toEqual(["h2.ndjson"]);
  });

  it("terminates a final line that parses but lacks its newline", async () => {
    const path = join(dir(), "h2.ndjson");
    writeFileSync(path, JSON.stringify(result()));
    const logs: string[] = [];
    expect(await recoverTruncatedTail(path, (m) => logs.push(m))).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(result())}\n`);
    expect(logs).toEqual([`${path}: final line lacked its newline; terminated it`]);
  });

  it("does not touch a truncated line that is not the last", async () => {
    const path = join(dir(), "h2.ndjson");
    const text = `{"run_id":"2026-10\n${JSON.stringify(result())}\n`;
    writeFileSync(path, text);
    expect(await recoverTruncatedTail(path, () => {})).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});

describe("readGolden", () => {
  it("reads inventory lines", async () => {
    const path = join(dir(), "golden.ndjson");
    writeFileSync(
      path,
      `${JSON.stringify(golden("pd-001", "f1"))}\n${JSON.stringify(golden("pd-002", "f2"))}\n`,
    );
    expect((await readGolden(path)).map((g) => g.work_id)).toEqual(["pd-001", "pd-002"]);
  });

  it("rejects duplicate work ids and empty files", async () => {
    const d = dir();
    const dup = join(d, "dup.ndjson");
    writeFileSync(
      dup,
      `${JSON.stringify(golden("pd-001", "f1"))}\n${JSON.stringify(golden("pd-001", "f2"))}\n`,
    );
    await expect(readGolden(dup)).rejects.toThrow(/duplicate work_id pd-001/);
    const empty = join(d, "empty.ndjson");
    writeFileSync(empty, "");
    await expect(readGolden(empty)).rejects.toThrow(/empty/);
  });
});

describe("sidecarPath", () => {
  it("derives evidence and run paths from the output path", () => {
    expect(sidecarPath("results/h3.ndjson", "evidence")).toBe("results/h3.evidence.ndjson");
    expect(sidecarPath("results/h4.ndjson", "run")).toBe("results/h4.run.json");
    expect(sidecarPath("results/h1.ndjson", "runs")).toBe("results/h1.runs.ndjson");
  });
});

describe("verifierImpl", () => {
  it("names the installed importer version", () => {
    expect(verifierImpl()).toMatch(/^ipfs-unixfs-importer@17\.\d+\.\d+$/);
  });
});

describe("run status markers", () => {
  it("round-trips started and completed lines through the schema", async () => {
    const out = join(dir(), "h3.ndjson");
    await markRunStarted(out, "r1", 7);
    await markRunCompleted(out, "r1", 7);
    const lines = await readJsonLines(sidecarPath(out, "runs"), runStatusSchema);
    expect(lines).toMatchObject([
      { run_id: "r1", status: "started", expected_attempts: 7 },
      { run_id: "r1", status: "completed", recorded_attempts: 7 },
    ]);
    expect(Number.isNaN(Date.parse((lines[0] as { started_at: string }).started_at))).toBe(false);
    expect(Number.isNaN(Date.parse((lines[1] as { finished_at: string }).finished_at))).toBe(false);
  });
});
