import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findFilmPda, findMembershipPda, findOrganizationPda } from "./pda";

describe("PDA derivation", () => {
  it("derives the organization PDA matching the independently-verified golden value", async () => {
    const [pda, bump] = await findOrganizationPda({ slug: "spiralhq" });
    expect(pda).toBe("61cFSS8a4CEfZ1MxLUNd4HWpemd3qDwbZ9soGLomMNU7");
    expect(bump).toBe(251);
  });

  it("derives the membership PDA matching the independently-verified golden value", async () => {
    const [orgPda] = await findOrganizationPda({ slug: "spiralhq" });
    const [pda, bump] = await findMembershipPda({
      organization: orgPda,
      member: address("11111111111111111111111111111111"),
    });
    expect(pda).toBe("HQrkhzWmWL3qmM72fbDMUCMfoDvtftrfvBr2Dtzo4tCJ");
    expect(bump).toBe(253);
  });

  it("derives the film PDA matching the independently-verified golden value", async () => {
    const [orgPda] = await findOrganizationPda({ slug: "spiralhq" });
    const cid = new Uint8Array(64);
    cid[0] = 0x01;
    cid[1] = 0x70;
    cid[2] = 0x12;
    cid[3] = 0x20;
    for (let i = 4; i < 36; i++) cid[i] = i;
    const [pda, bump] = await findFilmPda({ organization: orgPda, cid, cidLen: 36 });
    expect(pda).toBe("CEqq9LkKoai1wLMnJS8mf1bFQcABd1qCzg3V76dcdgmR");
    expect(bump).toBe(252);
  });
});
