const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof DOMException)
    return error.name === "TimeoutError" || error.name === "AbortError";
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}
