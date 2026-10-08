import { readFile } from "node:fs/promises";
import { address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { bytesToCidString, type InventoryRecord } from "@spiral-backbone/protocol";
import { fetchFilm } from "@spiral-backbone/protocol/generated/film";
import { remoteRecursivePins, type SshTarget } from "../../../../scripts/kubo-node-control";
import { manifestSchema, validateManifest } from "../../../../scripts/validate-manifest";
import { readGolden } from "../common/golden";
import { campaignSpecSchema, validateCampaign } from "../h2/campaign";
import { peerIdFromBytes } from "../h2/executor/provenance";
import { readFilm } from "../h2/executor/registry";
import { generatePlan, goldenDigest, plannedAttemptCount, readPlan } from "../h2/plan";
import { checkTopologyMatchesCampaign, sshTargetOf, type Topology } from "../h2/topology";
import type { Check } from "./checks";

export type FilmRpc = Rpc<GetAccountInfoApi>;

async function readJson(kind: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${kind} ${path} is unreadable or not valid JSON`);
  }
}

async function loadGolden(path: string): Promise<InventoryRecord[]> {
  try {
    return await readGolden(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const badLine = /^(.*:\d+): invalid JSON/.exec(message);
    if (badLine) throw new Error(`${badLine[1]}: invalid JSON`);
    if ((error as NodeJS.ErrnoException).code !== undefined) {
      throw new Error(`golden ${path} is unreadable`);
    }
    throw error;
  }
}

export function manifestFinalCheck(manifestPath: string, filesDir: string): Check {
  return {
    stage: "infra",
    name: "manifest (--final)",
    run: async () => {
      const raw = await readJson("manifest", manifestPath);
      const { errors, notes } = await validateManifest(raw, { filesDir, final: true });
      if (errors.length > 0) {
        throw new Error(`${errors.length} errors; first: ${errors[0]}`);
      }
      const { works } = manifestSchema.parse(raw);
      const unverified = notes.filter((n) => n.includes("not downloaded")).length;
      const files = unverified > 0 ? `${unverified} files not verified` : "all files verified";
      return `${works.length} works, ${works.filter((w) => w.cold_cid).length} cold, ${files}`;
    },
  };
}

export function goldenMatchesManifestCheck(goldenPath: string, manifestPath: string): Check {
  return {
    stage: "h2",
    name: "golden ↔ manifest",
    run: async () => {
      const parsed = manifestSchema.safeParse(await readJson("manifest", manifestPath));
      if (!parsed.success) throw new Error(`manifest ${manifestPath} does not match the schema`);
      const golden = await loadGolden(goldenPath);
      const manifest = new Map(parsed.data.works.map((w) => [w.work_id, w]));
      const byId = new Map(golden.map((g) => [g.work_id, g]));
      const problems: string[] = [];
      const missing = [...manifest.keys()].filter((id) => !byId.has(id));
      if (missing.length > 0) problems.push(`missing in golden: ${missing.join(", ")}`);
      const extra = [...byId.keys()].filter((id) => !manifest.has(id));
      if (extra.length > 0) problems.push(`not in manifest: ${extra.join(", ")}`);
      for (const record of golden) {
        const work = manifest.get(record.work_id);
        if (work && work.cold_cid !== record.cold_cid) {
          problems.push(
            `${record.work_id}: cold_cid golden ${record.cold_cid}, manifest ${work.cold_cid}`,
          );
        }
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `${golden.length} works match, ${golden.filter((g) => g.cold_cid).length} cold`;
    },
  };
}

export function filmsMatchCheck(
  rpc: FilmRpc,
  goldenPath: string,
  topology: Topology,
  retry: { retries?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Check {
  return {
    stage: "h2",
    name: "Films ↔ golden ↔ topology",
    run: async () => {
      const golden = await loadGolden(goldenPath);
      const expected = new Set(topology.replicas.map((r) => r.peer_id));
      const problems: string[] = [];
      for (const record of golden) {
        let film;
        try {
          film = (
            await readFilm(
              (abortSignal) => fetchFilm(rpc, address(record.film_pda), { abortSignal }),
              retry,
            )
          ).value.data;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          problems.push(`${record.work_id}: Film unreadable (${message})`);
          continue;
        }
        const cid = (() => {
          try {
            return bytesToCidString(new Uint8Array(film.cid), film.cidLen);
          } catch {
            return null;
          }
        })();
        if (cid !== record.cid) problems.push(`${record.work_id}: cid differs`);
        const declared = new Set(
          film.replicas
            .slice(0, film.replicaCount)
            .filter((r) => r.active)
            .map((r) => peerIdFromBytes(new Uint8Array(r.peerId), r.peerIdLen)),
        );
        const missing = [...expected].filter((p) => !declared.has(p));
        const extra = [...declared].filter((p) => !expected.has(p));
        if (missing.length > 0) problems.push(`${record.work_id}: missing ${missing.join(", ")}`);
        if (extra.length > 0) problems.push(`${record.work_id}: extra ${extra.join(", ")}`);
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `${golden.length} Films: CID matches golden, active replicas = ${expected.size} topology PeerIDs`;
    },
  };
}

export function campaignFeasibleCheck(
  campaignPath: string,
  goldenPath: string,
  topology: Topology,
): Check {
  return {
    stage: "h2",
    name: "campaign plan",
    run: async () => {
      const parsed = campaignSpecSchema.safeParse(await readJson("campaign", campaignPath));
      if (!parsed.success) {
        const at = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
        throw new Error(`campaign ${campaignPath} does not match the schema at: ${at.join(", ")}`);
      }
      const campaign = parsed.data;
      const errors = [
        ...validateCampaign(campaign),
        ...checkTopologyMatchesCampaign(topology, campaign.replica_nodes),
      ];
      if (errors.length > 0) throw new Error(errors.join("; "));
      const golden = await loadGolden(goldenPath);
      const plan = generatePlan({ campaign, golden, runId: "preflight" });
      return `${plannedAttemptCount(plan)} attempts in ${plan.blocks.length} blocks over ${golden.length} works`;
    },
  };
}

export function replicaPinsChecks(
  topology: Topology,
  goldenPath: string,
  deps: { pins?: (target: SshTarget) => Promise<string[]> } = {},
): Check[] {
  const pins = deps.pins ?? remoteRecursivePins;
  return topology.replicas.map((replica) => ({
    stage: "h2",
    name: `replica ${replica.name} pins`,
    run: async () => {
      const golden = await loadGolden(goldenPath);
      const pinned = new Set(await pins(sshTargetOf(replica)));
      const missing = golden.map((g) => g.cid).filter((cid) => !pinned.has(cid));
      if (missing.length > 0) {
        const noun = missing.length === 1 ? "CID" : "CIDs";
        throw new Error(
          `${replica.name}: ${missing.length} golden ${noun} not pinned: ${missing.join(", ")}`,
        );
      }
      return `${golden.length} of ${golden.length} golden CIDs pinned`;
    },
  }));
}

export function planMatchesGoldenCheck(planPath: string, goldenPath: string): Check {
  return {
    stage: "h2",
    name: "plan ↔ golden",
    run: async () => {
      let frozen: string;
      try {
        frozen = (await readPlan(planPath)).golden_sha256;
      } catch {
        throw new Error(`plan ${planPath} is unreadable or not a valid plan`);
      }
      const current = goldenDigest(await loadGolden(goldenPath));
      if (frozen !== current) {
        throw new Error(`plan golden_sha256 ${frozen} differs from the current golden ${current}`);
      }
      return `golden digest ${current}`;
    },
  };
}
