import { createSolanaRpc } from "@solana/kit";
import { redact, secretsOfUrls } from "./redact";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export async function fetchGenesis(rpcUrl: string): Promise<string> {
  return createSolanaRpc(rpcUrl).getGenesisHash().send();
}

export async function assertExpectedCluster(
  rpcUrl: string,
  expectedGenesis: string,
): Promise<void> {
  try {
    const genesis = await fetchGenesis(rpcUrl);
    if (genesis !== expectedGenesis) {
      throw new Error(`genesis ${genesis} does not match expected ${expectedGenesis}`);
    }
  } catch (error) {
    throw new Error(redact((error as Error).message, secretsOfUrls([rpcUrl])));
  }
}
