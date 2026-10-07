import { randomBytes } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { artifactVersions, type InventoryRecord } from "@spiral-backbone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldSkipE2e, startLocalChain, type LocalChain } from "../../testing/chain";
import { createOrg, submitForTest } from "../../testing/submit";
import { HOST_GATEWAY_ADD_HOST, startRpcRelay } from "../testing/rpc-relay";
import { startLocalTopology, type LocalTopology } from "../testing/local-topology";
import type { AttemptPayload } from "./attempt";
import { buildExecutorImage } from "./image";
import type { Provenance } from "./provenance";
import { ExecutorFault, ExecutorRefused, runExecutorContainer } from "./run-container";

const skip = shouldSkipE2e("H2 executor end-to-end");

describe.skipIf(skip)("H2 executor container", () => {
  let chain: LocalChain;
  let relay: Awaited<ReturnType<typeof startRpcRelay>>;
  let local: LocalTopology;
  let work: InventoryRecord;

  const payload = (overrides: Partial<AttemptPayload>): AttemptPayload => ({
    run_id: "2026-10-06T12:00:00Z-h2-exec",
    attempt_id: "t/pd-901/direct/r1",
    scenario: "t@g1",
    work_id: work.work_id,
    film_pda: work.film_pda,
    size_bytes: Number(work.byte_size),
    size_band: work.size_band,
    method: "direct",
    repetition: 1,
    timeout_ms: 60_000,
    gateway_eligible: true,
    active_replicas: 3,
    rpc_url: relay.urlForContainers,
    gateway_url: local.topology.gateway_url,
    bootstrap_multiaddr: local.topology.network_node.bootstrap_multiaddr,
    private_network: true,
    artifact_versions: artifactVersions(),
    ...overrides,
  });

  beforeAll(async () => {
    chain = await startLocalChain();
    relay = await startRpcRelay(chain.rpcUrl);
    local = await startLocalTopology({
      rpcUrlForContainers: relay.urlForContainers,
      addHosts: [HOST_GATEWAY_ADD_HOST],
    });
    await buildExecutorImage();
    await createOrg(chain, "h2-exec");
    work = await submitForTest({
      chain,
      slug: "h2-exec",
      workId: "pd-901",
      content: randomBytes(700_000),
      title: "H2 executor",
      kuboUrls: Object.values(local.replicaApiUrls),
    });
  }, 900_000);

  afterAll(async () => {
    await local?.stop();
    await relay?.stop();
    chain?.stop();
  }, 120_000);

  it("recovers directly from the declared replicas, with provenance", async () => {
    const out = await runExecutorContainer(payload({}), local.topology.executor);
    expect(out.record).toMatchObject({
      hypothesis: "H2",
      outcome: "success",
      failure_class: null,
      cid_observed: work.cid,
    });
    const prov = out.evidence["provenance"] as Provenance;
    const rows = prov.peers;
    expect(rows.some((r) => r.declared && r.bytes_received > 0)).toBe(true);
    expect(rows.every((r) => r.declared || r.bytes_received === 0)).toBe(true);
    expect(prov.data_received).toBeGreaterThan(0);
    const declaredTotal = rows
      .filter((r) => r.declared)
      .reduce((sum, r) => sum + r.bytes_received, 0);
    expect(prov.ledger_declared_total).toBe(declaredTotal);
    expect(prov.ledger_undeclared_total).toBe(0);
    expect(prov.dag_size).toBeGreaterThan(Number(work.byte_size));
    expect(declaredTotal).toBeGreaterThanOrEqual(prov.dag_size ?? Infinity);
    expect(prov.unattributed).toBe(prov.data_received - declaredTotal);
    expect(out.evidence["active_replicas"]).toBe(3);
    expect(out.record.rpc_endpoint).toBe(new URL(relay.urlForContainers).host);
  }, 180_000);

  it("recovers through the gateway and records its headers", async () => {
    const out = await runExecutorContainer(
      payload({ method: "gateway", attempt_id: "t/pd-901/gateway/r1" }),
      local.topology.executor,
    );
    expect(out.record.outcome).toBe("success");
    expect((out.evidence["gateway_headers"] as Record<string, string>)["x-ipfs-roots"]).toBe(
      work.cid,
    );
  }, 180_000);

  it("refuses a gateway attempt that is not gateway-eligible", async () => {
    await expect(
      runExecutorContainer(
        payload({ method: "gateway", gateway_eligible: false }),
        local.topology.executor,
      ),
    ).rejects.toBeInstanceOf(ExecutorRefused);
  }, 120_000);

  it("faults instead of recording when the Film account does not exist", async () => {
    const missing = (await generateKeyPairSigner()).address;
    const error = await runExecutorContainer(
      payload({ film_pda: missing }),
      local.topology.executor,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutorFault);
    expect((error as Error).message).toMatch(/executor fault: .*(not found|Account)/i);
  }, 120_000);

  it("faults instead of recording when the registry RPC answers with an HTTP error", async () => {
    const error = await runExecutorContainer(
      payload({ rpc_url: `${local.topology.gateway_url.replace(/\/$/, "")}/not-an-rpc` }),
      local.topology.executor,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutorFault);
    expect((error as Error).message).toMatch(/executor fault: .*HTTP/i);
  }, 120_000);

  it("applies the firewall: blocking the only bootstrap makes a direct attempt fail", async () => {
    const blocked = { ...local.topology.executor, block_cidrs: [`${local.networkNodeIp}/32`] };
    const out = await runExecutorContainer(payload({ timeout_ms: 15_000 }), blocked);
    expect(out.record.outcome).toBe("failure");
    expect(["timeout", "object_unavailable", "connection_error"]).toContain(
      out.record.failure_class,
    );
  }, 180_000);
});
