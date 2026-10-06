import { createHash } from "node:crypto";

export function describeEndpoint(url: string): { host: string; fingerprint: string } {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return { host: new URL(url).host, fingerprint: `sha256:${digest}` };
}
