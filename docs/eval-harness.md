# Evaluation harness (Phase 5a: H1, H3, H4, report)

`packages/eval` turns the hypotheses into commands. Each writes one NDJSON line per attempt, validated
against the frozen schema in `packages/protocol/src/results.ts`, plus a sidecar for data the schema
has no field for. H2 (Phase 5b) is documented separately.

| Command                                                                                   | Output                                                               | Sidecar                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run eval:h1 -- --golden results/inventory-golden.ndjson`                             | `results/h1.ndjson`                                                  | `h1.evidence.ndjson` (tamper offset/bytes, mismatch diagnosis, retrieval errors)             |
| `npm run eval:h3`                                                                         | `results/h3.ndjson`                                                  | `h3.evidence.ndjson` (observed code, instruction index, refusing program, full program logs) |
| `npm run eval:h4 -- --golden results/inventory-golden.ndjson --database-url postgres://…` | `results/h4.ndjson`                                                  | `h4.run.json` (backfill report, counts, missing organizations, field diffs)                  |
| `npm run eval:report`                                                                     | `results/report/report.md`, `h1.csv`, `h3.csv`, `h4-divergences.csv` | —                                                                                            |

`run_id` = `<ISO second>Z-<h1|h3|h4>-<label>`. The report shows the latest run per hypothesis.

Every command also appends to `<out>.runs.ndjson` (for example `results/h3.runs.ndjson`): a
`started` line with `expected_attempts` before any work, and a `completed` line with
`recorded_attempts` only when the run finished. A run that aborts (an H1 harness fault, a transient
RPC error in H3, a crash) leaves only `started`. The report prints one `Status:` line under each
`Run:` line: `complete (N/N attempts)`, `**INCOMPLETE** — run did not finish (M of N expected
attempts recorded)`, or `unknown (no run-status sidecar)` for runs that predate the sidecar. H1
counts one intact attempt per work; tampered attempts are not part of the denominator because an
intact mismatch makes them not evaluable. H4 writes `completed` on the success and refutation
paths, and leaves only `started` after an infrastructure failure. The marker lives in the markdown
only; the CSVs are unchanged.
**Exit codes report harness health, not hypothesis outcomes.** A completed run exits 0 even if
records say `failure`; invalid input, an unreadable golden, a harness fault or a failed backfill
exit 1. Harness faults and bad input never become result records: they abort the run or are
refused up front.
RPC endpoints are recorded as host only, never as the full URL.

## The golden inventory

`spiral submit --work-id <id> --manifest dataset/manifest.json …` does the following:

1. checks the file against the manifest entry (size and sha256);
2. refuses any non-Ed25519 replica PeerID (the identity multihash must start `00 24 08 01 12 20`),
   and refuses two `--replicas` URLs that resolve to the same PeerID (e.g. `localhost` and
   `127.0.0.1` for one node), naming the colliding URLs. `declare_replica` has no on-chain
   duplicate check, so this is caught before any upload or transaction;
3. uploads to every node and registers the film;
4. declares one replica per node;
5. reads the Film account back with a single-account fetch;
6. prints one `InventoryRecord` line.

Collect those lines into `results/inventory-golden.ndjson`: that file is the only link between a
`work_id` and its `film_pda`. H4 compares the rebuilt catalog against it; H1 iterates over it.
If replicas are later deactivated on-chain, the golden no longer matches. H4 then reports
`filmReplicas.active` divergences, which is correct behavior and not a bug.

**Partial submit.** `register_film` and each `declare_replica` are separate transactions. If a
`declare_replica` fails after `register_film` confirmed, the film exists on-chain but no golden line
was printed, and re-submitting the same file to the same organization fails (duplicate CID: the
Film PDA already exists). H4 would then report the film as `films:unexpected`. To recover, either
submit to a fresh organization, or record the golden line by hand from the Film account (read it
back and build the `InventoryRecord` with the signatures you have).

## H1

For each golden line: read the Film account on-chain, retrieve the CID **through a Kubo RPC URL
(never a public gateway — that would warm the cache and contaminate H2's cold CIDs)**, then
recompute the CID with the isolated `packages/eval/verifier` (streaming, flat memory). After that,
flip one byte (XOR 0xff) at a deterministic offset in the middle half of the file and recompute
again, expecting a mismatch.

An intact mismatch is diagnosed in the evidence as one of three causes:

- `retrieved_bytes_differ_from_original`: the retrieved sha256 differs from the manifest sha256;
- `onchain_cid_malformed`: `cid_len` ≠ 36 or the prefix is not `01701220`;
- `chunking_parameters_diverge`: neither of the above.

After an intact mismatch the tamper attempt is **not evaluable**: no `tampered` record is written
and it is not counted. The evidence gets
`{ run_id, work_id, scenario: "tampered", not_evaluable: "intact recomputation already mismatched" }`
instead, because a mismatch on the tampered copy would prove nothing.

Only failures on the remote side become `failure` records: a Kubo timeout (`timeout`), an
unreachable node, an RPC 429 or 5xx (`connection_error`), or a missing object or Film account
(`object_unavailable`). A local I/O fault while writing the retrieved file (ENOSPC, EACCES, EROFS,
EMFILE, EISDIR, or a failed open/write) and an RPC 4xx other than 429 (401/403/404 from a
misconfigured endpoint) abort the run with exit 1.

## H3

Each run creates fresh fixtures: organizations `h3-<label>-a` and `h3-<label>-b`, five ephemeral
signers funded with 0.02 SOL each, and one existing film. It then sends the seven registrations
as raw transactions with `skipPreflight: true`, never through the CLI. The high-level
`client.sendTransaction` cannot be used here, because it fails before sending and leaves no
signature. Each attempt passes only if it confirms on-chain with `InstructionError[0, Custom(code)]`:

| #   | Scenario                            | Code                              | Refused by                             |
| --- | ----------------------------------- | --------------------------------- | -------------------------------------- |
| 1   | no Membership                       | 3012 (AccountNotInitialized)      | film                                   |
| 2   | revoked                             | 6001                              | organization (CPI `assert_can_submit`) |
| 3   | Reader role                         | 6002                              | organization                           |
| 4   | Membership of another org           | 6003                              | organization                           |
| 5   | signer ≠ membership.member          | 6004                              | organization                           |
| 6   | duplicate CID                       | 0 (account already in use)        | System Program                         |
| 7   | a Film account passed as Membership | 3007 (AccountOwnedByWrongProgram) | film                                   |

Because the organizations are created per run, **every H3 run needs a fresh `--label`**: re-using
one fails with "already in use". The default label is a base-36 timestamp, so omitting `--label`
is the simplest choice.

Scenario 7 on Devnet cannot write arbitrary bytes into a System-owned account the way the Phase 1
litesvm test does. It passes a real Film account instead: an account with data, owned by another
program, which yields the same owner-check failure.

## H4

`eval:h4` runs `backfill({ reset: true })`, which performs `DROP SCHEMA public CASCADE` →
migrations → `getProgramAccounts`. It then restricts the rebuilt catalog to the golden's
organizations and films and diffs it field by field. **It destroys the target database**: never
point `--database-url` at anything shared. The URL must be given explicitly with `--database-url`;
`DATABASE_URL` in the environment is ignored on purpose, so a forgotten variable pointing at a dev
database can never be wiped.

If the backfill fails, `h4.run.json` records the error and the command exits 1. When the cause is
an account the indexer cannot project (`InvalidAccountError`), the chain itself could not be
rebuilt. That is a genuine H4 refutation, so one `failure` record per golden work is written
(`infrastructure_failure: false`). Any other cause (database unreachable, RPC errors,
permissions) is an infrastructure failure: no result records are written
(`infrastructure_failure: true`).

## Devnet acceptance (manual — researcher)

The programs are not deployed on Devnet (checked 2026-10-02). In `spiral-programs`:

1. Back up `keys/organization-keypair.json` and `keys/film-keypair.json` outside the repo (see
   `keys/README.md`). Losing them makes the program addresses unrecoverable.
2. `solana config set --url devnet`, then fund the deployer (`solana airdrop`, or the web faucet).
3. `anchor deploy --provider.cluster devnet` and `anchor idl init` for both programs.
4. Create `keys/bootstrap-payer-keypair.json`, fund it, then run `npx tsx scripts/bootstrap-devnet.ts`.

Then, in `spiral-backbone`, with a dedicated endpoint:

```bash
export SPIRAL_RPC_URL=https://<dedicated devnet endpoint>
# one Kubo node reachable at http://127.0.0.1:5001 (e.g. infra/kubo or a container)
npm run spiral -- org create --slug spiral-eval --name "Spiral Eval" --cluster devnet --rpc-url "$SPIRAL_RPC_URL"
npm run spiral -- submit --org spiral-eval --work-id pd-001 --file dataset/files/DuckandC1951.mp4 \
  --title "Duck and Cover" --replicas http://127.0.0.1:5001 --cluster devnet --rpc-url "$SPIRAL_RPC_URL" \
  >> results/inventory-golden.ndjson
npm run eval:h1 -- --golden results/inventory-golden.ndjson --label devnet
npm run eval:h3   # no --label: each run needs a fresh one (see H3)
npm run eval:h4 -- --golden results/inventory-golden.ndjson --database-url postgres://… --label devnet
npm run eval:report
```

Acceptance:

- criterion 1: all three commands complete and their NDJSON is valid;
- criterion 2: `report.md` shows the seven H3 codes;
- criterion 5: the report renders.
