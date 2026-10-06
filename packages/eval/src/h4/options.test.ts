import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveH4Options } from "./options";

const flags = {
  golden: "g.ndjson",
  out: "o.ndjson",
  label: "run",
  rpcUrl: "http://127.0.0.1:8899",
};

afterEach(() => vi.unstubAllEnvs());

describe("resolveH4Options", () => {
  it("accepts an explicit database url", () => {
    const r = resolveH4Options({ ...flags, databaseUrl: "postgres://u:p@h/db" });
    expect(r).toMatchObject({ ok: true, options: { databaseUrl: "postgres://u:p@h/db" } });
  });

  it("ignores DATABASE_URL and demands --database-url", () => {
    vi.stubEnv("DATABASE_URL", "postgres://dev:secret@prod-host/dev");
    const r = resolveH4Options(flags);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--database-url");
    expect(r.error).not.toContain("secret");
    expect(r.error).not.toContain("prod-host");
  });

  it("never echoes the url value on other errors", () => {
    const r = resolveH4Options({ ...flags, databaseUrl: "postgres://u:hunter2@h/db", rpcUrl: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain("hunter2");
  });
});
