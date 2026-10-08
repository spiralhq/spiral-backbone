import { findOrganizationPda } from "@spiral-backbone/protocol";
import { getInitializeOrganizationInstructionAsync } from "@spiral-backbone/protocol/generated/organization";
import { Command } from "commander";
import { z } from "zod";
import { createSpiralClient } from "../../lib/client";
import { handleCliError } from "../../lib/errors";

export const createOptionsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,32}$/, "slug must be 1-32 characters of [a-z0-9-]"),
  name: z
    .string()
    .min(1)
    .refine((name) => Buffer.byteLength(name, "utf8") <= 96, "name must be at most 96 bytes"),
  cluster: z.enum(["devnet", "local"]),
  keypair: z.string().min(1),
  rpcUrl: z.string().optional(),
  wsUrl: z.string().optional(),
});

export const create = new Command()
  .name("create")
  .description("create a new organization")
  .requiredOption(
    "--slug <slug>",
    "short identifier for the organization (1-32 chars of [a-z0-9-])",
  )
  .requiredOption("--name <name>", "display name (max 96 UTF-8 bytes)")
  .option("--cluster <cluster>", "devnet or local", "devnet")
  .option(
    "--keypair <path>",
    "path to the authority keypair",
    `${process.env["HOME"]}/.config/solana/id.json`,
  )
  .option("--rpc-url <url>", "override RPC URL (takes precedence over --cluster)")
  .option(
    "--ws-url <url>",
    "override the WebSocket subscriptions URL used for transaction confirmation (paired with --rpc-url when the RPC/WS ports don't follow the conventional derivation, e.g. an ephemeral Surfpool instance)",
  )
  .action(async (opts) => {
    try {
      const options = createOptionsSchema.parse(opts);
      const client = await createSpiralClient({
        cluster: options.cluster,
        keypairPath: options.keypair,
        rpcUrl: options.rpcUrl,
        rpcSubscriptionsUrl: options.wsUrl,
      });

      const instruction = await getInitializeOrganizationInstructionAsync({
        authority: client.payer,
        slug: options.slug,
        name: options.name,
      });

      const { context } = await client.sendTransaction([instruction]);
      const signature = context.signature;
      const [organizationPda] = await findOrganizationPda({ slug: options.slug });

      console.log(`Organization "${options.slug}" created at ${organizationPda}.`);
      console.log(`Transaction: ${signature}`);
    } catch (error) {
      handleCliError(error);
    }
  });
