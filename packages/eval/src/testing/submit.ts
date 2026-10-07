import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inventoryRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { create } from "../../../cli/src/commands/org/create";
import { submit } from "../../../cli/src/commands/submit";
import type { LocalChain } from "./chain";

function chainFlags(chain: LocalChain): string[] {
  return [
    "--cluster",
    "local",
    "--rpc-url",
    chain.rpcUrl,
    "--ws-url",
    chain.wsUrl,
    "--keypair",
    chain.keypairPath,
  ];
}

export async function createOrg(chain: LocalChain, slug: string): Promise<void> {
  await create.parseAsync(["--slug", slug, "--name", `Org ${slug}`, ...chainFlags(chain)], {
    from: "user",
  });
}

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
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

export async function submitForTest(input: {
  chain: LocalChain;
  slug: string;
  workId: string;
  content: Uint8Array;
  title: string;
  kuboUrls: string[];
  coldCid?: boolean;
}): Promise<InventoryRecord> {
  const filePath = join(input.chain.workDir, `${input.workId}.bin`);
  writeFileSync(filePath, input.content);
  const manifestPath = join(input.chain.workDir, `${input.workId}.manifest.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      works: [
        {
          work_id: input.workId,
          size_bytes: input.content.byteLength,
          size_band: "small",
          cold_cid: input.coldCid ?? false,
          sha256: createHash("sha256").update(input.content).digest("hex"),
        },
      ],
    }),
  );
  const stdout = await captureStdout(() =>
    submit.parseAsync(
      [
        "--org",
        input.slug,
        "--work-id",
        input.workId,
        "--manifest",
        manifestPath,
        "--file",
        filePath,
        "--title",
        input.title,
        "--replicas",
        input.kuboUrls.join(","),
        ...chainFlags(input.chain),
      ],
      { from: "user" },
    ),
  );
  return inventoryRecordSchema.parse(JSON.parse(stdout.trim()));
}
