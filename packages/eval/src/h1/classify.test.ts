import {
  SolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { classifyWorkError } from "./classify";
import { RetrievalError } from "./retrieve";

describe("classifyWorkError", () => {
  it("maps known causes", () => {
    expect(classifyWorkError(new RetrievalError("timeout", "slow"))).toBe("timeout");
    expect(
      classifyWorkError(
        new SolanaError(SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND, {
          address: "11111111111111111111111111111111" as never,
        }),
      ),
    ).toBe("object_unavailable");
    for (const statusCode of [429, 500, 503]) {
      expect(
        classifyWorkError(
          new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
            message: "x",
            headers: new Headers(),
            statusCode,
          } as never),
        ),
      ).toBe("connection_error");
    }
  });

  it("returns null for harness faults so the runner rethrows", () => {
    expect(classifyWorkError(new Error("ENOSPC"))).toBeNull();
  });

  it("returns null for client-side HTTP errors other than 429", () => {
    for (const statusCode of [400, 401, 403, 404]) {
      expect(
        classifyWorkError(
          new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
            message: "x",
            headers: new Headers(),
            statusCode,
          } as never),
        ),
      ).toBeNull();
    }
  });
});
