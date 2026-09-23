import { createHash } from "node:crypto";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { FILM_PROGRAM_ADDRESS } from "./generated/film";

export { findMembershipPda, findOrganizationPda } from "./generated/organization";

export interface FilmSeeds {
  organization: Address;
  cid: Uint8Array;
  cidLen: number;
}

/** Hand-written, not Codama-generated — see docs/solana-kit-notes.md#codama-pda-finders-need-idl-pda-metadata. */
export async function findFilmPda(
  seeds: FilmSeeds,
  config: { programAddress?: Address } = {},
): Promise<ProgramDerivedAddress> {
  const programAddress = config.programAddress ?? FILM_PROGRAM_ADDRESS;
  const addressEncoder = getAddressEncoder();
  const digest = createHash("sha256")
    .update(Buffer.from(seeds.cid.subarray(0, seeds.cidLen)))
    .digest();
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      new TextEncoder().encode("film"),
      addressEncoder.encode(seeds.organization),
      digest.subarray(0, 32),
    ],
  });
}
