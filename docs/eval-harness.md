# Evaluation harness (H1–H4, report)

`packages/eval` turns the project's four research hypotheses into commands:

- **H1 — integrity of the registered representation:** recomputing the CID of retrieved content
  matches the CID registered on-chain, and a tampered copy never does.
- **H2 — retrievability from the registry:** a fresh client that knows only the on-chain Film
  account retrieves and validates every work from the declared replicas. Acceptance: at least 95%
  success with all three replicas active, and recovery still operational with a single active
  replica. Consulting the local index or any application service refutes it, and so does a direct
  success with zero active replicas.
- **H3 — submission authority:** the programs refuse every unauthorized registration on-chain,
  each with its expected error code.
- **H4 — reconstructibility of the query layer:** the off-chain catalog rebuilt from on-chain
  account state alone matches the golden inventory field by field.

Each command writes one NDJSON line per attempt, validated
against the frozen schema in `packages/protocol/src/results.ts`, plus a sidecar for data the schema
has no field for.

| Command                                                                                   | Output                                                                                                                                                  | Sidecar                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run eval:h1 -- --golden results/inventory-golden.ndjson`                             | `results/h1.ndjson`                                                                                                                                     | `h1.evidence.ndjson` (tamper offset/bytes, mismatch diagnosis, retrieval errors)             |
| `npm run eval:h2 -- plan --campaign … --golden …`                                         | `plans/h2-<run_id>.json` (frozen plan)                                                                                                                  | —                                                                                            |
| `npm run eval:h2 -- run --plan … --golden … --topology …` (or `--resume <run_id>`)        | `results/h2.ndjson`, `results/h2-blocks.ndjson`                                                                                                         | `h2.evidence.ndjson` (attempt_id, generation, provenance, gateway headers), `h2.runs.ndjson` |
| `npm run eval:h3`                                                                         | `results/h3.ndjson`                                                                                                                                     | `h3.evidence.ndjson` (observed code, instruction index, refusing program, full program logs) |
| `npm run eval:h4 -- --golden results/inventory-golden.ndjson --database-url postgres://…` | `results/h4.ndjson`                                                                                                                                     | `h4.run.json` (backfill report, counts, missing organizations, field diffs)                  |
| `npm run eval:report`                                                                     | `results/report/report.md`, `h1.csv`, `h2-rates.csv`, `h2-by-replicas.csv`, `h2-latency.csv`, `h2-provenance-audit.csv`, `h3.csv`, `h4-divergences.csv` | —                                                                                            |

`run_id` = `<ISO second>Z-<h1|h2|h3|h4>-<label>`. The report shows the latest run per hypothesis.

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

The real campaign — servers, program deploy, submit, the runs in order, daily archive and
teardown — is in the [campaign runbook](campaign-runbook.md).

## The golden inventory

`spiral submit --work-id <id> --manifest dataset/manifest.json …` does the following:

1. checks the file against the manifest entry (size and sha256);
2. refuses any non-Ed25519 replica PeerID (the identity multihash must start `00 24 08 01 12 20`),
   and refuses two `--replicas` URLs that resolve to the same PeerID (e.g. `localhost` and
   `127.0.0.1` for one node), naming the colliding URLs, before any upload or transaction;
3. uploads to every node, then registers the film unless its Film PDA already exists. An existing
   Film must have the same CID, byte size and title, otherwise submit exits 1 and touches nothing;
4. declares a replica for each `--replicas` node whose PeerID is not already active on the Film.
   An inactive one is reactivated; an active one is skipped (the program would refuse it with
   film 6010 `DuplicateReplica`);
5. reads the Film account back with a single-account fetch;
6. takes `register_signature` and `replica_signatures` from the Film's transaction history
   (`getSignaturesForAddress` on the Film PDA). Each instruction is identified by its
   discriminator and must name this Film. `register_signature` is the oldest successful
   `register_film`. `replica_signatures` has one entry per active slot, in slot order: the
   newest successful `declare_replica` for that PeerID, which is the one that made it active, and
   its `blockTime` must equal the slot's `declared_at`. `replicas[]` also lists inactive slots, so
   the two arrays are not index-aligned. If any signature cannot be determined after a few
   retries (including a listed transaction that `getTransaction` does not return), submit exits 1
   and prints nothing on stdout;
7. prints one `InventoryRecord` line.

Collect those lines into `results/inventory-golden.ndjson`: that file is the only link between a
`work_id` and its `film_pda`. H4 compares the rebuilt catalog against it; H1 iterates over it.
If replicas are later deactivated on-chain, the golden no longer matches. H4 then reports
`filmReplicas.active` divergences, which is correct behavior and not a bug.

**Older goldens.** Golden lines captured before H2 have no `cold_cid` and no longer parse. Re-run
submit to regenerate them. No default is applied, on purpose: guessing `cold_cid` could let a
cold work through the gateway before the zero-replica block.

**Partial submit.** `register_film` and each `declare_replica` are separate transactions, so a
submit can stop after the Film exists but before the golden line is printed. Rerun the same
command: submit is idempotent per work, skips what is already on-chain, and prints the same golden
line an uninterrupted run would have printed, apart from timestamps and the signatures of
transactions sent in the rerun. Do not move to a fresh
organization to recover. A Film left behind in the campaign organization without a golden line
would show up in H4 as `films:unexpected`, so recovering into a fresh organization means
resubmitting all 20 works there.

### On-chain error codes

Custom program error codes overlap across the two programs (organization uses 6000-6010, film
6005-6013): always read the failing instruction's program ID before decoding. The generated clients export each set as
`ORGANIZATION_ERROR__*` and `FILM_ERROR__*`.

| Program      | Code      | Name                                   | Meaning                                                 |
| ------------ | --------- | -------------------------------------- | ------------------------------------------------------- |
| organization | 6000-6005 | `MembershipNotFound` ... `SlugInvalid` | See the generated `organization/errors`                 |
| organization | 6006      | `NameTooLong`                          | Name longer than 96 bytes                               |
| organization | 6007      | `MembershipNotActive`                  | Target membership is not active                         |
| organization | 6008      | `AuthorityProtected`                   | The authority's membership cannot be revoked or changed |
| organization | 6009      | `MemberCountOverflow`                  | Member count overflowed                                 |
| organization | 6010      | `NameEmpty`                            | Empty name                                              |
| film         | 6005-6009 | `InvalidCidLength` ... `InvalidPeerId` | See the generated `film/errors`                         |
| film         | 6010      | `DuplicateReplica`                     | PeerID already holds an active replica slot             |
| film         | 6011      | `TitleTooLong`                         | Title longer than 160 bytes                             |
| film         | 6012      | `CidPaddingNotZero`                    | CID buffer is not zero after `cid_len`                  |
| film         | 6013      | `ReplicaCountOverflow`                 | Replica count overflowed                                |

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

## H2

H2 has four parts:

1. **Frozen plan.** `eval:h2 plan` expands a campaign spec and the golden inventory into
   `plans/h2-<run_id>.json`. The file is written once and never overwritten. Every attempt has a
   deterministic `attempt_id` = `<block>/<work_id>/<method>/r<repetition>`, a `timeout_ms` of
   `base_ms + ceil(bytes / 1,000,000) × per_mb_ms`, and a `gateway_eligible` flag.
2. **Orchestrator.** `eval:h2 run` walks the blocks in plan order. It applies each block's replica
   state, checks it, runs the attempts, and checks it again.
3. **Executor.** Each attempt runs in its own `docker run --rm` container and prints exactly one
   JSON line `{ record, evidence }`.
4. **Report.** The H2 section of `eval:report`; see below.

A record's `scenario` is `<block>@g<generation>` (e.g. `replicas=1@g1`), and `attempt` is the
repetition. The `attempt_id` is not in the frozen results schema: it lives in the plan and in the
evidence sidecar. `tx_signature` is `null`.

**Campaign spec.** It lists `replica_nodes`, `stabilization_ms`, `max_gate_attempts`,
`max_end_attempts`, `max_block_generations`, `timeout` and the `blocks` (`main`, `cold-start` or `degradation`, with
`active_replicas`, `methods`, `works` = `all | cold | warm | [work_id…]` and `repetitions`). The
degradation blocks must be contiguous and nested, with exactly `N, N-1, …, 0` active replicas in
that order. Any other shape is rejected. Only degradation blocks may have zero active replicas.
Duplicate `attempt_id`s (e.g. from a duplicate `work_id`) abort `plan`. `max_end_attempts` is
required: a spec file without it is rejected (`max_end_attempts is required`). A plan frozen
before the field existed still loads and runs with a single end check per generation.

**Cold CIDs.** A gateway attempt on a `cold_cid` work in any block before the first zero-replica
block would warm the public cache. `plan` refuses it (`ColdCidViolation`) and writes no plan. The
executor also refuses (exit 3) a gateway attempt whose `gateway_eligible` is false, and the run
aborts.

### Replica state

State is never assumed:

- A node is **observed active** only if `systemctl is-active` over SSH and `ipfs ping` from the
  network node agree.
- The intended state is **confirmed** only if every node's two checks match the intention **and**
  `findprovs` from the network node lists every intended-active replica for every CID of the
  block. `findprovs` never proves a node is **off**: stale provider records outlive the node, so
  the ping does that. The lookups run in parallel, at most 5 at a time; each stops as soon as
  every intended-active replica has been seen for that CID, or at `--providers-timeout-ms`.
- A probe that cannot answer is a harness fault, never "off". Before trusting a node as off, the
  check asserts that the network node API is alive and that the node answers SSH. `systemctl
is-active` reads as off only when it answers an inactive state (exit 3); an SSH failure (exit
  255, timeout, spawn error) is a probe fault.
- SSH reachability, `systemctl is-active`, start, stop, the network node liveness call and the
  ping are each tried 3 times (2 s, then 4 s, between tries) before their failure counts. A ping
  reads as unreachable only after all three tries fail. A ping call that cannot reach the
  network node API is a fault, never an unreachable replica.
- Start and stop run `systemctl --no-block`, so they return once the job is queued; the check
  observes the outcome.

Each block goes through these steps:

1. **Gate.** Apply the state, sleep `stabilization_ms`, check. Repeat up to `max_gate_attempts`
   times until the check is confirmed.
2. Run the attempts.
3. **End re-check.** Check up to `max_end_attempts` times, sleeping `stabilization_ms` between
   tries, until the check is confirmed. Every try is an `end` record. The generation is
   invalidated only when the last try is still unconfirmed, or at once when any try sees a node
   whose systemd or ping state contradicts the intention (a missing provider record alone is
   retried). An invalidated generation stays in the artifacts, nothing is deleted, and the block
   runs again as generation `g+1` with a new `scenario`.

Every check is a line in `h2-blocks.ndjson` (`phase` = `gate | end`, `check_number`, the observed
nodes, `missing_providers`, `confirmed`, `reasons`, `at`). A generation is **valid** only if its
last `end` record is confirmed. After the last block, every replica is turned back on.

A generation run beyond `max_block_generations` (see [Faults and resume](#faults-and-resume)) is
preceded by one line with `phase: "extra_generation"`, the block, the `generation`, the campaign's
`max_block_generations`, `intended_active`, a `reason` and `at`. It carries no check fields.

### Executor

- **Fresh node.** Each attempt gets a fresh repo with `Provide.Enabled=false`,
  `Routing.Type=dhtclient`, `HTTPRetrieval.Enabled=false` and `Discovery.MDNS.Enabled=false`. It
  is bootstrapped only to `bootstrap_multiaddr` (the network node in the dry run) or to the public
  defaults, **never to the replicas**.
- **Firewall.** `block_cidrs` are rejected with `iptables` inside the container, so the
  submission machine cannot serve the content.
- **Registry read.** The executor reads the Film account itself from `film_pda` + `rpc_url`. It
  takes the CID and the declared active PeerIDs from it, and uses no local index or service.
- **Retrieval.** `direct` runs `ipfs cat`. `gateway` uses HTTP and records the status and cache
  headers. Either way, the CID is then recomputed with the isolated verifier.
- **Exit codes.** 0 = attempt recorded, success or failure. 3 = refused (cold CID). 2 = harness
  fault.

**Verdict.** The executor applies these rules in order:

1. A retrieval error gives its class: `timeout`, `object_unavailable`, `connection_error` or
   `gateway_failure`.
2. A different CID gives `cid_mismatch`.
3. A `gateway` hit with zero active replicas gives `external_cache`.
4. A `direct` success must pass the provenance rule below; otherwise it is `external_cache`.

**Direct provenance.** After `cat`, the executor reads the bitswap ledger of every peer in the
union of `swarm peers` and the `bitswap stat --verbose` peers. Each peer is marked declared or
undeclared against the Film account. A direct attempt is a success only if all three hold:

- `DataReceived` > 0;
- zero ledger bytes came from undeclared peers;
- the declared ledger total is at least the `dag stat --offline` size of the file.

`DataReceived` itself is not compared against the DAG size: it counts redundant copies of the root sent concurrently
by several replicas. The evidence `provenance` records, for audit: the per-peer rows,
`data_received`, `dup_data_received`, `dag_size`, `ledger_declared_total`,
`ledger_undeclared_total` and `unattributed` (`data_received` minus the ledger sum).

**Known limitation:** if an undeclared peer sends a copy of a block that a declared replica also
sent, bitswap cannot tell them apart. The only trace is a positive `unattributed`; the report's
direct provenance audit shows its distribution (see [Report](#report)).

### Faults and resume

Harness faults abort the run, so nothing is recorded for that attempt. `eval:h2 run` exits **75**
(`EX_TEMPFAIL`) when the fault is safe to resume after a wait, and **1** otherwise. Exit 75 covers
only: an SSH timeout or connection-level failure after its retries (`probe fault: SSH to … timed
out or was killed`, `… could not connect: Connection refused|timed out|reset|closed|No route to
host`), a network node API that stays unreachable on the network
(`network node API unreachable (…)`, also during a ping), the executor timeout (`executor timed out after <n> s`), the executor's inner budgets
(`provenance exceeded its <n> s budget at ipfs …`, `ipfs daemon did not become ready`), and a
registry read whose retries ran out (`registry unavailable after <n> attempts: …`). Everything
else exits 1: a refusal, any other executor fault, a mismatch, inconsistent artifacts,
`GenerationLimitError`, a gate that never confirms, a held lock, bad input, and SSH or API
failures that waiting will not fix. Those fault at once, without retries: SSH
`authentication failed`, `host key verification failed`, `cannot resolve the host name`,
`ssh could not run`, any other SSH exit 255, a `systemctl is-active` answer that is not a state,
and `network node API at <host> failed: …` (an HTTP error or an unresolvable host). Harness
faults are:

- executor exit 2, a refusal, or anything other than one valid output line;
- inside the executor: a registry read error (RPC HTTP error, missing Film account), a local
  filesystem error while writing the retrieved file, or a `bitswap stat` without a `Peers` key.
  Registry reads are retried up to 3 times (1 s, 2 s, 4 s) on 429, 5xx, a timeout, or a
  `fetch failed` whose cause is ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, EPIPE or an undici
  socket or timeout error, before faulting with `registry unavailable after <n> attempts: …`.
  Any other registry error faults at once, including ENOTFOUND (a mistyped `rpc_url`);
- an SSH failure or an unanswerable probe, after its retries;
- an executor container that outlives its budget: the attempt `timeout_ms` + 60 s daemon start +
  127 s registry worst case (4 × 30 s + 1 + 2 + 4 s) + 60 s provenance. The fault ends with
  `executor timed out after <n> s`;
- a gate that never confirms within `max_gate_attempts`;
- a block that exceeds `max_block_generations` (`GenerationLimitError`); see the extra generation
  below;
- a record whose `cid_expected` or `film_pda` differs from the planned attempt (e.g. the RPC
  points at another cluster that has an account at the same PDA);
- evidence whose `declared_replicas` set differs from the topology's replica PeerIDs (an extra or
  missing declared peer would mis-attribute provenance and could fake a refutation);
- inconsistent artifacts (see below).

`eval:h2 run --resume <run_id> --topology …` reloads `plans/h2-<run_id>.json` and skips every
result already recorded under the same `scenario`. It handles each block as follows:

- A block whose last `end` is confirmed is skipped.
- A block whose last `end` since the generation's last `gate` is unconfirmed resumes at `g+1`.
  A recorded miss always invalidates the generation, even when a crash cut an end check or a
  resume pre-check short before its last try: the gap before the resume is unbounded and the
  state may have been repaired meanwhile, so a later confirmation would not describe the state
  the attempts ran in. Retries happen only within one uninterrupted run.
- A block that crashed mid-generation with results already recorded is checked **before** the
  state is re-applied:
  - The check is retried like the end check: each unconfirmed try is logged as
    `end confirmed:false`, and the block moves to `g+1` only on node drift or when every try
    missed.
  - If it is confirmed, it is logged as an extra `gate` record, followed by the normal
    re-apply gate or gates, and the remaining attempts run in the same generation. The resume
    pre-check is the **first** `gate` record of that generation whose `at` is later than the
    generation's last pre-crash result. It closes the pre-crash segment, so each segment is
    bracketed by state checks.
- A confirmed `end` with missing results aborts the run: the artifacts are inconsistent.

`check_number` continues across resumes.

**Extra generation.** By default a block that would need generation `max_block_generations + 1`
aborts with `GenerationLimitError`, and a plain resume aborts again. After finding the cause of the
drift, `eval:h2 run --resume <run_id> --allow-extra-generation …` permits exactly one more
generation for the block at the limit and writes the `extra_generation` line before it. The flag
is refused without `--resume`, or when no block of the run is at its limit. It is not stored: if
that generation is also invalidated, the run aborts again and needs the flag again. A resume
without the flag finishes an extra generation that was already logged.

Operator notes:

- `--resume` must be given the same `--out` as the original run. A different `--out` starts from
  scratch in the new file.
- `eval:h2 run` holds two locks while it runs, `<topology>.lock` (next to the resolved
  `--topology` file) and `<out>.lock`, each created exclusively with its PID and start time. A
  second run on the same topology, whatever its run_id or `--out`, or on the same `--out`, exits 1
  with `<path>.lock is held by running PID <pid>`. A lock left by a process that is no longer
  running (or carrying the current process's own PID) is taken over, and the takeover is logged.
  The locks are removed on exit.
- A crash in the middle of an append can leave a final line without its newline. On `--resume`,
  such a line in the results, the block log, the evidence or the run markers is moved to
  `<file>.partial-<ts>` and logged; the attempt it belonged to is simply re-run. Without
  `--resume`, and anywhere but the last line, a broken line is refused.
- A mid-run fault leaves the replicas in the failing block's state. Resume re-applies the state;
  nothing has to be restored by hand.
- Error messages redact every URL from the topology (RPC, gateway, network node API, bootstrap
  multiaddr). The SSH `host:port` of a replica may still appear: it is operator diagnostics.
- The attempt payload, including the full `rpc_url`, enters the executor container as the
  `SPIRAL_ATTEMPT` environment variable, set in the environment of the `docker run` child process and
  passed with `docker run -e SPIRAL_ATTEMPT`. The RPC URL is therefore not in the `docker run`
  arguments, so `ps` on the control machine does not show it. It remains in the container's
  environment, so `docker inspect` on the control machine shows it while the container runs.
  Records only ever contain the host.
- The run files stamp the backbone commit; it ends in `-dirty` when tracked files had uncommitted
  changes, so campaign data from an unclean checkout is recognisable.
- SSH failure messages carry only the host, port and exit status plus the tail of ssh's own stderr;
  they never include the `ssh` command line or the identity file path. Pre-flight errors never carry
  the payer keypair path.

**Evidence pairing.** The orchestrator appends the evidence line before the result line, and the
result line is the commit point. A crash between the two can leave evidence with no result, and
resume then writes a second evidence line for the same attempt. Analysis must join evidence to
results on `(attempt_id, generation)`, take the **last** evidence line for each key, and ignore
evidence that has no result.

### Report

The report shows the latest H2 run. It reads that run's frozen plan from
`--plans-dir <dir>/h2-<run_id>.json` (default `plans`) to learn each block's `kind` and the
campaign's highest active replica count. The report fails with exit 1, with no fallback, on:

- a missing file: `frozen plan <path> not found — pass --plans-dir`;
- unreadable JSON, a schema mismatch or a plan without blocks:
  `frozen plan <path> is invalid: <reason>`;
- a plan of another run: `frozen plan <path> belongs to run <plan run_id>, not <run_id>`;
- the same `(run_id, scenario, work_id, method, attempt)` twice among the reported run's results:
  `duplicate H2 result (…) appears N times`;
- a results file whose last line was cut by a crash: `<file>:<n>: truncated final line …`.
  Resume the run (which moves the line aside) before reporting.

- **Included attempts.** Only attempts whose generation's last `end` is confirmed are counted.
  The others are excluded and counted on two separate lines: one for an unconfirmed end
  (`end-of-block replica state not confirmed`), one for a crash before the end check
  (`no end-of-block state check recorded`). Attempts of invalid generations are
  the report's "excluded" attempts.
- **Extra generations.** When the block log has `extra_generation` lines, the report prints
  `Generations beyond the campaign limit: N (block <block>@g<n>, …)`.
- **Attempts line.** The line reads
  `Attempts included: X of Y planned (Z recorded, including re-run generations)`. Y is the plan's
  attempt count. Z counts every record of the run, including records of invalid generations.
  **This line is the authoritative count.**
- **Status line.** On a completed run it prints `complete (R/Y attempts)`, where R is the
  `recorded_attempts` of the `completed` marker. R includes re-run generations, so it can exceed Y
  (e.g. `complete (8/6)`). On an unfinished run it prints `**INCOMPLETE**` with the included count
  of Y (`X of Y expected attempts included`).
- **Acceptance line.** Right after the attempts line:
  `**Success with N active replicas: X% (S of D, excluding E external_cache) — criterion ≥ 95%: met|NOT met**`
  ("replica" when N = 1). N is the highest `active_replicas` count in the frozen plan, never a
  count inferred from the attempts that happened to be valid. The line combines both methods and
  every block with N active replicas (e.g. `main`, `cold-start` and `replicas=3`), counting each
  block's attempts from its valid generations only. `external_cache` stays outside the denominator
  D. X has two decimals and is truncated, not rounded, so it cannot contradict the verdict at the boundary (`94.99%` for 18999 of 19999). When D = 0 the
  verdict is `no data`. When no valid attempt has N active replicas (e.g. every such generation
  was unconfirmed), the line reads
  `**Success with N active replicas: no valid attempts — criterion ≥ 95%: no data**`; it never
  falls back to a lower count. The line states the observation; the exit code does not depend on
  it.
- **Direct-only line.** Right after the acceptance line:
  `**Direct-only success with N active replicas: X% (S of D, excluding E external_cache) — criterion ≥ 95%: met|NOT met|no data**`.
  It counts only `direct` attempts at N active replicas, with the same valid-generation filter,
  the same `external_cache` exclusion and the same truncation as the combined line. With no valid
  direct attempt it reads `no valid attempts … no data`. The combined line stays as context; the
  direct-only line is the one that tests recovery from the registry without the gateway.
- **One-replica line.**
  `**Direct success with 1 active replica: S of D (X%) — recovery operational: yes|no|no data**`
  counts `direct` attempts in blocks with exactly one active replica (`external_cache` outside D).
  `yes` means S > 0; `no` means D > 0 and S = 0; `no data` means no valid attempt, or D = 0.
- **Refutation line.** `**Direct success with zero active replicas: N** — this refutes H2.` It
  appears only when an included `direct` attempt succeeded in a zero-replica block.
- **Contaminated control line.** The report prints:

  ```text
  **Zero-replica control contaminated: N direct recoveries from undeclared sources** — does not refute H2; the zero-replica control is weakened.
  ```

  It counts included `direct` attempts recorded as `external_cache` in a zero-replica block: the
  content was recovered and verified, but from a peer the Film account does not declare. That
  does not refute H2, which is only refuted by delivery from declared replicas (a direct
  `success`). It does mean something outside the registry still served the content with every
  replica off, so the zero-replica control no longer isolates the replicas. The line prints
  independently of the refutation line, and both can appear.

- **Rate table (`h2-rates.csv`).** One row per `replica_state` × method, in plan order.
  `replica_state` is the block name. `external_cache` has its own column and is left out of the
  denominator of `success_rate`. Blocks that share an active replica set (e.g. `main`,
  `cold-start` and `replicas=3`) stay separate rows here.
- **By active replicas (`h2-by-replicas.csv`).** Under `### By active replicas`: one row per
  active replica count × method, highest count first, with the same columns and rate formula as
  the rate table. Blocks with the same count are combined.
- **Latency table (`h2-latency.csv`).** Successful attempts per block kind (`main`, `cold-start`,
  `degradation`, from the frozen plan) × size band × method.
  `latency_ms` covers the whole attempt, including:
  - the registry RPC read, including retries (`registry_attempts` in the evidence marks them);
  - for `direct`: `initFreshNode`, daemon startup and the provenance queries;
  - the CID recomputation.
- **Cold vs warm.** Neither table separates cold works from warm ones: nothing in the report reads
  `cold_cid`, and blocks with `works: "all"` mix both. To compare them, use campaign blocks with
  `works: "cold"` / `"warm"`, or join the records against the golden inventory's `cold_cid`.
- **Failure table.** Keyed by `replica_state`, method and `failure_class`. It is markdown only,
  with no CSV.
- **Direct provenance audit (`h2-provenance-audit.csv`).** Under `### Direct provenance audit`,
  after the failure table. The population is the included `direct` successes. Each is joined to
  the run's lines of `h2.evidence.ndjson` (same `run_id`; the sidecar holds every run) on
  `(attempt_id, generation)`, taking the last line per key. The table gives
  min, median, p95 and max (nearest rank) of `unattributed_bytes` and of
  `unattributed_pct_of_dag` (`unattributed / dag_size × 100`, two decimals; a null `dag_size`
  leaves that attempt out of the pct row only, and the report then prints
  `Percent row excludes K direct successes without dag_size`). The sign is kept.
  `Direct successes audited: N` counts the joined successes.
  - **Reading it.** This is the check for the known provenance limitation above. Values near zero
    mean the ledgers explain every byte received. A negative value means the ledgers counted more
    than `DataReceived`, which is harmless. A large positive value means more bytes arrived than
    the ledgers explain; an undeclared peer may have sent duplicate blocks. Those successes deserve
    a manual look at their evidence `peers` rows before the success rate is trusted.
  - **Missing evidence.** A direct success with no evidence line, or with `provenance: null`, is an
    artifact inconsistency. The report prints
    `**Direct successes without provenance evidence: N**` and leaves it out of the table.
  - An evidence line that is not valid JSON, lacks `run_id`, `attempt_id`,
    `provenance.unattributed` or `provenance.dag_size`, or whose `generation` is not a positive
    integer, fails the report. So does a joined direct success with `dag_size` 0:
    `evidence for <attempt_id> (generation N): dag_size is 0 on a direct success`.
- **Plan consistency.** The report fails if an included attempt's block has a different
  `intended_active` count in the block log than `active_replicas` in the frozen plan:
  `block <name>: block log has X intended active replicas, frozen plan has Y`.

### Dry run

`packages/eval/campaigns/h2-dry-run.json` is a reduced campaign (`main`, `cold-start`,
`replicas=3…0`, one repetition, `stabilization_ms` 3 s). `startLocalTopology()` in
`packages/eval/src/h2/testing/local-topology.ts` starts a private Docker network with a swarm key.
It contains a network node, a gateway-only node and three systemd-in-Docker replicas controlled
over SSH. `packages/eval/src/h2/h2.e2e.test.ts` runs the whole flow against it with a Surfpool
chain:

- degradation in order;
- a crash and resume;
- drift that invalidates a generation;
- the report.

The chain must drain its events (see [the embedded Surfpool stall](solana-kit-notes.md#testing-against-surfpool)).

### Real campaign

The operator sequence is in the [campaign runbook](campaign-runbook.md); this section only lists
what H2 itself requires.

- **Campaign.** The campaign composition is the researcher's decision, written as a campaign
  spec: `packages/eval/campaigns/h2-final.json`.
- **Timing.** On the public DHT, a gate needs minutes in total, not seconds, for provider records
  to propagate after a restart. `h2-final.json` gets them from repeated short gates:
  `stabilization_ms: 30000` × up to `max_gate_attempts: 20` bounds each gate at about 10 minutes,
  while a gate whose state confirms early costs only 30 s. The end check gets
  `max_end_attempts: 5` tries, 30 s apart, before a provider-record miss invalidates a
  generation. The timeout is
  `{ "base_ms": 60000, "per_mb_ms": 1000 }` (`timeout` is required in the spec).
- **Topology.** Start from `packages/eval/campaigns/topology.example.json`; replace the `<…>`,
  `.example` and PeerID values.
  - `replicas` must equal the active replicas declared on every Film in the golden. A mismatch
    faults on the first attempt.
  - The network node is a Kubo container on the orchestrator with its API published on
    `127.0.0.1:15001`, which gives `network_node.api_url` = `http://127.0.0.1:15001` (runbook §3).
  - `bootstrap_multiaddr: null` means the public DHT, and `swarm_key_path: null` means the public
    network.
  - Set `block_cidrs` to the submission machine's address.
  - `replicas[].ssh` uses the `spiral` operator account from the
    [IPFS nodes runbook](ipfs-nodes-runbook.md).
- **Executor image.** Build it on the control machine with `buildExecutorImage()` or
  `docker build -t spiral-h2-executor:dev packages/eval/src/h2/executor`.

### Kubo 0.43.1 notes

- `Reprovider.*` is deprecated, and the daemon refuses to start with it. Use `Provide.Strategy`
  and `Provide.DHT.Interval`. `infra/kubo/setup.sh` sets `Provide` and clears `Reprovider`.
- A private network (swarm key) requires `AutoConf.Enabled=false` and `AutoTLS.Enabled=false`.
- `Routing.AcceleratedDHTClient=true` never becomes ready in a tiny private DHT, so nothing gets
  provided. It is off in the local overlay only, and stays on in `setup.sh` for the public DHT.
- `--profile server` filters private addresses, so the local overlay sets `Swarm.AddrFilters=[]`
  and `Addresses.NoAnnounce=[]`.

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

Only transactions that landed on-chain are judged. A `sendTransaction` transport error (HTTP
429/5xx, a network error) aborts the run, and so does a transaction that never lands: the harness
polls (every 500 ms, for at most 90 s) until the transaction is confirmed or the block height
passes the `lastValidBlockHeight` of its blockhash, then throws "transaction expired without
landing". An aborted attempt writes no result record and the run stays `started`. A transaction that landed and failed with a program
error is the observation; one that landed and succeeded (an unauthorized registration got through)
is recorded as a `failure`. A transaction that landed with an error but whose `getTransaction`
response has missing or empty `logMessages` is a provider fault, not an observation: it aborts the
run like a transport error instead of being recorded as a `failure`.

Because the organizations are created per run, **every H3 run needs a fresh `--label`**: re-using
one fails with "already in use". The default label is a base-36 timestamp, so omitting `--label`
is the simplest choice.

Scenario 7 on Devnet cannot write arbitrary bytes into a System-owned account the way the litesvm
test in `spiral-programs` (`programs/film/tests/h3_scenarios.rs`) does. It passes a real Film account instead: an account with data, owned by another
program, which yields the same owner-check failure.

## H4

`eval:h4` runs `backfill({ reset: true })`, which performs `DROP SCHEMA public CASCADE` →
migrations → `getProgramAccounts`. It then restricts the rebuilt catalog to the golden's
organizations and films and diffs it field by field. **It destroys the target database**: never
point `--database-url` at anything shared. The URL must be given explicitly with `--database-url`;
`DATABASE_URL` in the environment is ignored on purpose, so a forgotten variable pointing at a dev
database can never be wiped.

If the backfill fails, `h4.run.json` records the error and the command exits 1. When the cause is
an account the indexer cannot project (`InvalidAccountError`) and that account is in the golden
scope (an organization in the golden, or a Film whose organization is in the golden), the golden's
data could not be rebuilt. That is a genuine H4 refutation, so one `failure` record per golden work
is written (`infrastructure_failure: false`). An undecodable account outside that scope (another
organization, a stray Film, a Membership) says nothing about the golden: it is an infrastructure
failure whose message names the account. Any other cause (database unreachable, RPC errors,
permissions) is also an infrastructure failure: no result records are written
(`infrastructure_failure: true`).

## Cluster check

`eval:h1`, `eval:h3` and `eval:h4` call `getGenesisHash` before anything else and compare it with
`--expected-genesis`, which defaults to the Devnet genesis hash. On a mismatch (or an unreachable
RPC) the command exits 1 before writing any file, with the RPC URL redacted. Pass the cluster's own
genesis hash only for a local validator. `eval:h1` also calls the Kubo API (`/api/v0/id`) once
before the loop and exits 1 with `Kubo API unreachable at <host> — is the tunnel open?` when it
fails.

## Devnet acceptance (manual — researcher)

Deploy the programs first: [campaign runbook §1](campaign-runbook.md#1-devnet-programs) (key
backup, deploy, IDL metadata, payer, and why pre-flight checks the deployed bytecode against your
local build). Then, in `spiral-backbone`, with a dedicated endpoint. This is a rehearsal, not the
campaign: use a scratch results directory so nothing enters the campaign's `results/` (the report
and the golden live there) and the golden cannot be mixed with the real one:

```bash
export SPIRAL_RPC_URL=https://<dedicated devnet endpoint>
mkdir -p scratch/results
# one Kubo node reachable at http://127.0.0.1:5001 (e.g. infra/kubo or a container)
npm run spiral -- org create --slug spiral-eval --name "Spiral Eval" --cluster devnet --rpc-url "$SPIRAL_RPC_URL"
npm run spiral --silent -- submit --org spiral-eval --work-id pd-001 --file dataset/files/DuckandC1951.mp4 \
  --title "Duck and Cover" --replicas http://127.0.0.1:5001 --cluster devnet --rpc-url "$SPIRAL_RPC_URL" \
  >> scratch/results/inventory-golden.ndjson
npm run eval:h1 -- --golden scratch/results/inventory-golden.ndjson --kubo-url http://127.0.0.1:5001 --out scratch/results/h1.ndjson --label devnet
npm run eval:h3 -- --out scratch/results/h3.ndjson   # no --label: each run needs a fresh one (see H3)
npm run eval:h4 -- --golden scratch/results/inventory-golden.ndjson --database-url postgres://… --out scratch/results/h4.ndjson --label devnet
npm run eval:report -- --results-dir scratch/results --out-dir scratch/results/report
```

`--silent` keeps npm's `> spiral` banner out of stdout, and so out of the golden file.

By default the report shows the latest run of each hypothesis. `--run-h1`, `--run-h2`,
`--run-h3` and `--run-h4` pick a run by id, so a stray later run can be left out without editing
files. The H4 sidecar holds one run only; a different `--run-h4` id is an error. When the records
included for a hypothesis carry more than one distinct `artifact_versions` object, the report
prints `**WARNING: mixed artifact versions in this run: …**` under that hypothesis's heading,
listing each version object.

It passes when:

- all three commands complete and their NDJSON is valid;
- `report.md` shows the seven H3 codes;
- the report renders.
