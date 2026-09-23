import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateClients } from "./generate-clients";

const PROTOCOL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_IDL_DIR = join(PROTOCOL_DIR, "src", "idl");

let fakeIdlDir: string | undefined;
let fakeOutDir: string | undefined;

afterEach(() => {
  if (fakeIdlDir) rmSync(fakeIdlDir, { recursive: true, force: true });
  if (fakeOutDir) rmSync(fakeOutDir, { recursive: true, force: true });
  fakeIdlDir = undefined;
  fakeOutDir = undefined;
});

// Copies the real committed IDL into a temp dir — the golden PDA value asserted below is
// derived from the real program address baked into it, which a synthetic IDL can't reproduce.
function setUpFakeDirs(): { idlDir: string; outDir: string } {
  fakeIdlDir = mkdtempSync(join(tmpdir(), "fake-protocol-idl-"));
  fakeOutDir = mkdtempSync(join(tmpdir(), "fake-protocol-generated-"));
  copyFileSync(join(REAL_IDL_DIR, "organization.json"), join(fakeIdlDir, "organization.json"));
  copyFileSync(join(REAL_IDL_DIR, "film.json"), join(fakeIdlDir, "film.json"));
  return { idlDir: fakeIdlDir, outDir: fakeOutDir };
}

describe("generateClients", () => {
  it("produces the expected PDA finders and instruction builders for organization", async () => {
    const { idlDir, outDir } = setUpFakeDirs();
    await generateClients(idlDir, outDir);
    const generated = await import(pathToFileURL(join(outDir, "organization", "index.ts")).href);

    const pda = await generated.findOrganizationPda({ slug: "spiralhq" });
    expect(pda[0]).toBe("61cFSS8a4CEfZ1MxLUNd4HWpemd3qDwbZ9soGLomMNU7");

    expect(typeof generated.getInitializeOrganizationInstructionAsync).toBe("function");
    expect(typeof generated.fetchMaybeMembership).toBe("function");
    expect(generated.ORGANIZATION_ERROR__MEMBERSHIP_REVOKED).toBe(0x1771);
  }, 30_000);

  it("does not generate a film PDA finder — that seed can't be expressed in the IDL", async () => {
    const { idlDir, outDir } = setUpFakeDirs();
    await generateClients(idlDir, outDir);
    const generated = await import(pathToFileURL(join(outDir, "film", "index.ts")).href);
    expect("findFilmPda" in generated).toBe(false);
    // film.json has no `pda` metadata (unlike organization.json's 8), so Codama emits only
    // the sync getRegisterFilmInstruction, not an ...Async variant.
    expect("getRegisterFilmInstructionAsync" in generated).toBe(false);
    expect(typeof generated.getRegisterFilmInstruction).toBe("function");
  }, 30_000);
});
