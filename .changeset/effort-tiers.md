---
"@foldedspacelabs/metistry-core": minor
---

Tiers are (model, effort) pairs, and sessions end at task boundaries. `core`
gains `tiers.ts` — the schema for a `tiers:` block, the `default`/`routine`
names, and the one resolver that turns a tier NAME into a pair (an unknown
name lands on `default`, never on an invented model) — and `session-roll.ts`,
which marks a thread's active sessions `rolled` so the next turn starts a
fresh SDK session and logs one `runs` row with the reason and the turn count.
The `agent` manifest gains an optional `effort` (`low | medium | high`,
default `low`), so a crew declares the other half of its tier; a manifest
without it keeps working, cheaply. Rationale and figures:
`docs/research/2026-09-cost-optimization.md`, decisions 2 and 3.
