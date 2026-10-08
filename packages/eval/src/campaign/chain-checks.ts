import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  getAddressDecoder,
  type Address,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetGenesisHashApi,
  type Rpc,
} from "@solana/kit";
import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";
import filmIdl from "../../../protocol/src/idl/film.json" with { type: "json" };
import organizationIdl from "../../../protocol/src/idl/organization.json" with { type: "json" };
import type { Check } from "./checks";

const PROGRAM_DATA_HEADER = 45;

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export type ChainRpc = Rpc<GetGenesisHashApi & GetAccountInfoApi & GetBalanceApi>;

export const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const SPIRAL_PROGRAMS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "spiral-programs",
);

export interface ProgramSpec {
  name: string;
  address: Address;
  soPath: string;
  buildIdlPath: string;
  protocolIdl: unknown;
}

export function defaultProgramSpecs(programsDir: string = SPIRAL_PROGRAMS_DIR): ProgramSpec[] {
  return [
    { name: "organization", address: ORGANIZATION_PROGRAM_ADDRESS, protocolIdl: organizationIdl },
    { name: "film", address: FILM_PROGRAM_ADDRESS, protocolIdl: filmIdl },
  ].map((p) => ({
    ...p,
    soPath: join(programsDir, "target", "deploy", `${p.name}.so`),
    buildIdlPath: join(programsDir, "target", "idl", `${p.name}.json`),
  }));
}

export function rpcGenesisCheck(rpc: ChainRpc, expectedGenesis: string): Check {
  return {
    stage: "infra",
    name: "rpc genesis",
    run: async () => {
      const genesis = await rpc.getGenesisHash().send();
      if (genesis !== expectedGenesis) {
        throw new Error(`genesis ${genesis} does not match expected ${expectedGenesis}`);
      }
      return `genesis ${genesis}`;
    },
  };
}

async function accountData(rpc: ChainRpc, addr: Address) {
  const { value } = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  if (!value) return null;
  return {
    executable: value.executable,
    owner: value.owner,
    data: Buffer.from(value.data[0], "base64"),
  };
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "undefined";
}

function firstDifference(local: unknown, onChain: unknown): string | null {
  if (canonical(local) === canonical(onChain)) return null;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(local) || !isObject(onChain)) return "(root)";
  const keys = [...new Set([...Object.keys(local), ...Object.keys(onChain)])];
  return keys.find((k) => canonical(local[k]) !== canonical(onChain[k])) ?? "(root)";
}

const sha8 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

function programCheck(rpc: ChainRpc, program: ProgramSpec): Check {
  const fail = (message: string) => new Error(`${program.name}: ${message}`);
  return {
    stage: "infra",
    name: `program ${program.name}`,
    run: async () => {
      const account = await accountData(rpc, program.address);
      if (!account) throw fail("program account not found");
      if (account.owner !== BPF_UPGRADEABLE_LOADER) {
        throw fail(`program account owner ${account.owner} is not the upgradeable loader`);
      }
      if (!account.executable) throw fail("program account is not executable");
      if (account.data.length < 36) {
        throw fail(`program account is not an upgradeable Program (${account.data.length} bytes)`);
      }
      const tag = account.data.readUInt32LE(0);
      if (tag !== 2) throw fail(`program account is not an upgradeable Program (tag ${tag})`);
      const programDataAddress = getAddressDecoder().decode(account.data.subarray(4, 36));

      const programData = await accountData(rpc, programDataAddress);
      if (!programData) throw fail(`ProgramData account ${programDataAddress} not found`);
      if (programData.owner !== BPF_UPGRADEABLE_LOADER) {
        throw fail(`ProgramData owner ${programData.owner} is not the upgradeable loader`);
      }
      const dataTag =
        programData.data.length < PROGRAM_DATA_HEADER
          ? `${programData.data.length} bytes`
          : `tag ${programData.data.readUInt32LE(0)}`;
      if (dataTag !== "tag 3") {
        throw fail(
          `ProgramData account is not initialized ProgramData (${dataTag}); was the program closed?`,
        );
      }

      const local = await readFile(program.soPath);
      if (local.length === 0) throw fail(`local build ${basename(program.soPath)} is empty`);
      const region = programData.data.subarray(PROGRAM_DATA_HEADER);
      const matches =
        region.length >= local.length &&
        local.equals(region.subarray(0, local.length)) &&
        region.subarray(local.length).every((b) => b === 0);
      if (!matches) {
        let end = region.length;
        while (end > 0 && region[end - 1] === 0) end--;
        throw fail(
          `deployed bytecode differs from ${basename(program.soPath)} (sha256 local ${sha8(local)} vs on-chain ${sha8(region.subarray(0, end))})`,
        );
      }

      const buildIdl: unknown = JSON.parse(await readFile(program.buildIdlPath, "utf8"));
      const diff = firstDifference(program.protocolIdl, buildIdl);
      if (diff !== null) {
        throw fail(
          `build IDL ${basename(program.buildIdlPath)} differs from packages/protocol (first difference: ${diff})`,
        );
      }
      return `${program.name}: deployed bytecode = local build ${sha8(local)}, protocol IDL matches build`;
    },
  };
}

export function programChecks(rpc: ChainRpc, programs: ProgramSpec[]): Check[] {
  if (programs.length === 0) throw new Error("programChecks: no programs to check");
  return programs.map((program) => programCheck(rpc, program));
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
}

export function payerBalanceCheck(rpc: ChainRpc, payer: Address, minLamports: bigint): Check {
  return {
    stage: "infra",
    name: "payer balance",
    run: async () => {
      const { value } = await rpc.getBalance(payer).send();
      if (value < minLamports) {
        throw new Error(`payer balance ${sol(value)} is below the minimum ${sol(minLamports)}`);
      }
      return `payer balance ${sol(value)} (minimum ${sol(minLamports)})`;
    },
  };
}
