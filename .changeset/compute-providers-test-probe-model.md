---
"@foldedspacelabs/metistry-cli": patch
---

`metistry compute providers test <name> --complete` no longer probes the
alphabetically-first model in a provider's listing — for OpenRouter's 400+
models that was some obscure, unroutable one, which 404s and reads as the
key having failed when the listing had already proven it works. The
completion probe now prefers a model already assigned to that provider in
`compute.yaml`, then a model this project's own docs point an operator at
first for it, then OpenRouter's own `openrouter/auto`, and only then falls
back to the first listed model as before. `--model <id>` overrides the
choice outright. A failed completion is now reported separately from the
listing (`listing ok` / `completion: FAILED (model …, chosen: …) …
override with --model <id>`) rather than marking the whole provider row
FAILED.
