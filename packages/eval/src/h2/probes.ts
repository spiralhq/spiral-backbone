import { create } from "kubo-rpc-client";
import { RETRY_DELAYS_MS, withRetry } from "../../../../scripts/kubo-node-control";
import { isTransientNetworkError } from "../common/network-errors";

// Only a failure to reach the API is an API error; a Kubo error or our own timeout means the
// ping ran and got no answer.
function isApiError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

async function pingOnce(apiUrl: string, peerId: string, timeoutMs: number): Promise<boolean> {
  try {
    for await (const result of create({ url: apiUrl }).ping(peerId, {
      count: 1,
      signal: AbortSignal.timeout(timeoutMs),
    })) {
      if (!result.success) return false;
      if (result.time > 0) return true;
    }
    return false;
  } catch (error) {
    if (isApiError(error)) throw error;
    return false;
  }
}

class NoPingAnswer extends Error {}

export async function pingPeer(
  apiUrl: string,
  peerId: string,
  timeoutMs: number,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<boolean> {
  try {
    return await withRetry(
      async () => {
        if (!(await pingOnce(apiUrl, peerId, timeoutMs))) throw new NoPingAnswer();
        return true;
      },
      (error) => error instanceof NoPingAnswer || isTransientNetworkError(error),
      delaysMs,
    );
  } catch (error) {
    if (error instanceof NoPingAnswer) return false;
    throw networkNodeFault(apiUrl, error, " during ping");
  }
}

export interface ProviderEvent {
  name: string;
  providers?: { id: { toString(): string } }[];
}

export async function collectProviders(
  events: AsyncIterable<ProviderEvent>,
  want: ReadonlySet<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  const complete = () => want.size > 0 && [...want].every((id) => found.has(id));
  try {
    for await (const event of events) {
      if (event.name === "PROVIDER") {
        for (const provider of event.providers ?? []) found.add(provider.id.toString());
      }
      if (complete()) break;
    }
  } catch {
    // The timeout ends the search; whatever was found so far is the answer.
  }
  return found;
}

export async function findProviderIds(
  apiUrl: string,
  cid: string,
  timeoutMs: number,
  want: ReadonlySet<string> = new Set(),
  numProviders = 20,
): Promise<Set<string>> {
  const stop = new AbortController();
  const events = create({ url: apiUrl }).routing.findProvs(cid, {
    numProviders,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stop.signal]),
  });
  try {
    return await collectProviders(events as AsyncIterable<ProviderEvent>, want);
  } finally {
    stop.abort();
  }
}

export class NetworkNodeUnreachable extends Error {}

export async function assertNetworkNodeAlive(
  apiUrl: string,
  timeoutMs: number,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<void> {
  try {
    await withRetry(
      () => create({ url: apiUrl }).id({ signal: AbortSignal.timeout(timeoutMs) }),
      isTransientNetworkError,
      delaysMs,
    );
  } catch (error) {
    throw networkNodeFault(apiUrl, error);
  }
}

function networkNodeFault(apiUrl: string, error: unknown, during = ""): Error {
  const host = new URL(apiUrl).host;
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientNetworkError(error)) {
    return new NetworkNodeUnreachable(
      `network node API unreachable (${host})${during}: ${message}`,
      {
        cause: error,
      },
    );
  }
  return new Error(`network node API at ${host} failed${during}: ${message}`, { cause: error });
}
