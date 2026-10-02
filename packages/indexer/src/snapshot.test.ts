import type { CatalogSnapshot } from "@spiral-backbone/db";
import { describe, expect, it } from "vitest";
import { diffSnapshots, sortSnapshot } from "./snapshot";

function snapshot(): CatalogSnapshot {
  return {
    organizations: [
      {
        address: "org-b",
        authority: "auth",
        slug: "b",
        name: "B",
        createdAt: 2n,
        memberCount: 1,
        schemaVersion: 1,
        bump: 254,
      },
      {
        address: "org-a",
        authority: "auth",
        slug: "a",
        name: "A",
        createdAt: 1n,
        memberCount: 3,
        schemaVersion: 1,
        bump: 255,
      },
    ],
    memberships: [],
    films: [
      {
        address: "film-a",
        organization: "org-a",
        submitter: "auth",
        cid: new Uint8Array([1, 2, 3]),
        cidLen: 3,
        byteSize: 9_007_199_254_740_993n,
        chunkingProfile: 1,
        title: "T",
        submittedAt: 5n,
        accessPolicy: "Public",
        replicaCount: 1,
        schemaVersion: 1,
        bump: 252,
      },
    ],
    filmReplicas: [
      {
        film: "film-a",
        slot: 0,
        peerId: new Uint8Array([9]),
        peerIdLen: 1,
        declaredAt: 6n,
        active: true,
      },
    ],
  };
}

describe("diffSnapshots", () => {
  it("returns no differences for identical snapshots regardless of row order", () => {
    const shuffled = snapshot();
    shuffled.organizations.reverse();
    expect(diffSnapshots(snapshot(), shuffled)).toEqual([]);
  });

  it("reports a missing and an unexpected row by key", () => {
    const actual = snapshot();
    actual.organizations = actual.organizations.filter((org) => org.address !== "org-a");
    actual.filmReplicas.push({
      film: "film-a",
      slot: 1,
      peerId: new Uint8Array([8]),
      peerIdLen: 1,
      declaredAt: 7n,
      active: false,
    });
    expect(diffSnapshots(snapshot(), actual)).toEqual([
      { table: "organizations", key: "org-a", kind: "missing" },
      { table: "filmReplicas", key: "film-a#1", kind: "unexpected" },
    ]);
  });

  it("detects a bigint difference beyond Number precision", () => {
    const actual = snapshot();
    actual.films[0]!.byteSize = 9_007_199_254_740_992n;
    expect(diffSnapshots(snapshot(), actual)).toEqual([
      {
        table: "films",
        key: "film-a",
        kind: "field",
        field: "byteSize",
        expected: "9007199254740993n",
        actual: "9007199254740992n",
      },
    ]);
  });

  it("detects a single-byte difference in a bytes field", () => {
    const actual = snapshot();
    actual.films[0]!.cid = new Uint8Array([1, 2, 4]);
    expect(diffSnapshots(snapshot(), actual)).toEqual([
      {
        table: "films",
        key: "film-a",
        kind: "field",
        field: "cid",
        expected: "0x010203",
        actual: "0x010204",
      },
    ]);
  });
});

describe("sortSnapshot", () => {
  it("orders rows by primary key", () => {
    expect(sortSnapshot(snapshot()).organizations.map((org) => org.address)).toEqual([
      "org-a",
      "org-b",
    ]);
  });
});
