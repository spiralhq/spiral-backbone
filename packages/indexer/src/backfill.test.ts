import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from "@solana/kit";
import { createDb, organizations, resetCatalog, type Database } from "@spiral-backbone/db";
import {
  startPostgresContainer,
  type PostgresContainer,
} from "@spiral-backbone/db/testing/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfill, BackfillError } from "./backfill";
import { readCatalog } from "./catalog-store";
import { diffSnapshots } from "./snapshot";
import { createFakeChainTransport, sampleChain } from "./testing/fake-chain";

const SECRET_URL = "https://devnet.helius-rpc.com/?api-key=SECRET-KEY-123";

describe("backfill", () => {
  let pg: PostgresContainer;
  let db: Database;

  beforeAll(async () => {
    pg = await startPostgresContainer();
    db = createDb({ DATABASE_URL: pg.url });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await pg?.stop();
  });

  it("rebuilds the catalog and reports counts, RPC usage and a redacted endpoint", async () => {
    const { accounts, expected } = sampleChain();
    const { transport } = createFakeChainTransport(accounts);

    const report = await backfill({
      db,
      rpcUrl: SECRET_URL,
      reset: true,
      rpcOptions: { transport },
    });

    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([]);
    expect(report.status).toBe("succeeded");
    expect(report).not.toHaveProperty("error");
    expect(report.counts).toEqual({ organizations: 1, memberships: 2, films: 1, film_replicas: 2 });
    expect(report.rpc_calls).toEqual({ getProgramAccounts: 3, getMultipleAccounts: 3 });
    expect(report.rpc_calls_total).toBe(6);
    expect(report.rate_limit_retries).toBe(0);
    expect(report.rpc_endpoint).toBe("devnet.helius-rpc.com");
    expect(JSON.stringify(report)).not.toContain("SECRET-KEY-123");
    expect(report.reset).toBe(true);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("with --reset, drops rows that have no on-chain origin", async () => {
    await resetCatalog(db);
    await db.insert(organizations).values({
      address: "ghost-org",
      authority: "ghost",
      slug: "ghost",
      name: "Ghost",
      createdAt: 0n,
      memberCount: 0,
      schemaVersion: 1,
      bump: 1,
    });
    const { accounts, expected } = sampleChain();
    const { transport } = createFakeChainTransport(accounts);

    await backfill({ db, rpcUrl: SECRET_URL, reset: true, rpcOptions: { transport } });

    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([]);
  });

  it("on failure, throws a BackfillError carrying a failed report with endpoint and RPC stats", async () => {
    const transport: RpcTransport = async () => {
      throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(),
        message: "HTTP 429",
        statusCode: 429,
      });
    };

    const error = await backfill({
      db,
      rpcUrl: SECRET_URL,
      reset: true,
      rpcOptions: { transport, sleep: async () => {}, maxRateLimitRetries: 2 },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackfillError);
    const { report } = error as BackfillError;
    expect(report.status).toBe("failed");
    expect(report.error).toContain("429");
    expect(report.rate_limit_retries).toBe(2);
    expect(report.rpc_calls).toEqual({ getProgramAccounts: 1 });
    expect(report.rpc_calls_total).toBe(1);
    expect(report.rpc_endpoint).toBe("devnet.helius-rpc.com");
    expect(report.rpc_endpoint_fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(report.counts).toEqual({ organizations: 0, memberships: 0, films: 0, film_replicas: 0 });
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect((error as BackfillError).cause).toBeInstanceOf(SolanaError);
    expect(JSON.stringify(report)).not.toContain("SECRET-KEY-123");
    expect((error as Error).message).not.toContain("SECRET-KEY-123");
  });

  it("redacts the RPC URL from a failure message that embeds it", async () => {
    const transport: RpcTransport = async () => {
      throw new Error(`request to ${SECRET_URL} failed`);
    };

    const error = await backfill({
      db,
      rpcUrl: SECRET_URL,
      reset: true,
      rpcOptions: { transport },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackfillError);
    expect((error as Error).message).toContain("devnet.helius-rpc.com");
    expect((error as Error).message).not.toContain("SECRET-KEY-123");
    expect(JSON.stringify((error as BackfillError).report)).not.toContain("SECRET-KEY-123");
  });

  it("rejects a malformed RPC URL before touching the database", async () => {
    await resetCatalog(db);
    await db.insert(organizations).values({
      address: "kept-org",
      authority: "kept",
      slug: "kept",
      name: "Kept",
      createdAt: 0n,
      memberCount: 0,
      schemaVersion: 1,
      bump: 1,
    });

    await expect(backfill({ db, rpcUrl: "not a url", reset: true })).rejects.toThrow();

    const catalog = await readCatalog(db);
    expect(catalog.organizations.map((org) => org.address)).toEqual(["kept-org"]);
  });
});
