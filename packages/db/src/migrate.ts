import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./index";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Journal lives in `public` so DROP SCHEMA public wipes it too — see docs/indexer.md. */
export async function migrateCatalog(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: "public" });
}

export async function resetCatalog(db: Database): Promise<void> {
  await db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await migrateCatalog(db);
}
