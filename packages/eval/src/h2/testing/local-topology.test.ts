import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWithSpiralProfile } from "../../kubo-client";
import { findProviderIds } from "../probes";
import { checkState, networkProviderProbe, sshReplicaController } from "../state";
import { startLocalTopology, type LocalTopology } from "./local-topology";

describe("local H2 topology (Docker)", () => {
  let local: LocalTopology;

  beforeAll(async () => {
    local = await startLocalTopology({
      rpcUrlForContainers: "http://host.docker.internal:1",
      addHosts: [],
    });
  }, 600_000);

  afterAll(async () => {
    await local?.stop();
  }, 120_000);

  it("brings three replicas up, observable over SSH and from the network node", async () => {
    const controller = sshReplicaController(local.topology, { pingTimeoutMs: 10_000 });
    for (const replica of local.topology.replicas) {
      expect(await controller.observe(replica.name)).toEqual({
        node: replica.name,
        systemd_active: true,
        swarm_reachable: true,
      });
    }
  }, 120_000);

  it("announces content added to the replicas and confirms a degraded state", async () => {
    const content = randomBytes(600_000);
    let cid = "";
    for (const url of Object.values(local.replicaApiUrls))
      cid = (await addWithSpiralProfile(url, content)).toString();

    const expected = new Set(local.topology.replicas.map((r) => r.peer_id));
    let found = new Set<string>();
    for (let i = 0; i < 30 && [...expected].some((p) => !found.has(p)); i++) {
      found = await findProviderIds(local.topology.network_node.api_url, cid, 5_000);
    }
    expect([...expected].every((p) => found.has(p))).toBe(true);

    const controller = sshReplicaController(local.topology, { pingTimeoutMs: 10_000 });
    await controller.stop("c");
    const check = await checkState(
      controller,
      networkProviderProbe(local.topology, 15_000),
      local.topology,
      ["a", "b"],
      [cid],
    );
    expect(check.reasons).toEqual([]);
    expect(check.confirmed).toBe(true);
    await controller.start("c");
  }, 240_000);
});
