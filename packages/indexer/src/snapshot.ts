import type { CatalogSnapshot } from "@spiral-backbone/db";

export type SnapshotTable = "organizations" | "memberships" | "films" | "filmReplicas";

export type SnapshotDiff =
  | { table: SnapshotTable; key: string; kind: "missing" | "unexpected" }
  | {
      table: SnapshotTable;
      key: string;
      kind: "field";
      field: string;
      expected: string;
      actual: string;
    };

type Row = Record<string, unknown>;

const TABLES: SnapshotTable[] = ["organizations", "memberships", "films", "filmReplicas"];

function rowKey(table: SnapshotTable, row: Row): string {
  return table === "filmReplicas" ? `${row["film"]}#${row["slot"]}` : String(row["address"]);
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return JSON.stringify(value);
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  const byAddress = <T extends { address: string }>(rows: T[]) =>
    [...rows].sort((a, b) => compareKeys(a.address, b.address));
  return {
    organizations: byAddress(snapshot.organizations),
    memberships: byAddress(snapshot.memberships),
    films: byAddress(snapshot.films),
    filmReplicas: [...snapshot.filmReplicas].sort(
      (a, b) => compareKeys(a.film, b.film) || a.slot - b.slot,
    ),
  };
}

export function diffSnapshots(expected: CatalogSnapshot, actual: CatalogSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  for (const table of TABLES) {
    const expectedRows = new Map(
      (expected[table] as Row[]).map((row) => [rowKey(table, row), row]),
    );
    const actualRows = new Map((actual[table] as Row[]).map((row) => [rowKey(table, row), row]));
    for (const key of [...expectedRows.keys()].sort(compareKeys)) {
      const expectedRow = expectedRows.get(key)!;
      const actualRow = actualRows.get(key);
      if (!actualRow) {
        diffs.push({ table, key, kind: "missing" });
        continue;
      }
      const fields = new Set([...Object.keys(expectedRow), ...Object.keys(actualRow)]);
      for (const field of [...fields].sort(compareKeys)) {
        const expectedValue = canonical(expectedRow[field]);
        const actualValue = canonical(actualRow[field]);
        if (expectedValue !== actualValue) {
          diffs.push({
            table,
            key,
            kind: "field",
            field,
            expected: expectedValue,
            actual: actualValue,
          });
        }
      }
    }
    for (const key of [...actualRows.keys()].sort(compareKeys)) {
      if (!expectedRows.has(key)) diffs.push({ table, key, kind: "unexpected" });
    }
  }
  return diffs;
}
