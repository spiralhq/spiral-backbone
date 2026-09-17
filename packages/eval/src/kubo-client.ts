import { create } from "kubo-rpc-client";
import type { CID } from "multiformats/cid";

/** Submits `content` to the Kubo node at `apiUrl` using the Spiral Chunking Profile v1 flags. */
export async function addWithSpiralProfile(apiUrl: string, content: Uint8Array): Promise<CID> {
  const client = create({ url: apiUrl });
  const result = await client.add(content, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: "size-262144",
    trickle: false,
    pin: true,
  });
  return result.cid;
}
