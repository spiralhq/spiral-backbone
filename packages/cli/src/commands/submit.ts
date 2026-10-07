import { readFile } from "node:fs/promises";
import { getProgramDerivedAddress } from "@solana/kit";
import {
  assertNodesAgree,
  cidStringToBytes,
  describeEndpoint,
  fetchPeerId,
  findFilmPda,
  findMembershipPda,
  findOrganizationPda,
  inventoryRecordFromFilm,
  submitToNodes,
} from "@spiral-backbone/protocol";
import {
  FILM_PROGRAM_ADDRESS,
  fetchFilm,
  getDeclareReplicaInstruction,
  getRegisterFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import {
  fetchMaybeMembership,
  MembershipStatus,
  ORGANIZATION_ERROR__MEMBERSHIP_REVOKED,
  Role,
} from "@spiral-backbone/protocol/generated/organization";
import { Command } from "commander";
import { z } from "zod";
import { createSpiralClient, resolveRpcUrl } from "../lib/client";
import { CliError, handleCliError } from "../lib/errors";
import { assertContentMatchesWork, findManifestWork } from "../lib/manifest";

const MAX_REPLICAS = 8;

export const submitOptionsSchema = z.object({
  org: z.string().min(1),
  workId: z.string().min(1),
  manifest: z.string().min(1),
  file: z.string().min(1),
  title: z.string().min(1).max(160),
  replicas: z.string().min(1),
  cluster: z.enum(["devnet", "local"]),
  keypair: z.string().min(1),
  rpcUrl: z.string().optional(),
  wsUrl: z.string().optional(),
});

export function parseReplicaUrls(replicas: string): string[] {
  const urls = [
    ...new Set(
      replicas
        .split(",")
        .map((url) => url.trim())
        .filter((url) => url.length > 0),
    ),
  ];
  if (urls.length === 0) throw new CliError("--replicas must list at least one Kubo RPC URL");
  if (urls.length > MAX_REPLICAS) {
    throw new CliError(
      `at most ${MAX_REPLICAS} replicas can be declared on-chain (got ${urls.length})`,
    );
  }
  return urls;
}

export function assertDistinctPeers(urls: string[], peers: { peerId: string }[]): void {
  const byPeer = new Map<string, string[]>();
  peers.forEach(({ peerId }, i) => byPeer.set(peerId, [...(byPeer.get(peerId) ?? []), urls[i]!]));
  const collisions = [...byPeer.entries()].filter(([, group]) => group.length > 1);
  if (collisions.length > 0) {
    const detail = collisions
      .map(([peerId, group]) => `${group.join(" and ")} are the same node (${peerId})`)
      .join("; ");
    throw new CliError(
      `--replicas must name distinct IPFS nodes: ${detail}. Each replica is declared on-chain once per PeerID.`,
    );
  }
}

export const submit = new Command()
  .name("submit")
  .description(
    "submit a film to the declared IPFS nodes, register it and its replicas on-chain, and print its golden inventory line",
  )
  .requiredOption("--org <slug>", "organization slug")
  .requiredOption("--work-id <id>", "manifest work_id this file is, e.g. pd-001")
  .option("--manifest <path>", "dataset manifest", "dataset/manifest.json")
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
      const nodeUrls = parseReplicaUrls(options.replicas);

      const work = await findManifestWork(options.manifest, options.workId);
      const content = await readFile(options.file);
      const sha256 = assertContentMatchesWork(work, content);
      const peers = await Promise.all(nodeUrls.map((url) => fetchPeerId(url)));
      assertDistinctPeers(nodeUrls, peers);

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

      const register = await client.sendTransaction([
        getRegisterFilmInstruction({
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
        }),
      ]);

      const replicaSignatures: string[] = [];
      for (const peer of peers) {
        const declared = await client.sendTransaction([
          getDeclareReplicaInstruction({
            film: filmPda,
            submitter: client.payer,
            peerId: peer.bytes,
            peerIdLen: peer.bytes.length,
          }),
        ]);
        replicaSignatures.push(declared.context.signature);
      }

      const film = await fetchFilm(client.rpc, filmPda);
      const inventory = inventoryRecordFromFilm({
        workId: work.work_id,
        filmPda,
        film: film.data,
        sizeBand: work.size_band,
        coldCid: work.cold_cid,
        sha256,
        registerSignature: register.context.signature,
        replicaSignatures,
        rpcEndpoint: describeEndpoint(resolveRpcUrl(options)).host,
      });

      // stdout carries only the golden inventory line; human status goes to stderr.
      console.error(
        `Film "${options.title}" registered at ${filmPda} with ${peers.length} replica(s).`,
      );
      console.error(`Transaction: ${register.context.signature}`);
      console.log(JSON.stringify(inventory));
    } catch (error) {
      handleCliError(error);
    }
  });
