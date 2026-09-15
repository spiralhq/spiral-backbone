import { type Database, createDb } from "@spiral-backbone/db";

import { env } from "./env.server";

const db = createDb(env);

export function getDb(): Database {
  return db;
}
