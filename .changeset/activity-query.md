---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": patch
---

**The activity query (T1-3).** `activity_feed` returns `ok` on every row:
`false` where a run failed, `true` where it did not, and `null` where the
source cannot fail. Failure is now a column instead of English inside
`detail`. Routines are in the feed as a seventh group, `routine` (C43). A
`routine_run` row appears once it has settled, dated by when it did. Its
failure comes from `ok`/`error`, because a failed run carries no
`meta.outcome` (T1-4), and its skip or what it wrote comes from
`meta.outcome`. A `silent` tick is never a row. A new `turn_id` param returns
every call one reply made. A request closed because its source changed reads
*resolved at its source — nobody decided it here*, not *you decided
resolved_at_source*. The PWA's chips are eight (Routines added), and the glyph
takes `failed` from `ok`. MetistryKit's `ActivityFeedRow` decodes `ok`.
