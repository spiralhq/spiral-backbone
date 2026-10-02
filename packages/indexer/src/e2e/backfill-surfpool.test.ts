import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createSolanaRpc, lamports } from "@solana/kit";
import { surfpool } from "@solana/surfpool/kit";
import {
  createDb,
  films,
  migrateCatalog,
  organizations,
  type CatalogSnapshot,
  type Database,
} from "@spiral-backbone/db";
import {
  startPostgresContainer,
  type PostgresContainer,
} from "@spiral-backbone/db/testing/postgres";
import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfill } from "../backfill";
import { readCatalog } from "../catalog-store";
import { snapshotFromChain } from "../chain";
import { createIndexerRpc } from "../rpc";
import { diffSnapshots } from "../snapshot";
import { buildExpectedSnapshot, createFixtureClient, seedCatalog } from "./fixture";

const SPIRAL_PROGRAMS_DEPLOY_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "spiral-programs",
  "target",
  "deploy",
);

/** See docs/solana-kit-notes.md#testing-against-surfpool. */
function checkPrerequisites(): string | undefined {
  const missing = ["organization.so", "film.so"].filter(
    (name) => !existsSync(join(SPIRAL_PROGRAMS_DEPLOY_DIR, name)),
  );
  if (missing.length > 0) {
    return `spiral-programs build artifacts not found in ${SPIRAL_PROGRAMS_DEPLOY_DIR} (missing: ${missing.join(", ")}).`;
  }
  try {
    execFileSync("solana-keygen", ["--version"], { stdio: "ignore" });
  } catch {
    return "solana-keygen not found on PATH.";
  }
  return undefined;
}

const skipReason = checkPrerequisites();
if (skipReason) {
  if (process.env["SPIRAL_E2E"] === "required") {
    throw new Error(`[e2e] SPIRAL_E2E=required but a prerequisite is missing: ${skipReason}`);
  }
  console.warn(`[e2e] Skipping backfill acceptance test: ${skipReason}`);
}

describe.skipIf(skipReason !== undefined)("backfill on Surfpool (H4 in miniature)", () => {
  let surfnet: Awaited<ReturnType<typeof createSurfnetClient>>;
  let pg: PostgresContainer;
  let db: Database;
  let workDir: string;
  let expected: CatalogSnapshot;

  beforeAll(async () => {
    surfnet = await createSurfnetClient();
    surfnet.surfnet.deploy({
      programId: ORGANIZATION_PROGRAM_ADDRESS,
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "organization.so"),
    });
    surfnet.surfnet.deploy({
      programId: FILM_PROGRAM_ADDRESS,
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "film.so"),
    });

    pg = await startPostgresContainer();
    db = createDb({ DATABASE_URL: pg.url });

    workDir = mkdtempSync(join(tmpdir(), "spiral-indexer-e2e-"));
    const keypairPath = join(workDir, "payer.json");
    execFileSync("solana-keygen", [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      keypairPath,
    ]);
    const client = await createFixtureClient(keypairPath, surfnet.rpcUrl, surfnet.wsUrl);
    await surfnet.airdrop(client.payer.address, lamports(10_000_000_000n));

    const seeded = await seedCatalog(client);
    expected = await buildExpectedSnapshot(
      createSolanaRpc(surfnet.rpcUrl),
      seeded,
      client.payer.address,
    );
  }, 180_000);

  afterAll(async () => {
    if (surfnet) {
      try {
        surfnet.surfnet.stop();
      } catch (err) {
        console.error("[e2e] Failed to stop surfnet:", err);
      }
    }
    await db?.$client.end().catch(() => {});
    await pg?.stop().catch((err) => console.error("[e2e] Failed to stop postgres:", err));
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("DROP SCHEMA public CASCADE, then backfill, rebuilds every table exactly", async () => {
    await migrateCatalog(db);
    await db.execute(sql.raw("DROP SCHEMA public CASCADE"));

    const report = await backfill({ db, rpcUrl: surfnet.rpcUrl, reset: false });

    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([]);
    expect(report.counts).toEqual({ organizations: 2, memberships: 5, films: 3, film_replicas: 4 });
    expect(Object.keys(report.rpc_calls).sort()).toEqual([
      "getMultipleAccounts",
      "getProgramAccounts",
    ]);
    expect(report.rpc_calls["getProgramAccounts"]).toBe(3);
  }, 60_000);

  it("the rebuilt catalog matches a fresh read of the on-chain accounts field by field", async () => {
    await backfill({ db, rpcUrl: surfnet.rpcUrl, reset: true });
    const { rpc } = createIndexerRpc(surfnet.rpcUrl);
    expect(diffSnapshots(await snapshotFromChain(rpc), await readCatalog(db))).toEqual([]);
  }, 60_000);

  it("--reset discards rows with no on-chain origin", async () => {
    await migrateCatalog(db);
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
    await backfill({ db, rpcUrl: surfnet.rpcUrl, reset: true });
    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([]);
  }, 60_000);

  it("the diff is not vacuous: a tampered row is reported", async () => {
    await backfill({ db, rpcUrl: surfnet.rpcUrl, reset: true });
    const target = expected.films[0]!;
    await db.update(films).set({ title: "tampered" }).where(eq(films.address, target.address));
    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([
      {
        table: "films",
        key: target.address,
        kind: "field",
        field: "title",
        expected: JSON.stringify(target.title),
        actual: '"tampered"',
      },
    ]);
  }, 60_000);
});

function createSurfnetClient() {
  return createClient().use(surfpool({ surfnet: { offline: true } }));
}
