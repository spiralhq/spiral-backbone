# dataset

`manifest.json` describes the public-domain audiovisual works every hypothesis (H1–H4) uses as
its sample. **The two entries committed today are placeholders** that prove the validator works;
the 20-work selection is the researcher's curatorial decision (see `notice` in the manifest).

## Stratification

| Band     | Works | Size (decimal, half-open)           |
| -------- | ----- | ----------------------------------- |
| `small`  | 7     | 20 000 000 ≤ bytes < 100 000 000    |
| `medium` | 8     | 100 000 000 ≤ bytes < 400 000 000   |
| `large`  | 5     | 400 000 000 ≤ bytes < 1 000 000 000 |

MB/GB are decimal (10^6 / 10^9 bytes), the same convention the Internet Archive reports.

## Sources

Prelinger Archives, Internet Archive public-domain collections, Wikimedia Commons, Domínio
Público (MEC). `source` in the manifest is restricted to these four.

## Adding a work

1. Confirm public-domain status for **this specific file** and write the reason in
   `license.basis` (who produced it, when, and why it is PD — government work, term expired,
   no notice/renewal…) with a `license.reference_url` a reader can check.
2. Download the exact file named in `file_url` into `dataset/files/` (git-ignored):
   `curl -L -o dataset/files/<file_name> <file_url>`
3. Record `size_bytes` (`stat -c %s`), `sha256` (`sha256sum`) of the **original, unprocessed**
   file, `resolution` and `duration_seconds`.
4. `npm run validate:manifest` — checks schema, band, duplicates and, for downloaded files,
   size and sha256.

Before Phase 6, `node scripts/validate-manifest.ts --final` must pass: exactly 20 works, 7/8/5
per band, no `placeholder: true`.

## Why sha256 in addition to the CID

The raw-file sha256 is independent of IPFS chunking. If H1 reports a CID divergence, it separates
"the file changed" from "the CID was computed differently".
