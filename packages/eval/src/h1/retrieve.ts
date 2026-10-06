import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FailureClass } from "@spiral-backbone/protocol";
import { create } from "kubo-rpc-client";

export class RetrievalError extends Error {
  readonly failureClass: FailureClass;

  constructor(failureClass: FailureClass, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.failureClass = failureClass;
  }
}

const CONNECTION_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|socket hang up/i;

function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error) || depth > 5) return String(error);
  const code = (error as { code?: unknown }).code;
  return [
    error.name,
    error.message,
    typeof code === "string" ? code : "",
    errorText(error.cause, depth + 1),
  ].join(" ");
}

export function classifyRetrievalError(error: unknown): FailureClass {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "timeout";
  if (CONNECTION_PATTERN.test(errorText(error))) return "connection_error";
  return "object_unavailable";
}

const LOCAL_ERROR_CODES = new Set(["ENOSPC", "EACCES", "EROFS", "EMFILE", "EISDIR"]);
const LOCAL_SYSCALLS = new Set(["open", "write"]);

export function isLocalWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return (
    (typeof code === "string" && LOCAL_ERROR_CODES.has(code)) ||
    (typeof syscall === "string" && LOCAL_SYSCALLS.has(syscall))
  );
}

export function retrievalFailureOrigin(error: unknown, sourceFailed: boolean): "source" | "local" {
  if (isLocalWriteError(error)) return "local";
  return sourceFailed ? "source" : "local";
}

export async function retrieveToFile(
  kuboUrl: string,
  cid: string,
  destPath: string,
  timeoutMs: number,
): Promise<number> {
  const client = create({ url: kuboUrl });
  const signal = AbortSignal.timeout(timeoutMs);
  let bytes = 0;
  let sourceFailed = false;
  try {
    const source = Readable.from(
      (async function* () {
        try {
          for await (const chunk of client.cat(cid, { signal })) {
            bytes += chunk.byteLength;
            yield chunk;
          }
        } catch (error) {
          sourceFailed = true;
          throw error;
        }
      })(),
    );
    await pipeline(source, createWriteStream(destPath));
    return bytes;
  } catch (error) {
    if (retrievalFailureOrigin(error, sourceFailed) === "local") throw error;
    const failureClass = signal.aborted ? "timeout" : classifyRetrievalError(error);
    throw new RetrievalError(
      failureClass,
      `retrieving ${cid} from ${new URL(kuboUrl).host} failed (${failureClass}): ${(error as Error).message}`,
      { cause: error },
    );
  }
}
