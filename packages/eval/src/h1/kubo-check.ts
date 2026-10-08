import { describeEndpoint } from "@spiral-backbone/protocol";
import { create } from "kubo-rpc-client";

export async function assertKuboReachable(kuboUrl: string, timeoutMs = 10_000): Promise<void> {
  try {
    await create({ url: kuboUrl }).id({ signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(
      `Kubo API unreachable at ${describeEndpoint(kuboUrl).host} — is the tunnel open?`,
    );
  }
}
