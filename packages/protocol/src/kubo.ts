import { create } from "kubo-rpc-client";
import { CID } from "multiformats/cid";

/** Uploads `content` to every node in `nodeUrls` independently, using the Spiral Chunking
 * Profile v1 flags. Deliberately reimplemented rather than imported from packages/eval —
 * that package is evaluation-only tooling and protocol is upstream of it. */
export async function submitToNodes(
  nodeUrls: string[],
  content: Uint8Array,
): Promise<Map<string, CID>> {
  const results = new Map<string, CID>();
  for (const nodeUrl of nodeUrls) {
    const client = create({ url: nodeUrl });
    const result = await client.add(content, {
      cidVersion: 1,
      rawLeaves: true,
      chunker: "size-262144",
      trickle: false,
      pin: true,
    });
    results.set(nodeUrl, result.cid);
  }
  return results;
}

/** Throws if the nodes disagree on the resulting CID — the three-way agreement check submit requires. */
export function assertNodesAgree(results: Map<string, CID>): CID {
  const cids = [...results.values()].map((cid) => cid.toString());
  const [first, ...rest] = cids;
  if (!first) throw new Error("no nodes responded");
  if (rest.some((cid) => cid !== first)) {
    const detail = [...results.entries()]
      .map(([url, cid]) => `${url}=${cid.toString()}`)
      .join(", ");
    throw new Error(`nodes disagree on the resulting CID: ${detail}`);
  }
  const [, cid] = [...results.entries()][0]!;
  return cid;
}
