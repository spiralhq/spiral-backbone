import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncIdl } from "./sync-idl";

let fakeProgramsDir: string | undefined;
let fakeDestDir: string | undefined;

afterEach(() => {
  if (fakeProgramsDir) rmSync(fakeProgramsDir, { recursive: true, force: true });
  if (fakeDestDir) rmSync(fakeDestDir, { recursive: true, force: true });
  fakeProgramsDir = undefined;
  fakeDestDir = undefined;
});

describe("syncIdl", () => {
  it("copies both IDL files and writes provenance metadata", () => {
    fakeProgramsDir = mkdtempSync(join(tmpdir(), "fake-spiral-programs-"));
    execFileSync("git", ["init", "-q"], { cwd: fakeProgramsDir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"],
      {
        cwd: fakeProgramsDir,
      },
    );
    const commit = execFileSync("git", ["-C", fakeProgramsDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    mkdirSync(join(fakeProgramsDir, "idl"));
    writeFileSync(
      join(fakeProgramsDir, "idl", "organization.json"),
      JSON.stringify({ metadata: { version: "0.1.0" } }),
    );
    writeFileSync(
      join(fakeProgramsDir, "idl", "film.json"),
      JSON.stringify({ metadata: { version: "0.1.0" } }),
    );

    fakeDestDir = mkdtempSync(join(tmpdir(), "fake-idl-out-"));
    syncIdl(fakeProgramsDir, fakeDestDir);

    const idlDir = fakeDestDir;
    expect(JSON.parse(readFileSync(join(idlDir, "organization.json"), "utf8"))).toEqual({
      metadata: { version: "0.1.0" },
    });
    const metadata = JSON.parse(readFileSync(join(idlDir, "metadata.json"), "utf8"));
    expect(metadata.organization).toEqual({ programVersion: "0.1.0", sourceCommit: commit });
    expect(metadata.film).toEqual({ programVersion: "0.1.0", sourceCommit: commit });
  });

  it("throws a clear error when the IDL file is missing", () => {
    fakeProgramsDir = mkdtempSync(join(tmpdir(), "fake-spiral-programs-"));
    execFileSync("git", ["init", "-q"], { cwd: fakeProgramsDir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"],
      {
        cwd: fakeProgramsDir,
      },
    );
    fakeDestDir = mkdtempSync(join(tmpdir(), "fake-idl-out-"));
    expect(() => syncIdl(fakeProgramsDir, fakeDestDir)).toThrow(/IDL not found/);
  });
});
