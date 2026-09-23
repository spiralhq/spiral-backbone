import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, lamports } from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { surfpool } from "@solana/surfpool/kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { create } from "../commands/org/create";
import { submit } from "../commands/submit";
import { fetch_ } from "../commands/fetch/index";
import { verify } from "../commands/verify";
import { startKuboContainer, type KuboContainer } from "../../../eval/src/kubo-node";

const SPIRAL_PROGRAMS_DEPLOY_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "spiral-programs",
  "target",
  "deploy",
);

/** See docs/solana-kit-notes.md#testing-against-surfpool. */
function checkPrerequisites(): string | undefined {
  const missingSo = ["organization.so", "film.so"].filter(
    (name) => !existsSync(join(SPIRAL_PROGRAMS_DEPLOY_DIR, name)),
  );
  if (missingSo.length > 0) {
    return (
      `spiral-programs build artifacts not found in ${SPIRAL_PROGRAMS_DEPLOY_DIR} ` +
      `(missing: ${missingSo.join(", ")}). Check out spiral-programs as a sibling of this ` +
      "repo and run `anchor build` in it first."
    );
  }
  try {
    execFileSync("solana-keygen", ["--version"], { stdio: "ignore" });
  } catch {
    return "solana-keygen not found on PATH. Install the Solana CLI tools.";
  }
  return undefined;
}

const skipReason = checkPrerequisites();
if (skipReason) {
  if (process.env["SPIRAL_E2E"] === "required") {
    throw new Error(`[e2e] SPIRAL_E2E=required but a prerequisite is missing: ${skipReason}`);
  }
  console.warn(`[e2e] Skipping submit -> fetch -> verify: ${skipReason}`);
}

describe.skipIf(skipReason !== undefined)("submit -> fetch -> verify (end-to-end)", () => {
  let surfnet: Awaited<ReturnType<typeof createSurfnetClient>>;
  let kubo: KuboContainer;
  let workDir: string;
  let keypairPath: string;
  let rpcUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    surfnet = await createSurfnetClient();

    surfnet.surfnet.deploy({
      programId: "2JWb4r1LgykRNocsxVgfhysLtFtgjWvMRzceBDX79WCw",
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "organization.so"),
    });
    surfnet.surfnet.deploy({
      programId: "6MK8C7frTETvrmM5dhN6jkUyXdxcMAfTjKkhG1Y7Pcbu",
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "film.so"),
    });

    kubo = await startKuboContainer();
    workDir = mkdtempSync(join(tmpdir(), "spiral-e2e-"));
    rpcUrl = surfnet.rpcUrl;
    wsUrl = surfnet.wsUrl;

    keypairPath = join(workDir, "payer.json");
    execFileSync("solana-keygen", [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      keypairPath,
    ]);

    const fileClient = await createClient().use(signerFromFile(keypairPath));
    const payer = fileClient.payer;
    await surfnet.airdrop(payer.address, lamports(10_000_000_000n));
  }, 60_000);

  afterAll(async () => {
    if (surfnet) {
      try {
        surfnet.surfnet.stop();
      } catch (err) {
        console.error("[e2e] Failed to stop surfnet:", err);
      }
    }
    if (kubo) {
      try {
        await kubo.stop();
      } catch (err) {
        console.error("[e2e] Failed to stop Kubo container:", err);
      }
    }
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (err) {
        console.error("[e2e] Failed to remove work dir:", err);
      }
    }
  });

  it("submits, fetches, and verifies a film end-to-end", async () => {
    const slug = `e2e-${Date.now()}`;

    // initialize_organization also grants the creator an Admin Membership, so the
    // same keypair can submit next without a separate `org grant` step.
    await create.parseAsync(
      [
        "--slug",
        slug,
        "--name",
        "E2E Test Org",
        "--cluster",
        "local",
        "--rpc-url",
        rpcUrl,
        "--ws-url",
        wsUrl,
        "--keypair",
        keypairPath,
      ],
      { from: "user" },
    );

    const filePath = join(workDir, "content.bin");
    writeFileSync(filePath, new TextEncoder().encode("spiral e2e content"));

    const submitOutput = await captureConsole(() =>
      submit.parseAsync(
        [
          "--org",
          slug,
          "--file",
          filePath,
          "--title",
          "E2E Film",
          "--replicas",
          kubo.apiUrl,
          "--cluster",
          "local",
          "--rpc-url",
          rpcUrl,
          "--ws-url",
          wsUrl,
          "--keypair",
          keypairPath,
        ],
        { from: "user" },
      ),
    );
    const goldenRecord = JSON.parse(submitOutput.trim()) as { film_pda: string };
    const filmPda = goldenRecord.film_pda;

    const outDir = join(workDir, "recovered");
    await fetch_.parseAsync(
      [
        "--film",
        filmPda,
        "--out",
        outDir,
        "--method",
        "direct",
        "--cluster",
        "local",
        "--rpc-url",
        rpcUrl,
        "--kubo-url",
        kubo.apiUrl,
      ],
      { from: "user" },
    );

    const recoveredFiles = execFileSync("ls", [outDir], { encoding: "utf8" }).trim().split("\n");
    expect(recoveredFiles).toHaveLength(1);
    const recoveredPath = join(outDir, recoveredFiles[0]!);
    expect(readFileSync(recoveredPath)).toEqual(readFileSync(filePath));

    const verifyOutput = await captureConsole(() =>
      verify.parseAsync(
        ["--film", filmPda, "--file", recoveredPath, "--cluster", "local", "--rpc-url", rpcUrl],
        { from: "user" },
      ),
    );
    expect(verifyOutput).toContain("On-chain CID:");
    expect(verifyOutput).toContain("Match.");
  }, 60_000);

  it("rejects a submitter with no active Membership before building a transaction", async () => {
    // Acceptance criterion 7. Dedicated org so this test stays independent of execution order.
    const strangerSlug = `e2e-stranger-${Date.now()}`;
    await create.parseAsync(
      [
        "--slug",
        strangerSlug,
        "--name",
        "E2E Stranger Org",
        "--cluster",
        "local",
        "--rpc-url",
        rpcUrl,
        "--ws-url",
        wsUrl,
        "--keypair",
        keypairPath,
      ],
      { from: "user" },
    );

    const strangerKeypairPath = join(workDir, "stranger.json");
    execFileSync("solana-keygen", [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      strangerKeypairPath,
    ]);
    const strangerClient = await createClient().use(signerFromFile(strangerKeypairPath));
    await surfnet.airdrop(strangerClient.payer.address, lamports(10_000_000_000n));

    const filePath = join(workDir, "stranger-content.bin");
    writeFileSync(filePath, new TextEncoder().encode("should be rejected before any tx"));

    // handleCliError calls process.exit(1) — mock it to throw instead so the rejection is
    // observable, and capture console.error to inspect the message it wrote.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        submit.parseAsync(
          [
            "--org",
            strangerSlug,
            "--file",
            filePath,
            "--title",
            "Stranger Film",
            "--replicas",
            kubo.apiUrl,
            "--cluster",
            "local",
            "--rpc-url",
            rpcUrl,
            "--ws-url",
            wsUrl,
            "--keypair",
            strangerKeypairPath,
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("process.exit called");

      const errorOutput = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("no membership");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 60_000);
});

function createSurfnetClient() {
  return createClient().use(surfpool({ surfnet: { offline: true } }));
}

/** Commander commands print via console.log; capture it instead of parsing stdout piping. */
async function captureConsole(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
