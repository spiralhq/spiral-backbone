import { readFile } from "node:fs/promises";
import {
  bytesToCidString,
  cidStringToBytes,
  findFilmPda,
  findMembershipPda,
  findOrganizationPda,
  submitToNodes,
  assertNodesAgree,
  resultRecordSchema,
} from "@spiral-backbone/protocol";
import { getProgramDerivedAddress } from "@solana/kit";
import {
  fetchMaybeMembership,
  MembershipStatus,
  ORGANIZATION_ERROR__MEMBERSHIP_REVOKED,
  Role,
} from "@spiral-backbone/protocol/generated/organization";
import {
  FILM_PROGRAM_ADDRESS,
  getRegisterFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import { Command } from "commander";
import { z } from "zod";
import { createSpiralClient, resolveRpcUrl } from "../lib/client";
import { CliError, handleCliError } from "../lib/errors";

export const submitOptionsSchema = z.object({
  org: z.string().min(1),
  file: z.string().min(1),
  title: z.string().min(1).max(160),
  replicas: z.string().min(1),
  cluster: z.enum(["devnet", "local"]),
  keypair: z.string().min(1),
  rpcUrl: z.string().optional(),
  wsUrl: z.string().optional(),
});

export const submit = new Command()
  .name("submit")
  .description("submit a film to the declared IPFS nodes and register it on-chain")
  .requiredOption("--org <slug>", "organization slug")
  .requiredOption("--file <path>", "path to the file to submit")
  .requiredOption("--title <title>", "film title (max 160 chars)")
  .requiredOption(
    "--replicas <urls>",
    "comma-separated Kubo RPC URLs, e.g. http://node-a:5001,http://node-b:5001",
  )
  .option("--cluster <cluster>", "devnet or local", "devnet")
  .option(
    "--keypair <path>",
    "path to the submitter keypair",
    `${process.env["HOME"]}/.config/solana/id.json`,
  )
  .option("--rpc-url <url>", "override RPC URL (takes precedence over --cluster)")
  .option(
    "--ws-url <url>",
    "override the WebSocket subscriptions URL used for transaction confirmation (paired with --rpc-url when the RPC/WS ports don't follow the conventional derivation, e.g. an ephemeral Surfpool instance)",
  )
  .action(async (opts) => {
    try {
      const options = submitOptionsSchema.parse(opts);
      const nodeUrls = options.replicas.split(",").map((url) => url.trim());

      const content = await readFile(options.file);
      const nodeResults = await submitToNodes(nodeUrls, content);
      const agreedCid = assertNodesAgree(nodeResults);

      const client = await createSpiralClient({
        cluster: options.cluster,
        keypairPath: options.keypair,
        rpcUrl: options.rpcUrl,
        rpcSubscriptionsUrl: options.wsUrl,
      });
      const [organizationPda] = await findOrganizationPda({ slug: options.org });
      const [membershipPda] = await findMembershipPda({
        organization: organizationPda,
        member: client.payer.address,
      });

      const membershipAccount = await fetchMaybeMembership(client.rpc, membershipPda);
      if (!membershipAccount.exists) {
        throw new CliError(
          `${client.payer.address} has no membership in "${options.org}" — cannot submit.`,
        );
      }
      if (membershipAccount.data.status !== MembershipStatus.Active) {
        throw new CliError(
          `Membership for ${client.payer.address} in "${options.org}" is not active (error ${ORGANIZATION_ERROR__MEMBERSHIP_REVOKED}) — cannot submit.`,
        );
      }
      if (
        membershipAccount.data.role !== Role.Submitter &&
        membershipAccount.data.role !== Role.Admin
      ) {
        throw new CliError(
          `Membership for ${client.payer.address} in "${options.org}" has role ${Role[membershipAccount.data.role]}, which cannot submit.`,
        );
      }

      const { cid, cidLen } = cidStringToBytes(agreedCid.toString());
      const [filmPda] = await findFilmPda({ organization: organizationPda, cid, cidLen });
      const [eventAuthority] = await getProgramDerivedAddress({
        programAddress: FILM_PROGRAM_ADDRESS,
        seeds: [new TextEncoder().encode("__event_authority")],
      });

      const instruction = getRegisterFilmInstruction({
        submitter: client.payer,
        organization: organizationPda,
        membership: membershipPda,
        film: filmPda,
        eventAuthority,
        program: FILM_PROGRAM_ADDRESS,
        cid,
        cidLen,
        byteSize: BigInt(content.byteLength),
        chunkingProfile: 1,
        title: options.title,
      });

      const startedAt = new Date().toISOString();
      const { context } = await client.sendTransaction([instruction]);
      const signature = context.signature;
      const finishedAt = new Date().toISOString();

      const goldenRecord = resultRecordSchema.parse({
        run_id: "manual-submit",
        hypothesis: "H4",
        film_pda: filmPda,
        work_id: options.file,
        size_bytes: content.byteLength,
        size_band: "unspecified",
        scenario: "submit",
        method: "cli",
        attempt: 1,
        started_at: startedAt,
        finished_at: finishedAt,
        latency_ms: Date.parse(finishedAt) - Date.parse(startedAt),
        cid_expected: bytesToCidString(cid, cidLen),
        cid_observed: bytesToCidString(cid, cidLen),
        outcome: "success",
        failure_class: null,
        tx_signature: signature,
        rpc_endpoint: resolveRpcUrl(options),
        verifier_impl: "n/a",
        artifact_versions: {},
      });

      // Human-readable status goes to stderr; stdout carries only the golden NDJSON record,
      // so a consumer can pipe stdout straight into a parser without grepping for JSON.
      console.error(`Film "${options.title}" registered at ${filmPda}.`);
      console.error(`Transaction: ${signature}`);
      console.log(JSON.stringify(goldenRecord));
    } catch (error) {
      handleCliError(error);
    }
  });
