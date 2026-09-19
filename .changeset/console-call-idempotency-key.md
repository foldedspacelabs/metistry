---
"@foldedspacelabs/metistry-cli": patch
---

`metistry console call` grows `--idempotency-key <key>`, so a caller — the
Mac app or a script — can retry a `POST /capture` without minting a second
note. The key is checked to the server's own shape (trimmed, non-empty, at
most 200 characters) before the request ever goes out, and a replay (the
console's `idempotency-replayed` response header, which this verb otherwise
prints no trace of) folds `"replayed": true` into `--json` output or a
one-line stderr note in plain mode.
