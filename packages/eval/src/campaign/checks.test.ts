import { describe, expect, it } from "vitest";
import { secretsOfUrls } from "../common/redact";
import { renderChecks, runChecks, type Check } from "./checks";

const ok = (name: string): Check => ({ stage: "infra", name, run: async () => "fine" });
const bad = (name: string, message: string): Check => ({
  stage: "infra",
  name,
  run: async () => {
    throw new Error(message);
  },
});

describe("runChecks", () => {
  it("runs every check, turns throws into blocked results and redacts secrets", async () => {
    const results = await runChecks(
      [ok("a"), bad("b", "https://rpc.example/KEY failed"), ok("c")],
      ["https://rpc.example/KEY"],
    );
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
    expect(results[1]!.detail).not.toContain("KEY");
  });

  it("runs checks sequentially", async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number): Check => ({
      stage: "h2",
      name,
      run: async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        return name;
      },
    });
    await runChecks([slow("a", 20), slow("b", 0)], []);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });
});

describe("renderChecks", () => {
  it("states READY only when every check passed", async () => {
    expect(renderChecks(await runChecks([ok("a")], []))).toContain("Pre-flight: READY");
    expect(renderChecks(await runChecks([ok("a"), bad("b", "x")], []))).toContain(
      "Pre-flight: BLOCKED (1 of 2 checks failed)",
    );
  });

  it("renders one table row per check and escapes pipes", async () => {
    const text = renderChecks(await runChecks([ok("a"), bad("b", "x|y\nz")], []));
    expect(text).toContain("| stage | check | status | detail |");
    expect(text).toContain("| infra | a | OK | fine |");
    expect(text).toContain("| infra | b | BLOCKED | x\\|y z |");
  });
});

describe("secretsOfUrls", () => {
  it("lets runChecks strip a bare RPC URL with an API key from details", async () => {
    const rpcUrl = "https://devnet.helius-rpc.com/?api-key=SECRET123";
    const results = await runChecks(
      [
        bad(
          "rpc",
          `request to ${rpcUrl} failed; host devnet.helius-rpc.com; key ?api-key=SECRET123`,
        ),
      ],
      secretsOfUrls([rpcUrl]),
    );
    expect(results[0]!.detail).not.toContain("SECRET123");
    expect(results[0]!.detail).not.toContain("helius");
  });
});
