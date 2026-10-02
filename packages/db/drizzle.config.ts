import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

export default defineConfig({
  schema: "./src/schema",
  out: "./src/migrations",
  dialect: "postgresql",
  migrations: {
    schema: "public",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
