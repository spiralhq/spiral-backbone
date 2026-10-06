import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";

export type RefusingProgram = "film" | "organization" | "system";

export interface H3Scenario {
  id: number;
  key: string;
  description: string;
  expectedCode: number;
  refusingProgram: RefusingProgram;
}

export const EXPECTED_INSTRUCTION_INDEX = 0;

export const REFUSING_PROGRAM_ADDRESS: Record<RefusingProgram, string> = {
  film: FILM_PROGRAM_ADDRESS,
  organization: ORGANIZATION_PROGRAM_ADDRESS,
  system: "11111111111111111111111111111111",
};

export const H3_SCENARIOS: readonly H3Scenario[] = [
  {
    id: 1,
    key: "no-membership",
    description: "signer has no Membership account",
    expectedCode: 3012,
    refusingProgram: "film",
  },
  {
    id: 2,
    key: "revoked-membership",
    description: "Membership was revoked",
    expectedCode: 6001,
    refusingProgram: "organization",
  },
  {
    id: 3,
    key: "reader-role",
    description: "Membership role is Reader",
    expectedCode: 6002,
    refusingProgram: "organization",
  },
  {
    id: 4,
    key: "org-mismatch",
    description: "Membership belongs to another organization",
    expectedCode: 6003,
    refusingProgram: "organization",
  },
  {
    id: 5,
    key: "member-mismatch",
    description: "signer differs from membership.member",
    expectedCode: 6004,
    refusingProgram: "organization",
  },
  {
    id: 6,
    key: "duplicate-cid",
    description: "CID already registered in this organization",
    expectedCode: 0,
    refusingProgram: "system",
  },
  {
    id: 7,
    key: "foreign-owner-membership",
    description: "account passed as Membership is a Film account (owned by the film program)",
    expectedCode: 3007,
    refusingProgram: "film",
  },
];
