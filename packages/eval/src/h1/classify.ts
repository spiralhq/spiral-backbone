import {
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import type { FailureClass } from "@spiral-backbone/protocol";
import { RetrievalError } from "./retrieve";

export function classifyWorkError(error: unknown): FailureClass | null {
  if (error instanceof RetrievalError) return error.failureClass;
  if (isSolanaError(error, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND)) return "object_unavailable";
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = error.context.statusCode;
    return status === 429 || status >= 500 ? "connection_error" : null;
  }
  return null;
}
