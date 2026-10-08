import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPeerId,
  inventoryRecordSchema,
  type InventoryRecord,
} from "@spiral-backbone/protocol";
import {
  FILM_PROGRAM_ADDRESS,
  FilmInstruction,
  identifyFilmInstruction,
} from "@spiral-backbone/protocol/generated/film";
import { createClient, lamports, type Instruction } from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { surfpool } from "@solana/surfpool/kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { create } from "../commands/org/create";
import { submit } from "../commands/submit";
import { fetch_ } from "../commands/fetch/index";
import { verify } from "../commands/verify";
import { startKuboContainer, type KuboContainer } from "../../../eval/src/kubo-node";

const sendHook = vi.hoisted(() => ({
  failAtDeclare: false,
  sent: [] as { kind: string; signature: string }[],
}));

vi.mock("../lib/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/client")>();
  return {
    ...original,
    createSpiralClient: async (options: Parameters<typeof original.createSpiralClient>[0]) => {
      const client = await original.createSpiralClient(options);
      const sendTransaction = async (instructions: Instruction[]) => {
        const [first] = instructions;
        const kind =
          first?.programAddress === FILM_PROGRAM_ADDRESS && first.data
            ? FilmInstruction[identifyFilmInstruction(first.data)]!
            : "other";
        if (kind === "DeclareReplica" && sendHook.failAtDeclare) {
          sendHook.failAtDeclare = false;
          throw new Error("injected failure before declare_replica");
        }
        const result = await client.sendTransaction(instructions);
        sendHook.sent.push({ kind, signature: result.context.signature });
        return result;
      };
      return { ...client, sendTransaction } as typeof client;
    },
  };
});

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
  let drain: NodeJS.Timeout | undefined;
  let kubo: KuboContainer;
  let workDir: string;
  let keypairPath: string;
  let rpcUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    surfnet = await createSurfnetClient();
    // Undrained simnet events stall the surfnet after ~1000 slots; see docs/solana-kit-notes.md.
    drain = setInterval(() => surfnet.surfnet.drainEvents(), 1_000);
    drain.unref();

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
    clearInterval(drain);
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

    const content = new TextEncoder().encode("spiral e2e content");
    const filePath = join(workDir, "content.bin");
    writeFileSync(filePath, content);
    const manifestPath = join(workDir, "manifest.json");
    writeManifest(manifestPath, "pd-901", content);

    const submitOutput = await captureConsole(() =>
      submit.parseAsync(
        [
          "--org",
          slug,
          "--work-id",
          "pd-901",
          "--manifest",
          manifestPath,
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
    const inventory = inventoryRecordSchema.parse(JSON.parse(submitOutput.trim()));
    const filmPda = inventory.film_pda;
    const kuboPeer = await fetchPeerId(kubo.apiUrl);
    expect(inventory.work_id).toBe("pd-901");
    expect(inventory.replica_count).toBe(1);
    expect(inventory.replicas).toEqual([
      {
        slot: 0,
        peer_id_hex: Buffer.from(kuboPeer.bytes).toString("hex"),
        peer_id_len: 38,
        declared_at: expect.stringMatching(/^\d+$/),
        active: true,
      },
    ]);
    expect(inventory.replica_signatures).toHaveLength(1);

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
    // Dedicated org so this test stays independent of execution order.
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
    const strangerContent = new TextEncoder().encode("should be rejected before any tx");
    writeFileSync(filePath, strangerContent);
    const strangerManifestPath = join(workDir, "stranger-manifest.json");
    writeManifest(strangerManifestPath, "pd-902", strangerContent);

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
            "--work-id",
            "pd-902",
            "--manifest",
            strangerManifestPath,
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

  it("resumes an interrupted submit to the same golden line as an uninterrupted one", async () => {
    const content = new TextEncoder().encode("spiral e2e resumable content");
    const filePath = join(workDir, "resumable.bin");
    writeFileSync(filePath, content);
    const manifestPath = join(workDir, "resumable-manifest.json");
    writeManifest(manifestPath, "pd-903", content);
    const stamp = Date.now();
    const straightSlug = `e2e-straight-${stamp}`;
    const resumedSlug = `e2e-resumed-${stamp}`;
    for (const slug of [straightSlug, resumedSlug]) await createOrg(slug);

    const submitArgs = (slug: string) => [
      "--org",
      slug,
      "--work-id",
      "pd-903",
      "--manifest",
      manifestPath,
      "--file",
      filePath,
      "--title",
      "E2E Resumable Film",
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
    ];
    const runSubmit = (slug: string) =>
      captureConsole(() => submit.parseAsync(submitArgs(slug), { from: "user" }));
    const takeSent = () => sendHook.sent.splice(0);

    takeSent();
    const straight = inventoryRecordSchema.parse(
      JSON.parse((await runSubmit(straightSlug)).trim()),
    );
    const straightSent = takeSent();
    expect(straightSent.map((s) => s.kind)).toEqual(["RegisterFilm", "DeclareReplica"]);
    expect(straight.register_signature).toBe(straightSent[0]!.signature);
    expect(straight.replica_signatures).toEqual([straightSent[1]!.signature]);

    sendHook.failAtDeclare = true;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(submit.parseAsync(submitArgs(resumedSlug), { from: "user" })).rejects.toThrow(
        "process.exit called",
      );
      expect(logSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errors = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errors).toContain("injected failure before declare_replica");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      sendHook.failAtDeclare = false;
    }
    const interruptedSent = takeSent();
    expect(interruptedSent.map((s) => s.kind)).toEqual(["RegisterFilm"]);

    const resumed = inventoryRecordSchema.parse(JSON.parse((await runSubmit(resumedSlug)).trim()));
    const resumedSent = takeSent();
    expect(resumedSent.map((s) => s.kind)).toEqual(["DeclareReplica"]);
    expect(resumed.register_signature).toBe(interruptedSent[0]!.signature);
    expect(resumed.replica_signatures).toEqual([resumedSent[0]!.signature]);
    expect(withoutRunSpecifics(resumed)).toEqual(withoutRunSpecifics(straight));

    const again = inventoryRecordSchema.parse(JSON.parse((await runSubmit(resumedSlug)).trim()));
    expect(takeSent()).toEqual([]);
    expect({ ...again, captured_at: "" }).toEqual({ ...resumed, captured_at: "" });
  }, 120_000);

  async function createOrg(slug: string): Promise<void> {
    await create.parseAsync(
      [
        "--slug",
        slug,
        "--name",
        "E2E Org",
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
  }
});

/** Timestamps, plus what differs only because the two Films live in different organizations. */
function withoutRunSpecifics(record: InventoryRecord) {
  return {
    ...record,
    film_pda: "",
    bump: 0,
    organization: "",
    register_signature: "",
    replica_signatures: record.replica_signatures.map(() => ""),
    submitted_at: "",
    captured_at: "",
    replicas: record.replicas.map((replica) => ({ ...replica, declared_at: "" })),
  };
}

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

function writeManifest(path: string, workId: string, content: Uint8Array): void {
  writeFileSync(
    path,
    JSON.stringify({
      works: [
        {
          work_id: workId,
          size_bytes: content.byteLength,
          size_band: "small",
          cold_cid: false,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    }),
  );
}
