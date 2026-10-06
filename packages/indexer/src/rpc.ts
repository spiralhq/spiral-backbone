export { describeEndpoint } from "@spiral-backbone/protocol";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isJsonRpcPayload,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from "@solana/kit";

export interface RpcStats {
  calls: Record<string, number>;
  rateLimitRetries: number;
}

export interface IndexerRpcOptions {
  maxRateLimitRetries?: number;
  baseDelayMs?: number;
  transport?: RpcTransport;
  sleep?: (ms: number) => Promise<void>;
}

const HTTP_TOO_MANY_REQUESTS = 429;

export function createIndexerRpc(url: string, options: IndexerRpcOptions = {}) {
  const stats: RpcStats = { calls: {}, rateLimitRetries: 0 };
  const inner = options.transport ?? createDefaultRpcTransport({ url });
  const maxRetries = options.maxRateLimitRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const transport: RpcTransport = async (config) => {
    const method = isJsonRpcPayload(config.payload) ? config.payload.method : "unknown";
    stats.calls[method] = (stats.calls[method] ?? 0) + 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(config);
      } catch (error) {
        const rateLimited =
          isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
          error.context.statusCode === HTTP_TOO_MANY_REQUESTS;
        if (!rateLimited || attempt >= maxRetries) throw error;
        stats.rateLimitRetries++;
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  };

  return { rpc: createSolanaRpcFromTransport(transport), stats };
}

export type IndexerRpc = ReturnType<typeof createIndexerRpc>["rpc"];
