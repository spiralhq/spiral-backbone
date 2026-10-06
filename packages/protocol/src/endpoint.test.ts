import { describe, expect, it } from "vitest";
import { describeEndpoint } from "./endpoint";

describe("describeEndpoint", () => {
  it("keeps the host and hides query-string API keys", () => {
    const described = describeEndpoint("https://devnet.helius-rpc.com/?api-key=SECRET-KEY-123");
    expect(described.host).toBe("devnet.helius-rpc.com");
    expect(described.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(described)).not.toContain("SECRET-KEY-123");
  });

  it("hides path tokens and distinguishes endpoints on the same host", () => {
    const a = describeEndpoint("https://x.solana-devnet.quiknode.pro/TOKENAAAA/");
    const b = describeEndpoint("https://x.solana-devnet.quiknode.pro/TOKENBBBB/");
    expect(JSON.stringify(a)).not.toContain("TOKENAAAA");
    expect(a.host).toBe(b.host);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
