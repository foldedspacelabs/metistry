---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/routines": minor
"@metistry-apps/console": patch
---

**Groups and sources (T1-8, migration 0027).** A request can now mirror something that lives elsewhere: `proposals.source` holds `{kind, external_ref, person}`, and a unique partial index over the pending rows makes one subject one row — `raiseMirror` (core) inserts with the matching `ON CONFLICT … DO NOTHING` and returns the waiting row's id on a second raise, so two raises for one PR make one row. `resolveAtSource` closes a pending mirror as `decision = 'resolved_at_source'` when its source changes, and matches nothing without a `source`. A `proposals_source_shape` CHECK refuses a source without a non-empty `kind` and `external_ref`, which would otherwise dodge both the dedupe and the expiry. `proposals.group_id` is the card several rows are answered as (a meeting's Accept All). The morning brief's 14-day expiry now skips every row with a `source` — a mirror never expires. The `pending_requests` named query returns `source` and `group_id`.
