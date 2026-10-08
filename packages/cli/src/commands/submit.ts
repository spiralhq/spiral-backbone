import { readFile } from "node:fs/promises";
import {
  getProgramDerivedAddress,
  type Address,
  type GetAccountInfoApi,
  type Instruction,
  type Rpc,
} from "@solana/kit";
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
  fetchMaybeFilm,
  getDeclareReplicaInstruction,
  type Film,
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
import {
  activeReplicaPeers,
  peerHex,
  resolveFilmSignatures,
  type FilmHistoryRpc,
  type FilmSignatures,
} from "../lib/film-signatures";
import { assertContentMatchesWork, findManifestWork } from "../lib/manifest";

const MAX_REPLICAS = 8;
const CHUNKING_PROFILE = 1;

export const submitOptionsSchema = z.object({
  org: z.string().min(1),
  workId: z.string().min(1),
  manifest: z.string().min(1),
  file: z.string().min(1),
  title: z
    .string()
    .min(1)
    .refine((title) => Buffer.byteLength(title, "utf8") <= 160, "title must be at most 160 bytes"),
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

export interface FilmChain {
  rpc: Rpc<GetAccountInfoApi> & FilmHistoryRpc;
  send(instruction: Instruction): Promise<unknown>;
}

export interface FilmSubmission {
  filmPda: Address;
  cid: Uint8Array;
  cidLen: number;
  byteSize: bigint;
  chunkingProfile: number;
  title: string;
  peers: { peerId: string; bytes: Uint8Array }[];
  registerInstruction: () => Instruction;
  declareInstruction: (peerId: Uint8Array) => Instruction;
  log?: (line: string) => void;
  history?: { attempts?: number; delayMs?: number };
}

function assertSameFilm(existing: Film, submission: FilmSubmission): void {
  const where = `Film ${submission.filmPda} already exists`;
  const sameCid =
    existing.cidLen === submission.cidLen &&
    Buffer.from(existing.cid.slice(0, existing.cidLen)).equals(
      Buffer.from(submission.cid.subarray(0, submission.cidLen)),
    );
  if (!sameCid) throw new CliError(`${where} with a different CID; refusing to touch it.`);
  if (existing.byteSize !== submission.byteSize) {
    throw new CliError(
      `${where} with byte_size ${existing.byteSize}, not ${submission.byteSize}; refusing to touch it.`,
    );
  }
  if (existing.chunkingProfile !== submission.chunkingProfile) {
    throw new CliError(
      `${where} with chunking_profile ${existing.chunkingProfile}, not ${submission.chunkingProfile}; refusing to touch it.`,
    );
  }
  if (existing.title !== submission.title) {
    throw new CliError(
      `${where} with title "${existing.title}"; rerun with that --title to resume it.`,
    );
  }
}

/** Idempotent per Film: registers it unless it exists, then declares only the inactive PeerIDs. */
export async function ensureFilmOnChain(
  chain: FilmChain,
  submission: FilmSubmission,
): Promise<{ film: Film } & FilmSignatures> {
  const log = submission.log ?? (() => {});
  const existing = await fetchMaybeFilm(chain.rpc, submission.filmPda);
  let active = new Set<string>();
  if (existing.exists) {
    assertSameFilm(existing.data, submission);
    active = new Set(activeReplicaPeers(existing.data));
    log(`Film ${submission.filmPda} already registered; resuming.`);
  } else {
    await chain.send(submission.registerInstruction());
  }

  for (const peer of submission.peers) {
    if (active.has(peerHex(peer.bytes, peer.bytes.length))) {
      log(`Replica ${peer.peerId} already active; skipping.`);
      continue;
    }
    await chain.send(submission.declareInstruction(peer.bytes));
  }

  const film = (await fetchFilm(chain.rpc, submission.filmPda)).data;
  const nowActive = new Set(activeReplicaPeers(film));
  const inactive = submission.peers.filter(
    (peer) => !nowActive.has(peerHex(peer.bytes, peer.bytes.length)),
  );
  if (inactive.length > 0) {
    throw new CliError(
      `Film ${submission.filmPda} does not list ${inactive.map((p) => p.peerId).join(", ")} as active after declaring.`,
    );
  }
  const signatures = await resolveFilmSignatures(
    chain.rpc,
    submission.filmPda,
    film,
    submission.history,
  );
  return { film, ...signatures };
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
  .requiredOption("--title <title>", "film title (max 160 UTF-8 bytes)")
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

      const { film, registerSignature, replicaSignatures } = await ensureFilmOnChain(
        {
          rpc: client.rpc,
          send: (instruction) => client.sendTransaction([instruction]),
        },
        {
          filmPda,
          cid,
          cidLen,
          byteSize: BigInt(content.byteLength),
          chunkingProfile: CHUNKING_PROFILE,
          title: options.title,
          peers,
          registerInstruction: () =>
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
              chunkingProfile: CHUNKING_PROFILE,
              title: options.title,
            }),
          declareInstruction: (peerId) =>
            getDeclareReplicaInstruction({
              authority: client.payer,
              organization: organizationPda,
              membership: membershipPda,
              film: filmPda,
              eventAuthority,
              program: FILM_PROGRAM_ADDRESS,
              peerId,
              peerIdLen: peerId.length,
            }),
          log: (line) => console.error(line),
        },
      );

      const inventory = inventoryRecordFromFilm({
        workId: work.work_id,
        filmPda,
        film,
        sizeBand: work.size_band,
        coldCid: work.cold_cid,
        sha256,
        registerSignature,
        replicaSignatures,
        rpcEndpoint: describeEndpoint(resolveRpcUrl(options)).host,
      });

      // stdout carries only the golden inventory line; human status goes to stderr.
      console.error(
        `Film "${film.title}" at ${filmPda} has ${replicaSignatures.length} active replica(s).`,
      );
      console.error(`Transaction: ${registerSignature}`);
      console.log(JSON.stringify(inventory));
    } catch (error) {
      handleCliError(error);
    }
  });
