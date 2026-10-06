import { getProgramDerivedAddress, type Address } from "@solana/kit";
import { cidStringToBytes } from "@spiral-backbone/protocol";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const DAG_PB = 0x70;

export interface CidBytes {
  cid: Uint8Array;
  cidLen: number;
}

export async function labelCid(label: string): Promise<CidBytes> {
  const digest = await sha256.digest(new TextEncoder().encode(label));
  return cidStringToBytes(CID.create(1, DAG_PB, digest).toString());
}

export async function eventAuthority(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [new TextEncoder().encode("__event_authority")],
  });
  return pda;
}
