import { describe, expect, it } from "vitest";
import { CliError } from "../lib/errors";
import { assertDistinctPeers, parseReplicaUrls, submitOptionsSchema } from "./submit";

const valid = {
  org: "spiralhq",
  workId: "pd-001",
  manifest: "dataset/manifest.json",
  file: "/tmp/film.mp4",
  title: "A Trip to the Moon",
  replicas: "http://node-a:5001,http://node-b:5001,http://node-c:5001",
  cluster: "devnet",
  keypair: "/tmp/id.json",
};

describe("submit command options", () => {
  it("accepts a well-formed set of options", () => {
    expect(submitOptionsSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a work id", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest["workId"];
    expect(submitOptionsSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a title over 160 characters", () => {
    expect(submitOptionsSchema.safeParse({ ...valid, title: "x".repeat(161) }).success).toBe(false);
  });
});

describe("parseReplicaUrls", () => {
  it("trims and dedupes", () => {
    expect(parseReplicaUrls(" http://a:5001 ,http://a:5001,http://b:5001")).toEqual([
      "http://a:5001",
      "http://b:5001",
    ]);
  });

  it("refuses more than 8 replicas", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `http://n${i}:5001`).join(",");
    expect(() => parseReplicaUrls(nine)).toThrow(/at most 8/);
  });
});

describe("assertDistinctPeers", () => {
  it("accepts URLs that resolve to distinct PeerIDs", () => {
    expect(() =>
      assertDistinctPeers(
        ["http://a:5001", "http://b:5001"],
        [{ peerId: "12D3KooWA" }, { peerId: "12D3KooWB" }],
      ),
    ).not.toThrow();
  });

  it("refuses two URLs that resolve to the same PeerID, naming both", () => {
    const attempt = () =>
      assertDistinctPeers(
        ["http://a:5001", "http://127.0.0.1:5001", "http://localhost:5001"],
        [{ peerId: "12D3KooWA" }, { peerId: "12D3KooWB" }, { peerId: "12D3KooWB" }],
      );
    expect(attempt).toThrow(CliError);
    expect(attempt).toThrow(/http:\/\/127\.0\.0\.1:5001 and http:\/\/localhost:5001.*12D3KooWB/);
  });
});
