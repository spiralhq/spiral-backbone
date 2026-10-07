import {
  assertSshReachable,
  checkSystemdActive,
  shutdownService,
  startService,
} from "../../../../scripts/kubo-node-control";
import { assertNetworkNodeAlive, findProviderIds, pingPeer } from "./probes";
import { replicaByName, sshTargetOf, type Topology } from "./topology";

export interface NodeObservation {
  node: string;
  systemd_active: boolean;
  swarm_reachable: boolean;
}

export interface StateCheck {
  intended: string[];
  observed: NodeObservation[];
  missing_providers: Record<string, string[]>;
  confirmed: boolean;
  reasons: string[];
}

export interface ReplicaController {
  start(node: string): Promise<void>;
  stop(node: string): Promise<void>;
  observe(node: string): Promise<NodeObservation>;
}

export interface ProviderProbe {
  providers(cid: string): Promise<Set<string>>;
  liveness?: () => Promise<void>;
}

export function sshReplicaController(
  topology: Topology,
  opts: { pingTimeoutMs: number },
): ReplicaController {
  return {
    start: async (node) => {
      const replica = replicaByName(topology, node);
      await startService(sshTargetOf(replica), replica.service);
    },
    stop: async (node) => {
      const replica = replicaByName(topology, node);
      await shutdownService(sshTargetOf(replica), replica.service);
    },
    observe: async (node) => {
      const replica = replicaByName(topology, node);
      await assertSshReachable(sshTargetOf(replica));
      const [systemd, swarm] = await Promise.all([
        checkSystemdActive(sshTargetOf(replica), replica.service),
        pingPeer(topology.network_node.api_url, replica.peer_id, opts.pingTimeoutMs),
      ]);
      return { node, systemd_active: systemd, swarm_reachable: swarm };
    },
  };
}

export function networkProviderProbe(topology: Topology, timeoutMs: number): ProviderProbe {
  return {
    providers: (cid) => findProviderIds(topology.network_node.api_url, cid, timeoutMs),
    liveness: () => assertNetworkNodeAlive(topology.network_node.api_url, 10_000),
  };
}

export async function applyState(
  controller: ReplicaController,
  allNodes: string[],
  intended: string[],
): Promise<void> {
  for (const node of allNodes) {
    if (intended.includes(node)) await controller.start(node);
    else await controller.stop(node);
  }
}

export function decideState(input: {
  intended: string[];
  observed: NodeObservation[];
  providersByCid: Record<string, Set<string>>;
  peerIdByNode: Record<string, string>;
}): StateCheck {
  const reasons: string[] = [];
  for (const obs of input.observed) {
    const shouldBeOn = input.intended.includes(obs.node);
    const want = shouldBeOn ? "on" : "off";
    if (obs.systemd_active !== shouldBeOn) {
      reasons.push(
        `${obs.node}: systemd ${obs.systemd_active ? "active" : "inactive"}, intended ${want}`,
      );
    }
    if (obs.swarm_reachable !== shouldBeOn) {
      reasons.push(
        `${obs.node}: swarm ${obs.swarm_reachable ? "reachable" : "unreachable"}, intended ${want}`,
      );
    }
  }
  const missing: Record<string, string[]> = {};
  for (const [cid, providers] of Object.entries(input.providersByCid)) {
    const absent = input.intended.filter((node) => !providers.has(input.peerIdByNode[node] ?? ""));
    if (absent.length > 0) {
      missing[cid] = absent;
      reasons.push(`${cid}: no provider record from ${absent.join(", ")}`);
    }
  }
  return {
    intended: input.intended,
    observed: input.observed,
    missing_providers: missing,
    confirmed: reasons.length === 0,
    reasons,
  };
}

export async function checkState(
  controller: ReplicaController,
  probe: ProviderProbe,
  topology: Topology,
  intended: string[],
  cids: string[],
): Promise<StateCheck> {
  await probe.liveness?.();
  const observed = await Promise.all(topology.replicas.map((r) => controller.observe(r.name)));
  const providersByCid: Record<string, Set<string>> = {};
  if (intended.length > 0) {
    for (const cid of cids) providersByCid[cid] = await probe.providers(cid);
  }
  const peerIdByNode = Object.fromEntries(topology.replicas.map((r) => [r.name, r.peer_id]));
  return decideState({ intended, observed, providersByCid, peerIdByNode });
}
