import { SolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isTransientRegistryError, readFilm } from "./registry";

const http = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: "x",
    statusCode,
  });
const noSleep = async () => {};
const fetchFailed = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

async function closedPort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fetchError = (url: string) =>
  fetch(url).then(
    () => {
      throw new Error(`${url} answered`);
    },
    (error: unknown) => error,
  );

describe("isTransientRegistryError", () => {
  it("retries 429, 5xx, transient network errors and timeouts, not other 4xx", () => {
    expect(isTransientRegistryError(http(429))).toBe(true);
    expect(isTransientRegistryError(http(503))).toBe(true);
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EPIPE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ])
      expect(isTransientRegistryError(fetchFailed(code)), code).toBe(true);
    expect(isTransientRegistryError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTransientRegistryError(http(401))).toBe(false);
    expect(isTransientRegistryError(new Error("Account not found"))).toBe(false);
  });

  it("does not retry a host name that does not resolve, or any other TypeError", () => {
    expect(isTransientRegistryError(fetchFailed("ENOTFOUND"))).toBe(false);
    expect(isTransientRegistryError(new TypeError("fetch failed"))).toBe(false);
    expect(isTransientRegistryError(new TypeError("Failed to parse URL from rpc"))).toBe(false);
    expect(isTransientRegistryError(new TypeError("x is not a function"))).toBe(false);
  });

  it("retries a real refused connection and refuses a real unresolvable host", async () => {
    expect(
      isTransientRegistryError(await fetchError(`http://127.0.0.1:${await closedPort()}/`)),
    ).toBe(true);
    expect(isTransientRegistryError(await fetchError("http://no-such-host.invalid/"))).toBe(false);
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

  it("names the exhausted retries in the error", async () => {
    let calls = 0;
    await expect(
      readFilm(
        async () => {
          calls++;
          throw http(503);
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toThrow(/^registry unavailable after 3 attempts: /);
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
