# spiral-backbone

`spiral-backbone` is the off-chain half of the **Spiral protocol**, a decentralized
audiovisual-preservation architecture that combines IPFS content-addressed storage with
Solana on-chain registration. This repository holds the indexing, verification, CLI, and
evaluation tooling that runs off-chain; the on-chain programs live in a separate repo,
[`spiralhq/spiral-programs`](https://github.com/spiralhq/spiral-programs).

The evaluation tests four research hypotheses, H1–H4 (integrity, retrievability from the
registry, submission authority, reconstructibility of the query layer). They are defined in
[`docs/eval-harness.md`](docs/eval-harness.md), and the real campaign that runs them is in
[`docs/campaign-runbook.md`](docs/campaign-runbook.md).

This is a TypeScript monorepo managed with npm workspaces and Turborepo. Linting and
formatting run on Oxlint/Oxfmt (no ESLint, no Prettier).

## Project Structure

```
spiral-backbone/
├── packages/
│   ├── config/          # Shared tsconfig base used by every package
│   ├── db/              # Database schema & queries (Drizzle ORM, Postgres)
│   ├── protocol/        # Protocol-level types/logic shared across packages
│   ├── cli/             # Command-line interface
│   ├── indexer/         # Off-chain indexer
│   └── eval/            # Evaluation harness
│       └── verifier/    # Isolated CID re-computation, evidence for hypothesis H1
├── infra/
│   └── kubo/            # Kubo node setup script + systemd unit
├── scripts/             # Repo-level scripts (import-boundary checker, manifest validator, Kubo node
│                        #   control agent, daily campaign archive) and their tests
└── dataset/             # Evaluation dataset (curated works used by the evaluation harness)
```

There is no `apps/` package and no HTTP API/server in this repo — none of the project's
research hypotheses require one. The `apps/*` workspace glob exists in `package.json` for
forward compatibility but is currently empty.

## Getting Started

Install dependencies:

```bash
npm install
```

Docker is required to run the full test suite: `npm run check`, `npm run test:scripts`,
and the `@spiral-backbone/eval` package's conformance/Kubo tests all spin up real
containers (a Kubo node, and a systemd-in-Docker container for the SSH control-agent
tests) and need a working local Docker daemon.

### Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up (or run `npm run db:start` to bring one
   up via Docker Compose).
2. Update `packages/db/.env` with your PostgreSQL connection details.
3. Apply the schema to your database:

```bash
npm run db:push
```

## Environment Configuration

Each package that needs environment variables owns its own `.env.schema` (currently
`packages/db/.env.schema`). [Varlock](https://varlock.dev) generates the typed `env.ts`
accessor from that schema. Codegen runs automatically via the root `postinstall` script,
and can be re-run manually after changing a schema with:

```bash
npm run env:generate
```

This runs `varlock codegen --path ./packages/db/` directly — there is no server bootstrap
or framework integration involved, since there is no server in this repo. Commit schema
files; keep secrets in ignored env files or your deployment platform.

## Import Boundaries

Two cross-package import boundaries are enforced (see `scripts/check-boundaries.ts` for the
rationale):

- `packages/eval/verifier/` must never import `@spiral-backbone/protocol` or any Kubo/IPFS
  client library — this keeps H1's CID re-computation evidence structurally independent.
- `packages/cli/src/commands/fetch(.ts|/**)` must never import `@spiral-backbone/db` or
  `@spiral-backbone/indexer`.

These are enforced two ways in parallel: an Oxlint `no-restricted-imports` override (see
`.oxlintrc.json`, catches dynamic `import()` too) and the custom regex-based
`scripts/check-boundaries.ts` script (redundant on purpose).

## IPFS Nodes

The Spiral Chunking Profile v1 (CID version 1, sha2-256, fixed 262144-byte chunks,
raw leaves, balanced layout, 174 links/node) is implemented twice, independently:
`packages/eval/verifier/` (pure TypeScript, `ipfs-unixfs-importer`) and the Kubo
submission path exercised in `packages/eval/src/conformance.test.ts`. That test
compares both on three synthetic file sizes and runs in CI on every push.

`infra/kubo/` and `scripts/kubo-node-control.ts` are the automation for the three
real Kubo nodes described in `docs/ipfs-nodes-runbook.md` — provisioning the VPS
themselves is a manual step (see that runbook); everything else (setup, the
systemd unit, and SSH start/shutdown/status control) is code, tested against local
Docker containers.

## Available Scripts

- `npm run dev` — runs `turbo run dev`. No package currently defines a `dev` script; this
  is a placeholder for when one does.
- `npm run build` — build all packages.
- `npm run check-types` — type-check the root `scripts/` directory and every workspace
  package.
- `npm run db:push` / `db:generate` / `db:migrate` / `db:studio` / `db:start` / `db:watch` /
  `db:stop` / `db:down` — Drizzle/Docker Compose commands, forwarded to `packages/db`.
- `npm run env:generate` — regenerate the Varlock-generated env accessor.
- `npm run check` — Oxlint, Oxfmt (`--write`, rewrites files), the import-boundary check,
  and the scripts test suite. Intended for local development. (Requires Docker — some of
  the scripts tests build and run real containers.)
- `npm run check:ci` — same as `check`, but runs Oxfmt with `--check` instead of `--write`
  so CI fails on unformatted code instead of silently reformatting it. (Also requires
  Docker, for the same reason.)
- `npm run test` — runs `turbo run test` across all packages.
- `npm run check:boundaries` — runs the import-boundary checker directly.
- `npm run test:scripts` — runs the vitest suite for `scripts/`.
- `npm run spiral` — the protocol CLI (`org create`, `submit`, `fetch`, `verify`).
- `npm run indexer` — the indexer CLI.
- `npm run validate:manifest` — validate `dataset/manifest.json` (`-- --final` for the campaign).
- `npm run eval:h1` / `eval:h2` / `eval:h3` / `eval:h4` / `eval:report` — the evaluation harness
  (`npm run eval` runs the bare CLI).
- `npm run campaign:preflight` — the campaign's fail-closed pre-flight.
- `npm run campaign:archive-day` — snapshot (or `--verify`) `results/` and `plans/`.

Tests that need the sibling `spiral-programs` build, Surfpool, `solana-keygen` and Docker skip
themselves when a prerequisite is missing; `SPIRAL_E2E=required` turns the skip into a failure.

## Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request: install, build,
`check-types`, `check:ci`, and `test`. The end-to-end suites skip there, because `spiral-programs`
is private and not checked out; run `SPIRAL_E2E=required npm run test` on a workstation that has
the programs built before relying on them (campaign runbook §0).
