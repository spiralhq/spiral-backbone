import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";

export function createH3Client(keypairPath: string, rpcUrl: string, wsUrl?: string) {
  return createClient()
    .use(signerFromFile(keypairPath))
    .use(solanaRpc(wsUrl ? { rpcUrl, rpcSubscriptionsUrl: wsUrl } : { rpcUrl }));
}

export type H3Client = Awaited<ReturnType<typeof createH3Client>>;
