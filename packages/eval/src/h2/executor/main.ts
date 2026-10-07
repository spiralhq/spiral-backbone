import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, createSolanaRpc } from "@solana/kit";
import { bytesToCidString, describeEndpoint, resultRecordSchema } from "@spiral-backbone/protocol";
import { fetchFilm } from "@spiral-backbone/protocol/generated/film";
import { computeSpiralCidFromFile } from "../../../verifier/index";
import { toJsonLine } from "../../common/ndjson";
import { verifierImpl } from "../../common/verifier-impl";
import { attemptPayloadSchema, EXECUTOR_EXIT } from "./attempt";
import { fetchViaGateway } from "./gateway";
import { catToFile, initFreshNode, provenance, startDaemon } from "./local-node";
import { peerIdFromBytes, type Provenance } from "./provenance";
import { classifyCatError, verdict, type Retrieval } from "./verdict";

async function main(): Promise<number> {
  const payload = attemptPayloadSchema.parse(JSON.parse(process.env["SPIRAL_ATTEMPT"] ?? ""));
  if (payload.method === "gateway" && !payload.gateway_eligible) {
    console.error(
      `refused: ${payload.attempt_id} is a cold CID, not gateway-eligible before the zero-replica block`,
    );
    return EXECUTOR_EXIT.refused;
  }

  const dest = join(await mkdtemp(join(tmpdir(), "attempt-")), "content");
  const startedAt = new Date();
  let retrieval: Retrieval;
  let provenanceRows: Provenance | null = null;
  let gatewayStatus: number | null = null;
  let gatewayHeaders: Record<string, string> = {};

  const film = (await fetchFilm(createSolanaRpc(payload.rpc_url), address(payload.film_pda))).data;
  const cidExpected = bytesToCidString(new Uint8Array(film.cid), film.cidLen);
  const declared = film.replicas
    .slice(0, film.replicaCount)
    .filter((r) => r.active)
    .map((r) => peerIdFromBytes(new Uint8Array(r.peerId), r.peerIdLen));

  if (payload.method === "direct") {
    await initFreshNode({
      bootstrapMultiaddr: payload.bootstrap_multiaddr,
      privateNetwork: payload.private_network,
      swarmKeyPath: process.env["SPIRAL_SWARM_KEY"] ?? null,
    });
    const daemon = await startDaemon();
    try {
      const cat = await catToFile(cidExpected, dest, payload.timeout_ms);
      retrieval = cat.ok
        ? { ok: true, cidObserved: (await computeSpiralCidFromFile(dest)).toString() }
        : {
            ok: false,
            failureClass: classifyCatError(cat.stderr, cat.timedOut),
            error: cat.stderr || "ipfs cat timed out",
          };
      provenanceRows = await provenance(new Set(declared), cat.ok ? cidExpected : null);
    } finally {
      await daemon.stop();
    }
  } else {
    const fetched = await fetchViaGateway(
      payload.gateway_url,
      cidExpected,
      dest,
      payload.timeout_ms,
    );
    gatewayStatus = fetched.status;
    gatewayHeaders = fetched.headers;
    retrieval = fetched.result.ok
      ? { ok: true, cidObserved: (await computeSpiralCidFromFile(dest)).toString() }
      : fetched.result;
  }

  const finishedAt = new Date();
  const result = verdict({
    method: payload.method,
    cidExpected,
    retrieval,
    provenance: provenanceRows,
    activeReplicas: payload.active_replicas,
  });
  const record = resultRecordSchema.parse({
    run_id: payload.run_id,
    hypothesis: "H2",
    film_pda: payload.film_pda,
    work_id: payload.work_id,
    size_bytes: payload.size_bytes,
    size_band: payload.size_band,
    scenario: payload.scenario,
    method: payload.method,
    attempt: payload.repetition,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    latency_ms: finishedAt.getTime() - startedAt.getTime(),
    cid_expected: cidExpected,
    cid_observed: retrieval.ok ? retrieval.cidObserved : null,
    outcome: result.outcome,
    failure_class: result.failure_class,
    tx_signature: null,
    rpc_endpoint: describeEndpoint(payload.rpc_url).host,
    verifier_impl: verifierImpl(),
    artifact_versions: payload.artifact_versions,
  });
  const evidence = {
    run_id: payload.run_id,
    attempt_id: payload.attempt_id,
    scenario: payload.scenario,
    reason: result.reason,
    active_replicas: payload.active_replicas,
    declared_replicas: declared,
    provenance: provenanceRows,
    gateway_status: gatewayStatus,
    gateway_headers: gatewayHeaders,
  };
  process.stdout.write(`${toJsonLine({ record, evidence })}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`executor fault: ${(error as Error).message}`);
    process.exit(EXECUTOR_EXIT.fault);
  },
);
