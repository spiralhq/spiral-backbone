import { describe, expect, it } from "vitest";
import { ED25519_PEER_ID_LENGTH, assertNodesAgree, peerIdToBytes } from "./kubo";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";

const CID_A = CID.parse("bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem");
const CID_B = CID.parse("bafkreia5pjridp4rhk7xz4crma7tbx36vbdrh5gx7d5wi6awjdy3jiqhgy");

describe("assertNodesAgree", () => {
  it("returns the shared CID when all nodes agree", () => {
    const results = new Map([
      ["http://a", CID_A],
      ["http://b", CID_A],
      ["http://c", CID_A],
    ]);
    expect(assertNodesAgree(results).toString()).toBe(CID_A.toString());
  });

  it("throws, naming every node's CID, when nodes disagree", () => {
    const results = new Map([
      ["http://a", CID_A],
      ["http://b", CID_B],
    ]);
    expect(() => assertNodesAgree(results)).toThrow(/http:\/\/a=.*http:\/\/b=/);
  });

  it("throws when no nodes responded", () => {
    expect(() => assertNodesAgree(new Map())).toThrow(/no nodes responded/);
  });
});

describe("peerIdToBytes", () => {
  it("decodes an Ed25519 PeerID into its 38-byte identity multihash", () => {
    const bytes = peerIdToBytes("12D3KooWRw8Wfm6Sv1y17kikmQfzpeZWsrAXZtGbTfg4URYfDQ6y");
    expect(bytes).toHaveLength(ED25519_PEER_ID_LENGTH);
    expect(Array.from(bytes.slice(0, 6))).toEqual([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  });

  it("refuses an RSA (sha2-256 multihash) PeerID", () => {
    expect(() => peerIdToBytes("QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N")).toThrow(
      /Ed25519/,
    );
  });

  it("refuses a 38-byte identity multihash whose key header is not Ed25519", () => {
    const valid = peerIdToBytes("12D3KooWRw8Wfm6Sv1y17kikmQfzpeZWsrAXZtGbTfg4URYfDQ6y");
    for (const [index, value] of [
      [2, 0x0a],
      [3, 0x02],
      [4, 0x0a],
      [5, 0x21],
    ] as const) {
      const forged = Uint8Array.from(valid);
      forged[index] = value;
      expect(() => peerIdToBytes(base58btc.baseEncode(forged))).toThrow(/00 24 08 01 12 20/);
    }
  });
});
