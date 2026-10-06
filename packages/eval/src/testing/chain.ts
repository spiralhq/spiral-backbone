import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, lamports, type Address } from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { surfpool } from "@solana/surfpool/kit";
import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";

export const SPIRAL_PROGRAMS_DEPLOY_DIR = join(
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

function e2eSkipReason(): string | undefined {
  const missing = ["organization.so", "film.so"].filter(
    (name) => !existsSync(join(SPIRAL_PROGRAMS_DEPLOY_DIR, name)),
  );
  if (missing.length > 0) {
    return `spiral-programs build artifacts not found in ${SPIRAL_PROGRAMS_DEPLOY_DIR} (missing: ${missing.join(", ")}).`;
  }
  try {
    execFileSync("solana-keygen", ["--version"], { stdio: "ignore" });
  } catch {
    return "solana-keygen not found on PATH.";
  }
  return undefined;
}

/** See docs/solana-kit-notes.md#testing-against-surfpool. */
export function shouldSkipE2e(suite: string): boolean {
  const reason = e2eSkipReason();
  if (!reason) return false;
  if (process.env["SPIRAL_E2E"] === "required") {
    throw new Error(`[e2e] SPIRAL_E2E=required but a prerequisite is missing: ${reason}`);
  }
  console.warn(`[e2e] Skipping ${suite}: ${reason}`);
  return true;
}

export interface LocalChain {
  rpcUrl: string;
  wsUrl: string;
  keypairPath: string;
  payer: Address;
  workDir: string;
  stop: () => void;
}

export async function startLocalChain(): Promise<LocalChain> {
  const surfnet = await createClient().use(surfpool({ surfnet: { offline: true } }));
  const workDir = mkdtempSync(join(tmpdir(), "spiral-eval-e2e-"));
  const stop = () => {
    try {
      surfnet.surfnet.stop();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };
  try {
    surfnet.surfnet.deploy({
      programId: ORGANIZATION_PROGRAM_ADDRESS,
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "organization.so"),
    });
    surfnet.surfnet.deploy({
      programId: FILM_PROGRAM_ADDRESS,
      soPath: join(SPIRAL_PROGRAMS_DEPLOY_DIR, "film.so"),
    });
    const keypairPath = join(workDir, "payer.json");
    execFileSync("solana-keygen", [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      keypairPath,
    ]);
    const { payer } = await createClient().use(signerFromFile(keypairPath));
    await surfnet.airdrop(payer.address, lamports(100_000_000_000n));
    return {
      rpcUrl: surfnet.rpcUrl,
      wsUrl: surfnet.wsUrl,
      keypairPath,
      payer: payer.address,
      workDir,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
