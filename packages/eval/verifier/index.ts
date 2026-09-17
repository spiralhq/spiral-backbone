import { MemoryBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import type { CID } from "multiformats/cid";

const CHUNK_SIZE_BYTES = 262_144;
const MAX_LINKS_PER_NODE = 174;

export type { CID };

export async function computeSpiralCid(content: Uint8Array): Promise<CID> {
  const blockstore = new MemoryBlockstore();
  let rootCid: CID | undefined;

  for await (const entry of importer([{ content }], blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE_BYTES }),
    layout: balanced({ maxChildrenPerNode: MAX_LINKS_PER_NODE }),
  })) {
    rootCid = entry.cid;
  }

  if (!rootCid) {
    throw new Error("importer produced no entries for the given content");
  }
  return rootCid;
}
