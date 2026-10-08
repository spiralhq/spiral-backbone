import { AccountRole, address, createNoopSigner, type Address } from "@solana/kit";
import {
  FILM_PROGRAM_ADDRESS,
  FilmInstruction,
  getDeclareReplicaInstruction,
  getRegisterFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import { describe, expect, it } from "vitest";
import { CliError } from "../lib/errors";
import { FAKE_ORG, FAKE_SUBMITTER, FakeFilmChain } from "../lib/testing/fake-film-chain";
import {
  assertDistinctPeers,
  ensureFilmOnChain,
  parseReplicaUrls,
  submitOptionsSchema,
  type FilmSubmission,
} from "./submit";

const valid = {
  org: "spiralhq",
  workId: "pd-001",
  manifest: "dataset/manifest.json",
  file: "/tmp/film.mp4",
  title: "A Trip to the Moon",
  replicas: "http://node-a:5001,http://node-b:5001,http://node-c:5001",
  cluster: "devnet",
  keypair: "/tmp/id.json",
};

describe("submit command options", () => {
  it("accepts a well-formed set of options", () => {
    expect(submitOptionsSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a work id", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest["workId"];
    expect(submitOptionsSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a title over 160 characters", () => {
    expect(submitOptionsSchema.safeParse({ ...valid, title: "x".repeat(161) }).success).toBe(false);
  });

  it("bounds the title in UTF-8 bytes, as the program does", () => {
    expect(submitOptionsSchema.safeParse({ ...valid, title: "é".repeat(80) }).success).toBe(true);
    expect(submitOptionsSchema.safeParse({ ...valid, title: "é".repeat(81) }).success).toBe(false);
  });
});

describe("parseReplicaUrls", () => {
  it("trims and dedupes", () => {
    expect(parseReplicaUrls(" http://a:5001 ,http://a:5001,http://b:5001")).toEqual([
      "http://a:5001",
      "http://b:5001",
    ]);
  });

  it("refuses more than 8 replicas", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `http://n${i}:5001`).join(",");
    expect(() => parseReplicaUrls(nine)).toThrow(/at most 8/);
  });
});

describe("assertDistinctPeers", () => {
  it("accepts URLs that resolve to distinct PeerIDs", () => {
    expect(() =>
      assertDistinctPeers(
        ["http://a:5001", "http://b:5001"],
        [{ peerId: "12D3KooWA" }, { peerId: "12D3KooWB" }],
      ),
    ).not.toThrow();
  });

  it("refuses two URLs that resolve to the same PeerID, naming both", () => {
    const attempt = () =>
      assertDistinctPeers(
        ["http://a:5001", "http://127.0.0.1:5001", "http://localhost:5001"],
        [{ peerId: "12D3KooWA" }, { peerId: "12D3KooWB" }, { peerId: "12D3KooWB" }],
      );
    expect(attempt).toThrow(CliError);
    expect(attempt).toThrow(/http:\/\/127\.0\.0\.1:5001 and http:\/\/localhost:5001.*12D3KooWB/);
  });
});

const FILM_PDA = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const OTHER = address("SysvarRent111111111111111111111111111111111");
const signer = createNoopSigner(FAKE_SUBMITTER);
const CID = new Uint8Array(64).fill(7);
const peer = (n: number) => {
  const bytes = new Uint8Array(38);
  bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  bytes.fill(n, 6);
  return { peerId: `peer-${n}`, bytes };
};
const PEERS = [peer(1), peer(2)];

function submission(overrides: Partial<FilmSubmission> = {}): FilmSubmission {
  return {
    filmPda: FILM_PDA,
    cid: CID,
    cidLen: 36,
    byteSize: 1234n,
    chunkingProfile: 1,
    title: "A Trip to the Moon",
    peers: PEERS,
    registerInstruction: () =>
      getRegisterFilmInstruction({
        submitter: signer,
        organization: FAKE_ORG,
        membership: OTHER,
        film: FILM_PDA,
        eventAuthority: OTHER,
        program: FILM_PROGRAM_ADDRESS,
        cid: CID,
        cidLen: 36,
        byteSize: 1234n,
        chunkingProfile: 1,
        title: overrides.title ?? "A Trip to the Moon",
      }),
    declareInstruction: (peerId) => declare(peerId),
    history: { attempts: 1, delayMs: 0 },
    ...overrides,
  };
}

function declare(peerId: Uint8Array, film: Address = FILM_PDA) {
  return getDeclareReplicaInstruction({
    authority: signer,
    organization: FAKE_ORG,
    membership: OTHER,
    film,
    eventAuthority: OTHER,
    program: FILM_PROGRAM_ADDRESS,
    peerId,
    peerIdLen: peerId.length,
  });
}

describe("ensureFilmOnChain", () => {
  it("registers and declares every replica on a fresh Film, with the sent signatures", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    const result = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([
      FilmInstruction.RegisterFilm,
      FilmInstruction.DeclareReplica,
      FilmInstruction.DeclareReplica,
    ]);
    const [register, ...declares] = chain.txs.map((tx) => tx.signature);
    expect(result.registerSignature).toBe(register);
    expect(result.replicaSignatures).toEqual(declares);
    expect(result.film.replicaCount).toBe(2);
  });

  it("resumes after register_film: skips it and declares the replicas", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    chain.failOn = (kind) => kind === FilmInstruction.DeclareReplica;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow("injected failure");
    const register = chain.txs[0]!.signature;

    chain.failOn = undefined;
    chain.sent = [];
    const result = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([FilmInstruction.DeclareReplica, FilmInstruction.DeclareReplica]);
    expect(result.registerSignature).toBe(register);
    expect(result.replicaSignatures).toEqual(chain.txs.slice(1).map((tx) => tx.signature));
  });

  it("declares only the PeerIDs that are not already active", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    let declared = 0;
    chain.failOn = (kind) => kind === FilmInstruction.DeclareReplica && ++declared === 2;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow("injected failure");

    chain.failOn = undefined;
    chain.sent = [];
    const result = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([FilmInstruction.DeclareReplica]);
    expect(result.replicaSignatures).toEqual([chain.txs[1]!.signature, chain.txs[2]!.signature]);
  });

  it("sends nothing when the Film is complete, and prints the same signatures again", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    const first = await ensureFilmOnChain(chain, submission());
    chain.sent = [];
    const second = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([]);
    expect(second).toEqual(first);
  });

  it("reactivates an inactive replica and records the reactivating signature", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    const first = await ensureFilmOnChain(chain, submission());
    chain.deactivate(0);
    chain.sent = [];
    const second = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([FilmInstruction.DeclareReplica]);
    expect(second.replicaSignatures).toEqual([chain.txs[3]!.signature, first.replicaSignatures[1]]);
  });

  it("refuses a Film that exists with a different CID, sending nothing", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.film = { ...chain.film!, cid: new Uint8Array(64).fill(9) };
    chain.sent = [];
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow(
      /already exists with a different CID/,
    );
    await expect(ensureFilmOnChain(chain, submission())).rejects.toBeInstanceOf(CliError);
    expect(chain.sent).toEqual([]);
  });

  it("refuses to resume under a different title", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.sent = [];
    await expect(ensureFilmOnChain(chain, submission({ title: "Other" }))).rejects.toThrow(
      /title "A Trip to the Moon"/,
    );
    expect(chain.sent).toEqual([]);
  });

  it("fails rather than print an empty register_signature", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.hideFromHistory.add(chain.txs[0]!.signature);
    const attempt = ensureFilmOnChain(chain, submission());
    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow(
      /register_film in the history of Film/,
    );
  });

  it("fails rather than print a missing replica signature", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.hideFromHistory.add(chain.txs[2]!.signature);
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow(
      /declare_replica for PeerID 0024080112200202/,
    );
  });

  it("retries the history read before giving up", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    const hidden = chain.txs[0]!.signature;
    chain.hideFromHistory.add(hidden);
    setTimeout(() => chain.hideFromHistory.delete(hidden), 5);
    const result = await ensureFilmOnChain(
      chain,
      submission({ history: { attempts: 20, delayMs: 2 } }),
    );
    expect(result.registerSignature).toBe(hidden);
  });

  it("ignores failed transactions and undecodable film instructions in the history", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    const first = await ensureFilmOnChain(chain, submission());
    chain.record(declare(PEERS[0]!.bytes), { InstructionError: [0, { Custom: 6010 }] });
    chain.record({
      programAddress: FILM_PROGRAM_ADDRESS,
      accounts: [{ address: FILM_PDA, role: AccountRole.READONLY }],
      data: new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, 1, 2, 3]),
    });
    expect(await ensureFilmOnChain(chain, submission())).toEqual(first);
  });

  it("matches a declare_replica reached through CPI", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.deactivate(1);
    const instruction = declare(PEERS[1]!.bytes);
    chain.apply(instruction);
    const viaCpi = chain.record(instruction, null, true);
    const result = await ensureFilmOnChain(chain, submission());
    expect(result.replicaSignatures[1]).toBe(viaCpi);
  });

  it("fails closed when getTransaction returns null for the newest declare of a reactivated replica", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    const first = await ensureFilmOnChain(chain, submission());
    chain.deactivate(0);
    await ensureFilmOnChain(chain, submission());
    const reactivation = chain.txs[3]!.signature;
    chain.nullTransactions.add(reactivation);
    chain.getTransactionCalls = 0;
    const attempt = ensureFilmOnChain(chain, submission({ history: { attempts: 3, delayMs: 0 } }));
    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toThrow(new RegExp(`${reactivation}.*not returned`));
    expect(chain.getTransactionCalls).toBe(3 * 4);
    await expect(attempt).rejects.toThrow(
      new RegExp(
        `newest is ${first.replicaSignatures[0]} with blockTime \\d+, but the slot's declared_at`,
      ),
    );
  });

  it("fails when the chosen declare's blockTime differs from the slot's declaredAt", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.txs[1]!.blockTime = 1;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow(
      /declare_replica for PeerID 0024080112200101.*blockTime 1.*declared_at/,
    );
  });

  it("fails when the chosen declare has no blockTime", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.txs[2]!.blockTime = null;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toBeInstanceOf(CliError);
  });

  it("resumes without resending a transaction that landed but was not confirmed", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    chain.landThenThrow = (kind) => kind === FilmInstruction.RegisterFilm;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow("confirmation timed out");
    chain.landThenThrow = (kind) => kind === FilmInstruction.DeclareReplica;
    await expect(ensureFilmOnChain(chain, submission())).rejects.toThrow("confirmation timed out");
    expect(chain.sent).toEqual([FilmInstruction.RegisterFilm, FilmInstruction.DeclareReplica]);

    chain.landThenThrow = undefined;
    chain.sent = [];
    const result = await ensureFilmOnChain(chain, submission());
    expect(chain.sent).toEqual([FilmInstruction.DeclareReplica]);
    const [register, ...declares] = chain.txs.map((tx) => tx.signature);
    expect(result.registerSignature).toBe(register);
    expect(result.replicaSignatures).toEqual(declares);
  });

  it("refuses to resume with a different chunking profile", async () => {
    const chain = new FakeFilmChain(FILM_PDA);
    await ensureFilmOnChain(chain, submission());
    chain.sent = [];
    await expect(ensureFilmOnChain(chain, submission({ chunkingProfile: 2 }))).rejects.toThrow(
      /chunking_profile 1/,
    );
    expect(chain.sent).toEqual([]);
  });
});
