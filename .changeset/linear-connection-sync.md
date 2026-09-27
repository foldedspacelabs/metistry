---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

**Linear: the connection and its sync (plan §2.6, §4 Q22, T4-24).** The
product ships its first `tracker` connection type, `seed/connection-types/linear/`
— a personal API key, sent as `Authorization: <API_KEY>` to
`https://api.linear.app` and nowhere else, capability `read`.
`@foldedspacelabs/metistry-connections` adds what a sync opens to read a
builtin provider's connection (`openSyncHttp`, `instanceSyncOpener`): the
connection `scheduled.yaml` names, else the one its provider's sync reads; a
`fetch` pinned to the provider's origin that follows no redirect; every
request through core's `guardedFetch` as `connection:<name>`, the key filled
only for a host on its *Sent only to* list; and the `linear` provider's
read-only GraphQL client (a document that is not a `query` is refused before
it leaves). *Used by* now names the sync a provider declares. The new `linear`
collector reconciles the issues assigned to the owner into `work`
(`external_ref linear:<KEY>`, state, priority and url in `meta`), closes the
ones that leave with why, and raises one `task` mirror per assigned issue that
clears at source; `addIssueToToday` captures `- [ ] <title> do <today>
linear:<KEY>` through the capture service, idempotent per issue. The console
hands collectors the opener; `metistry secrets sync --to env` delivers a
sync-read connection's secrets as `METISTRY_SECRET_<NAME>`.
