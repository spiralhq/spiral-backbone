import { SshProbeFault } from "../../../../scripts/kubo-node-control";
import { ExecutorFault, ExecutorRefused } from "./executor/run-container";
import { NetworkNodeUnreachable } from "./probes";

export const EXIT_RESUMABLE = 75;

const RESUMABLE_EXECUTOR_TAILS = [
  /: executor timed out after \d+(?:\.\d+)? s$/,
  /executor fault: provenance exceeded its \d+(?:\.\d+)? s budget at ipfs /,
  /executor fault: ipfs daemon did not become ready\s*$/,
  /executor fault: registry unavailable after \d+ attempts: /,
];

function causes(error: Error): Error[] {
  const chain = [error];
  for (let next = error.cause; next instanceof Error && chain.length < 10; next = next.cause)
    chain.push(next);
  return chain;
}

export function h2ExitCode(error: unknown): 1 | typeof EXIT_RESUMABLE {
  if (!(error instanceof Error) || error instanceof ExecutorRefused) return 1;
  if (error instanceof ExecutorFault) {
    return RESUMABLE_EXECUTOR_TAILS.some((p) => p.test(error.message)) ? EXIT_RESUMABLE : 1;
  }
  return causes(error).some(
    (e) => e instanceof SshProbeFault || e instanceof NetworkNodeUnreachable,
  )
    ? EXIT_RESUMABLE
    : 1;
}
