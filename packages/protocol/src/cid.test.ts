import { describe, expect, it } from "vitest";
import { bytesToCidString, cidStringToBytes } from "./cid";

const EXAMPLE_CID_STRING = "bafybeiaeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypsaijcem";

function exampleCidBytes(): Uint8Array {
  const cid = new Uint8Array(64);
  cid[0] = 0x01;
  cid[1] = 0x70;
  cid[2] = 0x12;
  cid[3] = 0x20;
  for (let i = 4; i < 36; i++) cid[i] = i;
  return cid;
}

describe("CID codec", () => {
  it("converts on-chain bytes to the known base32 CIDv1 string", () => {
    expect(bytesToCidString(exampleCidBytes(), 36)).toBe(EXAMPLE_CID_STRING);
  });

  it("converts the string back to bytes matching the original 36-byte prefix", () => {
    const { cid, cidLen } = cidStringToBytes(EXAMPLE_CID_STRING);
    expect(cidLen).toBe(36);
    expect(cid.subarray(0, 36)).toEqual(exampleCidBytes().subarray(0, 36));
    expect(cid.subarray(36)).toEqual(new Uint8Array(28)); // zero-padded tail
  });

  it("round-trips: bytes -> string -> bytes is lossless", () => {
    const original = exampleCidBytes();
    const asString = bytesToCidString(original, 36);
    const { cid, cidLen } = cidStringToBytes(asString);
    expect(cidLen).toBe(36);
    expect(cid.subarray(0, cidLen)).toEqual(original.subarray(0, 36));
  });

  it("rejects a CID longer than the 64-byte on-chain field", () => {
    // A CIDv1 with a 48-byte multihash digest (sha2-384) is 52 bytes total — still
    // under 64, so use raw bytes long enough to exceed it directly.
    expect(() => cidStringToBytes("bafkreidontcare".padEnd(120, "a"))).toThrow();
  });
});
