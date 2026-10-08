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
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      skipPreflight: true,
    })
    .send();
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let expired = false;
  while (Date.now() < deadline) {
    const tx = await fetchTransaction(rpc, signature);
    if (tx) {
      return {
        signature,
        err: tx.meta?.err ?? null,
        logs: [...(tx.meta?.logMessages ?? [])],
      };
    }
    if (expired) break;
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    expired = height > blockhash.lastValidBlockHeight;
    if (!expired) await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
  }
  throw new Error(`transaction expired without landing (${signature})`);
}

function fetchTransaction(
  rpc: SolanaRpc,
  signature: ReturnType<typeof getSignatureFromTransaction>,
) {
  return rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
}
