# @foldedspacelabs/metistry-connections

## 0.16.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.16.1

## 0.16.0

### Minor Changes

- e6f16eb: Connections P3 (T4-10). **OAuth as a public client**: `metistry connections authorize <name>` signs a connection in — a listener on 127.0.0.1 for exactly one callback, the browser at the provider, the `state` checked before any code is exchanged, the code exchanged with its PKCE verifier through the egress door, and the refresh token kept in this instance's Keychain; the process that dials mints the access token at the door and holds it in memory. The client id comes from the connection type's manifest or is the owner's own (a secret, `--client-id-secret`); a custom connection carries its own client model (C118, core's `customOAuthClientSchema`); the broker redirect is modelled and refused. **Every HTTP auth shortcut dials** — Basic and OAuth join bearer and the API-key header. **Generated tools** for API (`get`, `request`), feed (`list_items`, `get_item`, `search_items`) and files (`list_files`, `read_file`, `search_files`, `read_page`) connections, served lazily through the proxy's pair and added at Ask First. **The console builds the connections pool** (open since #374, ruled 2026-09-30), so `connections_list` / `connections_call` answer on a live console; `metistry secrets sync --to env` now delivers the secrets of every connection the console dials. **The permissions table** draws each connection an actor reaches as a row with the new `proxy` provenance, *reached through Metistry*. `connections add` writes a sync's first `connection:` into `scheduled.yaml`. And a call whose arguments carry a `{{ secret.… }}` reference is refused (`secret_reference`) before anything is dialled — the door would have filled it.
- 0ff5643: Targets and syncs as connections (T4-11). **Targets become agent connections**: a connection-type manifest gains a `dispatch:` block for `provides: agent` — the dispatcher (closed `AGENT_DISPATCHERS`: `devin-session`, `github-issue`), the data policy, the purposes with their preambles (Devin's `DEVIN_PURPOSES` move here), the result path — and the product ships `devin` and `github-issues` agent types beside the `github` tracker type. The console's target registry reads the instance's agent connections afresh and presents each as the target `dispatch()` already knows (dispatch unchanged), sending through the connection's own egress door (`openAgentHttp`): the key a `{{ secret.x }}` reference filled for its listed hosts when granted to `connection:<name>`, the response redacted. A brief or title carrying a secret or variable reference is refused before anything is sent. **Collectors become syncs bound to a connection and its secret**: `github-state` reads the `github` connection, `devin-sessions` and `devin-knowledge` the `devin` one (a type may name further syncs in `also_read_by`, and a sync further origins its code reaches); a connection always wins, and the legacy environment keys still work for one release. `metistry connections add|set --config KEY=VALUE` sets a connection type's fields.
- 3f80c1a: Google Calendar, signed in with Google (T4-14; ruling 2026-09-30, Q8). A new `google-calendar` connection type (`seed/connection-types/google-calendar/`) over a new builtin module (`packages/connections` `google-calendar.ts`): `read` — the owner's primary calendar through the Calendar API v3, named fields only (never the description), each occurrence under Google's own id, the owner's own answer as `self_status`; `rsvp` — `previewGoogleReply` / `respondToGoogleInvitation`, a PATCH whose body is exactly the owner's own `responseStatus` and address with `attendeesOmitted`; `write_own` — create, move and delete events nobody else is in. Every change previews first and confirms against the event's ETag with `If-Match`. Sign-in is T4-10's OAuth door (PKCE, a one-shot loopback listener, the refresh token in the Keychain): the shipped client id is public by design, a bring-your-own client id overrides it, and a client secret is only ever the owner's secret. The sync opener (`openSyncHttp`) now signs in with OAuth — an access token minted from the delivered refresh token, cached per connection across runs — and a sync may hold the token secret's *Sent only to* list to exact hosts (`tokenHosts`). A new `google-calendar` sync writes `calendar_events` every 15 minutes. `metistry connections authorize` prints a connection type's words about its shipped client (Google: *Google hasn't verified this app*) before the browser opens. There is no secret-in-URL door; private ICS feeds stay out.
- f6a8e5d: T4-15: Mail over IMAP. A fourth reach class, `imap` (host, port 993, TLS —
  plain only to loopback — username and the app password's secret name; a mail
  submission port is refused), and `planSocketEgress`, the host guard for a
  secret sent over a socket rather than HTTP: the exact `host:port` on its *Sent
  only to* list, TLS, granted, before anything is dialled. The `imap` connection
  type and Gmail (`gmail-mail`, pinned to `imap.gmail.com:993`; 2-Step
  Verification and an app password) over a hand-rolled IMAP4rev1 client (no
  dependency) whose commands are a closed set with fixed shapes — so no code
  path can send, move, flag or delete mail. `read` is headers only (EXAMINE,
  BODY.PEEK of fixed fields), stamped `source: comms` and sanitised; `draft`
  previews, then APPENDs to the `\Drafts` mailbox only when the digest matches.
  `check()` signs in, lists folders, finds Drafts and examines INBOX.
  `metistry connections add` takes `--imap host[:port] --username --secret
  [--plain]`.
- cbfb1a9: T4-17: Invitation and message requests. The eventkit, CalDAV and Google Calendar syncs raise
  one `invitation` mirror per meeting still to come whose owner's answer is
  needs-action and which someone else organises (R7) — a series is one card,
  the same meeting on two calendars one card with both askers — cleared with a
  receipt when the owner answers, it is cancelled or it passes; an ICS feed
  names no owner and raises none. A new sync, `mail-messages`, reads the last
  week of an IMAP inbox's headers (and Sent's, for what was answered) and
  raises one `message` mirror per message that waits on the owner's reply,
  inferred from the headers alone and saying so (`payload.inferred`), cleared
  when the owner replies, it leaves the inbox or it is a week old. The imap
  types declare `sync: mail-messages`, so their app password is delivered to
  the console; `openSyncImap` / `instanceImapOpener` open the mailbox through
  the IMAP host guard, and `ImapSession.readMessage` re-reads one message's
  headers by reference. `POST /api/calendar/invitations/:id/respond` answers
  through a connection whose provider declares `rsvp` — CalDAV or Google
  Calendar — (refused with Open in Calendar where none can) and `POST /api/mail/messages/:id/draft` writes a
  reply to Drafts, addressed from the message's own headers; both preview,
  then confirm with a single-use token, and never send mail.
- 91d222c: Connections: add and configure (T6-13b, screen 9 §10.5). **The Mac's Add Connection** starts with the type, then a known service or custom: a known service's form is **rendered from its connection type's fields** — text, URL, choice, a variable's name, a secret's name (a picker of the names `GET /api/secrets` serves, never a text field), an OAuth sign-in — so a type an extension installs renders with no per-service Swift; custom is configured by how it is reached (HTTP with *None · Bearer · Basic · API Key · OAuth*, a command with its environment, a path, a mailbox over IMAP). *What it sends* and the host guards draw on the draft as they do on a connection, and the whole `metistry connections add|set …` command is shown before the button runs it; *Sign In…* is `connections authorize`, confirmed. Two small doors close the gap the ticket found (coordinator call 2026-09-30, no new route, no new §2.2 verb): **`GET /api/connections` serves `types`** — the installed connection types, seed and extensions through one registry, each with its fields by kind and nothing of an OAuth client or a value — and `GET /api/connections/:name`'s `provider_unit` gains the same `type`; **`metistry connections add|set` take a repeatable `--config KEY=VALUE`**, judged against the type's manifest before anything is written — an unknown key, a wrong kind or a required field left out is exit 2 naming the field, a `secret` field takes only the NAME of a secret (a value is refused pointing at `secrets set`, never echoed), an `oauth` field is never typed. The detail also draws an IMAP reach as a mailbox.

### Patch Changes

- Updated dependencies [5a6ad9e]
- Updated dependencies [822a0c7]
- Updated dependencies [eadd0df]
- Updated dependencies [e6f16eb]
- Updated dependencies [0ff5643]
- Updated dependencies [f6a8e5d]
- Updated dependencies [cbfb1a9]
- Updated dependencies [7b979ef]
  - @foldedspacelabs/metistry-core@0.16.0

## 0.15.1

### Patch Changes

- 0025a4a: **Releases publish from the public repository again.** Every published package's `package.json` names its source (`repository` with `directory`, plus `homepage` and `bugs`), which npm's provenance check requires — v0.15.0 published nothing to npm for want of it. The release workflow now builds each GitHub release as a draft with every asset and publishes it only then, so immutable releases no longer refuse the assets; a failed Mac app holds the release as a draft instead of freezing it without the DMG; an npm provenance rejection fails the run instead of passing as a skip; and a malformed `APPLE_API_KEY_P8` is refused naming the format it must be (the raw `.p8` file, BEGIN/END lines included). Metadata and release tooling only; no runtime behaviour changes.
- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

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
