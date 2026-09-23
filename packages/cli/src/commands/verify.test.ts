import { describe, expect, it } from "vitest";
import { verifyOptionsSchema } from "./verify";

describe("verify command options", () => {
  it("accepts a well-formed set of options", () => {
    const result = verifyOptionsSchema.safeParse({
      film: "CEqq9LkKoai1wLMnJS8mf1bFQcABd1qCzg3V76dcdgmR",
      file: "/tmp/recovered.mp4",
      cluster: "devnet",
    });
    expect(result.success).toBe(true);
  });

  it("requires --film", () => {
    const result = verifyOptionsSchema.safeParse({
      file: "/tmp/recovered.mp4",
      cluster: "devnet",
    });
    expect(result.success).toBe(false);
  });
});
