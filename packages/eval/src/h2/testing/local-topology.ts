import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_EXECUTOR_IMAGE, topologySchema, type Topology } from "../topology";

const execFileAsync = promisify(execFile);
const KUBO_IMAGE = "ipfs/kubo:v0.43.1";
export const NODE_IMAGE = "spiral-h2-node:dev";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const NODE_IMAGE_DIR = join(import.meta.dirname, "node-image");

const PRIVATE_OVERLAY = [
  "ipfs config --json AutoConf.Enabled false",
  "ipfs config --json AutoTLS.Enabled false",
  "ipfs bootstrap rm --all",
  "ipfs config --json Swarm.AddrFilters '[]'",
  "ipfs config --json Addresses.NoAnnounce '[]'",
  "ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001",
];

export interface LocalTopology {
  topology: Topology;
  replicaApiUrls: Record<string, string>;
  networkNodeIp: string;
  networkName: string;
  stop(): Promise<void>;
}

const docker = (args: string[], timeout = 300_000) =>
  execFileAsync("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024 });

async function publishedPort(container: string, port: number): Promise<number> {
  const { stdout } = await docker(["port", container, `${port}/tcp`]);
  const value = Number(stdout.trim().split("\n")[0]?.split(":").at(-1));
  if (!Number.isInteger(value))
    throw new Error(`no published port ${port} on ${container}: ${stdout}`);
  return value;
}

async function containerIp(container: string, network: string): Promise<string> {
  const { stdout } = await docker([
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    container,
  ]);
  return stdout.trim();
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const apiReady = (url: string) => async () =>
  (await fetch(`${url}/api/v0/id`, { method: "POST" })).ok;

async function peerIdOf(apiUrl: string): Promise<string> {
  const body = (await (await fetch(`${apiUrl}/api/v0/id`, { method: "POST" })).json()) as {
    ID: string;
  };
  return body.ID;
}

export async function startLocalTopology(options: {
  rpcUrlForContainers: string;
  addHosts: string[];
  replicaNames?: string[];
}): Promise<LocalTopology> {
  if (!existsSync(join(REPO_ROOT, "infra/kubo/setup.sh"))) {
    throw new Error(`REPO_ROOT ${REPO_ROOT} does not contain infra/kubo/setup.sh`);
  }
  const names = options.replicaNames ?? ["a", "b", "c"];
  const workDir = mkdtempSync(join(tmpdir(), "spiral-h2-topology-"));
  const networkName = `spiral-h2-${randomBytes(4).toString("hex")}`;
  const containers: string[] = [];
  let networkCreated = false;

  const stop = async () => {
    for (const id of containers) await docker(["rm", "-f", id]).catch(() => {});
    if (networkCreated) await docker(["network", "rm", networkName]).catch(() => {});
    rmSync(workDir, { recursive: true, force: true });
  };

  try {
    const keyPath = join(workDir, "id_ed25519");
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    const swarmKeyPath = join(workDir, "swarm.key");
    writeFileSync(
      swarmKeyPath,
      `/key/swarm/psk/1.0.0/\n/base16/\n${randomBytes(32).toString("hex")}\n`,
    );

    const buildDir = join(workDir, "build");
    mkdirSync(buildDir, { recursive: true });
    copyFileSync(join(NODE_IMAGE_DIR, "Dockerfile"), join(buildDir, "Dockerfile"));
    copyFileSync(join(REPO_ROOT, "infra/kubo/setup.sh"), join(buildDir, "setup.sh"));
    copyFileSync(join(REPO_ROOT, "infra/kubo/ipfs.service"), join(buildDir, "ipfs.service"));
    writeFileSync(join(buildDir, "pnet.conf"), "[Service]\nEnvironment=LIBP2P_FORCE_PNET=1\n");
    await docker(["build", "-q", "-t", NODE_IMAGE, buildDir], 900_000);

    await docker(["network", "create", networkName]);
    networkCreated = true;

    const kuboNode = async (extra: string[], publish: string[]) => {
      const script = [
        "ipfs init --profile server --algorithm ed25519 >/dev/null",
        "cp /swarm.key $IPFS_PATH/swarm.key",
        ...PRIVATE_OVERLAY,
        ...extra,
        "exec ipfs daemon",
      ].join(" && ");
      const { stdout } = await docker([
        "run",
        "-d",
        "--rm",
        "--network",
        networkName,
        "-e",
        "LIBP2P_FORCE_PNET=1",
        "-v",
        `${swarmKeyPath}:/swarm.key:ro`,
        ...publish.flatMap((p) => ["-p", p]),
        "--entrypoint",
        "sh",
        KUBO_IMAGE,
        "-c",
        script,
      ]);
      const id = stdout.trim();
      containers.push(id);
      return id;
    };

    const network = await kuboNode(
      [`ipfs config --json Routing '{"Type":"dhtserver","AcceleratedDHTClient":false}'`],
      ["127.0.0.1::5001"],
    );
    const networkApi = `http://127.0.0.1:${await publishedPort(network, 5001)}`;
    await waitFor("network node API", apiReady(networkApi));
    const networkNodeIp = await containerIp(network, networkName);
    const bootstrap = `/ip4/${networkNodeIp}/tcp/4001/p2p/${await peerIdOf(networkApi)}`;

    const gateway = await kuboNode(
      [
        `ipfs bootstrap add ${bootstrap}`,
        `ipfs config --json Routing '{"Type":"dhtclient"}'`,
        "ipfs config --json Provide.Enabled false",
        "ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080",
      ],
      [],
    );
    const gatewayIp = await containerIp(gateway, networkName);

    const replicas: Topology["replicas"] = [];
    const replicaApiUrls: Record<string, string> = {};
    for (const name of names) {
      const { stdout } = await docker([
        "run",
        "-d",
        "--rm",
        "--network",
        networkName,
        "--privileged",
        "--cgroupns=host",
        "-v",
        "/sys/fs/cgroup:/sys/fs/cgroup:rw",
        "-v",
        `${swarmKeyPath}:/swarm.key:ro`,
        "-v",
        `${keyPath}.pub:/authorized_keys.pub:ro`,
        "-p",
        "127.0.0.1::22",
        "-p",
        "127.0.0.1::5001",
        NODE_IMAGE,
      ]);
      const id = stdout.trim();
      containers.push(id);
      await waitFor(
        `systemd in ${name}`,
        async () =>
          (await docker(["exec", id, "systemctl", "is-active", "ssh"])).stdout.trim() === "active",
      );
      await docker([
        "exec",
        id,
        "install",
        "-o",
        "spiral",
        "-g",
        "spiral",
        "-m",
        "600",
        "/authorized_keys.pub",
        "/home/spiral/.ssh/authorized_keys",
      ]);
      const sshPort = await publishedPort(id, 22);
      await waitFor(`ssh login to ${name}`, async () => {
        await execFileAsync("ssh", [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-p",
          String(sshPort),
          "-i",
          keyPath,
          "spiral@127.0.0.1",
          "true",
        ]);
        return true;
      });
      const configure = [
        "export IPFS_PATH=/home/ipfs/.ipfs",
        "spiral-kubo-setup >/dev/null",
        "cp /swarm.key $IPFS_PATH/swarm.key",
        ...PRIVATE_OVERLAY,
        `ipfs bootstrap add ${bootstrap}`,
        `ipfs config --json Routing '{"Type":"dhtserver","AcceleratedDHTClient":false}'`,
      ].join(" && ");
      await docker(["exec", id, "su", "ipfs", "-c", configure]);
      await docker(["exec", id, "sh", "-c", "systemctl daemon-reload && systemctl start ipfs"]);
      const apiUrl = `http://127.0.0.1:${await publishedPort(id, 5001)}`;
      await waitFor(`replica ${name} API`, apiReady(apiUrl));
      replicaApiUrls[name] = apiUrl;
      replicas.push({
        name,
        peer_id: await peerIdOf(apiUrl),
        service: "ipfs",
        ssh: {
          host: "127.0.0.1",
          port: sshPort,
          user: "spiral",
          identity_file: keyPath,
          insecure_host_key_checking: true,
        },
      });
    }

    const topology = topologySchema.parse({
      topology_version: 1,
      replicas,
      network_node: { api_url: networkApi, bootstrap_multiaddr: bootstrap },
      gateway_url: `http://${gatewayIp}:8080`,
      rpc_url: options.rpcUrlForContainers,
      executor: {
        image: DEFAULT_EXECUTOR_IMAGE,
        docker_network: networkName,
        add_hosts: options.addHosts,
        swarm_key_path: swarmKeyPath,
        block_cidrs: [],
        repo_root: REPO_ROOT,
      },
    });
    return { topology, replicaApiUrls, networkNodeIp, networkName, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
