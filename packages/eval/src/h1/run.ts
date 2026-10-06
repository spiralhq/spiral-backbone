import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { address, createSolanaRpc } from "@solana/kit";
import {
  artifactVersions,
  bytesToCidString,
  describeEndpoint,
  type InventoryRecord,
  type ResultRecord,
} from "@spiral-backbone/protocol";
import { fetchFilm } from "@spiral-backbone/protocol/generated/film";
import { computeSpiralCidFromFile } from "../../verifier/index";
import { appendJsonLine, appendResult } from "../common/ndjson";
import { markRunCompleted, markRunStarted } from "../common/run-status";
import { sidecarPath } from "../common/sidecar";
import { verifierImpl } from "../common/verifier-impl";
import { classifyWorkError } from "./classify";
import { diagnoseIntactMismatch } from "./diagnose";
import { sha256File } from "./hash";
import { retrieveToFile } from "./retrieve";
import { tamperOffset, writeTamperedCopy } from "./tamper";

export interface H1Options {
  golden: InventoryRecord[];
  rpcUrl: string;
  kuboUrl: string;
  outPath: string;
  workDir: string;
  runId: string;
  timeoutMs: number;
}

export interface H1Summary {
  intact: { success: number; failure: number };
  tampered: { success: number; failure: number };
}

export async function runH1(options: H1Options): Promise<H1Summary> {
  const rpc = createSolanaRpc(options.rpcUrl);
  const evidencePath = sidecarPath(options.outPath, "evidence");
  const shared = {
    run_id: options.runId,
    hypothesis: "H1" as const,
    method: "kubo-rpc",
    attempt: 1,
    tx_signature: null,
    rpc_endpoint: describeEndpoint(options.rpcUrl).host,
    verifier_impl: verifierImpl(),
    artifact_versions: artifactVersions(),
  };
  const summary: H1Summary = {
    intact: { success: 0, failure: 0 },
    tampered: { success: 0, failure: 0 },
  };
  await mkdir(options.workDir, { recursive: true });
  await markRunStarted(options.outPath, options.runId, options.golden.length);

  for (const work of options.golden) {
    const base = {
      ...shared,
      film_pda: work.film_pda,
      work_id: work.work_id,
      size_band: work.size_band,
    };
    const retrievedPath = join(options.workDir, `${work.work_id}.retrieved`);
    const tamperedPath = `${retrievedPath}.tampered`;
    const startedAt = new Date();
    let cidExpected = work.cid;
    let intactRecorded = false;
    try {
      const film = (await fetchFilm(rpc, address(work.film_pda))).data;
      const cidBytes = new Uint8Array(film.cid);
      cidExpected = bytesToCidString(cidBytes, film.cidLen);
      const size = await retrieveToFile(
        options.kuboUrl,
        cidExpected,
        retrievedPath,
        options.timeoutMs,
      );
      const observed = (await computeSpiralCidFromFile(retrievedPath)).toString();
      const intactOk = observed === cidExpected;
      await appendResult(
        options.outPath,
        record(
          base,
          "intact",
          size,
          startedAt,
          cidExpected,
          observed,
          intactOk,
          intactOk ? null : "cid_mismatch",
        ),
      );
      intactRecorded = true;
      summary.intact[intactOk ? "success" : "failure"]++;
      if (!intactOk) {
        const retrievedSha256 = await sha256File(retrievedPath);
        const cidPrefixHex = Buffer.from(cidBytes.slice(0, 4)).toString("hex");
        await appendJsonLine(evidencePath, {
          run_id: options.runId,
          work_id: work.work_id,
          scenario: "intact",
          diagnosis: diagnoseIntactMismatch({
            cidLen: film.cidLen,
            cidPrefixHex,
            manifestSha256: work.sha256,
            retrievedSha256,
          }),
          cid_len: film.cidLen,
          cid_prefix_hex: cidPrefixHex,
          manifest_sha256: work.sha256,
          retrieved_sha256: retrievedSha256,
        });
        await appendJsonLine(evidencePath, {
          run_id: options.runId,
          work_id: work.work_id,
          scenario: "tampered",
          not_evaluable: "intact recomputation already mismatched",
        });
        continue;
      }

      const offset = tamperOffset(`${options.runId}:${work.work_id}`, size);
      const bytes = await writeTamperedCopy(retrievedPath, tamperedPath, offset);
      const tamperedStart = new Date();
      const tamperedObserved = (await computeSpiralCidFromFile(tamperedPath)).toString();
      const detected = tamperedObserved !== cidExpected;
      await appendResult(
        options.outPath,
        record(
          base,
          "tampered",
          size,
          tamperedStart,
          cidExpected,
          tamperedObserved,
          detected,
          null,
        ),
      );
      summary.tampered[detected ? "success" : "failure"]++;
      await appendJsonLine(evidencePath, {
        run_id: options.runId,
        work_id: work.work_id,
        scenario: "tampered",
        offset,
        original_byte: bytes.original,
        tampered_byte: bytes.tampered,
      });
    } catch (error) {
      if (intactRecorded) throw error;
      const failureClass = classifyWorkError(error);
      if (failureClass === null) throw error;
      await appendResult(
        options.outPath,
        record(
          base,
          "intact",
          Number(work.byte_size),
          startedAt,
          cidExpected,
          null,
          false,
          failureClass,
        ),
      );
      summary.intact.failure++;
      await appendJsonLine(evidencePath, {
        run_id: options.runId,
        work_id: work.work_id,
        scenario: "intact",
        error: (error as Error).message,
      });
    } finally {
      await rm(retrievedPath, { force: true });
      await rm(tamperedPath, { force: true });
    }
  }
  await markRunCompleted(
    options.outPath,
    options.runId,
    summary.intact.success + summary.intact.failure,
  );
  return summary;
}

function record(
  base: Omit<
    ResultRecord,
    | "scenario"
    | "size_bytes"
    | "started_at"
    | "finished_at"
    | "latency_ms"
    | "cid_expected"
    | "cid_observed"
    | "outcome"
    | "failure_class"
  >,
  scenario: "intact" | "tampered",
  sizeBytes: number,
  startedAt: Date,
  cidExpected: string,
  cidObserved: string | null,
  ok: boolean,
  failureClass: ResultRecord["failure_class"],
): ResultRecord {
  const finishedAt = new Date();
  return {
    ...base,
    scenario,
    size_bytes: sizeBytes,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    latency_ms: finishedAt.getTime() - startedAt.getTime(),
    cid_expected: cidExpected,
    cid_observed: cidObserved,
    outcome: ok ? "success" : "failure",
    failure_class: failureClass,
  };
}
