# eval/verifier

Empty for now. This package will contain the isolated CID re-computation implementation
that produces the evidence for hypothesis H1.

**Import boundary, enforced from the first real file added here:** nothing in `verifier/`
may import `@spiral-backbone/protocol`, or any dependency that reaches a Kubo/IPFS client.
This is what makes H1's independence verifiable structurally, not just by convention. The
rule is already active in `scripts/check-boundaries.ts` (and mirrored in `.oxlintrc.json`);
it currently has no files to check here, and starts applying with the first real commit to
this folder.
