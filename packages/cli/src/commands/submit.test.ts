import { describe, expect, it } from "vitest";
import { submitOptionsSchema } from "./submit";

describe("submit command options", () => {
  it("accepts a well-formed set of options", () => {
    const result = submitOptionsSchema.safeParse({
      org: "spiralhq",
      file: "/tmp/film.mp4",
      title: "A Trip to the Moon",
      replicas: "http://node-a:5001,http://node-b:5001,http://node-c:5001",
      cluster: "devnet",
      keypair: "/tmp/id.json",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a title over 160 characters", () => {
    const result = submitOptionsSchema.safeParse({
      org: "spiralhq",
      file: "/tmp/film.mp4",
      title: "x".repeat(161),
      replicas: "http://node-a:5001",
      cluster: "devnet",
      keypair: "/tmp/id.json",
    });
    expect(result.success).toBe(false);
  });
});
