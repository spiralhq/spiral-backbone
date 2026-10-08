import {
  AccountRole,
  getBase58Encoder,
  type Address,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  type ReadonlyUint8Array,
  type Rpc,
  type Signature,
} from "@solana/kit";
import {
  FILM_PROGRAM_ADDRESS,
  FilmInstruction,
  identifyFilmInstruction,
  parseDeclareReplicaInstruction,
  parseRegisterFilmInstruction,
  type Film,
} from "@spiral-backbone/protocol/generated/film";
import { CliError } from "./errors";

export type FilmHistoryRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>;

export interface FilmSignatures {
  registerSignature: string;
  replicaSignatures: string[];
}

interface FilmHistory {
  registerSignature?: string;
  /** Newest successful declare_replica per PeerID (hex). */
  declareByPeer: Map<string, { signature: string; blockTime: bigint | null }>;
  /** Listed by getSignaturesForAddress but not returned by getTransaction. */
  unreadable: string[];
}

const PAGE_LIMIT = 1000;

export function peerHex(peerId: ReadonlyUint8Array, peerIdLen: number): string {
  return Buffer.from(peerId.slice(0, peerIdLen)).toString("hex");
}

function activeReplicas(film: Film): { peer: string; declaredAt: bigint }[] {
  return film.replicas
    .slice(0, film.replicaCount)
    .filter((replica) => replica.active)
    .map((replica) => ({
      peer: peerHex(replica.peerId, replica.peerIdLen),
      declaredAt: replica.declaredAt,
    }));
}

export function activeReplicaPeers(film: Film): string[] {
  return activeReplicas(film).map(({ peer }) => peer);
}

async function readFilmHistory(rpc: FilmHistoryRpc, filmPda: Address): Promise<FilmHistory> {
  const history: FilmHistory = { declareByPeer: new Map(), unreadable: [] };
  const base58 = getBase58Encoder();
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(filmPda, {
        commitment: "confirmed",
        limit: PAGE_LIMIT,
        ...(before ? { before } : {}),
      })
      .send();
    for (const entry of page) {
      if (entry.err !== null) continue;
      const tx = await rpc
        .getTransaction(entry.signature, {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      if (!tx) {
        history.unreadable.push(entry.signature);
        continue;
      }
      if (tx.meta?.err) continue;
      const blockTime = entry.blockTime ?? tx.blockTime ?? null;
      const keys: Address[] = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta?.loadedAddresses.writable ?? []),
        ...(tx.meta?.loadedAddresses.readonly ?? []),
      ];
      const instructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
      ];
      for (const ix of instructions) {
        if (keys[ix.programIdIndex] !== FILM_PROGRAM_ADDRESS) continue;
        const instruction = {
          programAddress: FILM_PROGRAM_ADDRESS,
          accounts: ix.accounts.map((index) => ({
            address: keys[index]!,
            role: AccountRole.READONLY,
          })),
          data: base58.encode(ix.data),
        };
        let kind: FilmInstruction;
        try {
          kind = identifyFilmInstruction(instruction.data);
        } catch {
          continue;
        }
        if (kind === FilmInstruction.RegisterFilm) {
          const parsed = parseRegisterFilmInstruction(instruction);
          // Newest first, so the last match is the oldest.
          if (parsed.accounts.film.address === filmPda) history.registerSignature = entry.signature;
        } else if (kind === FilmInstruction.DeclareReplica) {
          const parsed = parseDeclareReplicaInstruction(instruction);
          if (parsed.accounts.film.address !== filmPda) continue;
          const peer = peerHex(parsed.data.peerId, parsed.data.peerIdLen);
          if (!history.declareByPeer.has(peer)) {
            history.declareByPeer.set(peer, {
              signature: entry.signature,
              blockTime: blockTime === null ? null : BigInt(blockTime),
            });
          }
        }
      }
    }
    if (page.length < PAGE_LIMIT) return history;
    before = page[page.length - 1]!.signature;
  }
}

function missingSignatures(
  history: FilmHistory,
  active: { peer: string; declaredAt: bigint }[],
): string[] {
  const missing = history.unreadable.map(
    (signature) =>
      `transaction ${signature} (listed for the Film but not returned by getTransaction)`,
  );
  if (!history.registerSignature) missing.push("register_film");
  for (const { peer, declaredAt } of active) {
    const declare = history.declareByPeer.get(peer);
    if (!declare) {
      missing.push(`declare_replica for PeerID ${peer}`);
    } else if (declare.blockTime !== declaredAt) {
      missing.push(
        `declare_replica for PeerID ${peer} (newest is ${declare.signature} with blockTime ${declare.blockTime}, but the slot's declared_at is ${declaredAt})`,
      );
    }
  }
  return missing;
}

/**
 * register_signature is the oldest successful register_film for this Film; each active replica's
 * signature is its newest successful declare_replica (a declare of an active PeerID is refused, so
 * that is the one that made it active), whose blockTime must equal the slot's declared_at.
 * Returned for active slots only, in slot order. Any unreadable history entry fails closed.
 */
export async function resolveFilmSignatures(
  rpc: FilmHistoryRpc,
  filmPda: Address,
  film: Film,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<FilmSignatures> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 1_500;
  const active = activeReplicas(film);
  let missing: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const history = await readFilmHistory(rpc, filmPda);
    missing = missingSignatures(history, active);
    if (missing.length === 0) {
      return {
        registerSignature: history.registerSignature!,
        replicaSignatures: active.map(({ peer }) => history.declareByPeer.get(peer)!.signature),
      };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new CliError(
    `could not determine the transaction signature of ${missing.join(", ")} in the history of Film ${filmPda}. ` +
      "No golden line was written; rerun the same command, or check that the RPC endpoint keeps transaction history.",
  );
}
