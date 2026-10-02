import {
  isJsonRpcPayload,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createIndexerRpc, describeEndpoint } from "./rpc";

function httpError(statusCode: number) {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: `HTTP ${statusCode}`,
    statusCode,
  });
}

function slotTransport(failures: number[]): RpcTransport {
  const queue = [...failures];
  return (async ({ payload }: { payload: unknown }) => {
    if (!isJsonRpcPayload(payload)) throw new Error("unexpected payload");
    const status = queue.shift();
    if (status !== undefined) throw httpError(status);
    return { jsonrpc: "2.0", id: (payload as { id?: unknown }).id, result: 123 };
  }) as unknown as RpcTransport;
}

const noSleep = async () => {};

describe("createIndexerRpc", () => {
  it("counts logical calls per method", async () => {
    const { rpc, stats } = createIndexerRpc("http://unused", {
      transport: slotTransport([]),
      sleep: noSleep,
    });
    await rpc.getSlot().send();
    await rpc.getSlot().send();
    expect(stats).toEqual({ calls: { getSlot: 2 }, rateLimitRetries: 0 });
  });

  it("retries HTTP 429 with exponential backoff and counts retries separately", async () => {
    const delays: number[] = [];
    const { rpc, stats } = createIndexerRpc("http://unused", {
      transport: slotTransport([429, 429]),
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(await rpc.getSlot().send()).toBe(123n);
    expect(delays).toEqual([100, 200]);
    expect(stats).toEqual({ calls: { getSlot: 1 }, rateLimitRetries: 2 });
  });

  it("gives up after maxRateLimitRetries and rethrows the 429", async () => {
    const { rpc, stats } = createIndexerRpc("http://unused", {
      transport: slotTransport([429, 429, 429]),
      maxRateLimitRetries: 2,
      sleep: noSleep,
    });
    await expect(rpc.getSlot().send()).rejects.toThrow("HTTP 429");
    expect(stats.rateLimitRetries).toBe(2);
  });

  it("does not retry other HTTP errors", async () => {
    const { rpc, stats } = createIndexerRpc("http://unused", {
      transport: slotTransport([500]),
      sleep: noSleep,
    });
    await expect(rpc.getSlot().send()).rejects.toThrow("HTTP 500");
    expect(stats.rateLimitRetries).toBe(0);
  });
});

describe("describeEndpoint", () => {
  it("keeps the host and hides query-string API keys", () => {
    const described = describeEndpoint("https://devnet.helius-rpc.com/?api-key=SECRET-KEY-123");
    expect(described.host).toBe("devnet.helius-rpc.com");
    expect(described.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(described)).not.toContain("SECRET-KEY-123");
  });

  it("hides path tokens and distinguishes endpoints on the same host", () => {
    const a = describeEndpoint("https://x.solana-devnet.quiknode.pro/TOKENAAAA/");
    const b = describeEndpoint("https://x.solana-devnet.quiknode.pro/TOKENBBBB/");
    expect(JSON.stringify(a)).not.toContain("TOKENAAAA");
    expect(a.host).toBe(b.host);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
