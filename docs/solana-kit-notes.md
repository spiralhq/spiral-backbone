# @solana/kit implementation notes

Gotchas discovered while building `packages/protocol` and `packages/cli` that
aren't obvious from Kit's own docs. Referenced from a few source comments; kept here instead
of repeated inline.

## RPC and WebSocket URL resolution

`solanaRpc({ rpcUrl })` derives the WebSocket subscriptions URL from `rpcUrl` by convention
(scheme swap, standard port offset). That only holds for well-known layouts (devnet, a local
validator's default ws port). An ephemeral Surfpool surfnet's RPC and WS ports are both
independently, randomly assigned, so `sendTransaction` fails with "WebSocket failed to
connect" unless the WS URL is passed explicitly — `rpcSubscriptionsUrl` on
`createSpiralClient`, `--ws-url` on the CLI commands that send transactions.

## Read-only vs. signing clients

`solanaRpc`/`solanaDevnetRpc`/`solanaLocalRpc` all require a `payer` already set on the
client. A read-only client (`fetch`, `verify` — no signer, no keypair needed) uses
`solanaRpcConnection({ rpcUrl })` instead, which only adds bare `rpc`/`rpcSubscriptions`.

## `signerFromFile` is a client plugin factory, not a signer factory

`signerFromFile(path)` returns `(client) => Promise<ExtendedClient>`, meant to be passed to
`.use()`. `await signerFromFile(path)` alone resolves to the function itself (functions
aren't thenables, so the `await` is a no-op) — `.address` on that is `undefined`. Apply it to
a client to get a real `KeyPairSigner`.

## `sendTransaction()`'s return shape

Resolves to a `SuccessfulSingleTransactionPlanResult`, not a bare signature string —
`{ context, kind, planType, plannedMessage, status }`. The signature is at
`.context.signature`. `${result}` silently stringifies to `"[object Object]"`, which passed
type-checking undetected until a real send in the CLI's end-to-end test caught it.

## Event-CPI accounts aren't auto-defaulted

Anchor's `#[event_cpi]` self-CPI pattern needs `eventAuthority` (PDA seed
`["__event_authority"]` under the program's own address) and `program` (the program's own
address) supplied explicitly to Codama's `...Async` instruction builders. Unlike other
PDA-derivable accounts, Codama doesn't default these two — confirmed for both
`film::register_film` and `organization::revoke_membership`.

## Codama PDA finders need IDL `pda` metadata

Codama only auto-generates a `find{Name}Pda` for an account when the IDL's `pda` field
expresses its seeds. `organization.json` has 8 such entries (`findOrganizationPda`,
`findMembershipPda`, `findAdminMembershipPda` all generated). `film.json` has none — Film's
PDA seed is `sha256(cid[..cidLen])`, which Anchor's IDL seed DSL can't express (no
Borsh-length-prefix-aware slicing) — so `findFilmPda` (`packages/protocol/src/pda.ts`) is
hand-written and hand-verified against a real generated PDA value instead. The same gap means
`film`'s `register_film` only gets a sync `getRegisterFilmInstruction`, not an `...Async`
variant — callers must resolve `film`/`eventAuthority` themselves.

## `renderVisitor`'s default output layout

Without options, `renderVisitor` scaffolds a whole standalone package: its own
`package.json`, sources nested under a further `src/generated/` inside whatever folder it's
pointed at. `{ generatedFolder: ".", syncPackageJson: false }` renders flat into the target
folder directly instead — the layout every consumer in this codebase imports from.

## Testing against Surfpool

`packages/cli/src/e2e/submit-fetch-verify.test.ts` needs a sibling `spiral-programs` checkout
with `anchor build` already run, plus the `solana-keygen` CLI — neither is available on a
plain CI runner, and provisioning cross-repo checkout credentials for a private repo is
security-sensitive and out of scope. The test skips gracefully with a clear message when
either is missing (`SPIRAL_E2E=required` turns that into a hard failure instead, for a
developer or pre-merge check that needs the guarantee it actually ran). Full e2e verification
is a local-only run.

A few Kit-specific things this test (and any future one against an ephemeral Surfpool
surfnet) needs to get right:

- The surfnet client must be assigned to a variable `afterAll` can reach _before_ calling
  `.deploy()` — if deploy throws, the native surfnet process is already running and still
  needs to be stopped.
- The test payer needs a real file-backed keypair (`solana-keygen`), not an in-memory Kit
  signer — freshly generated Kit signers are non-extractable by design and can't be written
  to the file `--keypair` expects.
- An embedded surfnet started with `startWithConfig({ offline: true })` keeps producing slots
  and buffers one simnet event per slot until `Surfnet.drainEvents()` is called. Nothing in
  the Kit plugin drains that buffer. Undrained, the surfnet stops answering RPC after about
  1,000 slots (~80 s at the default rate), while its port stays bound, so clients just hang.
  Any test that keeps a surfnet up longer than that must drain the events on an interval.
  `packages/eval/src/testing/chain.ts` does this. The H2 dry run was the first test long
  enough to hit it.
- `handleCliError` calls `process.exit(1)` on any CLI failure, which would kill the test
  worker if invoked for real in-process. Mock `process.exit` to throw instead when testing a
  failure path, and mock `console.error` to inspect what it printed.

## `verify`'s CID recomputation isn't H1 evidence

The CLI's `verify` command is a convenience recomputation for operators, not the formal
evidence source. `packages/eval/verifier/` is a deliberately separate, independently
re-implemented verifier (not imported from `protocol`) that H1's actual evidence comes from —
see that package's own isolation boundary rule (`eval-verifier-isolation` in
`scripts/check-boundaries.ts`).
