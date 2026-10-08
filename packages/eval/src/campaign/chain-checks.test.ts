import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, getAddressEncoder, lamports, type Address } from "@solana/kit";
import { FILM_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/film";
import { ORGANIZATION_PROGRAM_ADDRESS } from "@spiral-backbone/protocol/generated/organization";
import { afterAll, describe, expect, it } from "vitest";
import filmIdl from "../../../protocol/src/idl/film.json" with { type: "json" };
import organizationIdl from "../../../protocol/src/idl/organization.json" with { type: "json" };
import {
  BPF_UPGRADEABLE_LOADER,
  DEVNET_GENESIS,
  payerBalanceCheck,
  programChecks,
  rpcGenesisCheck,
  type ChainRpc,
  type ProgramSpec,
} from "./chain-checks";

interface FakeAccount {
  executable: boolean;
  owner?: string;
  data: Uint8Array;
}

function fakeRpc(opts: {
  genesis?: () => string;
  accounts?: Map<string, FakeAccount>;
  balance?: bigint;
}): ChainRpc {
  const respond = <T>(value: () => T) => ({ send: async () => value() });
  return {
    getGenesisHash: () => respond(opts.genesis ?? (() => DEVNET_GENESIS)),
    getAccountInfo: (addr: Address) =>
      respond(() => {
        const account = opts.accounts?.get(addr);
        if (!account) return { context: { slot: 1n }, value: null };
        return {
          context: { slot: 1n },
          value: {
            executable: account.executable,
            lamports: lamports(1n),
            owner: address(account.owner ?? BPF_UPGRADEABLE_LOADER),
            rentEpoch: 0n,
            space: BigInt(account.data.length),
            data: [Buffer.from(account.data).toString("base64"), "base64"],
          },
        };
      }),
    getBalance: () =>
      respond(() => ({ context: { slot: 1n }, value: lamports(opts.balance ?? 0n) })),
  } as unknown as ChainRpc;
}

const PROGRAM_DATA = address("9KogCx732Pm2iFyJRQqxEExRm9Kdp8v96Z8amCHnKHw8");
const ELF = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 1) % 256));
const sha8 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 8);

const dir = mkdtempSync(join(tmpdir(), "spiral-program-checks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const soPath = join(dir, "film.so");
writeFileSync(soPath, ELF);
const buildIdlPath = join(dir, "film.json");
writeFileSync(buildIdlPath, JSON.stringify(Object.fromEntries(Object.entries(filmIdl).reverse())));
const staleIdlPath = join(dir, "film-stale.json");
writeFileSync(
  staleIdlPath,
  JSON.stringify({ ...filmIdl, instructions: filmIdl.instructions.slice(1) }),
);

const filmSpec: ProgramSpec = {
  name: "film",
  address: FILM_PROGRAM_ADDRESS,
  soPath,
  buildIdlPath,
  protocolIdl: filmIdl,
};

function programAccount(tag = 2, programData: Address = PROGRAM_DATA): Uint8Array {
  const out = Buffer.alloc(36);
  out.writeUInt32LE(tag, 0);
  out.set(getAddressEncoder().encode(programData), 4);
  return out;
}

function programDataAccount(elf: Uint8Array, opts: { tag?: number; padding?: Uint8Array } = {}) {
  const padding = opts.padding ?? new Uint8Array(64);
  const out = Buffer.alloc(45 + elf.length + padding.length);
  out.writeUInt32LE(opts.tag ?? 3, 0);
  out.writeBigUInt64LE(42n, 4);
  out[12] = 1;
  out.set(elf, 45);
  out.set(padding, 45 + elf.length);
  return out;
}

function chain(
  overrides: { program?: FakeAccount | null; programData?: FakeAccount | null } = {},
): ChainRpc {
  const accounts = new Map<string, FakeAccount>();
  const program =
    overrides.program === undefined
      ? { executable: true, data: programAccount() }
      : overrides.program;
  if (program) accounts.set(FILM_PROGRAM_ADDRESS, program);
  const programData =
    overrides.programData === undefined
      ? { executable: false, data: programDataAccount(ELF) }
      : overrides.programData;
  if (programData) accounts.set(PROGRAM_DATA, programData);
  return fakeRpc({ accounts });
}

async function failure(check: { run(): Promise<string> }): Promise<string> {
  return check.run().then(
    (detail) => `unexpected pass: ${detail}`,
    (e: Error) => e.message,
  );
}

describe("rpcGenesisCheck", () => {
  it("passes when the genesis hash matches", async () => {
    const check = rpcGenesisCheck(fakeRpc({}), DEVNET_GENESIS);
    expect(check.stage).toBe("infra");
    await expect(check.run()).resolves.toContain(DEVNET_GENESIS);
  });

  it("blocks on a mismatch, naming both hashes", async () => {
    const check = rpcGenesisCheck(fakeRpc({ genesis: () => "OtherGenesis111" }), DEVNET_GENESIS);
    const error = await check.run().then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain("OtherGenesis111");
    expect(error?.message).toContain(DEVNET_GENESIS);
  });

  it("blocks when the RPC fails", async () => {
    const rpc = fakeRpc({
      genesis: () => {
        throw new Error("fetch failed");
      },
    });
    await expect(rpcGenesisCheck(rpc, DEVNET_GENESIS).run()).rejects.toThrow(/fetch failed/);
  });
});

describe("programChecks", () => {
  const only = (rpc: ChainRpc, spec: ProgramSpec = filmSpec) => {
    const checks = programChecks(rpc, [spec]);
    expect(checks).toHaveLength(1);
    return checks[0]!;
  };

  it("returns one infra check per program, named after it", () => {
    const checks = programChecks(chain(), [
      filmSpec,
      {
        ...filmSpec,
        name: "organization",
        address: ORGANIZATION_PROGRAM_ADDRESS,
        protocolIdl: organizationIdl,
      },
    ]);
    expect(checks.map((c) => [c.stage, c.name])).toEqual([
      ["infra", "program film"],
      ["infra", "program organization"],
    ]);
  });

  it("refuses an empty program list", () => {
    expect(() => programChecks(chain(), [])).toThrow(/no programs/);
  });

  it("passes when the deployed bytecode equals the local build and the IDLs match", async () => {
    await expect(only(chain()).run()).resolves.toBe(
      `film: deployed bytecode = local build ${sha8(ELF)}, protocol IDL matches build`,
    );
  });

  it("blocks when the program account is missing", async () => {
    expect(await failure(only(chain({ program: null })))).toBe("film: program account not found");
  });

  it("blocks when the program is not owned by the upgradeable loader", async () => {
    const program = {
      executable: true,
      owner: "BPFLoader2111111111111111111111111111111111",
      data: programAccount(),
    };
    expect(await failure(only(chain({ program })))).toMatch(
      /^film: program account owner BPFLoader2\w+ is not the upgradeable loader$/,
    );
  });

  it("blocks when the program account is not executable", async () => {
    const program = { executable: false, data: programAccount() };
    expect(await failure(only(chain({ program })))).toBe("film: program account is not executable");
  });

  it("blocks when the program account tag is not Program", async () => {
    const program = { executable: true, data: programAccount(3) };
    expect(await failure(only(chain({ program })))).toBe(
      "film: program account is not an upgradeable Program (tag 3)",
    );
  });

  it("blocks when the program account is too short to hold a ProgramData address", async () => {
    const program = { executable: true, data: programAccount().subarray(0, 20) };
    expect(await failure(only(chain({ program })))).toBe(
      "film: program account is not an upgradeable Program (20 bytes)",
    );
  });

  it("blocks when the ProgramData account is missing", async () => {
    expect(await failure(only(chain({ programData: null })))).toBe(
      `film: ProgramData account ${PROGRAM_DATA} not found`,
    );
  });

  it("blocks when the ProgramData account has the wrong owner", async () => {
    const programData = {
      executable: false,
      owner: "11111111111111111111111111111111",
      data: programDataAccount(ELF),
    };
    expect(await failure(only(chain({ programData })))).toMatch(
      /^film: ProgramData owner 1{32} is not/,
    );
  });

  it("blocks when the program was closed (ProgramData uninitialized)", async () => {
    const programData = { executable: false, data: programDataAccount(ELF, { tag: 1 }) };
    expect(await failure(only(chain({ programData })))).toBe(
      "film: ProgramData account is not initialized ProgramData (tag 1); was the program closed?",
    );
  });

  it("blocks when the program was closed (ProgramData empty)", async () => {
    const programData = { executable: false, data: new Uint8Array(0) };
    expect(await failure(only(chain({ programData })))).toBe(
      "film: ProgramData account is not initialized ProgramData (0 bytes); was the program closed?",
    );
  });

  it("blocks when the local build is empty", async () => {
    const emptySo = join(dir, "empty.so");
    writeFileSync(emptySo, "");
    expect(await failure(only(chain(), { ...filmSpec, soPath: emptySo }))).toBe(
      "film: local build empty.so is empty",
    );
  });

  it("blocks when the deployed bytecode differs", async () => {
    const other = Buffer.from(ELF);
    other[100] = other[100]! ^ 0xff;
    const programData = { executable: false, data: programDataAccount(other) };
    expect(await failure(only(chain({ programData })))).toBe(
      `film: deployed bytecode differs from film.so (sha256 local ${sha8(ELF)} vs on-chain ${sha8(other)})`,
    );
  });

  it("blocks when the on-chain region is shorter than the local build", async () => {
    const programData = {
      executable: false,
      data: programDataAccount(ELF.subarray(0, 200), { padding: new Uint8Array(0) }),
    };
    expect(await failure(only(chain({ programData })))).toBe(
      `film: deployed bytecode differs from film.so (sha256 local ${sha8(ELF)} vs on-chain ${sha8(ELF.subarray(0, 200))})`,
    );
  });

  it("blocks when the bytes after the ELF are not zero padding", async () => {
    const padding = new Uint8Array(64);
    padding[63] = 1;
    const programData = { executable: false, data: programDataAccount(ELF, { padding }) };
    expect(await failure(only(chain({ programData })))).toMatch(
      /^film: deployed bytecode differs from film\.so \(sha256 local \w{8} vs on-chain \w{8}\)$/,
    );
  });

  it("blocks when the build IDL differs from the protocol IDL", async () => {
    const check = only(chain(), { ...filmSpec, buildIdlPath: staleIdlPath });
    expect(await failure(check)).toBe(
      "film: build IDL film-stale.json differs from packages/protocol (first difference: instructions)",
    );
  });

  it("blocks when a local file is missing", async () => {
    const check = only(chain(), { ...filmSpec, soPath: join(dir, "missing.so") });
    expect(await failure(check)).toMatch(/ENOENT/);
  });
});

describe("payerBalanceCheck", () => {
  const payer = address("9KogCx732Pm2iFyJRQqxEExRm9Kdp8v96Z8amCHnKHw8");

  it("blocks below the minimum, reporting both values in SOL", async () => {
    const check = payerBalanceCheck(fakeRpc({ balance: 500_000_000n }), payer, 1_250_000_000n);
    expect(check.stage).toBe("infra");
    const error = await check.run().then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain("0.5 SOL");
    expect(error?.message).toContain("1.25 SOL");
  });

  it("passes at the minimum", async () => {
    const check = payerBalanceCheck(fakeRpc({ balance: 1_000_000_000n }), payer, 1_000_000_000n);
    await expect(check.run()).resolves.toContain("1 SOL");
  });

  it("passes above the minimum", async () => {
    const check = payerBalanceCheck(fakeRpc({ balance: 3_000_000_001n }), payer, 1_000_000_000n);
    await expect(check.run()).resolves.toContain("3.000000001 SOL");
  });
});
