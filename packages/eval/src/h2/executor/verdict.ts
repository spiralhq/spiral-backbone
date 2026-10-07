import type { FailureClass } from "@spiral-backbone/protocol";
import type { Provenance } from "./provenance";

export type Retrieval =
  | { ok: true; cidObserved: string }
  | { ok: false; failureClass: FailureClass; error: string };

export interface Verdict {
  outcome: "success" | "failure";
  failure_class: FailureClass | null;
  reason: string;
}

const failure = (failure_class: FailureClass, reason: string): Verdict => ({
  outcome: "failure",
  failure_class,
  reason,
});

export function verdict(input: {
  method: "direct" | "gateway";
  cidExpected: string;
  retrieval: Retrieval;
  provenance: Provenance | null;
  activeReplicas: number;
}): Verdict {
  if (!input.retrieval.ok) return failure(input.retrieval.failureClass, input.retrieval.error);
  if (input.retrieval.cidObserved !== input.cidExpected) {
    return failure(
      "cid_mismatch",
      `recomputed ${input.retrieval.cidObserved}, registry says ${input.cidExpected}`,
    );
  }
  if (input.method === "direct") {
    const p = input.provenance;
    if (!p) return failure("external_cache", "no provenance recorded for a direct retrieval");
    const foreign = p.peers.filter((r) => !r.declared && r.bytes_received > 0);
    if (foreign.length > 0) {
      return failure(
        "external_cache",
        `received bytes from undeclared peers: ${foreign.map((r) => r.peer_id).join(", ")}`,
      );
    }
    if (p.data_received === 0) {
      return failure(
        "external_cache",
        "cat succeeded but bitswap received 0 bytes; the source is unattributed",
      );
    }
    if (p.dag_size === null) {
      return failure("external_cache", "no DAG size recorded for a successful direct retrieval");
    }
    if (p.ledger_declared_total < p.dag_size) {
      return failure(
        "external_cache",
        `declared replicas account for ${p.ledger_declared_total} bytes, below the ${p.dag_size}-byte DAG`,
      );
    }
  }
  if (input.method === "gateway" && input.activeReplicas === 0) {
    return failure("external_cache", "gateway served the content with zero active replicas");
  }
  return { outcome: "success", failure_class: null, reason: "recovered and verified" };
}

export function classifyCatError(stderr: string, timedOut: boolean): FailureClass {
  if (timedOut) return "timeout";
  if (/not found|could not find|no providers|routing: not found/i.test(stderr))
    return "object_unavailable";
  if (/connection|dial|refused|unreachable/i.test(stderr)) return "connection_error";
  return "object_unavailable";
}
