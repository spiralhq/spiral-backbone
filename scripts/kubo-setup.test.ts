import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("../infra/kubo/setup.sh", import.meta.url));
const KUBO_IMAGE = "ipfs/kubo:v0.43.1";

function runInKubo(script: string) {
  return execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${SCRIPT_PATH}:/usr/local/bin/spiral-kubo-setup.sh:ro`,
      "--entrypoint",
      "/bin/sh",
      KUBO_IMAGE,
      "-c",
      script,
    ],
    { timeout: 120_000 },
  );
}

describe("infra/kubo/setup.sh", () => {
  it("runs twice against a fresh IPFS_PATH without error and applies the expected config", async () => {
    const { stdout } = await runInKubo(
      "/usr/local/bin/spiral-kubo-setup.sh && /usr/local/bin/spiral-kubo-setup.sh && ipfs config show",
    );
    const config = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(config.Routing.Type).toBe("dhtserver");
    expect(config.Routing.AcceleratedDHTClient).toBe(true);
    expect(config.Provide.Strategy).toBe("pinned");
    expect(config.Provide.DHT.Interval).toBe("12h");
    expect(config.Reprovider ?? null).toBeNull();
    expect(config.Swarm.ConnMgr.LowWater).toBe(200);
    expect(config.Swarm.ConnMgr.HighWater).toBe(600);
    expect(config.Datastore.GCPeriod).toBe("0");
  }, 120_000);

  it("leaves a repo the Kubo 0.43.1 daemon actually starts with", async () => {
    const { stdout } = await runInKubo(
      "/usr/local/bin/spiral-kubo-setup.sh >/dev/null && " +
        "(ipfs daemon --offline > /tmp/daemon.log 2>&1 &) && " +
        "for i in $(seq 1 60); do grep -q 'Daemon is ready' /tmp/daemon.log && break; sleep 0.5; done; " +
        "cat /tmp/daemon.log",
    );
    expect(stdout).toContain("Daemon is ready");
    expect(stdout).not.toMatch(/deprecated configuration/i);
  }, 120_000);
});
