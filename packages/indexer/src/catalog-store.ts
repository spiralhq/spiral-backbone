import { asc, getTableColumns } from "drizzle-orm";
import {
  filmReplicas,
  films,
  memberships,
  organizations,
  type CatalogSnapshot,
  type Database,
} from "@spiral-backbone/db";
import { sortSnapshot } from "./snapshot";

const INSERT_CHUNK_SIZE = 500;

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    result.push(rows.slice(start, start + size));
  return result;
}

function withoutIndexedAt<T extends { indexedAt: unknown }>(columns: T): Omit<T, "indexedAt"> {
  const copy: Partial<T> = { ...columns };
  delete copy.indexedAt;
  return copy as Omit<T, "indexedAt">;
}

export async function writeCatalog(db: Database, snapshot: CatalogSnapshot): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(filmReplicas);
    await tx.delete(films);
    await tx.delete(memberships);
    await tx.delete(organizations);
    for (const chunk of chunks(snapshot.organizations, INSERT_CHUNK_SIZE))
      await tx.insert(organizations).values(chunk);
    for (const chunk of chunks(snapshot.memberships, INSERT_CHUNK_SIZE))
      await tx.insert(memberships).values(chunk);
    for (const chunk of chunks(snapshot.films, INSERT_CHUNK_SIZE))
      await tx.insert(films).values(chunk);
    for (const chunk of chunks(snapshot.filmReplicas, INSERT_CHUNK_SIZE))
      await tx.insert(filmReplicas).values(chunk);
  });
}

export async function readCatalog(db: Database): Promise<CatalogSnapshot> {
  return sortSnapshot({
    organizations: await db
      .select(withoutIndexedAt(getTableColumns(organizations)))
      .from(organizations)
      .orderBy(asc(organizations.address)),
    memberships: await db
      .select(withoutIndexedAt(getTableColumns(memberships)))
      .from(memberships)
      .orderBy(asc(memberships.address)),
    films: await db
      .select(withoutIndexedAt(getTableColumns(films)))
      .from(films)
      .orderBy(asc(films.address)),
    filmReplicas: await db
      .select(withoutIndexedAt(getTableColumns(filmReplicas)))
      .from(filmReplicas)
      .orderBy(asc(filmReplicas.film), asc(filmReplicas.slot)),
  });
}
