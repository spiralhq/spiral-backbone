import { describe, expect, it } from "vitest";
import { fetchOptionsSchema } from "./index";

describe("fetch command options", () => {
  it("accepts a well-formed set of options with defaults applied", () => {
    const result = fetchOptionsSchema.safeParse({
      film: "CEqq9LkKoai1wLMnJS8mf1bFQcABd1qCzg3V76dcdgmR",
      out: "/tmp/spiral-fetch",
      method: "direct",
      cluster: "devnet",
      gatewayUrl: "https://ipfs.io",
      kuboUrl: "http://127.0.0.1:5001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a method other than direct/gateway", () => {
    const result = fetchOptionsSchema.safeParse({
      film: "CEqq9LkKoai1wLMnJS8mf1bFQcABd1qCzg3V76dcdgmR",
      out: "/tmp/spiral-fetch",
      method: "bittorrent",
      cluster: "devnet",
      gatewayUrl: "https://ipfs.io",
      kuboUrl: "http://127.0.0.1:5001",
    });
    expect(result.success).toBe(false);
  });
});
