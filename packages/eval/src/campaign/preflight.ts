import { createSolanaRpc, type Address } from "@solana/kit";
import type { Topology } from "../h2/topology";
import {
  defaultProgramSpecs,
  payerBalanceCheck,
  programChecks,
  rpcGenesisCheck,
  type ChainRpc,
} from "./chain-checks";
import type { Check, Stage } from "./checks";
import {
  campaignFeasibleCheck,
  filmsMatchCheck,
  goldenMatchesManifestCheck,
  manifestFinalCheck,
} from "./h2-checks";
import {
  conformanceCheck,
  executorImageCheck,
  gatewayCheck,
  networkNodeCheck,
  replicaChecks,
} from "./node-checks";

export type PreflightStage = Stage | "all";

export interface PreflightInputs {
  topology: Topology;
  payer: Address;
  manifestPath: string;
  filesDir: string;
  goldenPath?: string;
  campaignPath: string;
  expectedGenesis: string;
  minLamports: bigint;
  pingTimeoutMs: number;
  skipConformance: boolean;
  programsDir?: string;
}

export interface PreflightDeps {
  rpc: ChainRpc;
}

const skippedConformance: Check = {
  stage: "infra",
  name: "chunking conformance",
  run: async () => {
    throw new Error("skipped by flag");
  },
};

function infraChecks(inputs: PreflightInputs, rpc: ChainRpc): Check[] {
  const { topology } = inputs;
  return [
    rpcGenesisCheck(rpc, inputs.expectedGenesis),
    ...programChecks(rpc, defaultProgramSpecs(inputs.programsDir)),
    payerBalanceCheck(rpc, inputs.payer, inputs.minLamports),
    manifestFinalCheck(inputs.manifestPath, inputs.filesDir),
    inputs.skipConformance ? skippedConformance : conformanceCheck(),
    ...replicaChecks(topology, { pingTimeoutMs: inputs.pingTimeoutMs }),
    networkNodeCheck(topology, inputs.pingTimeoutMs),
    gatewayCheck(topology.gateway_url, inputs.pingTimeoutMs),
    executorImageCheck(topology.executor.image),
  ];
}

function h2Checks(inputs: PreflightInputs, rpc: ChainRpc, goldenPath: string): Check[] {
  return [
    goldenMatchesManifestCheck(goldenPath, inputs.manifestPath),
    filmsMatchCheck(rpc, goldenPath, inputs.topology),
    campaignFeasibleCheck(inputs.campaignPath, goldenPath, inputs.topology),
  ];
}

export async function buildChecks(
  stage: PreflightStage,
  inputs: PreflightInputs,
  deps: Partial<PreflightDeps> = {},
): Promise<Check[]> {
  if (stage !== "infra" && !inputs.goldenPath) {
    throw new Error(`--golden is required for --stage ${stage}`);
  }
  const rpc = deps.rpc ?? createSolanaRpc(inputs.topology.rpc_url);
  return [
    ...(stage === "h2" ? [] : infraChecks(inputs, rpc)),
    ...(stage === "infra" ? [] : h2Checks(inputs, rpc, inputs.goldenPath!)),
  ];
}
