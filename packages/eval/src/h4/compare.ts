import type { CatalogSnapshot, FilmRecord, FilmReplicaRecord } from "@spiral-backbone/db";
import { diffSnapshots, type SnapshotDiff } from "@spiral-backbone/indexer";
import { cidStringToBytes, type InventoryRecord } from "@spiral-backbone/protocol";

export interface GoldenComparison {
  diffs: SnapshotDiff[];
  missingOrganizations: string[];
  rebuiltCount: number;
  failingFilms: Set<string>;
}

export function filmRecordsFromGolden(golden: InventoryRecord[]): {
  films: FilmRecord[];
  filmReplicas: FilmReplicaRecord[];
} {
  return {
    films: golden.map((g) => ({
      address: g.film_pda,
      organization: g.organization,
      submitter: g.submitter,
      cid: cidStringToBytes(g.cid).cid.slice(0, g.cid_len),
      cidLen: g.cid_len,
      byteSize: BigInt(g.byte_size),
      chunkingProfile: g.chunking_profile,
      title: g.title,
      submittedAt: BigInt(g.submitted_at),
      accessPolicy: g.access_policy,
      replicaCount: g.replica_count,
      schemaVersion: g.schema_version,
      bump: g.bump,
    })),
    filmReplicas: golden.flatMap((g) =>
      g.replicas.map((r) => ({
        film: g.film_pda,
        slot: r.slot,
        peerId: new Uint8Array(Buffer.from(r.peer_id_hex, "hex")),
        peerIdLen: r.peer_id_len,
        declaredAt: BigInt(r.declared_at),
        active: r.active,
      })),
    ),
  };
}

export function compareWithGolden(
  golden: InventoryRecord[],
  catalog: CatalogSnapshot,
): GoldenComparison {
  const expected = filmRecordsFromGolden(golden);
  const goldenOrgs = new Set(golden.map((g) => g.organization));
  const goldenFilms = new Set(golden.map((g) => g.film_pda));
  const films = catalog.films.filter(
    (f) => goldenOrgs.has(f.organization) || goldenFilms.has(f.address),
  );
  const inScope = new Set(films.map((f) => f.address));
  const filmReplicas = catalog.filmReplicas.filter((r) => inScope.has(r.film));

  const diffs = diffSnapshots(
    { organizations: [], memberships: [], ...expected },
    { organizations: [], memberships: [], films, filmReplicas },
  );
  const knownOrgs = new Set(catalog.organizations.map((o) => o.address));
  const missingOrganizations = [...goldenOrgs].filter((o) => !knownOrgs.has(o)).sort();

  const failingFilms = new Set(
    diffs.map((d) => d.key.split("#")[0]!).filter((film) => goldenFilms.has(film)),
  );
  for (const g of golden) {
    if (missingOrganizations.includes(g.organization)) failingFilms.add(g.film_pda);
  }
  return {
    diffs,
    missingOrganizations,
    rebuiltCount: films.filter((f) => goldenFilms.has(f.address)).length,
    failingFilms,
  };
}
