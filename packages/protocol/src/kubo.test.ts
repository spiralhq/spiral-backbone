import { describe, expect, it } from "vitest";
import { assertNodesAgree } from "./kubo";
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
