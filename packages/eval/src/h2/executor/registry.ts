import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";

export function isTransientRegistryError(error: unknown): boolean {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = error.context.statusCode;
    return status === 429 || status >= 500;
  }
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function readFilm<T>(
  fetch: (signal: AbortSignal) => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ value: T; attempts: number }> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return {
        value: await fetch(AbortSignal.timeout(options.timeoutMs ?? 30_000)),
        attempts: attempt,
      };
    } catch (error) {
      if (attempt > retries || !isTransientRegistryError(error)) throw error;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
}
