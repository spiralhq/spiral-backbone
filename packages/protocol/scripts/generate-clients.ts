import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const PROGRAM_NAMES = ["organization", "film"] as const;
const PROTOCOL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const IDL_DIR = join(PROTOCOL_DIR, "src", "idl");
const GENERATED_OUT_DIR = join(PROTOCOL_DIR, "src", "generated");

export async function generateClients(
  idlDir: string = IDL_DIR,
  outDir: string = GENERATED_OUT_DIR,
): Promise<void> {
  for (const name of PROGRAM_NAMES) {
    const idlPath = join(idlDir, `${name}.json`);
    const idl = JSON.parse(readFileSync(idlPath, "utf8"));
    const codama = createFromRoot(rootNodeFromAnchor(idl));
    // Flat output layout — see docs/solana-kit-notes.md#renderVisitors-default-output-layout.
    await codama.accept(
      renderVisitor(join(outDir, name), {
        generatedFolder: ".",
        syncPackageJson: false,
      }),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await generateClients();
  console.log(`Generated clients for: ${PROGRAM_NAMES.join(", ")}`);
}
