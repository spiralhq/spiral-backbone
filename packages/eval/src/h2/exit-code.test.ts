import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import {
  address,
  createSolanaRpc,
  SolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { fetchFilm } from "@spiral-backbone/protocol/generated/film";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { sshFailure } from "../../../../scripts/kubo-node-control";
import { TruncatedTailError } from "../common/ndjson";
import { EXIT_RESUMABLE, h2ExitCode } from "./exit-code";
import { provenance } from "./executor/local-node";
import { readFilm } from "./executor/registry";
import { ExecutorFault, ExecutorRefused, faultDetail } from "./executor/run-container";
import { BlockGateError, GenerationLimitError } from "./orchestrator";
import { assertNetworkNodeAlive } from "./probes";
import { RunLockHeld } from "./run-lock";

async function listening<T extends Server | ReturnType<typeof createHttpServer>>(server: T) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listening(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const where = { host: "10.0.0.5", port: 22 };
const ssh255 = (stderr: string) =>
  sshFailure(where, { code: 255, killed: false, signal: null }, stderr);
const wrappedByReachability = (cause: Error) =>
  new Error(`SSH to 10.0.0.5:22 failed: ${cause.message}`, { cause });

const readRealFilm = (rpcUrl: string) =>
  failureOf(
    readFilm(
      (abortSignal) =>
        fetchFilm(createSolanaRpc(rpcUrl), address("11111111111111111111111111111111"), {
          abortSignal,
        }),
      { retries: 1, sleep: async () => {} },
    ),
  );

const http = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: statusCode === 503 ? "Service Unavailable" : "Not Found",
    statusCode,
  });

const executorExit2 = (inner: string) =>
  new ExecutorFault(
    `executor for main/pd-901/direct/r1 failed: ${faultDetail({ code: 2, stderr: `executor fault: ${inner}\n` })}`,
  );

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );

describe("h2ExitCode", () => {
  it("is resumable for an SSH timeout or connection-level failure, raw or wrapped", () => {
    const faults = [
      sshFailure(where, { killed: true, signal: "SIGTERM", code: null }, ""),
      ssh255("ssh: connect to host 10.0.0.5 port 22: Connection refused"),
      ssh255("ssh: connect to host 10.0.0.5 port 22: Connection timed out"),
      ssh255("ssh: connect to host 10.0.0.5 port 22: Operation timed out"),
      ssh255("ssh: connect to host 10.0.0.5 port 22: No route to host"),
      ssh255("kex_exchange_identification: read: Connection reset by peer"),
      ssh255("Connection closed by 10.0.0.5 port 22"),
    ];
    for (const fault of faults) {
      expect(h2ExitCode(fault), fault.message).toBe(EXIT_RESUMABLE);
      expect(h2ExitCode(wrappedByReachability(fault)), fault.message).toBe(EXIT_RESUMABLE);
    }
  });

  it("is not resumable for an SSH failure that will not pass", () => {
    const faults = [
      ssh255("spiral@10.0.0.5: Permission denied (publickey)."),
      ssh255("Host key verification failed."),
      ssh255("@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n@@@"),
      ssh255("ssh: Could not resolve hostname node-a: Name or service not known"),
      ssh255(""),
      sshFailure(where, { code: "ENOENT" }, ""),
    ];
    for (const fault of faults) {
      expect(h2ExitCode(fault), fault.message).toBe(1);
      expect(h2ExitCode(wrappedByReachability(fault)), fault.message).toBe(1);
    }
  });

  it("is not resumable for a systemctl answer that is not a state", () => {
    expect(
      h2ExitCode(
        new Error(
          "probe fault: `systemctl is-active ipfs` on 10.0.0.5:22 answered exit 4: Unit ipfs.service could not be found.",
        ),
      ),
    ).toBe(1);
  });

  it("is resumable only when the network node API is unreachable on the network", async () => {
    const refused = await failureOf(
      assertNetworkNodeAlive(`http://127.0.0.1:${await closedPort()}`, 1_000, [0, 0]),
    );
    expect(refused.message).toMatch(/^network node API unreachable \(127\.0\.0\.1:\d+\): /);
    expect(h2ExitCode(refused)).toBe(EXIT_RESUMABLE);

    const server = createHttpServer((_req, res) => res.writeHead(500).end("boom"));
    const port = await listening(server);
    try {
      const answered = await failureOf(
        assertNetworkNodeAlive(`http://127.0.0.1:${port}`, 1_000, [0, 0]),
      );
      expect(answered.message).toMatch(/^network node API at 127\.0\.0\.1:\d+ failed: /);
      expect(h2ExitCode(answered)).toBe(1);
    } finally {
      server.close();
    }

    const unresolvable = await failureOf(
      assertNetworkNodeAlive("http://no-such-host.invalid:5001", 1_000, [0, 0]),
    );
    expect(h2ExitCode(unresolvable)).toBe(1);
  });

  it("is resumable for the executor timeout", () => {
    const timeout = faultDetail({ killed: true, code: null, signal: "SIGTERM" }, 307_000);
    expect(timeout).toBe("executor timed out after 307 s");
    expect(
      h2ExitCode(new ExecutorFault(`executor for main/pd-901/direct/r1 failed: ${timeout}`)),
    ).toBe(EXIT_RESUMABLE);
  });

  it("is resumable for the executor's inner budgets", async () => {
    const budget = await failureOf(provenance(new Set(), null, 0));
    expect(budget.message).toMatch(/^provenance exceeded its 0 s budget at ipfs bitswap$/);
    expect(h2ExitCode(executorExit2(budget.message))).toBe(EXIT_RESUMABLE);
    expect(h2ExitCode(executorExit2("ipfs daemon did not become ready"))).toBe(EXIT_RESUMABLE);
  });

  it("is resumable for a registry read whose retries ran out", async () => {
    const http503 = await failureOf(
      readFilm(
        async () => {
          throw http(503);
        },
        { retries: 1, sleep: async () => {} },
      ),
    );
    const refused = await readRealFilm(`http://127.0.0.1:${await closedPort()}`);
    for (const error of [http503, refused]) {
      expect(error.message).toMatch(/^registry unavailable after 2 attempts: /);
      expect(h2ExitCode(executorExit2(error.message))).toBe(EXIT_RESUMABLE);
    }
  });

  it("is not resumable for an RPC host name that does not resolve", async () => {
    const error = await readRealFilm("http://no-such-host.invalid");
    expect(error.message).toBe("fetch failed");
    expect(h2ExitCode(executorExit2(error.message))).toBe(1);
  });

  it("is not resumable for a registry error that is not transient", async () => {
    for (const cause of [http(404), new Error("Account not found at address: F1")]) {
      const error = await failureOf(
        readFilm(
          async () => {
            throw cause;
          },
          { sleep: async () => {} },
        ),
      );
      expect(h2ExitCode(executorExit2(error.message))).toBe(1);
    }
  });

  it("is not resumable for any other executor fault, or a refusal", () => {
    expect(h2ExitCode(executorExit2("ipfs daemon exited with 1"))).toBe(1);
    expect(h2ExitCode(executorExit2("Unexpected token in JSON"))).toBe(1);
    expect(
      h2ExitCode(
        new ExecutorRefused(
          "main/pd-901/gateway/r1: refused: main/pd-901/gateway/r1 is a cold CID, not gateway-eligible before the zero-replica block",
        ),
      ),
    ).toBe(1);
    expect(
      h2ExitCode(new ExecutorRefused("main/pd-901/direct/r1: executor timed out after 307 s")),
    ).toBe(1);
  });

  it("is not resumable for harness, input or artifact errors", () => {
    const errors: unknown[] = [
      new GenerationLimitError(
        "block main exceeded 2 generations; find the cause of the drift, then resume with --allow-extra-generation to permit one more",
      ),
      new BlockGateError("block main: replica state never confirmed after 3 checks"),
      new Error(
        "block main main@g1: artifacts are inconsistent — end confirmed but 2 planned attempts have no result",
      ),
      new Error("executor returned a record for a different attempt than main/pd-901/direct/r1"),
      new Error(
        "executor record for main/pd-901/direct/r1 does not match the plan: cid_expected x vs y, film_pda F1 vs F1",
      ),
      new Error(
        'executor evidence for main/pd-901/direct/r1: declared_replicas ["a"] differ from the topology replicas ["a","b"]',
      ),
      new RunLockHeld(
        "results/h2.ndjson.lock is held by running PID 4242 since 2026-10-08T10:00:00.000Z",
      ),
      new TruncatedTailError("results/h2.ndjson", 7),
      z.object({ a: z.string() }).safeParse({}).error,
      new Error(
        "`sudo systemctl --no-block start ipfs` on 10.0.0.5:22 exited 1: sudo: a password is required",
      ),
      new Error("give exactly one of --plan or --resume"),
      "not even an Error",
    ];
    for (const error of errors) expect(h2ExitCode(error)).toBe(1);
  });
});
