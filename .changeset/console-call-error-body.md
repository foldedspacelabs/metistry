---
"@foldedspacelabs/metistry-cli": patch
---

`metistry console call --json` now prints the console's error body on a non-2xx response, so a client can read the 409 conflict's `reason`/`decision` instead of a rendered summary. Plain mode is unchanged.
