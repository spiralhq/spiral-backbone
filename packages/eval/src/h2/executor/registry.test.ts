import { SolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { isTransientRegistryError, readFilm } from "./registry";

const http = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: "x",
    statusCode,
  });
const noSleep = async () => {};

describe("isTransientRegistryError", () => {
  it("retries 429, 5xx and network errors, not other 4xx", () => {
    expect(isTransientRegistryError(http(429))).toBe(true);
    expect(isTransientRegistryError(http(503))).toBe(true);
    expect(isTransientRegistryError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientRegistryError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTransientRegistryError(http(401))).toBe(false);
    expect(isTransientRegistryError(new Error("Account not found"))).toBe(false);
  });
});

describe("readFilm", () => {
  it("recovers after transient failures and counts the attempts", async () => {
    let calls = 0;
    const result = await readFilm(
      async () => {
        calls++;
        if (calls < 3) throw http(calls === 1 ? 429 : 503);
        return "film";
      },
      { sleep: noSleep },
    );
    expect(result).toEqual({ value: "film", attempts: 3 });
  });

  it("rethrows a non-transient error immediately", async () => {
    let calls = 0;
    await expect(
      readFilm(
        async () => {
          calls++;
          throw http(401);
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rethrows the last error once retries are exhausted", async () => {
    let calls = 0;
    await expect(
      readFilm(
        async () => {
          calls++;
          throw http(503);
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("backs off exponentially", async () => {
    const waits: number[] = [];
    let calls = 0;
    await readFilm(
      async () => {
        if (++calls < 4) throw http(500);
        return 1;
      },
      { baseDelayMs: 100, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([100, 200, 400]);
  });

  it("passes a per-call abort signal", async () => {
    let seen: AbortSignal | undefined;
    await readFilm(async (signal) => {
      seen = signal;
      return 1;
    });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
