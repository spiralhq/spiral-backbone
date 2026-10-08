import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { judge } from "./outcome";
import { sendRawSkipPreflight, type SolanaRpc } from "./raw-send";
import { H3_SCENARIOS, REFUSING_PROGRAM_ADDRESS } from "./scenarios";

const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const LAST_VALID = 100n;

interface FakeOptions {
  sendError?: Error;
  tx?: { meta: { err: unknown; logMessages: string[] } } | null;
  blockHeight?: bigint;
}

function fakeRpc(options: FakeOptions) {
  const calls = { send: 0 };
  const rpc = {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID },
      }),
    }),
    sendTransaction: () => ({
      send: async () => {
        calls.send++;
        if (options.sendError) throw options.sendError;
        return "sig";
      },
    }),
    getTransaction: () => ({ send: async () => options.tx ?? null }),
    getBlockHeight: () => ({ send: async () => options.blockHeight ?? 0n }),
  } as unknown as SolanaRpc;
  return { rpc, calls };
}

const instruction: Instruction = {
  programAddress: "11111111111111111111111111111111" as Instruction["programAddress"],
};
const reader = H3_SCENARIOS.find((s) => s.key === "reader-role")!;
const fast = { pollMs: 1, timeoutMs: 1_000 };

describe("sendRawSkipPreflight", () => {
  it("throws on a transport error from sendTransaction", async () => {
    const payer = await generateKeyPairSigner();
    const { rpc } = fakeRpc({ sendError: new Error("429 Too Many Requests") });
    await expect(sendRawSkipPreflight(rpc, payer, instruction, fast)).rejects.toThrow(/429/);
  });

  it("throws when the blockhash expires before the transaction lands", async () => {
    const payer = await generateKeyPairSigner();
    const { rpc } = fakeRpc({ tx: null, blockHeight: LAST_VALID + 1n });
    await expect(sendRawSkipPreflight(rpc, payer, instruction, fast)).rejects.toThrow(
      /expired without landing/,
    );
  });

  it("returns a landed transaction that failed with the expected program error", async () => {
    const payer = await generateKeyPairSigner();
    const err = { InstructionError: [0, { Custom: 6002 }] };
    const logMessages = [
      `Program ${REFUSING_PROGRAM_ADDRESS.organization} failed: custom program error: 0x1772`,
    ];
    const { rpc } = fakeRpc({ tx: { meta: { err, logMessages } } });
    const result = await sendRawSkipPreflight(rpc, payer, instruction, fast);
    expect(judge(reader, result).outcome).toBe("success");
  });

  it("records a failure when an unauthorized registration landed and succeeded", async () => {
    const payer = await generateKeyPairSigner();
    const { rpc } = fakeRpc({ tx: { meta: { err: null, logMessages: [] } } });
    const result = await sendRawSkipPreflight(rpc, payer, instruction, fast);
    expect(judge(reader, result)).toMatchObject({
      outcome: "failure",
      reason: expect.stringMatching(/accepted/),
    });
  });
});
