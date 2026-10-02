import { z } from "zod";
import { describe, expect, it } from "vitest";
import { resolveBackfillOptions } from "./backfill";

const DB = "postgres://postgres:pw@127.0.0.1:5432/postgres";

describe("resolveBackfillOptions", () => {
  it("prefers flags over environment variables", () => {
    const options = resolveBackfillOptions(
      { rpcUrl: "https://flag.example.com", databaseUrl: DB, reset: true },
      { SPIRAL_RPC_URL: "https://env.example.com", DATABASE_URL: "postgres://env" },
    );
    expect(options).toEqual({
      rpcUrl: "https://flag.example.com",
      databaseUrl: DB,
      reset: true,
      report: undefined,
      warnings: [],
    });
  });

  it("falls back to SPIRAL_RPC_URL and DATABASE_URL", () => {
    const options = resolveBackfillOptions(
      {},
      { SPIRAL_RPC_URL: "https://env.example.com", DATABASE_URL: DB },
    );
    expect(options.rpcUrl).toBe("https://env.example.com");
    expect(options.databaseUrl).toBe(DB);
    expect(options.reset).toBe(false);
  });

  it("fails with a clear message when no RPC URL is given", () => {
    expect(() => resolveBackfillOptions({ databaseUrl: DB }, {})).toThrow(
      "--rpc-url (or SPIRAL_RPC_URL) is required",
    );
  });

  it("fails with a clear message when no database URL is given", () => {
    expect(() => resolveBackfillOptions({ rpcUrl: "https://x.example.com" }, {})).toThrow(
      "--database-url (or DATABASE_URL) is required",
    );
  });

  it("rejects a malformed RPC URL", () => {
    expect(() => resolveBackfillOptions({ rpcUrl: "not a url", databaseUrl: DB }, {})).toThrow(
      "--rpc-url",
    );
  });

  it("rejects a non-http(s) RPC URL without echoing it", () => {
    const secret = "ftp://x.example.com/?api-key=SECRET-KEY-123";
    expect(z.url().safeParse(secret).success).toBe(true);
    let message = "";
    try {
      resolveBackfillOptions({ rpcUrl: secret, databaseUrl: DB }, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("--rpc-url is not a valid http(s) URL");
    expect(message).not.toContain("SECRET-KEY-123");
  });

  it("does not echo a malformed RPC URL, which may embed an API key", () => {
    const secret = "not a url?api-key=SECRET-KEY-123";
    expect(z.url().safeParse(secret).success).toBe(false);
    let message = "";
    try {
      resolveBackfillOptions({ rpcUrl: secret, databaseUrl: DB }, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("--rpc-url");
    expect(message).not.toContain("SECRET-KEY-123");
  });

  it("warns when pointed at the rate-limited public Devnet endpoint", () => {
    const options = resolveBackfillOptions(
      { rpcUrl: "https://api.devnet.solana.com", databaseUrl: DB },
      {},
    );
    expect(options.warnings).toHaveLength(1);
    expect(options.warnings[0]).toContain("public Devnet");
  });
});
