import { readFile } from "node:fs/promises";
import { z, ZodError } from "zod";
import type { SshTarget } from "../../../../scripts/kubo-node-control";

export const DEFAULT_EXECUTOR_IMAGE = "spiral-h2-executor:dev";

const sshSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    user: z.string().min(1),
    identity_file: z.string().min(1),
    insecure_host_key_checking: z.boolean().default(false),
  })
  .strict();

export const topologySchema = z
  .object({
    topology_version: z.literal(1),
    replicas: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9-]+$/),
            peer_id: z.string().min(1),
            service: z.string().default("ipfs"),
            ssh: sshSchema,
          })
          .strict(),
      )
      .min(1),
    network_node: z
      .object({ api_url: z.url(), bootstrap_multiaddr: z.string().nullable() })
      .strict(),
    gateway_url: z.url(),
    rpc_url: z.url(),
    executor: z
      .object({
        image: z.string().min(1),
        docker_network: z.string().nullable(),
        add_hosts: z.array(z.string()),
        swarm_key_path: z.string().nullable(),
        block_cidrs: z.array(z.string()),
        repo_root: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type Topology = z.infer<typeof topologySchema>;
export type TopologyInput = z.input<typeof topologySchema>;
export type TopologyReplica = Topology["replicas"][number];

export async function loadTopology(path: string): Promise<Topology> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`topology ${path} is unreadable or not valid JSON`);
  }
  try {
    return topologySchema.parse(raw);
  } catch (error) {
    const at =
      error instanceof ZodError ? error.issues.map((i) => i.path.join(".") || "(root)") : [];
    throw new Error(`topology ${path} does not match the schema at: ${at.join(", ")}`);
  }
}

export function sshTargetOf(replica: TopologyReplica): SshTarget {
  return {
    host: replica.ssh.host,
    port: replica.ssh.port,
    user: replica.ssh.user,
    identityFile: replica.ssh.identity_file,
    insecureHostKeyChecking: replica.ssh.insecure_host_key_checking,
  };
}

export function replicaByName(topology: Topology, name: string): TopologyReplica {
  const replica = topology.replicas.find((r) => r.name === name);
  if (!replica) throw new Error(`replica ${name} is not in the topology`);
  return replica;
}

export function checkTopologyMatchesCampaign(topology: Topology, replicaNodes: string[]): string[] {
  const names = new Set(topology.replicas.map((r) => r.name));
  return replicaNodes
    .filter((n) => !names.has(n))
    .map((n) => `campaign replica ${n} is not in the topology`);
}
