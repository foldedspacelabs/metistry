---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
---

Session summaries as a capture source (stash review item 2). `core` gains a
deterministic Claude Code transcript summariser — turns, duration, files
touched, tools with counts, models, first prompt and last response, both
clipped — plus the `kind: session` note it renders and a content-derived
`idempotency_key`. `cli` gains `metistry import-sessions [--since] [--project]
[--limit] [--dry-run]`, which posts those summaries to `/capture` from the
host, skipping anything a ledger at `~/.metistry/imported-sessions.json`
already sent. No model is called on either side, and a transcript is never
posted — only its summary.
