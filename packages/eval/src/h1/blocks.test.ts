import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseIntactMismatch } from "./diagnose";
import { sha256File } from "./hash";
import { classifyRetrievalError } from "./retrieve";
import { tamperOffset, writeTamperedCopy } from "./tamper";

const dir = mkdtempSync(join(tmpdir(), "h1-blocks-"));

describe("tamperOffset", () => {
  it("stays in the middle half of the file and is deterministic per seed", () => {
    for (const seed of ["a", "b", "run:pd-001", "run:pd-002"]) {
      const offset = tamperOffset(seed, 1_000_000);
      expect(offset).toBeGreaterThanOrEqual(250_000);
      expect(offset).toBeLessThan(750_000);
      expect(tamperOffset(seed, 1_000_000)).toBe(offset);
    }
    expect(tamperOffset("a", 1_000_000)).not.toBe(tamperOffset("b", 1_000_000));
  });

  it("refuses files too small to have a middle", () => {
    expect(() => tamperOffset("a", 3)).toThrow(/too small/);
  });
});

describe("writeTamperedCopy", () => {
  it("changes exactly one byte at the offset and leaves the source untouched", async () => {
    const source = join(dir, "source.bin");
    const original = randomBytes(4096);
    writeFileSync(source, original);
    const dest = join(dir, "tampered.bin");
    const result = await writeTamperedCopy(source, dest, 2000);
    const tampered = readFileSync(dest);
    expect(readFileSync(source)).toEqual(original);
    const differing = [...tampered].flatMap((byte, i) => (byte === original[i] ? [] : [i]));
    expect(differing).toEqual([2000]);
    expect(result).toEqual({ original: original[2000], tampered: original[2000]! ^ 0xff });
  });
});

describe("sha256File", () => {
  it("hashes a file by streaming", async () => {
    const path = join(dir, "hash.bin");
    const content = randomBytes(300_000);
    writeFileSync(path, content);
    expect(await sha256File(path)).toBe(createHash("sha256").update(content).digest("hex"));
  });
});

describe("diagnoseIntactMismatch", () => {
  const base = {
    cidLen: 36,
    cidPrefixHex: "01701220",
    manifestSha256: "a".repeat(64),
    retrievedSha256: "a".repeat(64),
  };

  it("blames the bytes when the retrieved file differs from the manifest original", () => {
    expect(diagnoseIntactMismatch({ ...base, retrievedSha256: "b".repeat(64) })).toBe(
      "retrieved_bytes_differ_from_original",
    );
  });

  it("blames the on-chain field when its length or prefix is outside the profile", () => {
    expect(diagnoseIntactMismatch({ ...base, cidLen: 34 })).toBe("onchain_cid_malformed");
    expect(diagnoseIntactMismatch({ ...base, cidPrefixHex: "01551220" })).toBe(
      "onchain_cid_malformed",
    );
  });

  it("otherwise blames the chunking parameters", () => {
    expect(diagnoseIntactMismatch(base)).toBe("chunking_parameters_diverge");
  });
});

describe("classifyRetrievalError", () => {
  it("classifies timeouts", () => {
    expect(classifyRetrievalError(new DOMException("t", "TimeoutError"))).toBe("timeout");
    expect(classifyRetrievalError(new DOMException("a", "AbortError"))).toBe("timeout");
  });

  it("classifies connection errors through the cause chain", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    });
    expect(classifyRetrievalError(error)).toBe("connection_error");
  });

  it("defaults to object_unavailable", () => {
    expect(classifyRetrievalError(new Error("block was not found locally (offline)"))).toBe(
      "object_unavailable",
    );
  });
});
