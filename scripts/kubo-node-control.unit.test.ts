import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Outcome =
  | { exit: number; stdout?: string; stderr?: string }
  | { killed: true }
  | { spawnError: string };

const outcomes: Outcome[] = [];
const commands: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    commands.push(args.at(-1) ?? "");
    const commandLine = `Command failed: ssh ${args.join(" ")}`;
    const outcome = outcomes.shift() ?? { exit: 0 };
    queueMicrotask(() => {
      if ("killed" in outcome) {
        callback(
          Object.assign(new Error(commandLine), {
            killed: true,
            signal: "SIGTERM",
            code: null,
          }),
          "",
          "",
        );
      } else if ("spawnError" in outcome) {
        callback(
          Object.assign(new Error(`spawn ssh ${outcome.spawnError}\n${commandLine}`), {
            code: outcome.spawnError,
          }),
          "",
          "",
        );
      } else if (outcome.exit === 0) {
        callback(null, outcome.stdout ?? "", outcome.stderr ?? "");
      } else {
        callback(
          Object.assign(new Error(commandLine), {
            code: outcome.exit,
            killed: false,
            signal: null,
          }),
          outcome.stdout ?? "",
          outcome.stderr ?? "",
        );
      }
    });
  },
}));

const {
  assertSshReachable,
  checkSystemdActive,
  remoteSudoRefusals,
  shutdownService,
  SshFault,
  SshProbeFault,
  startService,
  stderrTail,
} = await import("./kubo-node-control");

const target = { host: "node-a", port: 22, user: "spiral", identityFile: "/k" };

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  const result = promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  outcomes.length = 0;
  commands.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSystemdActive", () => {
  it("is true only for an active answer", async () => {
    outcomes.push({ exit: 0, stdout: "active\n" });
    expect((await settle(checkSystemdActive(target))).value).toBe(true);
    expect(commands).toEqual(["systemctl is-active ipfs"]);
  });

  it("is false when systemctl answers inactive or failed", async () => {
    outcomes.push({ exit: 3, stdout: "inactive\n" });
    expect((await settle(checkSystemdActive(target))).value).toBe(false);
    outcomes.push({ exit: 3, stdout: "failed\n" });
    expect((await settle(checkSystemdActive(target))).value).toBe(false);
    outcomes.push({ exit: 3, stdout: "activating\n" });
    expect((await settle(checkSystemdActive(target))).value).toBe(false);
    expect(commands).toHaveLength(3);
  });

  it("throws a probe fault when SSH itself fails (exit 255) on every try", async () => {
    outcomes.push(
      ...Array.from({ length: 3 }, () => ({ exit: 255, stderr: "Connection refused" })),
    );
    const { error } = await settle(checkSystemdActive(target));
    expect(error?.message).toMatch(/probe fault/);
    expect(error?.message).toMatch(/node-a:22/);
    expect(commands).toHaveLength(3);
  });

  it("throws a probe fault on a timeout, never false", async () => {
    outcomes.push(...Array.from({ length: 3 }, () => ({ killed: true as const })));
    const { error } = await settle(checkSystemdActive(target));
    expect(error).toBeInstanceOf(SshProbeFault);
    expect(error?.message).toMatch(/probe fault: SSH to node-a:22 timed out or was killed/);
    expect(commands).toHaveLength(3);
  });

  it("retries connection-level failures as probe faults", async () => {
    for (const stderr of [
      "ssh: connect to host node-a port 22: Connection refused",
      "ssh: connect to host node-a port 22: Connection timed out",
      "ssh: connect to host node-a port 22: Operation timed out",
      "ssh: connect to host node-a port 22: No route to host",
      "kex_exchange_identification: read: Connection reset by peer",
      "Connection closed by 10.0.0.5 port 22",
    ]) {
      commands.length = 0;
      outcomes.push(...Array.from({ length: 3 }, () => ({ exit: 255, stderr })));
      const { error } = await settle(checkSystemdActive(target));
      expect(error).toBeInstanceOf(SshProbeFault);
      expect(error?.message).toMatch(/^probe fault: SSH to node-a:22 could not connect: /);
      expect(commands).toHaveLength(3);
    }
  });

  it("faults at once, without retrying, when SSH fails for a reason that will not pass", async () => {
    const cases: [Parameters<typeof outcomes.push>[0], RegExp][] = [
      [
        { exit: 255, stderr: "spiral@node-a: Permission denied (publickey)." },
        /^SSH to node-a:22: authentication failed: spiral@node-a: Permission denied/,
      ],
      [
        { exit: 255, stderr: "Host key verification failed." },
        /^SSH to node-a:22: host key verification failed: /,
      ],
      [
        {
          exit: 255,
          stderr:
            "@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@\nHost key verification failed.",
        },
        /^SSH to node-a:22: host key verification failed: /,
      ],
      [
        {
          exit: 255,
          stderr: "ssh: Could not resolve hostname node-a: Name or service not known",
        },
        /^SSH to node-a:22: cannot resolve the host name: /,
      ],
      [{ spawnError: "ENOENT" }, /^ssh could not run for node-a:22 \(ENOENT\)$/],
      [{ exit: 255, stderr: "" }, /^SSH to node-a:22 exited 255: $/],
    ];
    for (const [outcome, message] of cases) {
      commands.length = 0;
      outcomes.length = 0;
      outcomes.push(outcome);
      const { error } = await settle(checkSystemdActive(target));
      expect(error).toBeInstanceOf(SshFault);
      expect(error?.message).toMatch(message);
      expect(commands).toHaveLength(1);
    }
  });

  it("throws a probe fault on an answer that is not an inactive state", async () => {
    outcomes.push({ exit: 4, stdout: "", stderr: "Unit ipfs.service could not be found." });
    const { error } = await settle(checkSystemdActive(target));
    expect(error?.message).toMatch(/probe fault/);
    expect(commands).toHaveLength(1);
  });

  it("recovers from a transient SSH failure", async () => {
    outcomes.push({ exit: 255, stderr: "Connection reset" }, { exit: 0, stdout: "active" });
    expect((await settle(checkSystemdActive(target))).value).toBe(true);
    expect(commands).toHaveLength(2);
  });

  it("backs off 2 s, then 4 s, between tries", async () => {
    const timedOut = {
      exit: 255,
      stderr: "ssh: connect to host node-a port 22: Connection timed out",
    };
    outcomes.push(timedOut, timedOut, { exit: 0, stdout: "active" });
    const promise = checkSystemdActive(target);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(commands).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(commands).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(commands).toHaveLength(3);
    await expect(promise).resolves.toBe(true);
  });
});

describe("startService / shutdownService", () => {
  it("queue the job with --no-block", async () => {
    await settle(startService(target));
    await settle(shutdownService(target));
    expect(commands).toEqual([
      "sudo systemctl --no-block start ipfs",
      "sudo systemctl --no-block stop ipfs",
    ]);
  });

  it("retry a transient SSH failure", async () => {
    outcomes.push(
      { exit: 255, stderr: "kex_exchange_identification: read: Connection reset by peer" },
      { exit: 0 },
    );
    expect((await settle(startService(target))).error).toBeUndefined();
    expect(commands).toHaveLength(2);
  });

  it("throw at once when systemctl itself refuses", async () => {
    outcomes.push({ exit: 1, stderr: "sudo: a password is required" });
    const { error } = await settle(shutdownService(target));
    expect(error?.message).toMatch(/password is required/);
    expect(commands).toHaveLength(1);
  });
});

describe("remoteSudoRefusals", () => {
  const start = "/usr/bin/systemctl --no-block start ipfs";
  const stop = "/usr/bin/systemctl --no-block stop ipfs";

  it("asks sudo -n -l for exactly the two runbook commands", async () => {
    outcomes.push({ exit: 0, stdout: start }, { exit: 0, stdout: stop });
    expect((await settle(remoteSudoRefusals(target))).value).toEqual([]);
    expect(commands).toEqual([`sudo -n -l ${start}`, `sudo -n -l ${stop}`]);
  });

  it("uses the topology service name", async () => {
    await settle(remoteSudoRefusals(target, "stand-in"));
    expect(commands).toEqual([
      "sudo -n -l /usr/bin/systemctl --no-block start stand-in",
      "sudo -n -l /usr/bin/systemctl --no-block stop stand-in",
    ]);
  });

  it("names each command that sudo refuses", async () => {
    outcomes.push({ exit: 1 }, { exit: 0, stdout: stop });
    expect((await settle(remoteSudoRefusals(target))).value).toEqual([start]);
    outcomes.push({ exit: 1, stderr: "sudo: a password is required" }, { exit: 1 });
    expect((await settle(remoteSudoRefusals(target))).value).toEqual([start, stop]);
  });

  it("throws a probe fault at once on a transient SSH failure", async () => {
    outcomes.push({ exit: 255, stderr: "Connection reset" });
    const { error } = await settle(remoteSudoRefusals(target));
    expect(error).toBeInstanceOf(SshProbeFault);
    expect(commands).toHaveLength(1);
  });

  it("throws on an SSH fault instead of reporting a refusal", async () => {
    outcomes.push({ exit: 255, stderr: "spiral@node-a: Permission denied (publickey)." });
    const { error } = await settle(remoteSudoRefusals(target));
    expect(error).toBeInstanceOf(SshFault);
    expect(commands).toHaveLength(1);
  });
});

describe("assertSshReachable", () => {
  it("recovers from a transient failure", async () => {
    outcomes.push({ killed: true }, { exit: 0 });
    expect((await settle(assertSshReachable(target))).error).toBeUndefined();
    expect(commands).toEqual(["true", "true"]);
  });

  it("throws after three failed tries", async () => {
    outcomes.push(...Array.from({ length: 3 }, () => ({ exit: 255, stderr: "No route to host" })));
    const { error } = await settle(assertSshReachable(target));
    expect(error?.message).toMatch(/SSH to node-a:22 failed: probe fault: /);
    expect(error?.cause).toBeInstanceOf(SshProbeFault);
    expect(commands).toHaveLength(3);
  });

  it("does not retry an authentication failure and keeps it as the cause", async () => {
    outcomes.push({ exit: 255, stderr: "spiral@node-a: Permission denied (publickey)." });
    const { error } = await settle(assertSshReachable(target));
    expect(error?.message).toMatch(
      /SSH to node-a:22 failed: SSH to node-a:22: authentication failed/,
    );
    expect(error?.cause).toBeInstanceOf(SshFault);
    expect(commands).toHaveLength(1);
  });
});

describe("ssh failure messages", () => {
  it("never carry the ssh command line or the identity file", async () => {
    outcomes.push({ spawnError: "EACCES" });
    const { error } = await settle(assertSshReachable({ ...target, identityFile: "/secret/key" }));
    expect(error?.message).toBe(
      "SSH to node-a:22 failed: ssh could not run for node-a:22 (EACCES)",
    );
    expect(String(error?.cause)).not.toMatch(/secret|-i |BatchMode/);
  });

  const keyPath = "/home/spiral/.ssh/spiral_campaign";
  const keyWarnings = [
    `Warning: Identity file ${keyPath} not accessible: No such file or directory.`,
    `no such identity: ${keyPath}: No such file or directory`,
    `Load key "${keyPath}": bad permissions`,
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @",
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    `Permissions 0644 for '${keyPath}' are too open.`,
    "This private key will be ignored.",
  ].join("\n");

  it("drop OpenSSH warnings that quote the identity file from a connection fault", async () => {
    outcomes.push(
      ...Array.from({ length: 3 }, () => ({
        exit: 255,
        stderr: `${keyWarnings}\nssh: connect to host node-a port 22: Connection refused`,
      })),
    );
    const { error } = await settle(assertSshReachable({ ...target, identityFile: keyPath }));
    expect(error?.message).toMatch(/Connection refused/);
    expect(error?.message).not.toMatch(/spiral_campaign|Identity file|Load key/);
  });

  it("drop them from an authentication failure", async () => {
    outcomes.push({
      exit: 255,
      stderr: `${keyWarnings}\nspiral@node-a: Permission denied (publickey).`,
    });
    const { error } = await settle(assertSshReachable({ ...target, identityFile: keyPath }));
    expect(error?.message).toMatch(/authentication failed: spiral@node-a: Permission denied/);
    expect(error?.message).not.toMatch(/spiral_campaign/);
  });

  it("drop them from a remote command that exited non-zero", async () => {
    outcomes.push({ exit: 1, stderr: `${keyWarnings}\nsudo: a password is required` });
    const { error } = await settle(shutdownService({ ...target, identityFile: keyPath }));
    expect(error?.message).toMatch(/exited 1: sudo: a password is required$/);
    expect(error?.message).not.toMatch(/spiral_campaign/);
  });

  it("redact the identity file path wherever else it appears", () => {
    expect(stderrTail(`debug1: Trying ${keyPath} first`, keyPath)).toBe(
      "debug1: Trying <identity file> first",
    );
    expect(stderrTail(`Permissions 0644 for '${keyPath}' are too open.`)).toBe("");
  });
});
