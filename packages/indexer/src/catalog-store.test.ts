import {
  createDb,
  organizations,
  resetCatalog,
  type CatalogSnapshot,
  type Database,
} from "@spiral-backbone/db";
import {
  startPostgresContainer,
  type PostgresContainer,
} from "@spiral-backbone/db/testing/postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readCatalog, writeCatalog } from "./catalog-store";
import { diffSnapshots } from "./snapshot";
import { sampleChain } from "./testing/fake-chain";

describe("catalog store", () => {
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

  it("round-trips a snapshot exactly, without indexed_at", async () => {
    const { expected } = sampleChain();
    await writeCatalog(db, expected);
    const actual = await readCatalog(db);
    expect(diffSnapshots(expected, actual)).toEqual([]);
    expect(Object.keys(actual.films[0]!)).not.toContain("indexedAt");
  });

  it("replaces previous contents instead of accumulating them", async () => {
    const { expected } = sampleChain();
    await writeCatalog(db, expected);
    const smaller: CatalogSnapshot = {
      ...expected,
      memberships: expected.memberships.slice(0, 1),
      filmReplicas: expected.filmReplicas.slice(0, 1),
    };
    await writeCatalog(db, smaller);
    await writeCatalog(db, smaller);
    expect(diffSnapshots(smaller, await readCatalog(db))).toEqual([]);
  });

  it("leaves the previous catalog intact when a write fails", async () => {
    const { expected } = sampleChain();
    await writeCatalog(db, expected);
    const orphanFilm: CatalogSnapshot = {
      ...expected,
      films: [{ ...expected.films[0]!, organization: "not-an-indexed-organization" }],
    };
    await expect(writeCatalog(db, orphanFilm)).rejects.toThrow();
    expect(diffSnapshots(expected, await readCatalog(db))).toEqual([]);
    expect(await db.$count(organizations)).toBe(1);
  });
});
