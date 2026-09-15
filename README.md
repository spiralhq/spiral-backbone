# spiral-backbone

`spiral-backbone` is the off-chain half of the **Spiral protocol**, a decentralized
audiovisual-preservation architecture that combines IPFS content-addressed storage with
Solana on-chain registration. This repository holds the indexing, verification, CLI, and
evaluation tooling that runs off-chain; the on-chain programs live in a separate repo,
[`spiralhq/spiral-programs`](https://github.com/spiralhq/spiral-programs).

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
├── scripts/             # Repo-level scripts (e.g. import-boundary checker)
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
  and the scripts test suite. Intended for local development.
- `npm run check:ci` — same as `check`, but runs Oxfmt with `--check` instead of `--write`
  so CI fails on unformatted code instead of silently reformatting it.
- `npm run test` — runs `turbo run test` across all packages.
- `npm run check:boundaries` — runs the import-boundary checker directly.
- `npm run test:scripts` — runs the vitest suite for `scripts/`.

## Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request: install, build,
`check-types`, `check:ci`, and `test`.
