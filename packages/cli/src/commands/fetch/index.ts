import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { address } from "@solana/kit";
import { bytesToCidString } from "@spiral-backbone/protocol";
import { fetchMaybeFilm } from "@spiral-backbone/protocol/generated/film";
import { create as createKuboClient } from "kubo-rpc-client";
import { Command } from "commander";
import { z } from "zod";
import { createReadOnlySpiralClient } from "../../lib/client";
import { CliError, handleCliError } from "../../lib/errors";

export const fetchOptionsSchema = z.object({
  film: z.string().min(1),
  out: z.string().min(1),
  method: z.enum(["direct", "gateway"]),
  cluster: z.enum(["devnet", "local"]),
  gatewayUrl: z.string().min(1),
  kuboUrl: z.string().min(1),
  rpcUrl: z.string().optional(),
});

export const fetch_ = new Command()
  .name("fetch")
  .description("recover a film's content from the account address alone, cold-start")
  .requiredOption("--film <pda>", "the Film account address")
  .requiredOption("--out <dir>", "directory to write the recovered file into")
  .option("--method <method>", "direct (Kubo RPC) or gateway (HTTP)", "direct")
  .option("--cluster <cluster>", "devnet or local", "devnet")
  .option(
    "--gateway-url <url>",
    "IPFS gateway base URL, used when --method=gateway",
    "https://ipfs.io",
  )
  .option("--kubo-url <url>", "Kubo RPC URL, used when --method=direct", "http://127.0.0.1:5001")
  .option("--rpc-url <url>", "override RPC URL (takes precedence over --cluster)")
  .action(async (opts) => {
    try {
      const options = fetchOptionsSchema.parse(opts);
      const client = await createReadOnlySpiralClient({
        cluster: options.cluster,
        rpcUrl: options.rpcUrl,
      });
      const filmAddress = address(options.film);

      const filmAccount = await fetchMaybeFilm(client.rpc, filmAddress);
      if (!filmAccount.exists) {
        throw new CliError(`No Film account found at ${options.film}.`);
      }

      const cidBytes = Uint8Array.from(filmAccount.data.cid);
      const cidString = bytesToCidString(cidBytes, filmAccount.data.cidLen);

      const content =
        options.method === "direct"
          ? await fetchViaKuboRpc(options.kuboUrl, cidString)
          : await fetchViaGateway(options.gatewayUrl, cidString);

      const outPath = join(options.out, cidString);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, content);

      console.log(`Recovered ${cidString} (${content.byteLength} bytes) to ${outPath}.`);
    } catch (error) {
      handleCliError(error);
    }
  });

async function fetchViaKuboRpc(kuboUrl: string, cidString: string): Promise<Uint8Array> {
  const client = createKuboClient({ url: kuboUrl });
  const chunks: Uint8Array[] = [];
  for await (const chunk of client.cat(cidString)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchViaGateway(gatewayUrl: string, cidString: string): Promise<Uint8Array> {
  const response = await globalThis.fetch(`${gatewayUrl.replace(/\/$/, "")}/ipfs/${cidString}`);
  if (!response.ok) {
    throw new CliError(`Gateway fetch failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
