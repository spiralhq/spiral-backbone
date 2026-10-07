import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchViaGateway } from "./gateway";

describe("fetchViaGateway", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end("content"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("rethrows a local filesystem error instead of classifying it", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "gw-")), "missing-dir", "content");
    await expect(fetchViaGateway(url, "bafy", dest, 5_000)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(!existsSync("/dev/full"))(
    "rethrows a local write error (ENOSPC, no path) instead of classifying it",
    async () => {
      await expect(fetchViaGateway(url, "bafy", "/dev/full", 5_000)).rejects.toMatchObject({
        code: "ENOSPC",
        syscall: "write",
      });
    },
  );

  it("still classifies an unreachable gateway as connection_error", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "gw-")), "content");
    const out = await fetchViaGateway("http://127.0.0.1:1", "bafy", dest, 5_000);
    expect(out.result).toMatchObject({ ok: false, failureClass: "connection_error" });
  });
});
