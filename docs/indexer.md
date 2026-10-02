# Indexer

`spiral-indexer backfill` rebuilds the relational catalog (`packages/db`) from on-chain account
state alone. It is the component H4 tests.

## Usage

    SPIRAL_RPC_URL=https://<dedicated devnet endpoint> \
    DATABASE_URL=postgres://… \
    npm run indexer -- backfill [--reset] [--report results/backfill.json]

`--reset` runs `DROP SCHEMA public CASCADE` and re-applies the migrations first. Without it the
migrations are applied if needed and the four catalog tables are replaced in one transaction.
`--reset` drops everything in schema `public` (tables, types, extensions, grants) — never point
`DATABASE_URL` at a shared database.

stdout is one JSON line (`BackfillReport`): row counts, `rpc_calls` per method (a retried call
counts once), `rate_limit_retries` (HTTP 429s absorbed by backoff — counted apart so Phase 5 can
tell RPC throttling from a recovery failure), `duration_ms`, and the endpoint as `rpc_endpoint`
(host only) + `rpc_endpoint_fingerprint` (`sha256:` of the full URL, first 12 hex). The full URL
is never printed: Helius and QuickNode embed the API key in it. `--rpc-url` must be `http(s)`.

Every run emits a report, including a failed one: `status` is `"succeeded"` or `"failed"`; a
failed report adds `error` (the message, with the RPC URL redacted to its host), all `counts` are
0, and it still carries the endpoint, `rpc_calls`, `rate_limit_retries` and timings accumulated up
to the failure — so a run killed by throttling is distinguishable from a recovery failure. The CLI
prints it to stdout (and `--report`), prints `Backfill failed: <message>` to stderr and exits 1.
The endpoint is described before any database work, so a malformed URL aborts before `--reset`
drops anything.

## How accounts are read

1. `getProgramAccounts(program, { dataSlice: {offset: 0, length: 0}, filters: [memcmp at 0 = discriminator] })`
   for each of `Organization`, `Membership` (organization program) and `Film` (film program):
   addresses only.
2. `getMultipleAccounts` in batches of 100 (the RPC limit), decoded with the Codama decoders.

The three `getProgramAccounts` listings run sequentially at different slots, so a state change
mid-run could produce an inconsistent snapshot; run backfill against a quiescent chain for H4
measurements.

No transaction history, no events (ADR-03) — `src/no-history.test.ts` enforces it. An account
that matches a discriminator but cannot be decoded, has out-of-range lengths, or has a
`schemaVersion` other than 1 (organizations and films; memberships have none) aborts the run with
its address: skipping it would hide a missing record from H4.

## Schema notes

- Columns mirror the generated account types exactly (e.g. `Organization` has no `film_count`,
  despite the early design doc). The only local column is `indexed_at`, never compared.
- `films.cid` stores exactly `cid_len` bytes; base32 is derived at query time with
  `bytesToCidString` from `@spiral-backbone/protocol`.
- `film_replicas` has one row per slot `< replica_count`, deactivated replicas included.
- u64/i64 values are Postgres `bigint` read as JS `bigint`. A u64 above 2^63−1 would be rejected
  by Postgres (loudly), never wrapped.
- Kit's UTF-8 decoder strips U+0000, so a NUL inside an on-chain string is stored without it; the
  H4 diff uses the same decoder on both sides and cannot see this.

## Migrations journal lives in `public`

`migrateCatalog` passes `migrationsSchema: "public"` (and `drizzle.config.ts` sets
`migrations.schema = "public"`). With Drizzle's default (`drizzle` schema), `DROP SCHEMA public
CASCADE` leaves the journal behind and the next `migrate()` recreates nothing — the exact H4
sequence would silently produce an empty database.

## `follow` mode: cut

The optional `logsSubscribe` mode was cut for schedule (Phase 4 acceptance criterion 3). No
hypothesis depends on it. The `sync_cursor` table exists (slot + signature) so that adding it
later needs no migration, but nothing writes to it today.

## Tests

- Unit (fake RPC transport): projection, diff, RPC instrumentation, batching, decode failures.
- Postgres (Docker `postgres:18`): migrations, reset, transactional write/read.
- Acceptance (`src/e2e/`, Surfpool + real `spiral-programs` binaries): DROP SCHEMA → backfill →
  empty field-by-field diff. Skipped when `spiral-programs` isn't built next to this repo;
  `SPIRAL_E2E=required` turns the skip into a failure. Turbo passes `SPIRAL_E2E` through and
  never caches `test`, so this works both with `npx vitest run --root packages/indexer` and with
  the root `npm run test`.
