import { describe, expect, it } from "vitest";
import { failingProgram, judge, parseInstructionError, type RawSendResult } from "./outcome";
import { H3_SCENARIOS, REFUSING_PROGRAM_ADDRESS } from "./scenarios";

const reader = H3_SCENARIOS.find((s) => s.key === "reader-role")!;
const ORGANIZATION = REFUSING_PROGRAM_ADDRESS.organization;
const FILM = REFUSING_PROGRAM_ADDRESS.film;
const refusedBy = (program: string) => [
  `Program ${FILM} invoke [1]`,
  `Program ${ORGANIZATION} invoke [2]`,
  `Program ${program} failed: custom program error: 0x1772`,
  `Program ${FILM} failed: custom program error: 0x1772`,
];
const confirmed = (err: unknown, logs: string[] = refusedBy(ORGANIZATION)): RawSendResult => ({
  signature: "sig",
  err,
  logs,
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
  it("succeeds only on the expected code at instruction 0 from the expected program", () => {
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

  it("fails when another program refused with the expected code", () => {
    expect(
      judge(reader, confirmed({ InstructionError: [0, { Custom: 6002 }] }, refusedBy(FILM))),
    ).toMatchObject({
      outcome: "failure",
      observed: { index: 0, code: 6002 },
      reason: expect.stringMatching(/expected organization .* to refuse, got /),
    });
  });

  it("fails when non-empty logs name no failing program", () => {
    expect(
      judge(
        reader,
        confirmed({ InstructionError: [0, { Custom: 6002 }] }, [`Program ${FILM} invoke [1]`]),
      ),
    ).toMatchObject({
      outcome: "failure",
      reason: expect.stringMatching(/no failing program in the logs/),
    });
  });

  it("throws, as a provider fault, when a failed transaction has empty or missing logs", () => {
    const err = { InstructionError: [0, { Custom: 6002 }] };
    expect(() => judge(reader, confirmed(err, []))).toThrow(/logs/);
    expect(() => judge(reader, { signature: "sig", err, logs: undefined as never })).toThrow(
      /logs/,
    );
  });

  it("checks each scenario against its own refusing program", () => {
    for (const scenario of H3_SCENARIOS) {
      const err = { InstructionError: [0, { Custom: scenario.expectedCode }] };
      const own = REFUSING_PROGRAM_ADDRESS[scenario.refusingProgram];
      const other = own === ORGANIZATION ? FILM : ORGANIZATION;
      expect(judge(scenario, confirmed(err, refusedBy(own))).outcome).toBe("success");
      expect(judge(scenario, confirmed(err, refusedBy(other))).outcome).toBe("failure");
    }
  });
});
