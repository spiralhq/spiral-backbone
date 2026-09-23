import { CID } from "multiformats/cid";

const ON_CHAIN_CID_LENGTH = 64;

export function bytesToCidString(cidBytes: Uint8Array, cidLen: number): string {
  return CID.decode(cidBytes.subarray(0, cidLen)).toString();
}

export function cidStringToBytes(cidString: string): { cid: Uint8Array; cidLen: number } {
  const parsed = CID.parse(cidString);
  const bytes = parsed.bytes;
  if (bytes.length > ON_CHAIN_CID_LENGTH) {
    throw new Error(
      `CID is ${bytes.length} bytes, exceeding the ${ON_CHAIN_CID_LENGTH}-byte on-chain field`,
    );
  }
  const cid = new Uint8Array(ON_CHAIN_CID_LENGTH);
  cid.set(bytes);
  return { cid, cidLen: bytes.length };
}
