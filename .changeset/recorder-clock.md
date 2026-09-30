---
"@metistry-apps/console": patch
---

The fixture recorder's seeds now derive every timestamp from its pinned `RECORDING_NOW` instead of Postgres's wall clock: `record-client-fixtures.mjs`'s proposal rows, the Usage crew-call/spend rows (a re-record on the real 1st of a month used to collapse the two-bar chart into one), and the named-query `as_of` field all stayed byte-identical between two recordings run at different real times in testing. `GET /api/runs/export`'s recorder request now carries a `since` cursor captured before this run's own seed, so leftover rows in a dirty scratch database no longer displace the recording's own rows from the export fixture's first page. `POST /api/proposals/batch`'s `later` verb stamps `snoozed_until` from an injected clock when one is configured (the fixture recorder, tests) — the same pattern #451 used for audit rows — and is unchanged for every real install.
