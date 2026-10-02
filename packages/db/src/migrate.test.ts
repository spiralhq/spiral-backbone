import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  filmReplicas,
  films,
  memberships,
  migrateCatalog,
  organizations,
  resetCatalog,
  syncCursor,
  type Database,
} from "./index";
import { startPostgresContainer, type PostgresContainer } from "./testing/postgres";

const CATALOG_TABLES = [organizations, memberships, films, filmReplicas, syncCursor];

describe("catalog migrations", () => {
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

  beforeEach(async () => {
    await resetCatalog(db);
  });

  it("creates every table with exactly the columns the Drizzle schema declares", async () => {
    for (const table of CATALOG_TABLES) {
      const config = getTableConfig(table);
      const result = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${config.name}`,
      );
      expect(result.rows.map((row) => row.column_name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
    }
  });

  it("recreates the tables after DROP SCHEMA public CASCADE and keeps no journal outside public", async () => {
    await db.insert(organizations).values({
      address: "org-a",
      authority: "auth",
      slug: "a",
      name: "A",
      createdAt: 1n,
      memberCount: 1,
      schemaVersion: 1,
      bump: 255,
    });

    await db.execute(sql.raw("DROP SCHEMA public CASCADE"));
    await migrateCatalog(db);

    expect(await db.$count(organizations)).toBe(0);
    const drizzleSchema = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from pg_namespace where nspname = 'drizzle'`,
    );
    expect(drizzleSchema.rows[0]?.n).toBe("0");
  });

  it("round-trips 64-bit integers, bytes and UTF-8 text exactly", async () => {
    await db.insert(organizations).values({
      address: "org-a",
      authority: "auth",
      slug: "a",
      name: "Acervo — São Paulo",
      createdAt: -1n,
      memberCount: 4_294_967_295,
      schemaVersion: 1,
      bump: 255,
    });
    await db.insert(films).values({
      address: "film-a",
      organization: "org-a",
      submitter: "sub",
      cid: new Uint8Array([0x01, 0x70, 0x12, 0x20, 0xff]),
      cidLen: 5,
      byteSize: 9_223_372_036_854_775_807n,
      chunkingProfile: 1,
      title: "Limite — ação 🎬",
      submittedAt: 1_790_127_735n,
      accessPolicy: "OrganizationOnly",
      replicaCount: 0,
      schemaVersion: 1,
      bump: 252,
    });

    const [org] = await db.select().from(organizations);
    const [film] = await db.select().from(films);
    expect(org?.memberCount).toBe(4_294_967_295);
    expect(org?.createdAt).toBe(-1n);
    expect(film?.byteSize).toBe(9_223_372_036_854_775_807n);
    expect(film?.cid).toEqual(new Uint8Array([0x01, 0x70, 0x12, 0x20, 0xff]));
    expect(film?.title).toBe("Limite — ação 🎬");
    expect(film?.indexedAt).toBeInstanceOf(Date);
  });
});
