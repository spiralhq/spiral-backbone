# 🌀 Spiral Backbone

<div align="center">

[![CI](https://github.com/spiralhq/spiral-backbone/actions/workflows/ci.yml/badge.svg)](https://github.com/spiralhq/spiral-backbone/actions/workflows/ci.yml)
[![TypeScript 6](docs/assets/badges/typescript.svg)](https://www.typescriptlang.org)
[![Node.js 22.18 or later](docs/assets/badges/node.svg)](https://nodejs.org)
[![Solana Devnet](docs/assets/badges/solana.svg)](https://solana.com)
[![IPFS Kubo 0.43.1](docs/assets/badges/ipfs.svg)](https://ipfs.tech)
[![PostgreSQL 18](docs/assets/badges/postgres.svg)](https://www.postgresql.org)
[![License MIT](docs/assets/badges/license.svg)](LICENSE)

**Off-chain half of the Spiral protocol**

_Indexing, content-addressed storage, CLI, and the evaluation harness that puts the protocol to the test._

</div>

---

## ✨ Overview

**Spiral** is a protocol for preserving audiovisual works by combining
content-addressed storage (IPFS) with on-chain registration (Solana). The
on-chain programs live in a separate repository,
[`spiralhq/spiral-programs`](https://github.com/spiralhq/spiral-programs);
this repository holds everything that runs off-chain — the indexer, the
CLI, the IPFS node automation, and the evaluation harness that tests the
protocol's hypotheses against a real campaign.

The evaluation harness tests four research hypotheses, **H1–H4**:
integrity, retrievability from the registry, submission authority, and
reconstructibility of the query layer. They are defined in
[`docs/eval-harness.md`](docs/eval-harness.md); the real campaign that runs
them is in [`docs/campaign-runbook.md`](docs/campaign-runbook.md).

This is a TypeScript monorepo managed with npm workspaces and Turborepo.
Linting and formatting use Oxlint and Oxfmt.

---

## 🧱 Project Structure

```
spiral-backbone/
├── packages/
│   ├── config/          # Shared tsconfig base used by every package
│   ├── db/              # Database schema and queries (Drizzle ORM, Postgres)
│   ├── protocol/        # Protocol types and logic shared across packages
│   ├── cli/             # Command-line interface
│   ├── indexer/         # Off-chain indexer
│   └── eval/            # Evaluation harness
│       └── verifier/    # Isolated CID re-computation, evidence for H1
├── infra/
│   └── kubo/            # Kubo node setup script and systemd unit
├── scripts/             # Import-boundary checker, manifest validator,
│                        #   Kubo node control agent, daily campaign archive
├── docs/                # Runbooks and technical notes
└── dataset/             # Evaluation dataset (curated works)
```

The repository has no HTTP API or server: none of the research hypotheses require one.

---

## 📦 Packages

### 🗂️ Indexer

Reconstructs the query-layer catalog **only** from the current state of the
on-chain accounts, never from events — this is what H4 tests. The catalog
is a disposable copy of the on-chain registry.

### 🧪 Eval

The evaluation harness: executes H1–H4 against the dataset and the deployed
programs, and reports the results. `verifier/` re-implements CID
computation independently, with no code shared with the submission path —
the agreement between the two is evidence, not the same code confirming
itself.

### 🛰️ CLI

The protocol CLI: `org` (`create`, `grant`, `revoke`), `submit`, `fetch` and
`verify`.

### 🗄️ DB

Database schema and queries for the query-layer catalog, via Drizzle ORM
over PostgreSQL.

### 🔗 Protocol

Types and logic shared across packages, including the clients generated from the
on-chain programs' IDLs.

---

## 🔐 Import Boundaries

`scripts/check-boundaries.ts` enforces these rules:

- `packages/eval/verifier/` must not import `@spiral-backbone/protocol`, any
  Kubo/IPFS client library or `packages/eval/src/`. This keeps H1's CID
  re-computation structurally independent.
- `packages/eval/src/`, except `h4/`, must not import `@spiral-backbone/db` or
  `@spiral-backbone/indexer`.
- The CLI's `fetch` command must not import `@spiral-backbone/db` or
  `@spiral-backbone/indexer`.
- `findMembershipPda` must not be imported from the generated `film` client; use
  the one from the `organization` program.

The import restrictions in the first three rules are also configured as Oxlint
`no-restricted-imports` overrides (`.oxlintrc.json`). The redundancy is
intentional.

---

## 📡 IPFS Nodes

The Spiral Chunking Profile v1 (CID version 1, sha2-256, fixed
262144-byte chunks, raw leaves, balanced layout, 174 links/node) is
implemented twice, independently: `packages/eval/verifier/` (pure
TypeScript, `ipfs-unixfs-importer`) and the Kubo submission path
in `packages/eval/src/kubo-client.ts`. `packages/eval/src/conformance.test.ts`
compares both on three synthetic file sizes and runs in CI on every push
(details in
[`docs/chunking-profile-verification.md`](docs/chunking-profile-verification.md)).

`infra/kubo/` and `scripts/kubo-node-control.ts` are the automation for the
real Kubo nodes described in
[`docs/ipfs-nodes-runbook.md`](docs/ipfs-nodes-runbook.md) — provisioning
the servers is a manual step; everything else (setup, the systemd
unit, and SSH start/shutdown/status control) is code, tested against local
Docker containers.

---

## 🛠️ Development

### Requirements

| Tool       | Version                               |
| ---------- | ------------------------------------- |
| Node.js    | ≥ 22.18 (CI and campaign use 26)      |
| npm        | 11.19.1 (pinned via `packageManager`) |
| PostgreSQL | 18                                    |
| Docker     | required for the full test suite      |

### Install

```bash
npm install
```

Docker is required to run the full test suite: `npm run check`,
`npm run test:scripts`, and the `@spiral-backbone/eval` package's
conformance/Kubo tests all spin up real containers (a Kubo node, and a
systemd-in-Docker container for the SSH control-agent tests).

### Database setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up (or run
   `npm run db:start` to bring one up via Docker Compose).
2. Update `packages/db/.env` with your PostgreSQL connection details.
3. Apply the schema:

```bash
npm run db:push
```

### Environment configuration

Each package that needs environment variables owns its own `.env.schema`
(currently `packages/db/.env.schema`). [Varlock](https://varlock.dev)
generates the typed `env.ts` accessor from that schema. Codegen runs
automatically via the root `postinstall` script, and can be re-run manually
after changing a schema with:

```bash
npm run env:generate
```

Commit schema files; keep secrets in ignored env files or your deployment
platform.

---

## 📜 Available Scripts

| Command                                                                                     | What it does                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run build`                                                                             | Build all packages                                                                                     |
| `npm run check-types`                                                                       | Type-check the root `scripts/` directory and every workspace package                                   |
| `npm run check`                                                                             | Oxlint, Oxfmt (`--write`), import boundaries, manifest validation and script tests (requires Docker)   |
| `npm run check:ci`                                                                          | Same as `check`, but Oxfmt runs with `--check` so CI fails on unformatted code instead of rewriting it |
| `npm run test`                                                                              | `turbo run test` across all packages                                                                   |
| `npm run test:scripts`                                                                      | Vitest suite for `scripts/`                                                                            |
| `npm run check:boundaries`                                                                  | Runs the import-boundary checker directly                                                              |
| `npm run spiral`                                                                            | The protocol CLI (`org`, `submit`, `fetch`, `verify`)                                                  |
| `npm run indexer`                                                                           | The indexer CLI                                                                                        |
| `npm run validate:manifest`                                                                 | Validate `dataset/manifest.json` (`-- --final` for the campaign)                                       |
| `npm run eval:h1` / `h2` / `h3` / `h4` / `report`                                           | The evaluation harness (`npm run eval` runs the bare CLI)                                              |
| `npm run campaign:preflight`                                                                | The campaign's fail-closed pre-flight                                                                  |
| `npm run campaign:archive-day`                                                              | Snapshot (or `--verify`) `results/` and `plans/`                                                       |
| `npm run db:push` / `generate` / `migrate` / `studio` / `start` / `watch` / `stop` / `down` | Drizzle/Docker Compose commands, forwarded to `packages/db`                                            |
| `npm run env:generate`                                                                      | Regenerate the Varlock-generated env accessor                                                          |

Tests that need the sibling `spiral-programs` build, Surfpool,
`solana-keygen`, and Docker skip themselves when a prerequisite is missing;
`SPIRAL_E2E=required` turns the skip into a failure.

---

## ⚙️ Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request: install,
build, `check-types`, `check:ci`, and `test`. The end-to-end suites skip
there, because `spiral-programs` is not checked out in CI — run
`SPIRAL_E2E=required npm run test` on a workstation that has the programs
built first (campaign runbook §0).

---

## 📜 License

[MIT](LICENSE).

---

<div align="center">

**Spiral is building public infrastructure for the preservation of human audiovisual memory.**

Made with 🌀 by **spiralhq**

</div>
