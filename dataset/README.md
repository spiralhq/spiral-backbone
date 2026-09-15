# dataset

Empty for now. This directory will hold `manifest.json`, describing the 20 public-domain
audiovisual works used by the evaluation hypotheses (H1-H4), stratified by size: 7 works in
the 20-100 MB range, 8 in the 100-400 MB range, and 5 in the 400 MB-1 GB range. A
`scripts/validate-manifest.ts` script will validate each manifest entry against its
referenced file.

The nominal selection of the 20 works is a curatorial decision for the researcher to make,
not something this codebase determines.
