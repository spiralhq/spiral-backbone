import { address, getProgramDerivedAddress } from "@solana/kit";
import { findMembershipPda, findOrganizationPda } from "@spiral-backbone/protocol";
import {
  getRevokeMembershipInstructionAsync,
  ORGANIZATION_PROGRAM_ADDRESS,
} from "@spiral-backbone/protocol/generated/organization";
import { Command } from "commander";
import { z } from "zod";
import { createSpiralClient } from "../../lib/client";
import { handleCliError } from "../../lib/errors";

export const revokeOptionsSchema = z.object({
  slug: z.string().min(1),
  member: z.string().min(1),
  cluster: z.enum(["devnet", "local"]),
  keypair: z.string().min(1),
  rpcUrl: z.string().optional(),
});

export const revoke = new Command()
  .name("revoke")
  .description("revoke a member's access")
  .requiredOption("--slug <slug>", "organization slug")
  .requiredOption("--member <pubkey>", "member's public key")
  .option("--cluster <cluster>", "devnet or local", "devnet")
  .option(
    "--keypair <path>",
    "path to the admin keypair",
    `${process.env["HOME"]}/.config/solana/id.json`,
  )
  .option("--rpc-url <url>", "override RPC URL (takes precedence over --cluster)")
  .action(async (opts) => {
    try {
      const options = revokeOptionsSchema.parse(opts);
      const client = await createSpiralClient({
        cluster: options.cluster,
        keypairPath: options.keypair,
        rpcUrl: options.rpcUrl,
      });
      const [organizationPda] = await findOrganizationPda({ slug: options.slug });
      const memberAddress = address(options.member);
      const [eventAuthority] = await getProgramDerivedAddress({
        programAddress: ORGANIZATION_PROGRAM_ADDRESS,
        seeds: [new TextEncoder().encode("__event_authority")],
      });

      const instruction = await getRevokeMembershipInstructionAsync({
        authority: client.payer,
        organization: organizationPda,
        member: memberAddress,
        eventAuthority,
        program: ORGANIZATION_PROGRAM_ADDRESS,
      });

      const { context } = await client.sendTransaction([instruction]);
      const signature = context.signature;
      const [membershipPda] = await findMembershipPda({
        organization: organizationPda,
        member: memberAddress,
      });

      console.log(`Revoked membership ${membershipPda}.`);
      console.log(`Transaction: ${signature}`);
    } catch (error) {
      handleCliError(error);
    }
  });
