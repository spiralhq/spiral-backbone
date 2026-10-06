import { describe, expect, it } from "vitest";
import { failingProgram, judge, parseInstructionError, type RawSendResult } from "./outcome";
import { H3_SCENARIOS } from "./scenarios";

const reader = H3_SCENARIOS.find((s) => s.key === "reader-role")!;
const confirmed = (err: unknown): RawSendResult => ({
  signature: "sig",
  sendError: null,
  err,
  logs: [],
});

describe("H3_SCENARIOS", () => {
  it("covers the seven scenarios with the codes observed on the real programs", () => {
    expect(H3_SCENARIOS.map((s) => [s.id, s.expectedCode, s.refusingProgram])).toEqual([
      [1, 3012, "film"],
      [2, 6001, "organization"],
      [3, 6002, "organization"],
      [4, 6003, "organization"],
      [5, 6004, "organization"],
      [6, 0, "system"],
      [7, 3007, "film"],
    ]);
  });
});

describe("parseInstructionError", () => {
  it("reads index and custom code, numbers or bigints", () => {
    expect(parseInstructionError({ InstructionError: [0, { Custom: 6002 }] })).toEqual({
      index: 0,
      code: 6002,
    });
    expect(parseInstructionError({ InstructionError: [0n, { Custom: 3012n }] })).toEqual({
      index: 0,
      code: 3012,
    });
  });

  it("returns null for other shapes", () => {
    expect(parseInstructionError(null)).toBeNull();
    expect(parseInstructionError("AccountInUse")).toBeNull();
    expect(parseInstructionError({ InstructionError: [0, "InvalidAccountData"] })).toBeNull();
  });
});

describe("failingProgram", () => {
  it("returns the innermost failing program (first failed line)", () => {
    expect(
      failingProgram([
        "Program 6MK8 invoke [1]",
        "Program 2JWb failed: custom program error: 0x1772",
        "Program 6MK8 failed: custom program error: 0x1772",
      ]),
    ).toBe("2JWb");
    expect(failingProgram(["Program x success"])).toBeNull();
  });
});

describe("judge", () => {
  it("succeeds only on the expected code at instruction 0", () => {
    expect(judge(reader, confirmed({ InstructionError: [0, { Custom: 6002 }] })).outcome).toBe(
      "success",
    );
  });

  it("fails when the program accepted the transaction", () => {
    expect(judge(reader, confirmed(null))).toMatchObject({
      outcome: "failure",
      reason: expect.stringMatching(/accepted/),
    });
  });

  it("fails on a different code or instruction index", () => {
    expect(judge(reader, confirmed({ InstructionError: [0, { Custom: 6001 }] })).outcome).toBe(
      "failure",
    );
    expect(judge(reader, confirmed({ InstructionError: [1, { Custom: 6002 }] })).outcome).toBe(
      "failure",
    );
  });

  it("fails when the refusal happened before the chain (no signature on record)", () => {
    const verdict = judge(reader, {
      signature: null,
      sendError: "Blockhash not found",
      err: null,
      logs: [],
    });
    expect(verdict).toMatchObject({
      outcome: "failure",
      reason: expect.stringMatching(/before reaching the chain/),
    });
  });

  it("fails when the transaction never confirmed", () => {
    const verdict = judge(reader, {
      signature: "sig",
      sendError: "not confirmed within timeout",
      err: null,
      logs: [],
    });
    expect(verdict.outcome).toBe("failure");
  });
});
