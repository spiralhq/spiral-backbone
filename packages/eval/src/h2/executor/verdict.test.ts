import { describe, expect, it } from "vitest";
import {
  parseBitswapStat,
  parseDagStatSize,
  parseLedgerBytesReceived,
  parseSwarmPeers,
  peerIdFromBytes,
  summarizeProvenance,
} from "./provenance";
import { classifyCatError, verdict } from "./verdict";

const CID = "bafybeidsllxmnuveplqr6cs7ndxpgsolad3j7wj3bntrkvl4bor5cb44lq";
const ok = { ok: true as const, cidObserved: CID };

type Row = { peer_id: string; bytes_received: number; declared: boolean };
const prov = (peers: Row[], data_received: number, dag_size: number | null = data_received) =>
  summarizeProvenance(peers, { peers: [], data_received, dup_data_received: 0 }, dag_size);
const direct = (provenance: ReturnType<typeof prov> | null) =>
  verdict({ method: "direct", cidExpected: CID, retrieval: ok, activeReplicas: 3, provenance });

describe("verdict", () => {
  it("succeeds for a verified direct retrieval served only by declared replicas", () => {
    expect(
      verdict({
        method: "direct",
        cidExpected: CID,
        retrieval: ok,
        activeReplicas: 3,
        provenance: prov(
          [
            { peer_id: "A", bytes_received: 900_208, declared: true },
            { peer_id: "NET", bytes_received: 0, declared: false },
          ],
          900_208,
        ),
      }),
    ).toMatchObject({ outcome: "success", failure_class: null });
  });

  it("classifies bytes from an undeclared peer as external_cache", () => {
    expect(
      verdict({
        method: "direct",
        cidExpected: CID,
        retrieval: ok,
        activeReplicas: 3,
        provenance: prov(
          [
            { peer_id: "A", bytes_received: 10, declared: true },
            { peer_id: "GW", bytes_received: 5, declared: false },
          ],
          15,
        ),
      }),
    ).toMatchObject({
      outcome: "failure",
      failure_class: "external_cache",
      reason: expect.stringMatching(/GW/),
    });
  });

  it("fails closed on empty or all-zero provenance for a successful direct cat", () => {
    for (const p of [
      prov([], 0, 700_158),
      prov([{ peer_id: "A", bytes_received: 0, declared: true }], 0, 700_158),
      null,
    ]) {
      expect(direct(p)).toMatchObject({ outcome: "failure", failure_class: "external_cache" });
    }
  });

  it("classifies a declared total below the DAG size as external_cache", () => {
    expect(
      direct(prov([{ peer_id: "A", bytes_received: 600_000, declared: true }], 700_474, 700_158)),
    ).toMatchObject({
      outcome: "failure",
      failure_class: "external_cache",
      reason: expect.stringMatching(/below the 700158-byte DAG/),
    });
  });

  it("classifies DataReceived 0 as external_cache even when ledgers look complete", () => {
    expect(
      direct(prov([{ peer_id: "A", bytes_received: 700_158, declared: true }], 0, 700_158)),
    ).toMatchObject({
      outcome: "failure",
      failure_class: "external_cache",
      reason: expect.stringMatching(/0 bytes/),
    });
  });

  it("fails closed when no DAG size was recorded", () => {
    expect(
      direct(prov([{ peer_id: "A", bytes_received: 700_158, declared: true }], 700_158, null)),
    ).toMatchObject({ outcome: "failure", failure_class: "external_cache" });
  });

  it("accepts the measured case: declared 700158 covers the 700158-byte DAG, DataReceived 700474", () => {
    const p = prov(
      [
        { peer_id: "NET", bytes_received: 0, declared: false },
        { peer_id: "A", bytes_received: 0, declared: true },
        { peer_id: "B", bytes_received: 700_158, declared: true },
        { peer_id: "C", bytes_received: 0, declared: true },
      ],
      700_474,
      700_158,
    );
    expect(p).toMatchObject({
      ledger_declared_total: 700_158,
      ledger_undeclared_total: 0,
      unattributed: 316,
      dag_size: 700_158,
    });
    expect(direct(p)).toMatchObject({ outcome: "success", failure_class: null });
  });

  it("records a negative unattributed value raw", () => {
    expect(
      prov(
        [
          { peer_id: "A", bytes_received: 400, declared: true },
          { peer_id: "B", bytes_received: 400, declared: true },
        ],
        700,
        700,
      ).unattributed,
    ).toBe(-100);
  });

  it("classifies a gateway hit with zero active replicas as external_cache", () => {
    expect(
      verdict({
        method: "gateway",
        cidExpected: CID,
        retrieval: ok,
        activeReplicas: 0,
        provenance: null,
      }),
    ).toMatchObject({ outcome: "failure", failure_class: "external_cache" });
    expect(
      verdict({
        method: "gateway",
        cidExpected: CID,
        retrieval: ok,
        activeReplicas: 1,
        provenance: null,
      }).outcome,
    ).toBe("success");
  });

  it("reports cid_mismatch and retrieval failures", () => {
    expect(
      verdict({
        method: "direct",
        cidExpected: CID,
        retrieval: { ok: true, cidObserved: "bafyOTHER" },
        activeReplicas: 3,
        provenance: prov([], 0),
      }).failure_class,
    ).toBe("cid_mismatch");
    expect(
      verdict({
        method: "direct",
        cidExpected: CID,
        retrieval: { ok: false, failureClass: "timeout", error: "x" },
        activeReplicas: 0,
        provenance: prov([], 0),
      }).failure_class,
    ).toBe("timeout");
  });
});

describe("classifyCatError", () => {
  it("maps timeouts, misses and connection errors", () => {
    expect(classifyCatError("", true)).toBe("timeout");
    expect(classifyCatError("Error: context canceled", true)).toBe("timeout");
    expect(classifyCatError("block was not found locally (offline)", false)).toBe(
      "object_unavailable",
    );
    expect(classifyCatError("failed to dial: connection refused", false)).toBe("connection_error");
  });
});

describe("provenance parsing", () => {
  it("parses swarm peers and ledger bytes", () => {
    expect(
      parseSwarmPeers(
        "/ip4/172.24.0.2/tcp/4001/p2p/12D3KooWA\n/ip4/172.24.0.3/tcp/4001/p2p/12D3KooWB\n",
      ),
    ).toEqual(["12D3KooWA", "12D3KooWB"]);
    expect(
      parseLedgerBytesReceived(
        "Ledger for 12D3KooWA\nDebt ratio:\t0.000000\nExchanges:\t0\nBytes sent:\t0\nBytes received:\t900208\n",
      ),
    ).toBe(900_208);
    expect(parseLedgerBytesReceived("Ledger for x\nBytes sent:\t5\nBytes received:\t0\n")).toBe(0);
    expect(() => parseLedgerBytesReceived("Ledger for x\n")).toThrow(/Bytes received/);
  });

  it("parses bitswap stat JSON and fails closed on a malformed one", () => {
    expect(
      parseBitswapStat(
        '{"Wantlist":[],"Peers":["12D3KooWA","12D3KooWB"],"BlocksReceived":4,"DataReceived":900208,"DupBlksReceived":1,"DupDataReceived":10}',
      ),
    ).toEqual({ peers: ["12D3KooWA", "12D3KooWB"], data_received: 900_208, dup_data_received: 10 });
    expect(parseBitswapStat('{"Peers":null,"DataReceived":0}')).toEqual({
      peers: [],
      data_received: 0,
      dup_data_received: 0,
    });
    expect(() => parseBitswapStat('{"Peers":[]}')).toThrow(/DataReceived/);
    expect(() => parseBitswapStat('{"DataReceived":0}')).toThrow(/Peers/);
    expect(() => parseBitswapStat("Error: oops")).toThrow();
  });

  it("parses dag stat TotalSize and fails closed otherwise", () => {
    expect(
      parseDagStatSize(
        '{"UniqueBlocks":4,"TotalSize":700158,"Ratio":1,"DagStats":[{"Cid":"bafy","Size":700158,"NumBlocks":4}]}',
      ),
    ).toBe(700_158);
    expect(() => parseDagStatSize('{"UniqueBlocks":4}')).toThrow(/TotalSize/);
    expect(() => parseDagStatSize("Error: block was not found locally (offline)")).toThrow();
  });

  it("encodes an on-chain PeerID back to its base58 form", () => {
    const bytes = new Uint8Array(38);
    bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
    expect(peerIdFromBytes(bytes, 38)).toMatch(/^12D3KooW/);
  });
});
