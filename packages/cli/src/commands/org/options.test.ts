import { describe, expect, it } from "vitest";
import { createOptionsSchema } from "./create";
import { grantOptionsSchema } from "./grant";
import { revokeOptionsSchema } from "./revoke";

describe("org command option schemas", () => {
  it("create: rejects a slug over 32 characters", () => {
    const result = createOptionsSchema.safeParse({
      slug: "x".repeat(33),
      name: "Too Long",
      cluster: "devnet",
      keypair: "/tmp/id.json",
    });
    expect(result.success).toBe(false);
  });

  it("create: accepts only [a-z0-9-] slugs, as the program does", () => {
    const parse = (slug: string) =>
      createOptionsSchema.safeParse({
        slug,
        name: "Spiral",
        cluster: "devnet",
        keypair: "/tmp/id.json",
      }).success;
    expect(parse("h3-run1-a")).toBe(true);
    expect(parse("")).toBe(false);
    expect(parse("Spiral")).toBe(false);
    expect(parse("spiral_hq")).toBe(false);
  });

  it("create: bounds the name in UTF-8 bytes", () => {
    const parse = (name: string) =>
      createOptionsSchema.safeParse({
        slug: "spiralhq",
        name,
        cluster: "devnet",
        keypair: "/tmp/id.json",
      }).success;
    expect(parse("é".repeat(48))).toBe(true);
    expect(parse("é".repeat(49))).toBe(false);
  });

  it("grant: rejects a role outside reader/submitter/admin", () => {
    const result = grantOptionsSchema.safeParse({
      slug: "spiralhq",
      member: "11111111111111111111111111111111",
      role: "superadmin",
      cluster: "devnet",
      keypair: "/tmp/id.json",
    });
    expect(result.success).toBe(false);
  });

  it("revoke: accepts a well-formed set of options", () => {
    const result = revokeOptionsSchema.safeParse({
      slug: "spiralhq",
      member: "11111111111111111111111111111111",
      cluster: "local",
      keypair: "/tmp/id.json",
    });
    expect(result.success).toBe(true);
  });
});
