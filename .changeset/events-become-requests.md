---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
---

Events become requests (T2-9, C96). **A failed routine** raises one `report`
per error signature, carrying when it last ran cleanly and when it failed and
a *Try Again* act; it clears as `resolved_at_source` the next time the routine
succeeds. **A missing secret** — a `requires.env` variable or the engine's
`auth.secret` — raises one request of the new stored kind `secret_failure`
(read as access) naming every component it stopped, cleared once the variable
is set. **A sync conflict copy** is now a `review` holding both versions (the
note as it stands and the copy, with their hashes) instead of a path-only
report, and clears when the copy is gone. All three are core mirrors: one row
per subject while it waits, and an answer is not asked again until what it was
about has recovered. The runner takes `requests` (default `runnerRequests`
over its own db; `null` raises none).
