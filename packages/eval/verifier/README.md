# eval/verifier

Isolated CID re-computation for the Spiral Chunking Profile v1 — the evidence for
hypothesis H1. `computeSpiralCid()` in `index.ts` reimplements the profile using
`ipfs-unixfs-importer` directly, independently of Kubo.

`computeSpiralCidFromFile(path)` is the same computation fed from a file stream into a
`BlackHoleBlockstore` (only the root CID is kept), so memory stays flat for ~1 GB works. Tests
assert it equals `computeSpiralCid` on the same bytes.

**Import boundary:** nothing in `verifier/` may import `@spiral-backbone/protocol`,
`packages/eval/src/*` (the Kubo-side helpers), or any dependency that reaches a
Kubo/IPFS client. This is what makes H1's independence verifiable structurally, not
just by convention — enforced by `scripts/check-boundaries.ts` and mirrored in
`.oxlintrc.json`.
