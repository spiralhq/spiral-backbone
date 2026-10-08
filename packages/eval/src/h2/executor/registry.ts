import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { isTransientNetworkError } from "../../common/network-errors";

export function isTransientRegistryError(error: unknown): boolean {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = error.context.statusCode;
    return status === 429 || status >= 500;
  }
  return isTransientNetworkError(error);
}

const REGISTRY_RETRIES = 3;
const REGISTRY_BASE_DELAY_MS = 1_000;
const REGISTRY_CALL_TIMEOUT_MS = 30_000;

export const REGISTRY_WORST_CASE_MS =
  (REGISTRY_RETRIES + 1) * REGISTRY_CALL_TIMEOUT_MS +
  REGISTRY_BASE_DELAY_MS * (2 ** REGISTRY_RETRIES - 1);

export async function readFilm<T>(
  fetch: (signal: AbortSignal) => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ value: T; attempts: number }> {
  const retries = options.retries ?? REGISTRY_RETRIES;
  const base = options.baseDelayMs ?? REGISTRY_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return {
        value: await fetch(AbortSignal.timeout(options.timeoutMs ?? REGISTRY_CALL_TIMEOUT_MS)),
        attempts: attempt,
      };
    } catch (error) {
      if (!isTransientRegistryError(error)) throw error;
      if (attempt > retries) {
        const detail = (error as Error).message.slice(0, 200);
        throw new Error(`registry unavailable after ${attempt} attempts: ${detail}`, {
          cause: error,
        });
      }
      await sleep(base * 2 ** (attempt - 1));
    }
  }
}
