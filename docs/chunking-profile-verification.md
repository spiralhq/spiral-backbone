# Spiral Chunking Profile v1: submission, verification, conformance

This is the code behind hypothesis H1 (a deterministic chunking profile,
independently re-verifiable). It has three parts: the profile definition
itself, two independent implementations of it, and a test proving they agree.

## The profile

| Parameter      | Value                                                |
| -------------- | ---------------------------------------------------- |
| CID version    | 1                                                    |
| Hash function  | sha2-256                                             |
| Chunker        | fixed-size, 262144 bytes                             |
| Raw leaves     | yes                                                  |
| Layout         | balanced                                             |
| Links per node | 174                                                  |
| Root codec     | dag-pb (`0x70`), or raw (`0x55`) for files ≤ 256 KiB |

Every implementation that submits or verifies a Spiral registration has to
reproduce this exactly. The two implementations below share no code —
agreement between them is evidence, not a tautology.

## The verifier (`packages/eval/verifier/`)

`computeSpiralCid(content: Uint8Array): Promise<CID>` reimplements the
profile using `ipfs-unixfs-importer` directly against an in-memory
blockstore — no Kubo, no daemon, no network call.

This directory has a structural import boundary (enforced by
`scripts/check-boundaries.ts` and mirrored in `.oxlintrc.json`): nothing
here may import `@spiral-backbone/protocol`, `kubo-rpc-client`,
`ipfs-http-client`, `helia`, or anything from `packages/eval/src/` (the
Kubo-side helpers below, even though they're a sibling directory in the
same package). If verification reused the submission client's fragmentation
convention, two identical bugs could cancel out and H1 could never be
refuted even with a wrong profile — the boundary is what makes the
independence real instead of a convention someone could accidentally erode.

One deliberate gap from the profile table above: `ipfs-unixfs-importer`
doesn't expose a `hasher` option in the version this repo uses (`17.1.1`) —
sha2-256 is hardcoded internally. The outcome is identical either way; the
code just doesn't pass an option that no longer exists.

## The Kubo side (`packages/eval/src/`)

`kubo-node.ts` manages an ephemeral, offline-mode Kubo Docker container
(`ipfs/kubo:v0.43.1`, pinned everywhere it's referenced) — `startKuboContainer()`
starts one on a random host port and polls `/api/v0/version` until it
answers; the returned `stop()` tears it down. If anything after `docker run`
fails (port resolution, readiness), the container is stopped before the
error propagates — an earlier version of this code could leak a running
container on that exact failure path.

`kubo-client.ts`'s `addWithSpiralProfile(apiUrl, content)` submits via
`kubo-rpc-client` with the profile's flags (`cidVersion: 1, rawLeaves: true,
chunker: "size-262144", trickle: false, pin: true`) — the RPC equivalent of
the profile's `ipfs add` command line.

This code intentionally lives outside `verifier/`, not because it's less
important, but because the isolation boundary only means something if there's
something real on the other side of it to be isolated from.

## The conformance test (`packages/eval/src/conformance.test.ts`)

Runs both paths against three synthetic sizes and asserts the resulting CIDs
match:

- **1 KiB** — trivial single-block case.
- **256 KiB + 1 byte** — crosses the raw/dag-pb codec threshold.
- **400 MiB** — 1600 leaves at 262144 bytes each, which at 174 links/node
  forces a two-level balanced DAG. This is the one case that actually pins
  the 174-links-per-node parameter: Kubo's HTTP `add` API has no option to
  set it, so agreement here is the only proof the two sides chose the same
  fanout.

The synthetic content is a small random prefix (bounded by
`crypto.getRandomValues`'s 65536-byte-per-call limit) tiled across the rest
of the buffer, not `size` bytes of fresh randomness — a fixed-size chunker's
boundaries depend only on byte position, so tiled content exercises exactly
the same code paths as full randomness while generating a 400 MiB buffer
in milliseconds instead of seconds.

This test is mandatory in CI (`.github/workflows/ci.yml` pulls
`ipfs/kubo:v0.43.1` ahead of time to keep the first run from looking like a
timeout) — a wrong profile is meant to fail here, as an engineering bug,
before it ever becomes a research result.
