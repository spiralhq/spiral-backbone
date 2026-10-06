import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { RawSendResult } from "./outcome";

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

export async function sendRawSkipPreflight(
  rpc: SolanaRpc,
  feePayer: TransactionSigner,
  instruction: Instruction,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RawSendResult> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(transaction), {
        encoding: "base64",
        skipPreflight: true,
      })
      .send();
  } catch (error) {
    return { signature: null, sendError: (error as Error).message, err: null, logs: [] };
  }
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const tx = await rpc
      .getTransaction(signature, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (tx) {
      return {
        signature,
        sendError: null,
        err: tx.meta?.err ?? null,
        logs: [...(tx.meta?.logMessages ?? [])],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
  }
  return { signature, sendError: "not confirmed within timeout", err: null, logs: [] };
}
