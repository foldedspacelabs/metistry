---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

`connections_call` folds a large answer (X-132; the Context Mode review's CM-6, allowed by the owner 2026-10-04). An upstream answer over `METISTRY_CONNECTION_FOLD_BYTES` (default 8 KiB on the wire) is folded once, after redaction, as a pure function of its text — a JSON array over `METISTRY_CONNECTION_FOLD_ARRAY_OVER` items (20) becomes its first `METISTRY_CONNECTION_FOLD_ARRAY_KEEP` (5), its last and the count; runs of a repeated line become the line and a count; anything still over the threshold gets a head and a tail — so the same answer folds to the same bytes every time. **The whole answer is kept** in the new `connection_answers` table (migration 0042: derived, ephemeral, self-purging after `METISTRY_CONNECTION_ANSWER_KEEP_HOURS`, default 24) under the call's own `runs` id, and read back one page at a time through the same tool — `connections_call { page: "<handle>/<n>" }`, no new tool — **by the principal that made the call and nobody else**: the read is `WHERE run_id = … AND principal = …`, so another caller with the handle hears the same `not_found` an unknown handle does. The `runs` row records `bytes_in`, `bytes_out`, `fold` and the handle. **The owner turns it off per connection**: `metistry connections policy <name> --fold off` writes `fold: false` beside Allow · Ask First · Never and the offer switch; `GET /api/connections` and `connections list --json` carry `fold` on every row.
