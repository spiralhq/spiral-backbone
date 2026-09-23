import { createClient } from "@solana/kit";
import {
  solanaDevnetRpc,
  solanaLocalRpc,
  solanaRpc,
  solanaRpcConnection,
} from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const LOCAL_RPC_URL = "http://127.0.0.1:8899";

export interface CreateClientOptions {
  cluster: "devnet" | "local";
  keypairPath: string;
  /** Overrides --cluster with an arbitrary RPC URL. */
  rpcUrl?: string;
  /** See docs/solana-kit-notes.md#rpc-and-websocket-url-resolution. */
  rpcSubscriptionsUrl?: string;
}

/** `solanaDevnetRpc()`/`solanaLocalRpc()` don't expose their resolved URL on the client,
 * so callers that need it (e.g. to record it in output) recompute it here instead. */
export function resolveRpcUrl(options: Pick<CreateClientOptions, "cluster" | "rpcUrl">): string {
  return options.rpcUrl ?? (options.cluster === "devnet" ? DEVNET_RPC_URL : LOCAL_RPC_URL);
}

export async function createSpiralClient(options: CreateClientOptions) {
  const base = createClient().use(signerFromFile(options.keypairPath));
  if (options.rpcUrl) {
    return base.use(
      solanaRpc(
        options.rpcSubscriptionsUrl
          ? { rpcUrl: options.rpcUrl, rpcSubscriptionsUrl: options.rpcSubscriptionsUrl }
          : { rpcUrl: options.rpcUrl },
      ),
    );
  }
  return options.cluster === "devnet" ? base.use(solanaDevnetRpc()) : base.use(solanaLocalRpc());
}

export type SpiralClient = Awaited<ReturnType<typeof createSpiralClient>>;

export interface CreateReadOnlyClientOptions {
  cluster: "devnet" | "local";
  rpcUrl?: string;
}

/** For fetch/verify: read-only, no keypair — see docs/solana-kit-notes.md#read-only-vs-signing-clients. */
export async function createReadOnlySpiralClient(options: CreateReadOnlyClientOptions) {
  const rpcUrl = options.rpcUrl ?? (options.cluster === "devnet" ? DEVNET_RPC_URL : LOCAL_RPC_URL);
  return createClient().use(solanaRpcConnection({ rpcUrl }));
}
