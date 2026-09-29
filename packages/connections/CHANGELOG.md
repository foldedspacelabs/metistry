# @foldedspacelabs/metistry-connections

## 0.15.0

### Minor Changes

- aee4e7f: **Send to Linear: a task becomes an issue (T4-25).** Two owner doors, one service each. `POST /api/trackers/:connection/issues {task_key, title?, team?, path?}` reads the task's line in its note and files one Linear issue through the connection the Linear sync reads — only while its provider declares `create` (the `linear` type now does), with the key filled at the egress door for `api.linear.app` only. It is idempotent by task key with no state of its own: `createLinearIssue` (connections) creates the issue under an id derived from the connection, the note and the key (`trackerIssueId`), looks that id up first, and looks it up again when a create fails — so a second press, a race or a lost answer answers the first issue (`200`, `created: false`). One fixed mutation (id, team, title); the sync's read door still refuses every mutation. `POST /api/vault-tasks/:task_key/link {ref, seen_text}` writes the ref on the line through core's new `setTaskRef` — one `linear:`/`gh:` ref at the end of the trailing run, proven by re-parse — as `user` with the read's hash, `409 stale` when the text changed or the line already carries a ref of that scheme, `Idempotency-Key` honoured. An opened connection (`SyncHttp`) now carries its provider's `capabilities`.
- 290cc20: T4-12: an `ics` calendar connection type and its `ics-calendar` sync. A public
  iCalendar feed is read through the egress door — pinned to the feed's own
  origin, no redirect followed, https only, capped at 10 MB — and its events
  (RRULE, RDATE, EXDATE and RECURRENCE-ID overrides; IANA and VTIMEZONE zones,
  DST-correct; all-day dates in the owner's `METISTRY_TZ`) are written into
  `calendar_events` beside the eventkit sync's, so Today reads one table for
  every source. The invite body is never read. A feed address carrying a token
  is refused at the connection file as a key; private feeds wait on a ruling.
  `openSyncHttp` accepts a provider with no origin of its own (the pin is then
  the connection's own URL), and collectors receive the owner's zone as
  `ownerTimeZone`.
- accfc70: T4-13: CalDAV with replies. A `caldav` calendar connection type, with iCloud
  (`icloud-calendar`) and Fastmail (`fastmail-calendar`) as known services that
  name their servers, signed in with an app password: read (the
  `caldav-calendar` sync writes the owner's two weeks into `calendar_events`,
  the owner's own answer as `self_status`), `rsvp` (only the owner's own
  ATTENDEE line changes — its PARTSTAT — and the RFC 6638 server delivers the
  REPLY) and `write_own` (events nobody else is in). Every change previews
  first and is confirmed against the event's ETag with `If-Match`. A Google
  address is refused: Google needs sign-in with Google. `openSyncHttp` sends
  Basic sign-in — `Basic {{ secret.x }}`, encoded and filled at the egress
  door — and `metistry connections add|set` take `--auth basic --username`.
  The WebDAV XML subset is hand-rolled (no dependency; a DOCTYPE is refused).
- c552e43: **Linear: completion both ways (T4-26).** `POST /api/trackers/:connection/issues/:key/complete` (owner reach) closes an issue in Linear: `completeIssue` reads it and, only if it is still open, sends one fixed mutation moving it to its team's first `completed` state — through the connection's egress door, the key filled for `api.linear.app` only; an issue already completed or canceled is answered as it stands (`changed: false`). `linearQuery` still refuses every mutation, so no caller can send another change. The owner's setting is the connection's `complete_issue` tool mode, which the `linear` connection type now declares (capability `complete`): Ask First (the default) — the client offers *Close <KEY> in Linear* after a tick; Allow — the client makes the call itself; Never — the door refuses `403 tool_off` and sends nothing. The door closes the issue's `work` row and resolves its `task` request at source, and writes no vault file. The other way, `GET /api/today` gains `tracker_closed`: the day's open lines whose `linear:` issue the tracker closed, for *Done in Linear* with a one-click Tick (named query `tracker_closed`, route-only) — the sync never writes the owner's note. The client-API row is served.

### Patch Changes

- 0c07861: **Builds against the dependency majors from #386** (`@types/node` 26, vitest 5, chokidar 5, `@simplewebauthn/*` 14). The only source change is a typing one in `connections`: an errno `code` carried onto a stdio child's failure is copied through a local, because `@types/node` 26 no longer lets an optional `code` be assigned to another under `exactOptionalPropertyTypes`. Behaviour is unchanged.
- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Minor Changes

- 851e08a: **Connections P1: the files, the pooled client, `metistry connections` and the
  read routes (plan §2.6, M13, T4-8a).** A new package,
  `@foldedspacelabs/metistry-connections`, reads `.metistry/connections/<name>.yaml`
  against the connection-type registry — `ok`, `absent` (provider not installed;
  nothing deleted) or `failed`, never fatal — and adds four rules to F-3's
  schema: no key-shaped literal anywhere a value is typed, no `{{ secret.x }}` in a
  URL, on a command line or in a path. Its `ConnectionPool` holds one MCP client
  per connection (stdio or Streamable HTTP), and refuses before dialling a tool
  the file does not list, one at Never, one at Ask First without an approval, and
  a call whose arguments carry the caller's own bearer; a command gets only the
  environment its file names, never the host process's; every HTTP request goes
  through core's `guardedFetch` with `connection:<name>` as the grantee and is
  pinned to the connection's origin (no redirect followed); every answer is
  redacted. `checkConnection` is its `check()` (ok · degraded · absent · failed).
  The CLI adds `metistry connections list|show|add|set|policy|remove|test`
  (protected writes through the reconciler; `add` dials once and applies the
  owner's Q15 defaults) and one doctor row per connection, never `failed`. The
  console serves `GET /api/connections` and `GET /api/connections/:name` to the
  owner — names, never values, and no dial. Core adds
  `INSTANCE_LAYOUT.connectionsDir`.
- 50a455d: **Linear: the connection and its sync (plan §2.6, §4 Q22, T4-24).** The
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

### Patch Changes

- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0
