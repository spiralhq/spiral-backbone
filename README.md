# 🌀 Spiral Backbone

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-informational?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Turborepo](https://img.shields.io/badge/Turborepo-monorepo-blueviolet?style=for-the-badge&logo=turborepo&logoColor=white)](https://turbo.build/repo)
[![License](https://img.shields.io/github/license/spiralhq/spiral-backbone?style=for-the-badge)](LICENSE)

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
Linting and formatting run on Oxlint/Oxfmt — no ESLint, no Prettier.

---

## 🧱 Project Structure

```
spiral-backbone/
├── packages/
│   ├── config/          # Shared tsconfig base used by every package
│   ├── db/               # Database schema & queries (Drizzle ORM, Postgres)
│   ├── protocol/        # Protocol-level types/logic shared across packages
│   ├── cli/              # Command-line interface
│   ├── indexer/         # Off-chain indexer
│   └── eval/             # Evaluation harness
│       └── verifier/    # Isolated CID re-computation, evidence for H1
├── infra/
│   └── kubo/              # Kubo node setup script + systemd unit
├── scripts/              # Import-boundary checker, manifest validator,
│                          #   Kubo node control agent, daily campaign archive
└── dataset/              # Evaluation dataset (curated works)
```

There is no `apps/` package and no HTTP API/server in this repo — none of
the protocol's research hypotheses require one. The `apps/*` workspace glob
exists in `package.json` for forward compatibility but is currently empty.

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

The protocol CLI: `org create`, `submit`, `fetch`, `verify`.

### 🗄️ DB

Database schema and queries for the query-layer catalog, via Drizzle ORM
over PostgreSQL.

---

## 🔐 Import Boundaries

Two cross-package import boundaries are enforced (see
`scripts/check-boundaries.ts` for the rationale):

- `packages/eval/verifier/` must never import `@spiral-backbone/protocol`
  or any Kubo/IPFS client library — this keeps H1's CID re-computation
  evidence structurally independent.
- `packages/cli/src/commands/fetch(.ts|/**)` must never import
  `@spiral-backbone/db` or `@spiral-backbone/indexer`.

These are enforced two ways in parallel: an Oxlint `no-restricted-imports`
override (`.oxlintrc.json`, catches dynamic `import()` too) and the custom
regex-based `scripts/check-boundaries.ts` script — redundant on purpose.

---

## 📡 IPFS Nodes

The Spiral Chunking Profile v1 (CID version 1, sha2-256, fixed
262144-byte chunks, raw leaves, balanced layout, 174 links/node) is
implemented twice, independently: `packages/eval/verifier/` (pure
TypeScript, `ipfs-unixfs-importer`) and the Kubo submission path exercised
in `packages/eval/src/conformance.test.ts`. That test compares both on
three synthetic file sizes and runs in CI on every push.

`infra/kubo/` and `scripts/kubo-node-control.ts` are the automation for the
real Kubo nodes described in
[`docs/ipfs-nodes-runbook.md`](docs/ipfs-nodes-runbook.md) — provisioning
the VPS themselves is a manual step; everything else (setup, the systemd
unit, and SSH start/shutdown/status control) is code, tested against local
Docker containers.

---

## 🛠️ Development

### Requirements

| Tool       | Version                               |
| ---------- | ------------------------------------- |
| Node.js    | ≥ 20 (22/26 used in campaign)         |
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

This runs `varlock codegen --path ./packages/db/` directly — there is no
server bootstrap involved, since there is no server in this repo. Commit
schema files; keep secrets in ignored env files or your deployment
platform.

---

## 📜 Available Scripts

| Command                                                                                     | What it does                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run build`                                                                             | Build all packages                                                                                     |
| `npm run check-types`                                                                       | Type-check the root `scripts/` directory and every workspace package                                   |
| `npm run check`                                                                             | Oxlint, Oxfmt (`--write`), the import-boundary check, and the scripts test suite — requires Docker     |
| `npm run check:ci`                                                                          | Same as `check`, but Oxfmt runs with `--check` so CI fails on unformatted code instead of rewriting it |
| `npm run test`                                                                              | `turbo run test` across all packages                                                                   |
| `npm run test:scripts`                                                                      | Vitest suite for `scripts/`                                                                            |
| `npm run check:boundaries`                                                                  | Runs the import-boundary checker directly                                                              |
| `npm run spiral`                                                                            | The protocol CLI (`org create`, `submit`, `fetch`, `verify`)                                           |
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

MIT License.

---

<div align="center">

**Spiral is building public infrastructure for the preservation of human audiovisual memory.**

Made with 🌀 by **spiralhq**

</div>
