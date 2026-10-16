# dataset

`manifest.json` describes the public-domain audiovisual works every hypothesis (H1–H4) uses as
its sample: 20 works from 1897 to 1928, each taken from an Internet Archive item that carries a
public-domain mark or dedication for the whole file. Public-domain status is asserted under U.S.
law; several works remain protected in jurisdictions that count the term from the author's death.

To fetch every file into `dataset/files/` and check it:

```bash
node -e 'for (const w of require("./dataset/manifest.json").works) console.log(`${w.file_url}\t${w.file_name}`)' |
  while IFS=$'\t' read -r url name; do curl -fL --retry 5 -o "dataset/files/$name" "$url"; done
node scripts/validate-manifest.ts --final
```

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

Before the evaluation campaign ([campaign runbook](../docs/campaign-runbook.md)),
`node scripts/validate-manifest.ts --final` must pass: exactly 20 works, 7/8/5
per band, no `placeholder: true`.

## Cold CIDs

Five works are reserved as cold CIDs (`cold_cid: true`). They must **never** be requested through
a public gateway before the zero-replica leg of H2: not by the researcher's browser, not by H1
(which uses Kubo RPC only), not by anything. Otherwise a gateway cache could serve them with zero
replicas and fake a refutation. `--final` requires exactly 5.

## Why sha256 in addition to the CID

The raw-file sha256 is independent of IPFS chunking. If H1 reports a CID divergence, it separates
"the file changed" from "the CID was computed differently".
