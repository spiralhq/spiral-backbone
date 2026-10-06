import { createReadStream } from "node:fs";
import { BlackHoleBlockstore, MemoryBlockstore } from "blockstore-core";
import { importer, type ImportCandidate } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import type { CID } from "multiformats/cid";

const CHUNK_SIZE_BYTES = 262_144;
const MAX_LINKS_PER_NODE = 174;

export type { CID };

function profileOptions() {
  return {
    cidVersion: 1 as const,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE_BYTES }),
    layout: balanced({ maxChildrenPerNode: MAX_LINKS_PER_NODE }),
  };
}

async function rootCid(
  candidate: ImportCandidate,
  blockstore: MemoryBlockstore | BlackHoleBlockstore,
): Promise<CID> {
  let root: CID | undefined;
  for await (const entry of importer([candidate], blockstore, profileOptions())) {
    root = entry.cid;
  }
  if (!root) {
    throw new Error("importer produced no entries for the given content");
  }
  return root;
}

export async function computeSpiralCid(content: Uint8Array): Promise<CID> {
  return rootCid({ content }, new MemoryBlockstore());
}

export async function computeSpiralCidFromFile(path: string): Promise<CID> {
  return rootCid({ content: createReadStream(path) }, new BlackHoleBlockstore());
}
