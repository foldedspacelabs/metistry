---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
"@metistry-apps/routines": patch
---

**Mirrors and secret failures (T4-23, R7).** One subject is one card with every
asker on it: a raise that lands on a waiting mirror raised by someone else is
appended once to `payload.also_asked` ({source_agent, trust, at, title?, event?,
context?}), so an agent's `requests_create` kind `pull_request` and the GitHub
sync's review request for the same PR are one card naming both, in either order
(the sync now joins an agent's waiting card too). A source change resolves its
mirror **with a receipt**: `resolveAtSource(db, source, receipt?)` writes
`payload.cleared = {what, where}` — *You approved it on GitHub*, *Merged on
GitHub*, *Completed in Linear*, *GITHUB_TOKEN is set again* — which rides on the
`409 already_decided` a late answer gets and in Activity's detail. A raise may
not carry `also_asked` or `cleared` itself. The GitHub sync's *An issue is
assigned to you* rule now raises: one `task` mirror per open issue assigned to
the token's login, once per assignment, cleared when it closes or is
reassigned. A missing secret's one request now names its **dependents** —
every scheduled component whose manifest requires it, due this tick or not —
as `payload.dependents`, a `used_by` line and the before list. The weekly
review no longer counts `resolved_at_source` rows as the owner's decisions; it
notes them apart.
