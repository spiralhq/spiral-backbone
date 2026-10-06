export const PROFILE_CID_LENGTH = 36;
export const PROFILE_CID_PREFIX_HEX = "01701220";

export type H1Diagnosis =
  | "retrieved_bytes_differ_from_original"
  | "onchain_cid_malformed"
  | "chunking_parameters_diverge";

export function diagnoseIntactMismatch(input: {
  cidLen: number;
  cidPrefixHex: string;
  manifestSha256: string;
  retrievedSha256: string;
}): H1Diagnosis {
  if (input.retrievedSha256 !== input.manifestSha256) return "retrieved_bytes_differ_from_original";
  if (input.cidLen !== PROFILE_CID_LENGTH || input.cidPrefixHex !== PROFILE_CID_PREFIX_HEX) {
    return "onchain_cid_malformed";
  }
  return "chunking_parameters_diverge";
}
