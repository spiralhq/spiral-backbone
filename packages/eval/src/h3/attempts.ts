import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { bytesToCidString, findFilmPda } from "@spiral-backbone/protocol";
import {
  FILM_PROGRAM_ADDRESS,
  getRegisterFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import { eventAuthority, labelCid, type CidBytes } from "./accounts";
import type { H3Fixtures } from "./fixtures";
import type { H3Scenario } from "./scenarios";

export interface ScenarioAttempt {
  instruction: Instruction;
  feePayer: TransactionSigner;
  film: Address;
  cid: string;
}

export async function registerFilmInstruction(input: {
  submitter: TransactionSigner;
  organization: Address;
  membership: Address;
  cid: CidBytes;
}): Promise<{ instruction: Instruction; film: Address }> {
  const [film] = await findFilmPda({
    organization: input.organization,
    cid: input.cid.cid,
    cidLen: input.cid.cidLen,
  });
  const instruction = getRegisterFilmInstruction({
    submitter: input.submitter,
    organization: input.organization,
    membership: input.membership,
    film,
    eventAuthority: await eventAuthority(FILM_PROGRAM_ADDRESS),
    program: FILM_PROGRAM_ADDRESS,
    cid: input.cid.cid,
    cidLen: input.cid.cidLen,
    byteSize: 1n,
    chunkingProfile: 1,
    title: "h3 attempt",
  });
  return { instruction, film };
}

export async function buildScenarioAttempt(
  scenario: H3Scenario,
  f: H3Fixtures,
  label: string,
): Promise<ScenarioAttempt> {
  const fresh = await labelCid(`h3-${label}-s${scenario.id}`);
  const plan = ((): {
    submitter: TransactionSigner;
    organization: Address;
    membership: Address;
    cid: CidBytes;
  } => {
    switch (scenario.id) {
      case 1:
        return {
          submitter: f.outsider,
          organization: f.organization,
          membership: f.outsiderMembership,
          cid: fresh,
        };
      case 2:
        return {
          submitter: f.revoked,
          organization: f.organization,
          membership: f.revokedMembership,
          cid: fresh,
        };
      case 3:
        return {
          submitter: f.reader,
          organization: f.organization,
          membership: f.readerMembership,
          cid: fresh,
        };
      case 4:
        return {
          submitter: f.member,
          organization: f.otherOrganization,
          membership: f.memberMembership,
          cid: fresh,
        };
      case 5:
        return {
          submitter: f.impostor,
          organization: f.organization,
          membership: f.memberMembership,
          cid: fresh,
        };
      case 6:
        return {
          submitter: f.admin,
          organization: f.organization,
          membership: f.adminMembership,
          cid: f.existingCid,
        };
      case 7:
        return {
          submitter: f.admin,
          organization: f.organization,
          membership: f.existingFilm,
          cid: fresh,
        };
      default:
        throw new Error(`unknown H3 scenario ${scenario.id}`);
    }
  })();
  const { instruction, film } = await registerFilmInstruction(plan);
  return {
    instruction,
    feePayer: plan.submitter,
    film,
    cid: bytesToCidString(plan.cid.cid, plan.cid.cidLen),
  };
}
