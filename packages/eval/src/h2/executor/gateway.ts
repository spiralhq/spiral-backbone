import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FailureClass } from "@spiral-backbone/protocol";

export const RECORDED_HEADERS = [
  "x-ipfs-roots",
  "x-ipfs-path",
  "etag",
  "cache-control",
  "age",
  "x-cache",
  "x-cache-status",
  "cf-cache-status",
  "server",
  "via",
  "date",
];

export async function fetchViaGateway(
  gatewayUrl: string,
  cid: string,
  dest: string,
  timeoutMs: number,
): Promise<{
  result: { ok: true } | { ok: false; failureClass: FailureClass; error: string };
  status: number | null;
  headers: Record<string, string>;
}> {
  const headers: Record<string, string> = {};
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/ipfs/${cid}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const name of RECORDED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    if (!response.ok || !response.body) {
      return {
        result: { ok: false, failureClass: "gateway_failure", error: `HTTP ${response.status}` },
        status: response.status,
        headers,
      };
    }
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(dest));
    return { result: { ok: true }, status: response.status, headers };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.path !== undefined || errno.syscall === "write") throw error;
    const name = (error as Error).name;
    const failureClass: FailureClass =
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection_error";
    return {
      result: { ok: false, failureClass, error: (error as Error).message },
      status: null,
      headers,
    };
  }
}
