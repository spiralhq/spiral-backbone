import { base58btc } from "multiformats/bases/base58";

export interface PeerBytes {
  peer_id: string;
  bytes_received: number;
  declared: boolean;
}

export interface Provenance {
  peers: PeerBytes[];
  data_received: number;
  dup_data_received: number;
  dag_size: number | null;
  ledger_declared_total: number;
  ledger_undeclared_total: number;
  unattributed: number;
}

export interface BitswapStat {
  peers: string[];
  data_received: number;
  dup_data_received: number;
}

export function parseSwarmPeers(output: string): string[] {
  return output
    .split("\n")
    .map((line) => /\/p2p\/(\S+)$/.exec(line.trim())?.[1])
    .filter((id): id is string => Boolean(id));
}

export function parseLedgerBytesReceived(output: string): number {
  const match = /bytes received:\s*(\d+)/i.exec(output);
  if (!match)
    throw new Error(`no "Bytes received" line in bitswap ledger output: ${output.slice(0, 200)}`);
  return Number(match[1]);
}

export function parseBitswapStat(output: string): BitswapStat {
  const raw = JSON.parse(output) as Record<string, unknown>;
  const count = (key: string, required: boolean): number => {
    const value = raw[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    if (value === undefined && !required) return 0;
    throw new Error(`bitswap stat has no valid ${key}: ${output.slice(0, 200)}`);
  };
  if (raw["Peers"] === undefined)
    throw new Error(`bitswap stat has no Peers key: ${output.slice(0, 200)}`);
  const peers = raw["Peers"] ?? [];
  if (!Array.isArray(peers) || !peers.every((p) => typeof p === "string")) {
    throw new Error(`bitswap stat Peers is not a list of peer IDs: ${output.slice(0, 200)}`);
  }
  return {
    peers,
    data_received: count("DataReceived", true),
    dup_data_received: count("DupDataReceived", false),
  };
}

export function parseDagStatSize(output: string): number {
  const size = (JSON.parse(output) as Record<string, unknown>)["TotalSize"];
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new Error(`dag stat has no valid TotalSize: ${output.slice(0, 200)}`);
  }
  return size;
}

export function summarizeProvenance(
  peers: PeerBytes[],
  stat: BitswapStat,
  dagSize: number | null,
): Provenance {
  const total = (declared: boolean) =>
    peers.filter((p) => p.declared === declared).reduce((sum, p) => sum + p.bytes_received, 0);
  const declaredTotal = total(true);
  const undeclaredTotal = total(false);
  return {
    peers,
    data_received: stat.data_received,
    dup_data_received: stat.dup_data_received,
    dag_size: dagSize,
    ledger_declared_total: declaredTotal,
    ledger_undeclared_total: undeclaredTotal,
    unattributed: stat.data_received - (declaredTotal + undeclaredTotal),
  };
}

export function peerIdFromBytes(bytes: Uint8Array, len: number): string {
  return base58btc.baseEncode(bytes.slice(0, len));
}
