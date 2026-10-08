import { EXPECTED_INSTRUCTION_INDEX, REFUSING_PROGRAM_ADDRESS, type H3Scenario } from "./scenarios";

export interface InstructionFailure {
  index: number;
  code: number;
}

export interface RawSendResult {
  signature: string;
  err: unknown;
  logs: string[];
}

export interface H3Verdict {
  outcome: "success" | "failure";
  observed: InstructionFailure | null;
  reason: string;
}

export function parseInstructionError(err: unknown): InstructionFailure | null {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return null;
  const tuple = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(tuple) || tuple.length !== 2) return null;
  const [index, detail] = tuple as [unknown, unknown];
  if (!detail || typeof detail !== "object" || !("Custom" in detail)) return null;
  return {
    index: Number(index),
    code: Number((detail as { Custom: unknown }).Custom),
  };
}

export function failingProgram(logs: readonly string[]): string | null {
  for (const line of logs) {
    const match = /^Program (\S+) failed:/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

export function judge(scenario: H3Scenario, result: RawSendResult): H3Verdict {
  if (result.err === null || result.err === undefined) {
    return {
      outcome: "failure",
      observed: null,
      reason: "transaction was accepted by the program",
    };
  }
  if (!result.logs || result.logs.length === 0) {
    throw new Error(
      `transaction ${result.signature} landed with an error but the RPC returned no logs (provider fault)`,
    );
  }
  const observed = parseInstructionError(result.err);
  if (!observed) {
    return {
      outcome: "failure",
      observed: null,
      reason: `unexpected error shape: ${JSON.stringify(result.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    };
  }
  if (observed.index !== EXPECTED_INSTRUCTION_INDEX || observed.code !== scenario.expectedCode) {
    return {
      outcome: "failure",
      observed,
      reason: `expected code ${scenario.expectedCode} at instruction ${EXPECTED_INSTRUCTION_INDEX}, got ${observed.code} at ${observed.index}`,
    };
  }
  const expectedProgram = REFUSING_PROGRAM_ADDRESS[scenario.refusingProgram];
  const refusedBy = failingProgram(result.logs);
  if (refusedBy !== expectedProgram) {
    return {
      outcome: "failure",
      observed,
      reason: `expected ${scenario.refusingProgram} (${expectedProgram}) to refuse, got ${refusedBy ?? "no failing program in the logs"}`,
    };
  }
  return {
    outcome: "success",
    observed,
    reason: "rejected on-chain with the expected code by the expected program",
  };
}
