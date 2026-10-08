import {
  address,
  getBase58Decoder,
  getBase64Decoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  FILM_PROGRAM_ADDRESS,
  FilmInstruction,
  getFilmEncoder,
  identifyFilmInstruction,
  parseDeclareReplicaInstruction,
  parseRegisterFilmInstruction,
  type FilmArgs,
  type ReplicaDeclarationArgs,
} from "@spiral-backbone/protocol/generated/film";
import type { FilmChain } from "../../commands/submit";

interface FakeTx {
  signature: string;
  err: unknown;
  instruction: Instruction;
  inner?: boolean;
  blockTime: number | null;
}

const EMPTY_REPLICA: ReplicaDeclarationArgs = {
  peerId: new Uint8Array(38),
  peerIdLen: 0,
  declaredAt: 0,
  active: false,
};

export const FAKE_ORG = address("11111111111111111111111111111112");
export const FAKE_SUBMITTER = address("11111111111111111111111111111113");

/** In-memory Film program: applies register_film/declare_replica and serves the RPC reads submit uses. */
export class FakeFilmChain implements FilmChain {
  film: FilmArgs | undefined;
  txs: FakeTx[] = [];
  sent: FilmInstruction[] = [];
  failOn?: (kind: FilmInstruction) => boolean;
  landThenThrow?: (kind: FilmInstruction) => boolean;
  hideFromHistory = new Set<string>();
  nullTransactions = new Set<string>();
  getTransactionCalls = 0;
  lastTime = 0;
  private clock = 1_000;
  private nextSig = 1;

  constructor(readonly filmPda: Address) {}

  signature(): string {
    return getBase58Decoder().decode(new Uint8Array(64).fill(this.nextSig++));
  }

  async send(instruction: Instruction): Promise<unknown> {
    const kind = identifyFilmInstruction(instruction.data!);
    if (this.failOn?.(kind)) throw new Error("injected failure");
    this.sent.push(kind);
    this.apply(instruction as Parameters<typeof parseRegisterFilmInstruction>[0]);
    const signature = this.signature();
    this.txs.push({ signature, err: null, instruction, blockTime: this.lastTime });
    if (this.landThenThrow?.(kind)) throw new Error("landed but confirmation timed out");
    return { context: { signature } };
  }

  record(
    instruction: Instruction,
    err: unknown = null,
    inner = false,
    blockTime: number | null = this.lastTime,
  ): string {
    const signature = this.signature();
    this.txs.push({ signature, err, instruction, inner, blockTime });
    return signature;
  }

  apply(instruction: Parameters<typeof parseRegisterFilmInstruction>[0]): void {
    const kind = identifyFilmInstruction(instruction.data);
    if (kind === FilmInstruction.RegisterFilm) {
      const { data } = parseRegisterFilmInstruction(instruction);
      if (this.film) throw new Error("account already in use");
      this.film = {
        organization: FAKE_ORG,
        submitter: FAKE_SUBMITTER,
        cid: data.cid,
        cidLen: data.cidLen,
        byteSize: data.byteSize,
        chunkingProfile: data.chunkingProfile,
        title: data.title,
        submittedAt: (this.lastTime = this.clock++),
        accessPolicy: 0,
        replicas: Array.from({ length: 8 }, () => EMPTY_REPLICA),
        replicaCount: 0,
        schemaVersion: 1,
        bump: 255,
      };
    } else if (kind === FilmInstruction.DeclareReplica) {
      const { data } = parseDeclareReplicaInstruction(instruction);
      const film = this.film!;
      const hex = (bytes: Uint8Array | ReadonlyArray<number>, len: number) =>
        Buffer.from(Array.from(bytes).slice(0, len)).toString("hex");
      const target = hex(data.peerId as Uint8Array, data.peerIdLen);
      const slots = film.replicas.slice(0, film.replicaCount);
      const slot = slots.findIndex((r) => hex(r.peerId as Uint8Array, r.peerIdLen) === target);
      if (slot >= 0 && slots[slot]!.active) throw new Error("custom program error: 6010");
      const replica = {
        peerId: data.peerId,
        peerIdLen: data.peerIdLen,
        declaredAt: (this.lastTime = this.clock++),
        active: true,
      };
      if (slot >= 0) film.replicas[slot] = replica;
      else film.replicas[film.replicaCount++] = replica;
    }
  }

  deactivate(slot: number): void {
    const film = this.film!;
    film.replicas[slot] = { ...film.replicas[slot]!, active: false };
  }

  get rpc(): FilmChain["rpc"] {
    const pending = <T>(value: T) => ({ send: async () => value });
    const getChain = () => this;
    return {
      getAccountInfo(addr: Address) {
        const chain = getChain();
        if (addr !== chain.filmPda || !chain.film) {
          return pending({ context: { slot: 1n }, value: null });
        }
        const bytes = getFilmEncoder().encode(chain.film);
        return pending({
          context: { slot: 1n },
          value: {
            data: [getBase64Decoder().decode(bytes), "base64"],
            executable: false,
            lamports: 1_000_000n,
            owner: FILM_PROGRAM_ADDRESS,
            space: BigInt(bytes.length),
            rentEpoch: 0n,
          },
        });
      },
      getSignaturesForAddress(addr: Address, config?: { before?: string; limit?: number }) {
        const chain = getChain();
        const touching = chain.txs
          .filter((tx) => !chain.hideFromHistory.has(tx.signature))
          .filter((tx) => tx.instruction.accounts!.some((meta) => meta.address === addr))
          .reverse();
        const start = config?.before
          ? touching.findIndex((tx) => tx.signature === config.before) + 1
          : 0;
        return pending(
          touching
            .slice(start, start + (config?.limit ?? 1000))
            .map((tx) => ({ signature: tx.signature, err: tx.err, blockTime: tx.blockTime })),
        );
      },
      getTransaction(signature: string) {
        const chain = getChain();
        chain.getTransactionCalls++;
        const tx = chain.txs.find((candidate) => candidate.signature === signature);
        if (!tx || chain.nullTransactions.has(signature)) return pending(null);
        const keys = [
          FAKE_SUBMITTER,
          ...new Set([
            ...tx.instruction.accounts!.map((meta) => meta.address),
            tx.instruction.programAddress,
          ]),
        ];
        const compiled = {
          programIdIndex: keys.indexOf(tx.instruction.programAddress),
          accounts: tx.instruction.accounts!.map((meta) => keys.indexOf(meta.address)),
          data: getBase58Decoder().decode(tx.instruction.data!),
        };
        return pending({
          blockTime: tx.blockTime,
          meta: {
            err: tx.err,
            loadedAddresses: { writable: [], readonly: [] },
            innerInstructions: tx.inner ? [{ index: 0, instructions: [compiled] }] : [],
          },
          transaction: {
            message: { accountKeys: keys, instructions: tx.inner ? [] : [compiled] },
          },
        });
      },
    } as unknown as FilmChain["rpc"];
  }
}
