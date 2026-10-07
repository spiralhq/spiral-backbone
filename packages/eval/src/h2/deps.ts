import { artifactVersions } from "@spiral-backbone/protocol";
import { runExecutorContainer } from "./executor/run-container";
import type { OrchestratorDeps, PayloadContext } from "./orchestrator";
import { applyState, checkState, networkProviderProbe, sshReplicaController } from "./state";
import type { Topology } from "./topology";

export function realDeps(
  topology: Topology,
  opts: { pingTimeoutMs: number; providersTimeoutMs: number },
): OrchestratorDeps {
  const controller = sshReplicaController(topology, { pingTimeoutMs: opts.pingTimeoutMs });
  const probe = networkProviderProbe(topology, opts.providersTimeoutMs);
  const all = topology.replicas.map((r) => r.name);
  return {
    applyState: (intended) => applyState(controller, all, intended),
    checkState: (intended, cids) => checkState(controller, probe, topology, intended, cids),
    runAttempt: (payload) => runExecutorContainer(payload, topology.executor),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function expectedDeclaredOf(topology: Topology): string[] {
  return topology.replicas.map((r) => r.peer_id);
}

export function payloadContextOf(topology: Topology): PayloadContext {
  return {
    rpc_url: topology.rpc_url,
    gateway_url: topology.gateway_url,
    bootstrap_multiaddr: topology.network_node.bootstrap_multiaddr,
    private_network: topology.executor.swarm_key_path !== null,
    artifact_versions: artifactVersions(),
  };
}
