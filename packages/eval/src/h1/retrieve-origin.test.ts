import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isLocalWriteError,
  RetrievalError,
  retrievalFailureOrigin,
  retrieveToFile,
} from "./retrieve";

const catBehaviour = vi.hoisted(() => ({ fail: false }));

vi.mock("kubo-rpc-client", () => ({
  create: () => ({
    cat: async function* () {
      yield new Uint8Array([1, 2, 3]);
      if (catBehaviour.fail) {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      }
    },
  }),
}));

function fsError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
}

describe("retrieval failure origin", () => {
  it("recognises local filesystem write-side errors", () => {
    for (const code of ["ENOSPC", "EACCES", "EROFS", "EMFILE", "EISDIR"]) {
      expect(isLocalWriteError(fsError(code, "stat"))).toBe(true);
    }
    expect(isLocalWriteError(fsError("ENOENT", "open"))).toBe(true);
    expect(isLocalWriteError(fsError("EIO", "write"))).toBe(true);
    expect(isLocalWriteError(fsError("ECONNREFUSED", "connect"))).toBe(false);
    expect(isLocalWriteError(new Error("fetch failed"))).toBe(false);
    expect(isLocalWriteError("ENOSPC")).toBe(false);
  });

  it("attributes errors to the source only when the source failed", () => {
    expect(retrievalFailureOrigin(new Error("fetch failed"), true)).toBe("source");
    expect(retrievalFailureOrigin(fsError("ENOSPC", "write"), true)).toBe("local");
    expect(retrievalFailureOrigin(new Error("premature close"), false)).toBe("local");
  });

  it("rethrows a destination open failure raw", async () => {
    catBehaviour.fail = false;
    const dest = join(mkdtempSync(join(tmpdir(), "h1-origin-")), "missing-dir", "out.bin");
    const attempt = retrieveToFile("http://127.0.0.1:1", "bafy", dest, 5_000);
    await expect(attempt).rejects.not.toBeInstanceOf(RetrievalError);
    await expect(attempt).rejects.toMatchObject({ code: "ENOENT", syscall: "open" });
  });

  it("wraps a source failure as a RetrievalError", async () => {
    catBehaviour.fail = true;
    const dest = join(mkdtempSync(join(tmpdir(), "h1-origin-")), "out.bin");
    const attempt = retrieveToFile("http://127.0.0.1:1", "bafy", dest, 5_000);
    await expect(attempt).rejects.toBeInstanceOf(RetrievalError);
    await expect(attempt).rejects.toMatchObject({ failureClass: "connection_error" });
  });
});
