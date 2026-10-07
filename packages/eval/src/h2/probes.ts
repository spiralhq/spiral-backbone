import { create } from "kubo-rpc-client";

export async function pingPeer(
  apiUrl: string,
  peerId: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    for await (const result of create({ url: apiUrl }).ping(peerId, {
      count: 1,
      signal: AbortSignal.timeout(timeoutMs),
    })) {
      if (!result.success) return false;
      if (result.time > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function findProviderIds(
  apiUrl: string,
  cid: string,
  timeoutMs: number,
  numProviders = 20,
): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    for await (const event of create({ url: apiUrl }).routing.findProvs(cid, {
      numProviders,
      signal: AbortSignal.timeout(timeoutMs),
    })) {
      if (event.name === "PROVIDER") {
        for (const provider of event.providers) found.add(provider.id.toString());
      }
    }
  } catch {
    // The timeout ends the search; whatever was found so far is the answer.
  }
  return found;
}

export async function assertNetworkNodeAlive(apiUrl: string, timeoutMs: number): Promise<void> {
  try {
    await create({ url: apiUrl }).id({ signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`network node API unreachable (${new URL(apiUrl).host}): ${message}`);
  }
}
