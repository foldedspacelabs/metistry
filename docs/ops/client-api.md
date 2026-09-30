# The client API — version 1

**One API for every client.** The console's routes and its closed action set
are the interface the Mac app, the PWA and a future iPhone app all speak
(design-build-plan §2.1). The Mac reaches it through `metistry console session
--stdio` — one long-lived CLI child speaking newline-delimited JSON, the owner
token never entering the app's process (F-12) — and the PWA and a phone over
HTTPS with a passkey session. **Same routes, same bodies, same errors.**
`metistry console call <METHOD> <path>` (`docs/ops/cli.md`) is the generic CLI
client for any authenticated route below, as the owner — the scripting seam.

**The contract is this document and one table.**
`packages/core/src/client-api.ts` holds the route table as data —
`{method, path, reach, principals, idempotent, conflict, cursor}` per route,
plus whether something serves it yet — and `packages/core/src/events.ts` holds
the live-changes catalogue. Four tests keep the halves honest:

- `apps/console/test/client-api-doc.test.ts` — this document's two tables
  agree with the code **line for line**, and every route has words of its own
  below the table.
- `apps/console/test/client-api.conformance.integration.test.ts` — every row
  the table serves reaches a handler; every row frozen ahead of its ticket is
  answered as no route; nothing outside the table is served, on any method;
  each served row admits exactly the credential kinds it records; every row's
  reach holds for every credential — `local_only` answers a passkey session on
  a served `local` row and nowhere else.
- `apps/console/test/reach-gate.integration.test.ts` — the `local` gate's own
  misuse tests, with bodies that would otherwise succeed (F-13).
- `packages/core/test/client-api.test.ts` — the table is consistent with
  itself: reach and principals agree, a `local` row admits the local owner
  token alone, no agent bearer reaches past `/mcp` and `/capture`.

**The console reads the table before it dispatches.** For the owner, a route
the table does not list as served is a `404` whatever handler exists behind it
(`apps/console/src/server.ts`, right after the agent gate) — so a handler added
without its row is unreachable rather than an undocumented door, and a row
frozen ahead of its ticket stays unserved until that ticket marks it served.
The `404` names the routes that do exist beside the one asked for — or, for a
route frozen ahead of its ticket, says this console does not serve it yet, so a
newer client talking to an older console reads "not yet" rather than "never".
The capture token and agent bearers keep the uniform answers they always had.

Everything else about the door is `docs/ops/auth.md`; capture is
`docs/ops/capture-shortcut.md`; ratings are `docs/ops/reply-feedback.md`; the
peer registry is `docs/ops/instances.md`; actions are `docs/ops/actions.md`.
This document replaced `docs/ops/console-api.md`, whose sections are below,
route by route.

## Reach and principals

**Reach** is one of four classes, enforced at the gate and never by the client:

| Reach | Who gets through | How it is proved |
| --- | --- | --- |
| `public` | anyone | the bootstrap: health, identity, the WebAuthn ceremony |
| `agent` | agent bearers, the capture owner token | `/mcp`, `POST /capture` |
| `owner` | the owner, from any client | a passkey session **or** the local owner token |
| `local` | the owner **on this Mac** | the local owner token only — accepted solely from a loopback peer (`apps/console/src/local-owner.ts`); a passkey session, even from the same Mac, is refused `403 local_only` naming the Mac app (F-13) |

**Principals** are the credential kinds a route actually admits, spelled as
the console's own `Auth` kinds:

| Principal | The credential |
| --- | --- |
| `anyone` | none at all — `public` rows only |
| `session` | a passkey session cookie (`metistry_session`) |
| `local_owner` | `METISTRY_LOCAL_OWNER_TOKEN`, from a loopback peer |
| `owner_token` | a host-minted `owner_tokens` row — the capture Shortcut |
| `agent` | an agent bearer: an external agent, the assistant, a crew |

A row's principals are **recorded, not aspired to**: where an existing route
admits more or less than its reach class, the row says what the server does and
the conformance test holds it there. Two such places:

- **The capture owner token reaches five `owner` routes** — `GET /api/whoami`,
  `POST /message`, `GET /api/messages`, `GET /api/status` and `GET /api/q/:name`
  — because they sit after the agent gate and before the management gate.
  `docs/ops/auth.md` states most of that reach (`/capture`, `/message`,
  `/api/status`, named queries — never management — and `whoami`'s answer for
  the token); `GET /api/messages` it does not mention, and it is reachable for
  the same reason. The set is pinned by a test, so widening it is a decision;
  narrowing it is one too.
- **Push and logout admit a passkey session alone.** They act on a device
  session row, and the local owner token has none — a `403` saying so.

### The `local` gate (F-13)

The console reads `local` off the table — `isLocalRoute` in
`packages/core/src/client-api.ts`, right after the owner's served-route check
in `apps/console/src/server.ts` — so a row filed under `local` is enforced
before any handler runs, with no second list in the server:

- **The local owner token from a loopback peer** gets through. From any other
  peer it is the uniform `401` an unknown token gets (and the attempt is
  audited as `owner_token_remote`), exactly as before — the address is the
  socket's, never a header.
- **A passkey session is refused `403 local_only`** — even one from
  `127.0.0.1` — with a message that names the route and the Mac app:

  ```
  403 {"error":{"code":"local_only","message":"POST /api/agents is reach `local`: only the Metistry Mac app (or the `metistry` command line) on the Mac this console runs on can do it — a passkey session cannot, even from that Mac. Open the Mac app there (docs/ops/client-api.md)"}}
  ```

  The refusal is audited (`runs`: `kind = auth`, `tool = local_only`, with
  the route and the credential kind), because a session reaching for a
  credential mint is what a stolen session would do.
- **The capture owner token and agent bearers** keep the uniform
  `403 forbidden` of the gates they already meet: `local_only` is an answer to
  the owner alone, so it tells no one else which routes are served.
- **A route frozen ahead of its ticket** is still "not served yet" (`404`) to
  every owner credential — the gate asks only of served rows.
- A request that carries a passkey cookie **and** the local owner token is a
  passkey session (the cookie is read first), so it is refused: the gate fails
  closed.

`local_only` is `packages/core`'s error code for this answer, status `403`.
Served `local` rows today: `POST /api/agents` and `POST /api/agents/:id/rotate`
— minting a bearer is a boundary change — and `POST /api/sessions/purge`, which
is irreversible. `metistry connect` mints through the first two
with the local owner token, so it is unaffected; the legacy PWA's agent panel
can no longer register or rotate an agent.

## Versioning

- **`api_version: 1`** is in `GET /api/identity` and `GET /health`, and every
  response the console makes carries **`Metistry-API-Version: 1`** — refusals
  and no-route answers included, so a client reads the version off a `401` as
  easily as off a `200`.
- **An additive change keeps the version**: a route, a field, a value, an event
  type. A client ignores a field or an event type it does not know.
- **Removing anything, or changing what it means, is version 2**, served
  beside version 1 for at least one release.
- **A client refuses a console below its minimum** with an upgrade sentence,
  never a crash.

## The rules every route keeps

### Errors — one envelope, and the door stays uniform

`packages/core`'s envelope, `{"error":{"code","message"}}`, on every refusal.
The codes and their statuses are `packages/core/src/errors.ts`: `invalid_request`
400, `unauthenticated` 401, `forbidden` 403, `local_only` 403 (a `local` route,
asked with a passkey session — "The `local` gate" above), `not_found` 404, `conflict` 409,
`rate_limited` 429, `internal` 500, `not_available` 503 (the capability is
absent in this deployment — degrades: absent — never a permission), and
`section_missing` 409 — the vault bridge's answer when the daily note's
`metistry:day` markers are not exactly one clean pair (docs/ops/reconciler.md,
"The section operation"), and Close the Day's (`POST /api/today/close`) when it
finds them so.

#### A refusal names the field that would permit it — except on the door

```
400 {"error":{"code":"invalid_request","message":"area must be a TitleCase vault-root prefix"}}
503 {"error":{"code":"not_available","message":"artifacts are not configured in this deployment — the console needs a vault bridge (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER, docs/ops/reconciler.md)"}}
```

Every 400, 404 and 503 on the owner's surfaces carries the parameter, the
config field or the grant that would have made the request work. A `503` that
says only "not available" tells an operator their deployment is missing
something and refuses to say what, when the answer is two environment
variables long.

**The exceptions are the door, and they are absolute.** A `401` is always
`{"code":"unauthenticated","message":"authentication required"}` — no detail,
ever, whatever it was that failed. And an agent credential's `403` is always
the canonical `"not granted"`, never anything that would let a caller tell
"not granted" from "not found": that distinction is visible to the owner's
surfaces only (invariant 8). `sendError` enforces both — it drops a detail
passed with `unauthenticated` rather than trusting a call site to remember.

### `409` — the reason, and the row as it stands

A `409` carries **`reason`** and the row **as it stands**, so a client branches
on the field and repaints from the body rather than re-fetching. The reasons
across the whole API are `packages/core`'s `CONFLICT_REASONS`:

| `reason` | Means |
| --- | --- |
| `already_decided` | someone answered first — from another device, or this one before it went offline; the body carries the winner |
| `stale` | what you saw is not what is there: the row, the line, the file or the pull request changed after you rendered it; the body carries the current one |

The table's `409` column says which routes may answer one and with which
reasons. `409` alone marks the older routes whose conflict carries no `reason`
yet — the task verbs, dispatch, agent registration and autonomy, artifact
publish — where the message names what would permit it.

### `Idempotency-Key` — where the table says `key`

The table's **Idempotent** column is one of:

| Value | Means |
| --- | --- |
| `key` | the route honours `Idempotency-Key`: the client mints a key before the first attempt, never regenerates it on retry, and a replay returns the first response with `Idempotency-Replayed: true` |
| `natural` | the route is idempotent by its own identity — a read, a replace, an upsert, a set — and needs no key |
| `no` | a replay is a second act, or a `409`: never replay one blindly, and never queue one offline |

`POST /capture`, the Tick door (`POST /api/vault-tasks/:task_key/check`),
the Defer door (`…/schedule`) and the Link door (`…/link`) honour the header.
The PWA's offline outbox replays only the first two (§2.17, screen 18 §4);
Defer and Link are not offered offline. The vault-task doors hold their keys
in the console's memory — see *Tick* below for why that is enough.

### `since` cursors on the polled lists — a reconnect is one bounded pull

```
GET /api/messages?limit=20                → {"messages":[…newest first…],"cursor":"<c>","more":false}
GET /api/messages?since=<c>&limit=100     → {"messages":[…oldest first…],"cursor":"<c'>","more":true}
GET /api/proposals                        → {"proposals":[…pending, newest first…],"cursor":"<c>","more":false}
GET /api/proposals?since=<c>              → {"proposals":[…changed since, oldest first…],"cursor":"<c'>","more":false}
400 when `since` is not a cursor this server minted
```

A cursor is an **opaque string**: the client never parses it, it hands it
back. (Inside: Postgres's text form of the row's change time — it keeps
microseconds where a JS `Date` would not — plus the row's tiebreakers, so
two rows written in one transaction, which share a `now()`, are never
skipped.) `cursor` in a response is the one to send next time — the newest
row seen, or the caller's own when nothing was new; `more` says whether a
page was cut at `limit` (max 100 on messages).

What moves a row past a cursor:

- **messages** — its own `ts`, or for an outbound row the time of its
  feedback: a 👍 given from the Mac resurfaces that reply on the phone's
  next pull, with the rating on it.
- **proposals** — its `ts`, or its `decided_at`: with `since`, the list is
  *everything that changed*, each row carrying `decision`, `decided_at` and
  `snoozed_until`, so a reconnect learns what was settled while it was away
  instead of showing a stale queue. Without `since` it is the triage queue as
  before — pending only, now minus anything `later` put down until an instant
  that has not arrived. A snooze deliberately does **not** move the cursor: it
  names a future instant, and a cursor that jumped forward would skip live
  rows.

`runs` has no *list* endpoint; the activity feed is the `runs_summary` /
`activity_feed` named queries, which take their own parameters. The whole
ledger, for merging two instances' timelines, is `GET /api/runs/export`.

The client's side of the contract — drain the outbox head-first, then pull
each list with its cursor, then repaint — is in the research note.

## The route table

Every route, one line each, in the order the code holds them. **Status**
`served` means something serves it today — with the ticket that changes it
next, if one does; a bare ticket id means the row is frozen ahead of that
ticket and answers `404` until it lands. **Cursor** `since` means the route
takes a `since` cursor and answers with the next one.

<!-- client-api:routes:begin -->
| Route | Reach | Principals | Idempotent | 409 | Cursor | Status | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | public | anyone | natural | — | — | served | liveness, and `api_version` |
| `GET /api/identity` | public | anyone | natural | — | — | served | who this instance is before sign-in: name, icon, capabilities, `api_version` |
| `POST /auth/enroll/start` | public | anyone | no | — | — | served | begin enrolling a passkey with a one-time code |
| `POST /auth/enroll/finish` | public | anyone | no | — | — | served | finish enrolling; sets the session cookie |
| `POST /auth/login/start` | public | anyone | no | — | — | served | begin a passkey sign-in |
| `POST /auth/login/finish` | public | anyone | no | — | — | served | finish a passkey sign-in; sets the session cookie |
| `* /mcp` | agent | agent | no | — | — | served | the MCP bridge: the tools an agent bearer's grants allow |
| `POST /capture` | agent · owner | session · local_owner · owner_token · agent | key | — | — | served | a note or a file into `Inbox/`; `source: "app"` for an owner credential (T2-1) |
| `GET /api/whoami` | owner | session · local_owner · owner_token | natural | — | — | served | which credential this is and whether it reaches management |
| `POST /auth/logout` | owner | session | no | — | — | served | end this device's session |
| `GET /api/devices` | owner | session · local_owner | natural | — | — | served | the enrolled passkeys and their sessions |
| `POST /api/devices/:id/revoke` | owner | session · local_owner | no | — | — | served | end one device session |
| `POST /message` | owner | session · local_owner · owner_token | no | — | — | served | send a message; `tier` picks the model tier for this one |
| `GET /api/messages` | owner | session · local_owner · owner_token | natural | — | since | served | the conversation, inbound and outbound |
| `POST /api/messages/:id/feedback` | owner | session · local_owner | natural | — | — | served | rate one reply, with an optional note |
| `DELETE /api/messages/:id/feedback` | owner | session · local_owner | natural | — | — | served | clear a reply's rating |
| `GET /api/push/vapid-key` | owner | session | natural | — | — | served | the VAPID public key to subscribe with |
| `POST /api/push/subscribe` | owner | session | natural | — | — | served | store this session's push subscription |
| `POST /api/push/test` | owner | session | no | — | — | served | send one test notification to this session |
| `GET /api/status` | owner | session · local_owner · owner_token | natural | — | — | served | the console's own checks: the database and the capture sink |
| `GET /api/proposals` | owner | session · local_owner | natural | — | since | served | the queue; with `since`, everything that changed |
| `POST /api/proposals/batch` | owner | session · local_owner | no | — | — | served | one verb (`later`, `skip`, `deny`) to many requests; per-row results |
| `POST /api/proposals/:id` | owner | session · local_owner | no | already_decided · stale | — | served | answer one request with an answer its type takes; `if_unchanged` refuses a stale answer |
| `GET /api/needs-you/count` | owner | session · local_owner | natural | — | — | served | how many requests wait: the sidebar row and the Dock badge |
| `GET /api/agents` | owner | session · local_owner | natural | — | — | served | the registry, each row's rendered scope and permission rows, and the unanswered access requests |
| `POST /api/agents` | local | local_owner | no | 409 | — | served | register an agent and mint its bearer (shown once) |
| `PUT /api/agents/:id/grants` | owner | session · local_owner | natural | — | — | served | replace an agent's knowledge grant |
| `PUT /api/agents/:id/projects` | owner | session · local_owner | natural | — | — | served | replace the projects an agent may work in |
| `PUT /api/agents/:id/autonomy` | owner | session · local_owner | natural | 409 | — | served | replace an agent's autonomy; the one route that may widen it |
| `POST /api/agents/:id/revoke` | owner | session · local_owner | no | — | — | served | revoke an agent's bearer |
| `POST /api/agents/:id/rotate` | local | local_owner | no | — | — | served | mint a new bearer for an agent (shown once) |
| `POST /api/agents/:id/approve` | owner | session · local_owner | natural | — | — | served | let a pending remote enrolment in |
| `GET /api/agents/:id/definition` | owner | session · local_owner | natural | — | — | served | an agent's definition, compute and limits, read-only — the write is `metistry agents define` |
| `GET /api/projects` | owner | session · local_owner | natural | — | — | served | every project with its mode, budget and rollup |
| `PUT /api/projects/:slug` | owner | session · local_owner | natural | — | — | served · T1-13 | set a project's mode, daily budget, caps and its own read grant |
| `GET /api/targets` | owner | session · local_owner | natural | — | — | served · T4-11 | the compute targets a task may be dispatched to |
| `POST /api/tasks/:id/dispatch` | owner | session · local_owner | no | 409 | — | served · T4-11 | dispatch a task to a compute target |
| `PATCH /api/tasks/:id` | owner | session · local_owner | no | 409 | — | served · T1-1 | edit a task: status, owner, project, title, description |
| `POST /api/tasks/:id/claim` | owner | session · local_owner | no | 409 | — | served | claim a task, with a lease |
| `POST /api/tasks/:id/release` | owner | session · local_owner | no | 409 | — | served | release a claimed task |
| `POST /api/tasks/:id/renew` | owner | session · local_owner | no | 409 | — | served | renew a claim's lease |
| `GET /api/artifacts` | owner | session · local_owner | natural | — | — | served | the artifacts, newest first |
| `POST /api/artifacts` | owner | session · local_owner | natural | 409 | — | served | publish an artifact version; idempotent on its `idempotency_key` |
| `GET /api/artifacts/:id` | owner | session · local_owner | natural | — | — | served | one artifact |
| `GET /api/artifacts/:id/versions` | owner | session · local_owner | natural | — | — | served | an artifact's versions |
| `GET /api/artifacts/:id/versions/:version` | owner | session · local_owner | natural | — | — | served | one version and its files |
| `GET /api/artifacts/:id/versions/:version/file` | owner | session · local_owner | natural | — | — | served | one file of a version, inline or raw |
| `GET /api/artifacts/:id/diff` | owner | session · local_owner | natural | — | — | served | the diff between two versions |
| `GET /api/artifacts/:id/comments` | owner | session · local_owner | natural | — | — | served | a version's comment threads |
| `POST /api/artifacts/:id/comments` | owner | session · local_owner | no | — | — | served | comment on a version, or reply to a comment |
| `POST /api/artifacts/:id/comments/:comment/resolve` | owner | session · local_owner | no | — | — | served | resolve a comment thread |
| `POST /api/artifacts/:id/comments/:comment/reopen` | owner | session · local_owner | no | — | — | served | reopen a comment thread |
| `POST /api/dispatches` | owner | session · local_owner | no | — | — | served | dispatch an artifact for review |
| `GET /api/dispatches/:id` | owner | session · local_owner | natural | — | — | served | a review dispatch's status |
| `GET /api/work/:id/thread` | owner | session · local_owner | natural | — | — | served | a task's room |
| `POST /api/work/:id/comments` | owner | session · local_owner | no | — | — | served | a message into a task's room |
| `POST /api/work/:id/thread/resolve` | owner | session · local_owner | no | — | — | served | resolve a task's room |
| `POST /api/work/:id/thread/reopen` | owner | session · local_owner | no | — | — | served | reopen a task's room |
| `GET /api/runs/export` | owner | session · local_owner | natural | — | since | served | the audit ledger as NDJSON, oldest first |
| `GET /api/runs/:id` | owner | session · local_owner | natural | — | — | served | one run in full, with the tool calls of its turn |
| `GET /api/turns/:turn_id/progress` | owner | session · local_owner | natural | — | — | served | a turn's tool calls so far: the working indicator |
| `GET /api/sessions/:id` | owner | session · local_owner | natural | — | — | served | one archived session |
| `POST /api/sessions/purge` | local | local_owner | no | — | — | served | purge the session archive now; the confirm names unfolded sessions |
| `GET /api/instances` | owner | session · local_owner | natural | — | — | served | the linked instances (`instances.yaml`) |
| `GET /api/commands` | owner | session · local_owner | natural | — | — | served | the composer's commands and agents, generated from the rules and the registry |
| `GET /api/compute` | owner | session · local_owner | natural | — | — | served | providers, assignments, spending limits and spend |
| `GET /api/compute/models` | owner | session · local_owner | natural | — | — | served | the models each provider serves |
| `GET /api/compute/catalogue` | owner | session · local_owner | natural | — | — | served · T4-18 | every switched-on provider's catalogue grouped by model, one line per place; `refresh` re-reads them |
| `POST /api/compute/assign` | owner | session · local_owner | natural | — | — | served | assign a model and effort to a tier or a crew |
| `POST /api/compute/unassign` | owner | session · local_owner | natural | — | — | served · T4-18 | remove a tier or a crew's assignment; `default` is reassigned, never removed |
| `POST /api/compute/budget` | owner | session · local_owner | natural | — | — | served | set a spending limit and what happens at it |
| `POST /api/compute/providers/test` | owner | session · local_owner | no | — | — | served | test a configured provider's credential |
| `GET /api/knowledge/search` | owner | session · local_owner | natural | — | — | served | search the vault: keyword, semantic or hybrid |
| `GET /api/knowledge/page` | owner | session · local_owner | natural | — | — | served | one page's content |
| `GET /api/knowledge/pages` | owner | session · local_owner | natural | — | — | served | the page index, filtered by area or prefix |
| `GET /api/knowledge/links` | owner | session · local_owner | natural | — | — | served | a page's links, both directions |
| `GET /api/knowledge/fold` | owner | session · local_owner | natural | — | — | served | the latest knowledge fold |
| `GET /api/knowledge/drafts` | owner | session · local_owner | natural | — | — | served | the drafts waiting on the owner |
| `GET /api/knowledge/areas` | owner | session · local_owner | natural | — | — | served | the per-area rollup |
| `POST /api/knowledge/conflicts/resolve` | owner | session · local_owner | no | stale | — | served | settle a conflicted file: keep one side |
| `GET /api/knowledge/history` | owner | session · local_owner | natural | — | — | served | a file's commits |
| `GET /api/knowledge/version` | owner | session · local_owner | natural | — | — | served | one file at one commit |
| `POST /api/knowledge/restore` | local | local_owner | no | stale | — | served | raise a Needs You request to restore a file; Approve restores as `user` |
| `GET /api/q/:name` | owner | session · local_owner · owner_token | natural | — | — | served | run a named query exposed `generic` |
| `GET /api/today` | owner | session · local_owner | natural | — | — | served | the day: tasks, work, order, events, brief, standup and plan |
| `GET /api/vault-tasks` | owner | session · local_owner | natural | — | — | served | vault tasks by filter: Slipping, Owed, Waiting on Others |
| `PUT /api/today/order` | owner | session · local_owner | natural | — | — | served | the owner's order for the day |
| `POST /api/today/add` | owner | session · local_owner | natural | — | — | served | Add to Today: capture a work item's task line onto the owner's current day (ruling 11); a second call for the same item returns the first capture |
| `POST /api/vault-tasks/:task_key/check` | owner | session · local_owner | key | stale | — | served | tick or untick one task line |
| `POST /api/vault-tasks/:task_key/schedule` | owner | session · local_owner | key | stale | — | served | defer one task line: a `do` date or someday |
| `POST /api/vault-tasks/:task_key/link` | owner | session · local_owner | key | stale | — | served | add one tracker ref to one task line |
| `POST /api/today/close` | owner | session · local_owner | no | stale | — | served | Close the Day: write the section, then plan tomorrow |
| `POST /api/meetings/:event_id/note` | owner | session · local_owner | natural | — | — | served | the meeting note for one event; a second call returns the first |
| `POST /api/calendar/events/:id/move` | owner | session · local_owner | no | stale | — | served | move an event: preview (who is in it, the new time), then confirm with a single-use token |
| `POST /api/calendar/invitations/:id/respond` | owner | session · local_owner | no | — | — | T4-17 | answer an invitation through the connection that can |
| `POST /api/mail/messages/:id/draft` | owner | session · local_owner | no | — | — | T4-17 | draft a reply through the connection that can; never sends |
| `GET /api/scheduled` | owner | session · local_owner | natural | — | — | served | every routine and sync with its schedule and last run |
| `GET /api/scheduled/routines/:name` | owner | session · local_owner | natural | — | — | served | one routine |
| `GET /api/scheduled/syncs/:name` | owner | session · local_owner | natural | — | — | served | one sync |
| `PUT /api/scheduled/routines/:name/schedule` | owner | session · local_owner | natural | — | — | served | set a routine's schedule |
| `POST /api/scheduled/routines/:name/pause` | owner | session · local_owner | natural | — | — | served | pause a routine |
| `POST /api/scheduled/routines/:name/resume` | owner | session · local_owner | natural | — | — | served | resume a routine |
| `POST /api/scheduled/routines/:name/run` | owner | session · local_owner | no | — | — | served | Run Now, under the budget preflight |
| `DELETE /api/scheduled/routines/:name` | owner | session · local_owner | natural | — | — | served | Reset to Default: delete the owner's entry |
| `PUT /api/scheduled/routines/:name/assignment` | local | local_owner | natural | — | — | served | a routine's actor, task and per-run grants |
| `POST /api/scheduled/routines` | local | local_owner | no | — | — | served | New Routine: an actor, a task and per-run grants |
| `PUT /api/scheduled/syncs/:name` | owner | session · local_owner | natural | — | — | served | a sync's cadence, pause and raise toggles |
| `POST /api/scheduled/syncs/:name/run` | owner | session · local_owner | no | — | — | served | run a sync now |
| `GET /api/connections` | owner | session · local_owner | natural | — | — | served | the connections: status, reach, tools and modes, used by — names, never a value |
| `GET /api/connections/:name` | owner | session · local_owner | natural | — | — | served | one connection, with its file and its provider's unit |
| `GET /api/secrets` | owner | session · local_owner | natural | — | — | served | secret names, hosts, grants, last used — never a value |
| `GET /api/variables` | owner | session · local_owner | natural | — | — | served | the variables agents read — name, value, read by, used in |
| `GET /api/recordings/:id` | owner | session · local_owner | natural | — | — | T8-4 | one recording's retention state |
| `POST /api/github/pulls/:owner/:repo/:number/review` | owner | session · local_owner | no | stale | — | served | post a review; the head SHA must match the one shown |
| `POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply` | owner | session · local_owner | no | stale | — | served | reply to a review thread; the head SHA must match |
| `POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve` | owner | session · local_owner | no | stale | — | served | resolve a review thread; the head SHA must match |
| `POST /api/trackers/:connection/issues` | owner | session · local_owner | natural | stale | — | served | create an issue from a task; idempotent by task key |
| `POST /api/trackers/:connection/issues/:key/complete` | owner | session · local_owner | natural | — | — | served | close an issue in its tracker; the connection's `complete_issue` mode decides (Never is 403) |
| `POST /api/prose/:id/feedback` | owner | session · local_owner | natural | — | — | served | rate one piece of generated prose |
| `DELETE /api/prose/:id/feedback` | owner | session · local_owner | natural | — | — | served | clear a prose rating |
| `GET /api/events` | owner | session · local_owner | natural | — | — | served | Server-Sent Events: what changed, as ids; `Last-Event-ID` resumes |
| `GET /api/vault/status` | owner | session · local_owner | natural | — | — | served | branch, ahead and behind, last commit, last push, conflict |
| `POST /api/vault/rollback` | local | local_owner | no | — | — | served | raise a Needs You request to roll back, with the preview |
<!-- client-api:routes:end -->

The **console writes exactly three protected paths**: `.metistry/assistant-prompt.md`
(an approved improvement), `.metistry/compute.yaml` (`/api/compute*`) and
`.metistry/scheduled.yaml` (the Scheduled doors, T3-3 — the reconciler admits it
since T3-2; `docs/ops/scheduled.md`). Every other protected path is written by
the CLI with the owner caller class (`apps/reconciler/src/paths.ts`
`CALLER_AUTHORITY`).

## Routes, family by family

Each family lists its routes, then their bodies, responses and errors. A route
frozen ahead of its ticket says what the plan fixes about it; the ticket fills
in the rest inside that shape and updates this section when it lands (U7).

### Bootstrap — public, and nothing the login page does not already show

```
GET  /health               200 {"ok":true,"api_version":1}   503 {"ok":false,"api_version":1} — the database did not answer
GET  /api/identity         see below
POST /auth/enroll/start    {code}                  200 {options}
POST /auth/enroll/finish   {code, label?, response} 200 {ok:true} + Set-Cookie metistry_session
POST /auth/login/start     {}                      200 {key, options}
POST /auth/login/finish    {key, response}         200 {ok:true} + Set-Cookie metistry_session
401 — every ceremony failure, uniformly: an unknown or spent code, a lost challenge, a failed assertion
```

`GET /health` is a liveness probe (`metistry doctor` reads it) and the cheapest
way to learn the contract version without signing in. The four ceremonies are
`docs/ops/auth.md`'s: a one-time, ten-minute enrolment code minted on the host
(`apps/console/scripts/enroll.mjs` — shell access is the root of trust for a
first passkey, so no route mints one) starts a passkey registration, and a
sign-in is the standard WebAuthn assertion. An origin mismatch is a `401` with
the reason, never a `500`.

#### `GET /api/identity` — who this instance is, before sign-in

```
GET /api/identity
200 {"instance_id":"8b6a3a2e-…","name":"<the assistant's name>","icon":"🦉",
     "capabilities":["artifacts","capture","dispatch","knowledge","queries","tasks"],
     "version":"0.8.0","api_version":1,"as_of":"2026-09-11T02:18:47.001Z"}
503 {"error":{"code":"not_available","message":"not available"}}
```

Public on purpose, and the one unauthenticated read the console has
(invariant 8 asks that every request authenticate *as if internet-exposed*;
this one carries nothing the login page does not already show). It exists
so a phone can render a display name before the passkey ceremony and
recognise "this origin is an instance you already have" by `instance_id` —
the key the phone stores everything under, because an origin can move
(`METISTRY_ORIGIN` accepts a list for exactly that). `voice` and `mention`
never cross the wire.

The fields come from `.metistry/identity.yaml` through the same overlay rule the
assistant uses for its prompt: `METISTRY_IDENTITY_FILES`, colon-separated,
last existing file wins; the default is `seed/identity.yaml` then
`$METISTRY_INSTANCE_DIR/.metistry/identity.yaml`. No `name` + `instance_id` → 503 and
a startup warning (degrades: absent). `metistry init` stamps the id.

##### `capabilities` — coarse, and deliberately uninformative (S1)

The vocabulary is fixed and lives in `packages/core`
(`CAPABILITIES`): **`artifacts` · `capture` · `dispatch` · `events` ·
`knowledge` · `queries` · `tasks`**. Each but `events` is a tool *group*, and
each is derived from what this console actually has wired, so an instance
cannot advertise something it would then answer `not_available` (or `404`) for:

| group | present when |
| --- | --- |
| `capture`, `tasks` | always — `/capture` and the tasks service need nothing configured |
| `knowledge` | a vault to read (the reconciler's bridge, D5) |
| `artifacts` | the vault client the artifacts module stores through (§4.21) |
| `queries` | at least one named query loaded (invariant 3's read path) |
| `dispatch` | at least one compute target configured (§4.18) |
| `events` | `GET /api/events` is served — the table's row says so (§2.20) — and this console has its events hub wired, so the route streams rather than answering `503` |

**What it is not.** Never a tool name (`knowledge_read` is a tool;
`knowledge` is a group), never a count of anything, never an origin, never
a project or crew name. Two consoles with one query and with ninety
advertise the same word — if it can be counted, it is inventory, and
inventory is not public. The **full `tools/list` stays behind an agent
token** at `/mcp`: SAM's own rule that discovery is itself grantable, which
is the half of its `system://sam.catalog` worth borrowing.

The invariant-8 reading is the same one that admitted this endpoint in the
first place: authenticating every request means an unauthenticated response
must survive being read by anyone, and "this instance can hold notes and
answer queries" is on the login page's level. What an attacker learns is
which of seven doors exist; what they still cannot do is open one.

**`api_version`** (F-1) is the contract this console speaks — see Versioning.
**`events`** (F-1) is the one capability that is not a tool group: it says the
console streams live changes, so a client subscribes instead of polling — and,
because it follows the table's row and the console's own wiring rather than a
flag, never subscribes to a console that would answer `404` or `503`.

### The agent surface — `/mcp` and `POST /capture`

```
*    /mcp       the MCP bridge (Streamable HTTP, stateless; POST carries JSON-RPC) — agent bearers only
POST /capture   {note?, filename?, content_base64?} as JSON, or raw bytes with X-Metistry-Filename
                201 {"id":42,"path":"Inbox/1757556000000-note.md","sha256":"…"}
```

**`/mcp`** is `packages/mcp-brain`: the tools an agent bearer's grants allow
(`docs/ops/assistant-tools.md`). The transport answers every method itself,
which is why its row's method is `*`; an owner credential is not an agent
principal there and gets the bridge's own `401`. Its `tools/list` is the
inventory `GET /api/identity` deliberately does not publish.

**`POST /capture`** is the one door an agent and the owner share: a note, or a
file, into the vault's `Inbox/` through the one capture sink every door uses
(`docs/ops/inbox.md`). Provenance is stamped from the credential, never the
body. An owner credential — a passkey session or the local owner token, i.e.
the Mac app and the PWA, never a request field — records `source: "app"`
(T2-1), so Activity can tell the owner's own captures apart from the
Shortcut's (`owner_token`, still `"http"`) and an agent bearer's (still
`"http"`; the bridge's own `capture` tool still records `"mcp"`).

#### `Idempotency-Key` on `POST /capture` — a retry is not a second note

```
POST /capture
Authorization: Bearer <owner or agent token>   (or the session cookie)
Idempotency-Key: 6f2c4e0a-…                     (client-minted, ≤200 chars)

201 {"id":42,"path":"Inbox/1757556000000-note.md","sha256":"…"}
201 {"id":42, … }   Idempotency-Replayed: true   ← the SAME response, later
```

The client mints the key **before the first attempt** and never regenerates
it on retry. A replay returns the row the first attempt made — same status,
same `id` — with `Idempotency-Replayed: true`; the second file is never
kept, even when two attempts race (unique index `inbox_idempotency_uidx`,
migration `0014`). The key is scoped to the credential **class** the server
derived — `user`, `owner_token`, or `agent:<id>` — never to anything in the
request, so two principals cannot collide on a key. Owner tokens share one
scope: they are all the owner's hand. Retention is unbounded: the key lives
on the inbox row itself, and inbox rows are permanent.

Without the header nothing changes: today's Shortcut and every existing
door insert as before. An empty or oversized key is a `400`. `metistry
console call --idempotency-key <key>` (`docs/ops/cli.md`) is the one client
that sends it today — checked to the same shape client-side, so a bad key
never reaches the wire — which is what makes a retried capture from the Mac
app or a script safe once something calls it with the flag.

`path` is relative to the instance repo root: captures live in the vault at
`Inbox/` so Obsidian can see and edit them (`docs/ops/inbox.md`).

#### A recording's transcript — the live-capture bridge at session end (T8-2b)

When a recording ends — Stop, the ten-hour stop, the disk, or a crash the
recorder finds when it next starts — the live-capture bridge
(`packages/mcp-live-capture`) sends its transcript here, as any capture
arrives. No new route and no new reach:

```
POST /capture
Authorization: Bearer <METISTRY_LIVE_CAPTURE_INBOX_TOKEN>   (a capture owner token)
Idempotency-Key: live-capture:20260928-120000-00ab           (one per session, forever)
Content-Type: application/json

{"note": "---\nkind: \"transcript\"\ncapture_session: \"20260928-120000-00ab\"\nended_reason: \"owner\"\n…---\n\n[00:00:01] (apps) …",
 "filename": "transcript-20260928-120000-00ab.md"}

201 {"id":42,"path":"Inbox/…-transcript-20260928-120000-00ab.md","sha256":"…"}
```

- **The credential** is an `owner_tokens` row — capture and messages only
  (`docs/ops/capture-shortcut.md` §1 mints one) — so it records
  `source: "http"`, scoped `owner_token` for the key. It is the bridge's
  third credential and reaches nothing on the bridge itself; the bridge
  refuses to start if it equals its tool or control token.
- **The key** makes every retry the first row: the bridge marks a session
  delivered only after a `201` with an `id`, so a crash between the
  console's answer and that mark re-sends, and gets the same row back.
- **A refusal** (`401`/`403`), a `5xx`, or no answer leaves the session on
  the Mac, owed; the bridge's `check` turns `degraded` with the reason, and
  the next pass (every minute) sends it with the same key.
- **The frontmatter** is written by our own door, so the inbox drain
  classifies on it: `kind: transcript` is placed deterministically, and
  `ended_reason: crashed` from an owner credential raises **one** `report`
  in Needs You, keyed on the session (C137). An agent bearer's capture
  raises none.

`POST /api/messages/:id/feedback` needs no key: it is an upsert on the
message id, so a replay is already the same row. `POST /message` is not
idempotent and not meant to be queued (a reply three hours late into a
moved-on thread is confusing); the research note says why.

### Who you are, and your devices

```
GET  /api/whoami               200 {"principal":"user","via":"local_owner_token","management":true,"origin":"…","as_of":"…"}
POST /auth/logout              200 {"ok":true}          403 — the local owner token has no session to end
GET  /api/devices              200 {"devices":[…]}
POST /api/devices/:id/revoke   200 {"revoked":true}     404 — no such session
```

`whoami` says which credential the console sees: `via` is `passkey_session`,
`local_owner_token` or `owner_token` (a capture token answers `principal:
"owner_token"`, `management: false`); `session_id` rides along for a session.
It is what `metistry console whoami` and the Mac app's "signed in as" read.
**Logout** ends the calling device's session row, so it takes a session; a
device is revoked from any other one with `…/revoke` — a lost phone is revoked
from the Mac.

### Chat

```
POST   /message                      {text, thread_id?, tier?}   202 {"message_id":…, "reply"?: "…"}   400 — no text
GET    /api/messages?limit=&since=   200 {"messages":[…],"cursor":"…","more":false}
POST   /api/messages/:id/feedback    {rating: 1 | -1, note?}     200 {"ok":true,"feedback":{rating,note,ts}}
DELETE /api/messages/:id/feedback                                200 {"ok":true,"feedback":null}
404 — the message is not an outbound reply;  400 — a rating that is not 1 or -1, a note that is not a string
```

**A message's `status`.** An inbound row (`direction: "in"`) carries its
turn's state, one of five:

| `status` | the turn |
| --- | --- |
| `new` | waiting for the assistant to pick it up |
| `processing` | being answered now |
| `done` | answered — the reply is the outbound row with this `in_reply_to` |
| `failed` | not answered; an `alert` row in the thread says why |
| `held` | waiting, unsent, because the provider its tier is assigned to refused the account (out of credits, a key it will not take) and that provider's Needs You `report` is pending; it goes back to `new` when the report is dismissed or a later turn on the provider succeeds (docs/ops/assistant-tools.md, "When the provider refuses the account") |

A client that does not know a status draws no turn state for it rather than
guessing. An outbound row's `status` is its `kind` (`reply`, `alert`, …).

**`turn_id`** (ruling 18, additive — `api_version` stays 1). An outbound row
carries the `turn_id` of the `runs` row that produced it — joined exactly on
`runs.meta.message_id` = the reply's own `in_reply_to`, the same key
`run_detail` already joins tool calls on, never adjacency or a time window —
or `null` where its turn left none (or none is found). Always `null` on an
inbound row. A reply's `turn_id` is what a client hands to `GET
/api/turns/:turn_id/progress` to draw its tool strip, so a reply need not be
inside any recent-activity window to draw one.

`POST /message` is durable before the `202`. `tier` is the composer's picker —
a tier name from the instance's `tiers:` — for this message only; a command or
a fast path still wins, and an unknown name is ignored rather than invented.
`/note` and a fast path answer in the `202` itself (`reply`); everything else
is answered by the assistant into the thread, read back through `GET
/api/messages`. A message answering a blocking `decision` request settles it.
The wire does not change when the owner's router policy serves
(`rules.yaml` `policy.mode: serve`, `docs/ops/compute.md` "Serving"): a
message the rules leave on the default tier may then be answered in the `202`
too (a fast path the policy chose), and the `202` may wait up to
`policy.timeout_ms` (at most 2 s) while the policy is consulted — a client
already handles both shapes of the body.
`POST /message` is **not idempotent and not meant to be queued**: a reply three
hours late into a moved-on thread confuses more than it helps. Feedback is an
upsert on the message id — the reply row stays immutable, the judgement is
revisable (`docs/ops/reply-feedback.md`).

### Push — bound to a device session

```
GET  /api/push/vapid-key   200 {"key":"…"}
POST /api/push/subscribe   {subscription}   200 {"ok":true}     400 — no subscription
POST /api/push/test                         200 {"result":"sent" | "no_subscription" | "dead"}
200 {"push":"absent"} — from all three, when this deployment has no VAPID keys (degrades: absent)
403 — any credential but a passkey session: the local owner token has no device to push to
```

A subscription is stored on the session row, so revoking the device ends its
pushes (`docs/ops/auth.md`).

**What a notification shows** is the PWA service worker's (`sw.js`, T7-5),
not the sender's: it reads a payload's `type`, `title` and `url` and nothing
else — a `body`, `actions`, an `image` are never shown. `type` (≤ 40
characters) heads the notification and `title` (≤ 120) is its line; each is
one line with key-shaped runs and six-digit runs blanked. A payload with no
`type` shows its `title` alone. `url` is followed only when it is a path on
the console's own origin — anything else opens `/`. A sender that wants a
tap to open Needs You sends `url: "/#/needs-you"`.

### Status

```
GET /api/status   200 {"checks":[{"name":"db",…},{"name":"inbox",…}],"as_of":"…"}
```

The console's own checks — a database round trip and a reach of the capture
sink — in `packages/core`'s `check()` shape. Every service's health, and the
local probes, are `metistry doctor` on the Mac (M6).

### Needs You — requests and their answers

```
GET  /api/proposals[?since=&limit=]   200 {"proposals":[{…the stored row…, "request":{type, word, body, primary, revise, decline, grouped, decisions, questions?}, "subject":{basis, fingerprint} | null}],"cursor":"…","more":false}
POST /api/proposals/batch             {ids, decision: later | skip | deny, feedback?}   200 {"results":[…]}
POST /api/proposals/:id               {decision, feedback?, area?, answers?, if_unchanged?: {seen_at?, subject?}}
                                      200 {"ok":true, …}   409 already_decided | stale   404   400
GET  /api/needs-you/count             200 {"waiting":3,"oldest_ts":"…","as_of":"…"}, through the `pending_count` named query
```

One queue for everything that needs the owner (D7). **What a request may be
answered with is its type's row in F-5's table, read from the stored row**
(`describeRequest(kind, payload).decisions`, plan §2.12; T2-3) — the console
builds no list of its own and never takes one from the request — plus `later`,
which is not an answer and every row takes:

| Type | `decision` the single route takes |
| --- | --- |
| question | `answers` (below), `accept_with_changes` (Revise: the owner's words, answering none of the questions), `deny` — an agent's enrolment takes no Revise |
| access | `allow`, `accept_with_changes` + `area` (narrower only), `deny` |
| action · note · improvement · review (preview) | `allow`, `accept_with_changes`, `deny` — and `accept_as_work` where the row carries a valid `payload.suggested_work` |
| review (before and after) | `deny` — Keep Mine and Take the Other go through the conflict door |
| report that names no act (`payload.act`) — an agent's finding, a routine's own note | `acknowledge` (Acknowledge, X-10), `skip` (Dismiss) — a report cannot be approved, revised or declined |
| report that names its act — an event's (below) — and any kind the table does not know | `skip` (Dismiss) — the act goes through its own door |
| message | `skip` (Not Mine) — Draft Reply goes through the mail door |
| pull request · invitation · task | nothing on the row: every answer goes through that system's door |

A verb the row does not take is `400 invalid_request` naming the ones it does,
and writes nothing on the row. **Skip is bulk-only (K2)**: the batch applies it
to any row; the single route takes `skip` only where the table makes it the
type's Decline (a report's Dismiss, a message's Not Mine), and refuses it
elsewhere with `Skip is bulk-only (K2) — POST /api/proposals/batch`. The batch's
`deny` is refused, per row, on a type with no Decline. `GET /api/proposals`
without `since` is the queue (pending, minus what `later` put down); with
`since` it is everything that changed — see the cursors above.

Every row `GET /api/proposals` returns carries `request`: its reading from
F-5's type table (`describeRequest` in `packages/core/src/requests.ts`, plan
§2.12) — the type, the word the owner reads, the body block, the answers its
type offers there, the decisions those answers store, and on a question its
`questions`. A client draws what it is given and keeps no kind → word map, and
no answer list, of its own (the PWA cannot import core; this is how it reads
the one table, X-5, T2-3). A kind the table does not know arrives as a
`report` with Dismiss its only answer — the stored `kind` is never the word.

**Acknowledge** (X-10, ruling 8 of 2026-09-27) is a report's primary where its
payload names no act: `decision: "acknowledge"`, stored as its own word,
`acknowledged` (core's `ACKNOWLEDGED`) — never `allow`, which a report cannot
take. It carries no words (`feedback` beside it is a `400`), it is not a batch
verb, and it fires nothing: knowledge-fold reads an acknowledged report as it
reads an approved note (`docs/ops/knowledge-fold.md`), and the agent that filed
it reads back that it was acknowledged (below). A report that names its act
(`payload.act {label, …}` — the events below) keeps the act as its primary and
is not acknowledged; a kind the table does not know is still Dismiss alone.

**The asker reads back the answer** (X-10). An agent learns where the owner's
answer to its own report or question stands by replaying `requests_create`
(`packages/mcp-brain`) — the same `idempotency_key`, or the same title within
24 hours — which returns the existing `id` and `answer`: `{state, decided_at?,
answers?, feedback?}`, `state` one of `pending`, `answered` (with each
question's `{prompt, choices, other?}`), `acknowledged`, `revised` or
`declined` (with the owner's words, where they wrote any), `dismissed`,
`expired`, or `closed`. No route and no tool was added; the lookup and the read
are keyed on the calling credential's agent id alone, so another agent's
request — however exactly its call is echoed — is never found, and the echo is
a new request of the caller's own.
The field is additive: every stored column is still there beside it. Skip is a
bulk verb in every client (K2): the PWA offers it on the selection bar and its
`s` shortcut, never on a row.

#### A connection call — Approve runs the proxy's payload (T4-9)

```
GET /api/proposals → {…, "kind":"action", "payload":{"title":"call comment_issue on tracker",
                        "action":{"kind":"connection_call","args":{"connection":"tracker","tool":"comment_issue",
                                  "args":{"issue":42,"body":"…"},"confirm_token":"…"}},
                        "preview_run":123, "provenance":{…}},
                      "request":{"type":"action","body":"preview", …}}

POST /api/proposals/7  {"decision":"allow"}
200 {"ok":true,"action":{"kind":"connection_call","connection":"tracker","tool":"comment_issue",
                         "is_error":false,"connection_run":456,"content":[…]}}
409 the token is spent or not this request's, or the arguments are not the ones previewed — nothing ran
404 · 503 the pool refused before dialling (the token comes back: Approve again once fixed) ·
          the call was sent and failed (the token stays spent: never repeated)
```

An Ask First call an agent made through `connections_call`. Draw
`payload.action.args` as the preview: it is exactly what Approve runs — the
console holds it to the digest recorded when the agent asked, and **nothing in
the answer's body reaches the call**. A refusal leaves the row pending with
`payload.error` (C45). Revise and Decline run nothing. `docs/ops/actions.md`
has the whole rule.

#### Mirrors — one subject, one card, cleared with a receipt (T1-8, T4-23)

A request with a `source {kind, external_ref, person}` **mirrors** something
that lives elsewhere — a PR waiting on the owner's review, an issue assigned
to them, a secret this instance needs. No route changed; these are fields on
rows `GET /api/proposals` already serves.

- **One subject, one card.** While one waits, every raise of the same
  `(source.kind, source.external_ref)` lands on it (0027's index), whatever
  its stored kind and whoever raised it. The row's `source_agent` is whoever
  asked first; **everyone else who asked** is appended, once each, to
  `payload.also_asked` — so an agent's review ask and GitHub's review request
  for the same PR are one card with both askers on it, in either order:

  ```
  also_asked: [{source_agent, trust, at, title?, event?, context?: {prose, refs}}, …]   # at most 20
  ```

  Nothing the first asker wrote changes; the same asker raising again writes
  nothing. A raise may not carry `also_asked` or `cleared` itself — both are
  the mirror's own.
- **Cleared at the source, with a receipt.** When the source changes (the
  review landed on GitHub, the issue was closed, the secret was set) the row
  leaves the queue as `decision = "resolved_at_source"` and gains
  `payload.cleared`:

  ```
  cleared: {what: "You approved it on GitHub", where: "github"}
  ```

  `what` is one line saying what happened there, `where` the source system
  (`source.kind`) — a client draws *You approved it on GitHub · 10:14 AM ·
  cleared here* from it and `decided_at`. It rides on the `409
  already_decided` a late answer gets (`proposal.payload.cleared`) and in
  Activity's detail. A mirror its source cleared is nobody's decision here:
  the weekly review notes it apart from what the owner decided.

#### A question — several per request, answered per question (T2-3)

```
GET /api/proposals → {…, "kind":"decision", "payload":{"title":"Three things before I open the fixtures PR",
                        "questions":[…], "context":{"prose":"…","refs":["gh:…#339"]}, …},
                      "request":{"type":"question", "body":"choices",
                        "primary":{"label":"Send Answers","sends":{"decision":"answers"}}, …,
                        "decisions":["answers","accept_with_changes","deny"],
                        "questions":[{"prompt":"Which store should the fixtures land under?","options":["NeedsYouStore","TodayStore"],"multi":false,"allow_other":true},
                                     {"prompt":"Who should review it?","options":["Dana","Kessler","the assistant"],"multi":true,"allow_other":true},
                                     {"prompt":"Open it as a draft?","options":["yes","no"],"multi":false,"allow_other":false}]}}

POST /api/proposals/5  {"decision":"answers","answers":[{"choices":["NeedsYouStore"]},
                                                       {"choices":["Dana","the assistant"],"other":"and whoever owns F-7"},
                                                       {"choices":["yes"]}]}
200 {"ok":true}
400 an answer outside a question's options, `other` where the question takes none, a second choice on a
    pick-one question, an unanswered question, a list that is not one per question, `feedback` beside `answers`
```

A question request (stored kind `decision`) asks 1–5 questions, each with 2–8
options of up to 80 characters, **pick one** (`multi: false`) or **pick any**
(`multi: true`), and — unless `allow_other: false` — ending in *Something
else…*. Read the questions from `request.questions`, never from the payload:
it is also how a row from before v2 (`payload.options`, one question whose
prompt is its title) is served — as one pick-one question with no *Something
else…*, because those rows were written under v1's rule that the options are
the only answers.

- **Send Answers** is `decision: "answers"` with `answers`: one entry per
  question, in order, each `{choices, other?}` — `choices` from that
  question's own options (at most one on pick one), `other` the owner's own
  words (1–1000 characters) where the question allows them. Pick one takes a
  choice *or* words; pick any takes any of the options and, optionally, words.
  Checked against the questions **as stored** (core's `checkAnswers`), refused
  whole with the reason, never half-read.
- **Nothing in an answer is executed** (C105). An option is a label and
  `other` is words; neither is a verb. The one question whose answer does
  something — an agent's enrolment, whose option `approve` lets it in and whose
  `deny` (or Decline) revokes it — takes only its own options.
- **Stored** as `decision = answered` — what answering a question in chat has
  always stored — with the per-question record in `payload.answers` and its
  words in `feedback` (one question: the answer; several: each prompt with its
  answer), written in the statement that settles the row. An enrolment keeps
  storing its own `approve | deny`.
- **Revise** is `accept_with_changes` + `feedback`: *these are the wrong
  questions*. It answers none of them. **Decline** is `deny`.
- **v1's wire** — the option itself as `decision`, `{"decision":"metistry"}` —
  is still one answer to a request that asks exactly one pick-one question
  (it is what every client sent before v2); on anything else it is a `400`.
  A request raised with one pick-one question also carries v1's
  `payload.options` beside `questions`, so a client that predates v2 can draw
  it.
- **Who asks**: the assistant, by ending a reply with a ```` ```decision ````
  block (one question, or several — `seed/assistant-prompt.md`), and every
  agent through `requests_create` kind `question` with `questions` — no new
  tool (`packages/mcp-brain`). Its `body` and `refs` arrive as
  `payload.context {prose, refs}`. A report's kind `decided` (C104) is not a
  question: `decision` is accepted as its old name and stored as `decided`.

`GET /api/needs-you/count` answers a count and the
oldest request's time and nothing else — the sidebar row and the Dock badge
(§2.10, §2.12).

#### Events become requests (C96, T2-9, T3-12)

Six things the owner used to learn about only on their own screens arrive in
this queue too, as rows of existing types. No route changed: they are rows
`GET /api/proposals` already serves. Five of the six are **mirrors**
(`source.kind = "metistry"`) — one row per subject while it waits, cleared as
`resolved_at_source` when the thing it is about recovers, never `expired`; a
budget's refusal of a **chat turn** (ruling 12, C96) is the one exception —
it carries no `source` and is not cleared programmatically, deduped instead
on the calendar window (`docs/ops/compute.md` "Budgets"). `payload.event`
says which one a row is.

| Event | `kind` → type | `source.external_ref` | Clears when |
| --- | --- | --- | --- |
| A scheduled **routine** failed | `report` → report | `routine-failed:<routine>#<error signature>` | the routine next runs cleanly |
| A **collector** failed three times in a row and stopped (C135) | `report` → report | `collector-failed:<collector>#<error signature>` | the collector next runs cleanly |
| A **Stop limit** paused the routines (C133) | `report` → report | `budget-stop:<scope>:<window>:<YYYY-MM-DD or YYYY-MM>@<limit>` | the budget no longer stops them (the window reset, the limit or its action changed) |
| A **budget** refused a chat turn (ruling 12, C96) | `report` → report | *(none — not a mirror)* | never on its own; the next calendar window raises a new row |
| A **secret** a component needs is unset | `secret_failure` → access | `secret:<VARIABLE>` | the variable is set |
| A sync **conflict copy** is in the vault | `review` → review | `conflict:<vault path of the copy>` | the copy is gone |

```
routine_failed   {title, body: "<the error, ≤ 600 chars>", component, run_id, error_signature,
                  last_ok_at | null, failed_at, act: {label: "Try Again", kind: "run_now", component},
                  stopped?: {failures, limit, since, at}}          # present once three strikes stopped it
collector_failed {title: "<name> stopped after N failures", body, component, run_id | null, error_signature,
                  last_ok_at | null, failed_at, stopped: {failures, limit, since, at},
                  act: {label: "Try Again", kind: "run_now", component}}
budget_stopped   {title: "Compute stopped at the $60.00 monthly budget", body: "Paused … : <routines>.",
                  budget: {scope, window, field, limit, spent, action}, paused: ["<routine>", …],
                  stopped_at, fix: "<the refusal, naming the compute.yaml field>",
                  act: {label: "Raise", kind: "open_settings", pane: "compute", section: "spending_limits"}}
budget_refused   {title: "Compute is over its daily budget", body: "<the refusal, naming the field, plus how nothing spent>",
                  thread, budget: {scope, window, field, limit, spent},
                  act: {label: "Raise", kind: "open_settings", pane: "compute", section: "spending_limits"}}
secret_failed    {title, variable, why, stopped: ["<component>", …],
                  dependents: [{component, title, kind: "routine" | "collector"}, …], used_by: "<one line>",
                  fix, last_ok_at | null, failed_at,
                  body: {kind: "before_after", heading, before: {label: "Waiting on it", text}, after: {label, text}}}
knowledge_conflict {title, refs,
                  body: {kind: "before_after", heading,
                         before: {label: "Mine",      path | null, text, sha256 | null, truncated},
                         after:  {label: "The Other", path,        text, sha256,        truncated}},
                  conflict: {path, original | null, sha256, original_sha256 | null}}
```

- **One per signature.** A routine's same fault again is the same row; a
  different fault is a row of its own. **Three strikes** (C135): the failure
  that stops a component (`METISTRY_RUNNER_MAX_STREAK`, default 3) turns a
  routine's waiting row for that signature into the stop — its `title` says
  *stopped after 3 failures* and it gains `stopped` — rather than raising a
  second row; a collector raises its stop as a row of its own. A **Stop
  limit** is one row per budget window however many routines it paused — a
  routine paused later is added to `paused` on the waiting row — and a limit
  raised and spent again is a new key, so a new row. A secret is one row
  however many components it stopped — a component stopped later is added to
  `stopped` on the waiting row — and it **names its dependents** (T4-23):
  `dependents` is every scheduled component whose manifest requires it (for
  the engine's secret, every one that requires the engine), whether or not
  its time has come yet; `used_by` is the line a card shows (*Morning Brief
  and GitHub use it*); `body.before` lists each, marked *stopped* or *stops
  when its time comes*. A conflict copy is one row. A chat turn's
  **budget refusal** is once per calendar window (`compute.md` "Budgets") —
  not per signature, since it carries no `source` to key on.
- **An answer sticks while the fault lasts.** Dismissed (or any other answer)
  and still broken: not raised again. Recovered and broken again: a new row.
  A routine's failure dismissed before three strikes is not raised again when
  they stop it; a Stop limit dismissed is not raised again in that window.
  A conflict copy the owner declined is not asked about again while it stays.
- **Two timestamps** (C64): `last_ok_at` — when the routine, or anything the
  secret stopped, last ran cleanly (`null`: never) — and `failed_at`.
- A conflict's texts are capped at 32 000 characters each (`truncated` says
  so); `conflict.sha256` and `original_sha256` are the files' own hashes, what
  `POST /api/knowledge/conflicts/resolve` (T2-10) checks before it writes.
- A collector's single failed run raises nothing here — three in a row do
  (T3-12). A copy raised before T2-9, as a `report` keyed `conflict:<path>`, is
  not raised again as a review beside it.

#### `409` for a settled decision, `404` for an unknown one

```
POST /api/proposals/17  {"decision":"allow"}
200 {"ok":true}
409 {"error":{"code":"conflict","message":"already decided"},"reason":"already_decided",
     "decision":"deny","decided_at":"2026-09-11T01:02:03.004Z","proposal":{…}}
404 {"error":{"code":"not_found","message":"not found"}}
```

Decided from another device, or from this one before it went offline: the
first answer to arrive wins (delivery order, not wall-clock), the second
gets `409` **with the winner**, so a client shows what actually happened
rather than "failed". Never re-triaged. This is also why the phone must not
queue decisions by default — a lease or a decision is a statement about
server state at delivery time.

`reason` and `proposal` (the row as it stands, so a client repaints rather
than re-fetches) ride the same envelope as the staleness `409` below — one
shape, two reasons, and the client branches on the field rather than on the
message.

#### A failed answer leaves the request pending — `payload.error` (C45)

```
POST /api/proposals/31  {"decision":"allow"}
409 {"error":{"code":"conflict","message":"task 6 is held by nobody, not by user — …"}}

GET /api/proposals   → {…, "id":31, "decision":"pending",
                        "payload":{…, "error":{"code":"conflict","message":"task 6 is held by nobody, …",
                                               "decision":"allow","at":"2026-09-26T20:11:52.004Z"}}}
```

Some answers *do* something before the row is settled — Approve on an
`improvement` (the prompt overlay write), on an `action` (one service call),
`accept_as_work` (the `work` row), `approve` on an enrolment (letting the agent
in), Approve and Revise on an `access_request` (the grants write). When that
consequence is refused or fails, the refusal comes back as usual **and** the
row stays `pending`, carrying why: `payload.error = {code, message, decision,
at, …details}`, where `decision` is the answer that was refused and `details`
are the refusal's own extra fields (an action's `violations`, `refused`). It is
never settled as if the answer had worked, and there is deliberately no retry —
the owner decides again, and a later answer replaces the error rather than
clearing the record of it (design-system amendments §2.4: a screen must not
draw a refusal as a decision).

- **A failure that threw** rather than refused answers the uniform `500` and
  stores `code: internal` with a fixed message — `payload.error` crosses the
  wire on this list, and an internal error's detail stays in the log and `runs`.
- **Refusing the request itself is not this.** A verb the row does not offer
  (`400`), an answer to a row that already moved (`409 stale`) or was already
  decided (`409 already_decided`) write nothing on the row: the question was
  not answered, so nothing about it failed.
- **The agent's own run** (`propose_action` at `act_within_scope`) that fails
  lands the same way — pending, with `payload.error` (no `decision`: the owner
  gave none), in this queue rather than decided `auto`.
- `if_unchanged` is unaffected: writing `payload.error` does not move the row's
  `changed_at`, so answering again with the `ts` you rendered is not stale.

`apps/console/test/c45.integration.test.ts` holds each of these doors to it,
one failure at a time; a door added later (the ones that answer through another
system — `pr_review`, `rsvp`, `draft`, `resolve_conflict`, `act`, `today`,
`delegate`) adds its own case there.

#### `if_unchanged` — a decision is an answer to the row you were shown

```
POST /api/proposals/17  {"decision":"allow","if_unchanged":{"seen_at":"2026-09-16T08:01:02.003Z"}}
409 {"error":{"code":"conflict","message":"the proposal changed after you saw it"},
     "reason":"stale","decision":"pending","decided_at":null,"proposal":{…, "ts":"…", "payload":{…}}}
400 when `seen_at` is not a timestamp this server minted
```

Optional, and opt-in: omit it and the route behaves exactly as it always did.
`seen_at` is the `ts` of the row the client **rendered** (or the list `cursor`
it rendered from — both forms are accepted). The server compares it against
when the row last *changed*, which is not one column: the proposal's own `ts`,
the `work` row it came from, and the newest message in that row's room
(`artifact_comments`, migration `0018`) — `greatest()` over all three. If any
of them moved after `seen_at`, nothing is decided and the current row comes
back so the client can show it again.

Approving a thing is approving *that* thing. A payload rewritten by a re-drain,
a linked task that moved, a negotiation that continued in the room — any of
them means the answer was to a different question
(`docs/research/2026-09-16-taskuary-review.md` ADOPT 3).

#### `if_unchanged.subject` — the thing the request is about (T2-14)

```
GET  /api/proposals → {…, "id":41, "kind":"pull_request", "work_id":88,
                        "subject":{"basis":"head_sha","fingerprint":"head_sha:5f0c…(32 hex)"}}
POST /api/proposals/41  {"decision":"later","if_unchanged":{"subject":"head_sha:5f0c…"}}
409 {"error":{"code":"conflict","message":"what this request is about changed after you saw it"},
     "reason":"stale","decision":"pending","decided_at":null,
     "proposal":{…, "subject":{"basis":"head_sha","fingerprint":"head_sha:9a1e…"}}}
400 when `subject` is not a fingerprint this server serves, or null
```

A card never acts on something the owner didn't see (plan §2.12 *Stale*,
design-system amendments §9). Every row the queue serves carries **`subject`**:
what the request is about, fingerprinted **as it stands** — or `null` for a row
about nothing outside itself. One basis per type (core's `requestSubjectOf`):

| Basis | For | Read from |
| --- | --- | --- |
| `head_sha` | a pull request | its work row's `meta.head_sha` (what the GitHub sync last saw), else the head the row was raised with |
| `line_text` | a task | the vault line `payload.task_line = {path, task_key}` names (`gone` when it was deleted), else its work row's title — a tracker item's one line |
| `work_updated_at` | every other row with a `work_id` — and a pull request or task that cannot supply its own | the work row's `updated_at` |

Send back the `subject.fingerprint` you **rendered** (or `null` if the row had
none) as `if_unchanged.subject`. If the subject is no longer that — a new
commit, an edited or deleted line, a moved work row, a row that gained or lost a
subject — the answer is refused `409 stale` **before anything is sent**: no
consequence runs (no action, no grant, no write), the row stays pending, and
nothing is written on it (not `payload.error` — the question was not answered,
so nothing failed). The `409` carries the row with its subject as it stands:
repaint, and answer again against what it says now.

- **Opaque.** A fingerprint is compared and sent back, never parsed; the value
  it hashes crosses the wire only where the row already carries it.
- **Narrow on purpose.** A comment on a pull request moves its work row but not
  its head, so it does not make a review stale; a task's facets are not its words.
- **With `seen_at`.** Both may ride one answer. When `subject` is sent, the work
  row is judged by the fingerprint and left out of `seen_at`'s comparison — so a
  client that renders the row's `ts` is not refused forever once the work row
  has moved since the row was raised. `seen_at` alone keeps exactly its old
  meaning; `if_unchanged` with neither field is a `400`.
- **Opt-in**, like `seen_at` (Versioning): omit it and the route behaves as it
  did. The PWA sends it on every single-row answer.

#### `accept_as_work` — one extra verb, where the row carries a suggestion

```
POST /api/proposals/17  {"decision":"accept_as_work"}
200 {"ok":true,"work":{"id":214,"title":"renew the wildcard cert","project":null}}
400 when the row carries no valid `payload.suggested_work`, or is not a `knowledge` request
409 / 400 / 500 the tasks service refused or failed: the proposal stays pending, carrying payload.error
```

Offered only on a `knowledge` proposal whose payload carries
`suggested_work: {title, project?, kind?}` — validated **server-side against
the stored row**, never against the request, exactly like a question's
options. (A `report` is Acknowledged or Dismissed, never approved — T2-3,
X-10 — so a suggestion on one is no longer an answer.) Where it is offered it is what Approve sends
(§1.4); `allow` stays valid beside it. It inserts the `work` row (owner-less, unclaimed), sets
`proposals.work_id`, and decides the proposal `allow`. `project` that is not a
project slug is dropped rather than invented; an unknown `kind` is a refusal
rather than a silent fall back to `task`. `docs/ops/reply-feedback.md` has the
rest, including why this leaves §4.12 intact.

#### `allow` on an `action` — the verb that does something

```
POST /api/proposals/31  {"decision":"allow"}
200 {"ok":true,"action":{"kind":"dispatch","ref":"gh:owner/repo#41","url":"…","run_id":9001}}
400 the stored payload.action does not validate — the message names the field
409 / 422 / 503 the SERVICE refused (a lease, a data policy, no vault bridge)
500 the service threw
    — every one of them leaves the proposal pending, carrying payload.error, and you decide again
```

An `action` proposal carries a closed `payload.action = {kind, args}`
(`dispatch | task_update | comment | capture | connection_call`). Allowing it runs the action
through the **same service call the owner's own route makes**, as the `user`
principal, with the proposal's `source_agent` recorded as `on_behalf_of`; the
result lands in `payload.result` and in a `runs` row. The action runs *before*
the row is decided — as the `improvement` path does — so a refusal leaves a
pending proposal rather than a settled decision that did nothing. Nothing is
half-applied, because one action is one service call. `docs/ops/actions.md`
has the enum, the autonomy table, and why `dispatch` stays human by default.

Rows an agent was allowed to run on its own arrive already decided `auto` —
never in this queue, always in the timeline.

#### `allow` on an improvement that edits `Me/` — the owner's hand on the owner's file

```
POST /api/proposals/52  {"decision":"allow"}
200 {"ok":true,"applied":{"path":"Me/profile.md","created":false}}
409 {"error":{"code":"conflict",…},"reason":"stale","decision":"pending","proposal":{…}}
    the file is no longer the "before" you were shown: nothing was written,
    and the request still waits — Decline it, or edit the file yourself
503 not_available — no vault bridge in this deployment
```

An `improvement` whose payload carries an edit to a file under `Me/` —
*Tidy Me/profile.md* (T3-4, `apps/console/src/profile-tidy.ts`) is the first —
draws the before-and-after body from `payload.body`
(`{kind: "before_after", heading, before: {label, text}, after: {label, text}}`)
and names the file in `payload.edit` (`{path, base_sha256}`). **Approve writes
`body.after.text` and nothing else, as `user`**, compare-and-swap on
`base_sha256`, and only if the file is byte for byte `body.before.text`; a path
outside `Me/` is not this edit at all. Revise and Decline write nothing. `Me/`
is the owner's alone (`isUserOwnedPath`): this answer is the only way anything
but the owner's own editor changes it.

#### `allow` on a routine suggestion — a change to one Scheduled entry

```
POST /api/proposals/61  {"decision":"allow"}
200 {"ok":true,"scheduled":{"section":"routines","name":"standup","path":".metistry/scheduled.yaml"}}
409 {"error":{"code":"conflict",…},"reason":"stale","decision":"pending","proposal":{…}}
    the entry is no longer the "before" you were shown (or its manifest's
    defaults changed since): nothing was written, and the request still waits
400 invalid_request — an agent's request (trust external), a malformed one,
    or an "after" the Scheduled door refuses (it would not validate, or would
    hold the routine) — nothing written
503 not_available — no Scheduled wired in, or this console cannot write the overlay
```

A routine suggestion (T3-11, `apps/console/src/routine-suggestions.ts`; screen
8 §10.4) is an `improvement` pointed at one entry of `.metistry/scheduled.yaml`.
Its payload carries the ask (`title`), why (`summary`), what it is about
(`subject: {kind: "routine" | "sync", name, title}`), the before-and-after body
(`body: {kind: "before_after", heading, before: {label: "Now", text}, after:
{label: "Suggested", text}}`) and the entry itself
(`scheduled_edit: {section, name, before, after}` — each side the entry as the
file holds it, or `null` for none: the manifest's defaults). **It changes only
when something runs** — a routine's `schedule` and `paused`; a sync's `every`,
`paused` and `raise` — the fields the owner's phone may change at the
Scheduled doors. A New Routine's actor, task and grants are the Mac's alone,
and a sync's connection is never Scheduled's, so neither is ever suggested.

**Approve writes exactly the "after", through the Scheduled door, as `user`**:
the same read, validate-against-the-manifests and compare-and-swap write
`PUT /api/scheduled/…` makes, with the owner's comments kept and the change in
the `scheduled` audit, and `payload.scheduled_applied` recording it on the row.
It re-draws the words from the entries and refuses one whose words are not
what they draw. Raising one, Later, Revise and Decline write nothing. A row
that carries `scheduled_edit` is never read as a `Me/` edit or a prompt
improvement.

#### `POST /api/proposals/batch` — one verb, many rows

```
POST /api/proposals/batch  {"ids":[17,18,19],"decision":"skip"}
200 {"results":[{"id":17,"ok":true},
                {"id":18,"ok":true},
                {"id":19,"ok":false,"error":{"code":"conflict","message":"already decided"},
                 "reason":"already_decided","decision":"allow","decided_at":"…","proposal":{…}}]}
400 when `ids` is not 1..100 positive integers, or `decision` is not later | skip | deny
```

**All-or-nothing per row, never per batch.** Each id is its own atomic
statement and gets its own result, because the alternative is a batch that
refuses ten items because one of them was answered on the phone thirty seconds
ago. The response is always `200` — the per-row `ok` is the outcome.

Only `later`, `skip` and `deny` may be batched: the verbs that need nothing
from the individual row. `allow`, `accept_with_changes` and `accept_as_work`
each *do* something per kind (a prompt overlay write, a `work` row), so they
stay one at a time. `deny` still carries its own per-kind consequence —
declining an enrolment revokes the agent — because it is the same handler
reached through a second door, and a verb that meant two different things
depending on the route would be worse than either. `feedback` applies to
`deny`; `skip` writes its own marker and ignores it.

Management surface, so the `user` principal only: an owner token gets the
uniform `403`, never a `404` that would hide the route's existence.

### Agents — the registry

```
GET  /api/agents                      200 {"agents":[{…, "scope":{…}, "permissions":[…]}],"access_requests":[…],"access_ceilings":[…]}
POST /api/agents                      {id, display_name, kind?, remote?}   201 {"id","token","pending","proposal_id"?}   409 — the id is taken
PUT  /api/agents/:id/grants           {tier, areas?, queries?, connections?}   200 {"ok":true,"grants":{…}}
PUT  /api/agents/:id/projects         {projects: [slug, …]}      200 {"ok":true,"projects":[…]}
PUT  /api/agents/:id/autonomy         {level?, actions?, may_dispatch_to?, accept_from?, max_open_bundles?}
POST /api/agents/:id/revoke           200 {"revoked":true,"access_requests"?:[…]}
POST /api/agents/:id/rotate           200 {"id","token"}         — the new bearer, shown once
POST /api/agents/:id/approve          200 {"approved":true,"proposals"?:[…]}
GET  /api/agents/:id/definition       200 {"id","definition","compute","limits","as_of"}   — read-only
400 — the field is named;  404 — no such agent, or it is revoked
```

The registry of every agent bearer: external agents, the assistant's own row,
crews. A token crosses the wire **once**, in the answer to
the call that minted it. Registering and rotating mint a credential, which is a
boundary change, so both are reach `local` (F-13): the local owner token from
this Mac — the Mac app, `metistry connect` — and a passkey session is refused
`403 local_only` ("The `local` gate" above).

**`POST /api/agents` mints `external` rows only** (T4-6). `kind` may be
omitted or `external`; anything else is `400 invalid_request`, refused before
anything is minted or written — no row, no enrolment request, no audit row.
The assistant's row is `ensureInternalAgent`'s, written from the user's own
configuration (`METISTRY_ASSISTANT_TOKEN`) at every start; a crew's is its
manifest's. A second `internal` row minted over HTTP would be a credential the
door treats as the assistant — the one writer — that no configuration answers
for (docs/ops/actors.md).

#### `permissions` — the table every surface prints (T4-6)

Every row of `GET /api/agents` carries `permissions`: the actor's
**Resource × Read × Write** rows (core's `describePermissions`,
`packages/core/src/access.ts`), in the shape of core's `PermissionRow`
(`packages/core/src/actor.ts`):

```json
{ "resource": { "kind": "knowledge" }, "label": "Knowledge",
  "read":  [ { "key": "Projects", "label": "Projects", "asks": false, "provenance": { "kind": "base", "source": "registry" } },
             { "key": "Areas/Ops", "label": "Areas/Ops", "asks": false, "provenance": { "kind": "approved", "proposalId": 4 } } ],
  "write": [] }
```

- Rows come Knowledge, Work, Artifacts, Inbox, Queries, Agents, then one per
  connection (`resource.kind: "connection"`, `name`). A row with both cells
  empty is left out; **`[]` holds nothing** — a revoked row, or a crew whose
  manifest is gone. Anything not listed is not granted.
- The table **renders `may()`**: a tool fills its cell only when the door
  would admit it, so a line here is a door that says yes.
- `asks` is ⏱: the owner answers first. `provenance` is `base` (no marker),
  `approved` (*approved in Needs You · #n*), `routine` (*during … only*) or
  `project` (*via project \<slug\>* — inherited from a project the actor is a
  member of, T4-7; see *Projects*).
- A client prints `label` and never re-derives a cell. The CLI, the console's
  panel and MetistryKit print the same words — core's `permissionRowText`,
  an empty cell `—` — held together by a test on the recorded fixture.
- The instance's assistant's lines are always configuration, never a grant
  (C52): every base entry's source is `environment`.

The mapping from each tool to its cell is `docs/ops/actors.md`'s table, encoded
beside `RULED_TOOLS` as `TOOL_PERMISSION_CELLS`.

#### `GET /api/agents/:id/definition` — what an actor runs with, read-only (T4-6)

```
GET /api/agents/researcher/definition
200 {"id":"researcher",
     "definition":{"kind":"crew","area":"example","description":"…","prompt":"…",
                   "files":[{"path":"seed/agents/example/researcher.md","origin":"product","sha256":"…"}]},
     "compute":{"kind":"same_as_assistant"},
     "limits":{"maxTurns":10,"budgetUsdPerRun":0.25},
     "as_of":"…"}
```

The actor's `definition`, `compute` and `limits` (core's `Actor`, plan §2.4) —
a model and effort are part of a definition (C128), so they come with it.

- **A crew**: its manifest — area, description, operating prompt — and the one
  file, relative to the instance (`origin: instance`) or to the release
  (`origin: product`, a shipped crew the instance has not copied). `compute` is
  `{kind: "model", ref, effort}` or `{kind: "same_as_assistant"}`.
- **The assistant** (`/api/agents/assistant/definition`, always answers):
  `identity` (`name`, `mention`, `mark`) and the files that exist, in
  composition order — `identity.yaml`, the root `CLAUDE.md`,
  `assistant-prompt.md`. `compute` is `{kind: "router"}`.
- **An external agent**: `definition`, `compute` and `limits` are `null` — it is
  someone else's code.
- `404` — no such agent, a revoked one, or a crew whose manifest is not loaded.

Each file's `sha256` is what an edit is made against. **The write is not
here**: a definition says how an actor behaves, so it is the owner's hand on a
protected path — `metistry agents define <id> --if-sha256 <hex>` (M12,
docs/ops/cli.md), which refuses a file that moved since it was read. Every
other method on the path is `404`.

#### Approve-before-enroll for remote agents (S2)

An agent whose bearer will be presented **from off this machine** does not
get to start working because a token was minted. SAM's `join` leaves an
enrollment PENDING until an administrator approves; invariant 2 says the
credential surface is the user's hand, so the same rule holds here.

```
POST /api/agents            (local owner token)
{"id":"devin","display_name":"Devin","kind":"external","remote":true}
201 {"id":"devin","token":"…","pending":true,"proposal_id":412}

POST /api/agents/devin/approve   (user principal)
200 {"approved":true,"proposals":[412]}
404 — no such row, revoked, or never remote (nothing to approve)
```

- `remote` is optional and defaults to `false`; it must be a boolean. Only
  `external` rows are minted here at all — an internal agent's token comes
  from the user's own environment, which *is* the approval (§4.11).
- The token **is** returned at mint, because the console shows a token
  exactly once. It simply authenticates nothing yet.
- While pending, `/mcp` and `/capture` answer **the same uniform 401 an
  unknown token gets** — same status, same body — and `last_seen_at` is not
  bumped, so there is nothing in the response to tell "waiting for approval"
  apart from "never existed". The refusal is a `WHERE` clause in
  `authenticateAgent`, not a branch a later edit could forget.
- Enrolment raises a **Needs You item**: a `decision` proposal whose
  `payload.options` are `["approve","deny"]`, so the PWA renders it with
  the two buttons it already knows how to render. Answering it does exactly
  what the route does — `approve` lets the row in, `deny` **revokes** it —
  and the route settles the item in the same breath, so the two doors onto
  one answer cannot drift. An `approve` that finds the agent revoked since it
  asked lets nobody in, so it is a `404` and the item stays pending with
  `payload.error` (C45); a `deny` in the same case settles, because its
  consequence — nobody gets in — already holds.
- `GET /api/agents` carries `remote`, `approved_at` and a derived
  `pending`. `metistry connect <tool> --remote` sets the flag; `metistry
  connect --list` shows `pending`. Loopback tools stay immediate, and
  `--remote` is decided at enrolment — it is refused on a row that already
  exists rather than widening it.

Approval is **not** a grant: a row let in still holds the default-deny
`{tier: "none", areas: []}` it was minted with. Two different questions,
answered separately.

#### `PUT /api/agents/:id/grants` — and the one other door onto it

```
PUT /api/agents/devin/grants   {"tier":"areas","areas":["Areas/Health"],"queries":false}
200 {"ok":true,"grants":{"tier":"areas","areas":["Areas/Health"]}}
400 the field is named ("area must be a TitleCase vault prefix (e.g. Areas/Fsl)")
404 no such row, or it is revoked
```

The grant is a read TIER plus, for `areas`, the vault prefixes it covers;
`queries` is a separate axis (invariant 3's read path). An area is TitleCase
from the vault root — core's `validAgentAreaGrant`, which also refuses
`.metistry/` and `Artifacts/`, because no agent read path serves either and a
grant of one would be inert. That is a rule about AGENTS, not about the owner,
whose own `Artifacts/` are `GET /api/artifacts` (ruled 2026-09-19). The bare
vault (`/`) is admitted for a `kind: internal` row alone, keyed on the ROW's
kind and never on the request.

`connections` (T4-8b, ruling 5) is a third, independent axis: the connection
names this credential is lent through the `/mcp` proxy's lazy pair
(`connections_list`, `connections_call`) — shape-checked as a list of
connection names and nothing else (whether the name exists, and whether the
owner has offered it to agents, is the door's question, not this route's).
Like `queries`, it rides across an access-request approval untouched
(`widenedGrants`) and is dropped only by a write that omits it — `PUT`
replaces the whole grant, so a write naming only `tier`/`areas` clears
`connections` exactly as it clears `queries`. A crew still needs its
manifest's `uses: [connections]` beside this grant: the grant alone reaches
nothing (core's `mayToolset` + `mayConnection`).

Since 2026-09-19 an agent can **ask** for an area it was refused
(`request_access` on `/mcp`, `docs/ops/actions.md`), and approving that ask in
Needs You is the second door onto this same write: one function
(`writeGrants`), one validator, one `agent_admin` audit row — the queue's
answer carries `via: triage` and the proposal id, and the owner's own PUT
carries `via: console`. Approve therefore cannot grant anything this route
would refuse, and the console's mutating surface gains no verb (invariant 10).

`GET /api/agents` answers the registry, the unanswered asks **and** the asks
the escalation ceiling refused, so the panel where a grant is edited shows
what has been asked of it — including what it can no longer ask:

```
GET /api/agents
200 {"agents":[{"id","display_name","kind","grants","projects","autonomy",
                "revoked","remote","approved_at","pending","last_seen_at",
                "grant_source","scope"}],
     "access_requests":[{"proposal_id":412,"agent":"devin","area":"Areas/Health",
                         "reason":"knowledge_read pointed me here","ts":"…",
                         "escalated":true,"prior_proposal":399}],
     "access_ceilings":[{"agent":"devin","area":"Areas/Finance","declines":2,
                         "last_proposal":388,"last_declined_at":"…",
                         "hits":3,"first_at":"…","last_at":"…"}]}
```

`access_ceilings` (C42, T2-2): after you decline an area twice, a third
`request_access` for it is refused at the tool and writes **no** proposal —
it is not a question you have not answered — so without this list it would
be invisible. Each such refusal writes one `runs` row, kind `access_ceiling`
(`meta: {agent, area, declines, last_proposal, last_declined_at}`), and this
is those rows grouped per (agent, area): `hits` is how many asks the ceiling
has refused, `last_proposal` the decline that closed it. The last 30 days,
newest first, at most 50 pairs; a pair drops off once the agent holds the
area (you granted it here) or is revoked. It is a view and has no verb: what
you do about it — grant the area, revoke the credential, or nothing — is the
routes below.

`scope` is the row **rendered**, in the one vocabulary every surface uses
(`describeScope` — [auth.md](auth.md)):

```json
"scope": { "role":"agent", "who":"an agent", "tier":"index", "access":"titles",
           "areas":[], "scope":"titles", "queries":true, "projects":["alpha"],
           "uses":null,
           "autonomy": { "level":"observe", "actions":{…},
                         "detailed": { "dispatch": {"mode":"deny","source":"defaulted","ceiling":"deny"},
                                       "comment": {"mode":"deny","source":"clamped","ceiling":"deny","asked":"allow"} } },
           "source":"registry", "from":"the registry — the owner's own hand, durable",
           "extras":["queries","projects: alpha","autonomy: observe"],
           "line":"an agent · titles · queries, projects: alpha, autonomy: observe" }
```

It is derived, never stored — a rendering of `grants`, `projects`,
`autonomy` and `grant_source`, all of which are still on the row beside it
for a client that wants the fields rather than the sentence. It exists so a
client never recombines them into words of its own, which is how the panel,
the queue and the CLI came to have three vocabularies for one record. The
same object rides on an `access_request`'s payload as `current_scope`.

`autonomy.actions` is `core`'s `effectiveActions` — the resolved (kind → mode)
table alone. `autonomy.detailed` is the same table from `effectiveActionsDetailed`
(C46/C47), one entry per kind, with WHY: `source` is `set` (the owner's own
entry, honoured), `defaulted` (no entry — the level's own default), or
`clamped` (the owner's entry asked for more than the level allows, and `mode`
is the ceiling instead); `asked` is the record's own per-kind entry and rides
only on `set` and `clamped` — it is the field that says an override happened
at all, and the only source where it disagrees with `mode` is `clamped`. A
client renders `detailed`, never re-derives it from `autonomy`'s level and
raw per-kind overrides — that reconstruction is exactly what left three
surfaces (the CLI, this route's own callers, MetistryKit) computing the same
table by hand.

That list is a **view**: the answer is given in the queue, through
`POST /api/proposals/:id` like every other request, which for this kind takes
an extra field —

```
POST /api/proposals/412 {"decision":"allow"}
200 {"ok":true,"granted":{"agent":"devin","area":"Areas/Health","grants":{…},"prior_tier":"index"}}
POST /api/proposals/412 {"decision":"accept_with_changes","area":"Areas/Health/Sleep"}
200 {"ok":true,"granted":{"agent":"devin","area":"Areas/Health/Sleep","grants":{…},"prior_tier":"index"}}
400 `accept_with_changes` with no `area` (there is nothing to grant), or an area the validator refuses
    — the row stays pending, carrying payload.error
400 `accept_with_changes` with an area that is not the one asked for or a folder under it
    {"error":{"code":"invalid_request","message":"Revise can only grant less …"},"asked":"Areas/Health"}
    — nothing is written: not the grant, not payload.error; the card is as you left it
403 a crew's scope is its manifest — Decline and edit that file
404 the agent is revoked or gone
    — every refusal leaves the row pending, for you to Decline
```

**Revise can only grant less** (C40, ruled 2026-09-20). The area that was
asked for is a ceiling: a revision must be it or a folder under it
(`Areas/Health` admits `Areas/Health/Sleep`; never `Areas`, `Areas/Finance`
or `Areas/HealthX`). Granting more than was asked, or somewhere beside it, is
not a revision of this request — it is a different decision about a scope
nobody asked for, and it is `PUT /api/agents/:id/grants`, on Agents, with the
whole credential in view. The refusal carries `asked` so a control can offer
the tree under it. It is audited (`console/triage/access_request`, `error:
wider_than_asked`) and writes nothing else.

**`prior_tier`** (C41) is the tier the credential held **before** this answer,
read from the registry at the moment of the write (and stored on the row as
`payload.granted.prior_tier`). An area grant *is* tier `areas`, so when
`prior_tier` is `index`, Approve was also a trade: vault-wide titles for
titles inside its folders. A client states that from this field rather than
deriving it from the ask's `current_scope`, which is a snapshot from when the
agent asked.

`deny`, `later` and `skip` grant nothing at all, and neither does a revoked
agent's ask: revoking settles its pending requests as `deny` in the same
breath it kills the token.

#### `PUT /api/agents/:id/autonomy` — the one route that may widen

```
PUT /api/agents/researcher/autonomy
    {"level":"act_within_scope","actions":{"dispatch":"deny"},"max_open_bundles":2}
200 {"ok":true,"autonomy":{…},"actions":{"dispatch":"deny","task_update":"allow",…},
     "widened":["level observe → act_within_scope"]}
400 the field is named (unknown key, unknown action kind, bad level)
403 a widening arrived somewhere that is not the user's own hand
409 the record changed between the read that checked it and this write
```

The §4.21 keys (`may_dispatch_to`, `accept_from`, `max_open_bundles`) narrow
and only narrow, as they always have. `level` and `actions` may go either way,
and **this route is the door that permits it** — it is reached by the `user`
principal alone, and `setAutonomy` refuses a widening from any caller that
does not say so, so a future call site cannot widen by forgetting. Every raise
writes a `runs` row (`agent_admin` / `autonomy_widened`) and one Needs You
alert per change per `METISTRY_ALERT_DEDUPE_H`. The body **replaces** the
record; `metistry agents autonomy` does the read-merge for you.

### Projects

```
GET /api/projects          200 {"projects":[…],"as_of":"…"}
PUT /api/projects/:slug    {mode?, daily_budget_usd?, max_open_bundles?, title?, area?, grants?}   200 {"ok":true,"project":{…}}
400 — an unknown key, a mode that is not autonomous | review, a budget out of range, a malformed grant
```

The project panel (§4.19) and its controls (§4.21): the kill switch (`mode`),
the daily budget and the caps. Every change records a `project_admin` run
(`docs/ops/projects.md`).

**`grants`** (T1-13, migration 0032) is the project's own read grant —
`{tier: none|index|areas, areas: [...], queries?}`, the same envelope
`PUT /api/agents/:id/grants` takes, validated by the identical function
(`validateGrants`) with the external rules: the bare vault (`/`) is refused
(that spelling is the internal assistant row's alone), and every area must be
vault CONTENT — a grant naming `.metistry/`, `Artifacts/…`, or anything else
outside the vault is refused.

**Every member inherits it** (T4-7). A crew's or external agent's effective
reach is its own grant ∪ the grants of the projects its row lists: the door
resolves the union per request (an agent bearer on `/mcp` and every agent
door), and `GET /api/agents` draws each inherited entry with provenance
`{kind: "project", project}` — *via project \<slug\>*. The agent row's own
`grants` field is unchanged by it. Narrowing the project's grant narrows every
member on its next request; removing the slug from the agent's projects
(`PUT /api/agents/:id/projects`) removes the inherited reach. The instance's
assistant inherits nothing (its reach is configuration).

`GET /api/projects` serves each project's stored **`grants`** beside its
rollup (T6-8, additive; `{tier: "none", areas: []}` when none was ever set),
so the Projects screen draws *every member gets these* from the same read as
the rest of the row. It is read from the `projects` row itself, not the
`projects_rollup` seed query, so an instance's overlay of that query cannot
drop it. `members` is the rollup's: an internal assistant row with no project
list is a member of every project, and — per the rule above — inherits none of
them; the Mac draws it apart from the members that do.

### Work — the board and dispatch

```
GET  /api/targets                 200 {"targets":[{name, transport, check}],"as_of":"…"}
POST /api/tasks/:id/dispatch      {target, brief, sources?, purpose?, max_acu?}   201 {"ok":true,"ref","url","run_id"}
PATCH /api/tasks/:id              see below
POST /api/tasks/:id/claim | release | renew   see below
```

**Dispatch** sends a task to a compute target (`docs/ops/targets.md`):
outbound, so the owner's alone. `target` is a name from `GET /api/targets`,
`brief` is the instruction; `purpose` is a knowledge-research brief kind and an
unknown one is refused rather than defaulted. The data policy and the `runs`
row are `dispatch()`'s — `400` names the field, `404` no targets are
registered, `409` the task is already bound or closed or the target is
unavailable, with `violations` or the target's `check` beside the envelope
where one applies. T4-11 turns targets into Agent connections.

#### The task routes — the board's drags, and nothing else (`user` principal)

```
PATCH /api/tasks/:id   {status?, owner?, project?, title?, description?}
POST  /api/tasks/:id/claim    {lease_seconds?}
POST  /api/tasks/:id/release  {note?}
POST  /api/tasks/:id/renew    {note?, lease_seconds?}
200 {"ok":true,"task":{…}}
400 the field is named (unknown key, bad status, a mixed change)
404 the task does not exist
409 the row's state refuses — the message names the route that would fix it
```

Until this shipped, `POST /api/tasks/:id/dispatch` was the *only* task route
the console had; every other mutation was an mcp-brain tool. These four are a
thin adapter over `TasksService` (`apps/console/src/task-routes.ts`) —
"adapters adapt this and add nothing". No policy lives in the adapter: every
refusal above came out of the `WHERE` clause of one atomic statement in
`packages/tasks`, and the route only turns it into a sentence.

They sit behind the same management gate as `/api/projects`, so an agent
token and a capture owner token both get the canonical `403`, never a `404`
that would say whether the task exists. One `runs` row per request records
the **door** (`component: console`, `kind: task_admin`); the service writes
its own for the **op** (`component: user`, `kind: task_op`).

`PATCH` has two arms and the fields pick which — see `packages/tasks`' README.
`status: "open"` is the **unblock** and is legal from `blocked` only;
`owner`/`title`/`project`/`description` need no claim; `in_progress | blocked | closed` are
the holder's, so closing a card you do not hold answers `409 … held by X, not
by user — claim it first`. Mixing the two arms in one body is a `400` naming
both fields, because the looser gate must never carry the stricter arm's write.

**Assignment is the human's alone.** `owner` exists on this route and on no
agent surface: `tasks_update`'s schema has no `owner` key and its status enum
has no `open`. That is collaboration rule 4 enforced by absence rather than by
a check — a human may address a card to any crew, and an agent cannot address
one at all. If an agent verb ever gains assignment, `crossKindRefusal` is the
guard it needs (`docs/research/2026-09-11-local-models-openrouter-opencode.md`).

**A description is set by whoever creates the row and edited by the owner
only** (T1-1, C85). `description` is at most 2,000 characters; `null` or a
blank string clears it, so "none" has one spelling (`null`) on every read.
An agent sets it once, through `tasks_create`; `tasks_update` has no
`description` key, so no agent surface can rewrite what a card says it is
about — the same absence that keeps `owner` off every agent verb. It is a
board-arm field, so the owner may describe a card a crew holds without
taking the claim, and it cannot ride in one body with a holder status (`400`
naming both). The door's `runs` row names the field, never the text. Every
task route's `task` now carries `description`, and so does `GET
/api/q/board` — the card detail's first section.

### Artifacts, reviews and rooms

```
GET  /api/artifacts[?project=&limit=]                         200 {"artifacts":[…],"as_of":"…"}
POST /api/artifacts                                           {project, slug, idempotency_key, message, files, kind?, expected_current_version?}
                                                              201 {artifact, version, links, deduplicated:false}   200 … deduplicated:true
GET  /api/artifacts/:id                                       the artifact
GET  /api/artifacts/:id/versions                              200 {"versions":[…]}
GET  /api/artifacts/:id/versions/:version                     the version and its manifest
GET  /api/artifacts/:id/versions/:version/file?path=[&raw=1]  200 {path, kind, sha256, bytes, content | content_base64}, or the bytes
GET  /api/artifacts/:id/diff?from=[&to=]                      the diff between two versions (to defaults to the latest)
GET  /api/artifacts/:id/comments?version=                     200 {"threads":[…]}
POST /api/artifacts/:id/comments                              {version, body, path?, anchor?} | {parent, body}   201
POST /api/artifacts/:id/comments/:comment/resolve            200 {"comment":{…}}
POST /api/artifacts/:id/comments/:comment/reopen             200 {"comment":{…}}
POST /api/dispatches                                          {artifact, version, thread_ids, to_agent, message?, idempotency_key?}   201
GET  /api/dispatches/:id                                      a review bundle's status
GET  /api/work/:id/thread                                     a task's room
POST /api/work/:id/comments                                   {body}   201
POST /api/work/:id/thread/resolve                             200 — the room's thread view
POST /api/work/:id/thread/reopen                              200
400 — the field is named;  404 — no such artifact, version, comment or task;  409 — publish lost its compare-and-swap
503 — no vault bridge configured (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER)
```

An adapter over the one artifacts service (§4.21, `docs/ops/threads.md`), the
owner's hand on it; agents reach the same service through `artifact_*` tools.
Publish is idempotent on its required `idempotency_key` (a retry hands back
what the first call made) and compare-and-swaps on `expected_current_version`
(`null` = must be new). The raw file route is the one place bytes leave the
vault for a browser: images and PDFs render inline under `Cache-Control:
no-store` and a sandboxing CSP; HTML and everything else is an attachment —
agent-authored HTML never renders on the console origin. **Resolve** is here
and nowhere else: no tool, no sweep, no timer resolves a room.

### The ledger — runs, turns and sessions

```
GET  /api/runs/export?since=&until=&component=&limit=   200 application/x-ndjson, oldest first
GET  /api/runs/:id                                      200 {"run":{…},"as_of":"…"}
GET  /api/turns/:turn_id/progress                       200 {"turn_id","calls":[{"id","tool","started_at","finished_at","ok","error","duration_ms"}],"as_of"}
GET  /api/sessions/:id      ?turn_id=                   200 {"session_id","turns":[{"id","session_id","thread","turn_id","ts","system_prompt","messages","tool_calls","folded_at","expires_at"}],"as_of"}
                                                         404 — no session with that id, or every row for it has expired or been purged
POST /api/sessions/purge   {confirm?, as_of?}           200 {"purged":false,"sessions","turns","sessions_unfolded","unfolded":[…],"as_of"}
                           {confirm: true, as_of?}      200 {"purged":true,"sessions","turns","sessions_unfolded","as_of"}
400 — `confirm` is not true/false, or `as_of` is not a timestamp
```

Chat's working indicator (T2-17) reads `turn_progress`: every tool call one
assistant turn has made so far, oldest first, exact-joined on `meta.turn_id`
(never a time window) — the same key `run_detail` joins on. A `finished_at`
of `null` on a row is the still-running call; the count and the elapsed
seconds are cheap enough that the client computes them rather than the wire
carrying a second, redundant shape of the same answer. An unknown or blank
`turn_id` is not a lookup failure — it answers `calls: []`.

Run detail's conversation (T2-17) reads `session_detail` — one row per turn
of the session, oldest first, straight from the session archive below (never
a reconstruction from files). `?turn_id=` narrows to one turn's full record;
omitted, every turn of the session comes back. Expiry is enforced by the
query itself, so a purged or expired session reads exactly like one that
never existed — `404`.

The timeline itself is the `activity_feed` and `runs_summary` named queries
through `GET /api/q/:name`; there is no `runs` list route.

**The session archive** (migration 0030, T3-9) is written by the engine, not
by any route: every finished turn — chat and machine-enqueued alike — is
appended with the system prompt as sent, the messages that turn added, and
each tool call's arguments and result, all through `core/redact.ts` before the
row is written (`apps/assistant/src/archive.ts`). Each row expires 30 days
after it is written and starts unfolded (`folded_at` NULL — the session fold's
queue). The scheduled `session-purge` routine deletes what has expired, and
anything older than its `retention_days` (Scheduled config, 1–30, default 30).

**What the fold learns arrives as a request** (C79, T3-10). The hourly
`session-fold` routine reads the owner's chat turns out of that queue, lets the
assistant suggest preferences, lessons and profile facts on a turn of its own
(thread `session-fold`), checks each suggestion model-free — a quote must be
the owner's own words from a turn the fold showed — and raises at most one
`improvement` per file, with `source: {kind: "metistry", external_ref:
"Me/Working Style.md#session-fold"}` (or `Me/profile.md#session-fold`). Its
payload is the Me/ edit every client already answers — `body` a
`before_after` of the whole file, `edit: {path, base_sha256}` — plus `items`,
one per line: `kind` (`preference`, `lesson`, `profile`), `line` (what Approve
writes), `quote` (the owner's words), `key`/`value` for a profile fact, and the
provenance screen-12 draws — `session_id`, `turn_id`, `archive_id`, `thread`,
`ts`. **Approve** (`POST /api/proposals/:id`, `allow`) writes the after as
`user`, refused `stale` if the file changed since; Decline writes nothing, and
a declined line is not proposed again. A later fold for a file whose request
is still waiting closes it `resolved_at_source` and raises one request with
both sets of lines, so a file never has two Approves that cannot both land.

**Purge Now** is irreversible, so it is `local`, and it is two steps on one
door. A body without `confirm: true` deletes **nothing** and answers what a
purge would cost: every archived session and turn, the exact count of sessions
the fold has not read yet (`sessions_unfolded`), and the newest fifty of them
by name (`unfolded`: `session_id`, `thread`, `turns`, `unfolded_turns`,
`first_ts`, `last_ts`) — what the confirm names before it offers *Fold First*.
`{confirm: true}` deletes every archived turn, folded or not; pass the
preview's `as_of` back and it deletes exactly what was counted, so a turn
archived while the confirm was open is kept. The purge is audited (`runs`:
`kind = sessions`, `tool = purge`, with the counts). The retention the purge
routine keeps is its Scheduled configuration (§2.5).

`activity_feed` (T1-3) takes `hours`, `limit`, `agent`, `project`, `kind`,
`since` and `turn_id`, and each row is `ts, kind, group, actor, subject,
detail, ref, turn_id, ok`. `kind` matches an exact row kind or one of the
seven groups the chips read — `capture`, `proposal`, `decision`, `run`,
`work`, `message` and `routine`. `ok` is `false` only where a run failed,
`true` where it did not, and `null` where the source cannot fail, so a client
draws failure from the column, never from `detail`. A `routine_run` is in the
`routine` group once it has settled, dated by when it did; a tick whose
`meta.outcome` is `silent` never appears, and a failed one (`ok = false`,
which carries no outcome) always does. A `routine_run` row's `subject` is the
routine's display name, not its raw component id — `plan-tomorrow` reads
`Tomorrow's Plan` (Ruling 25, X-21), the runner's own `meta.display_name`
stamp read straight from the manifest, or (a row from before that stamp
existed) the same identifier-to-title fallback a manifest-less New Routine
gets. `actor` still carries the component id unchanged. `turn_id` returns
every call one reply made, whatever the window's `limit` left out.

#### `GET /api/runs/export` — the audit ledger as NDJSON (S5)

```
GET /api/runs/export?since=<cursor>&until=<ts>&component=<name>&limit=N
Authorization: Bearer <local owner token>      (or the session cookie)
200 application/x-ndjson
{"instance_id":"8b6a3a2e-…","id":91,"ts":"2026-09-16T00:00:00.001Z","component":"console",
 "kind":"capture","tool":null,…,"meta":{"agent":"cursor"},
 "source_agent":"agent:cursor@8b6a3a2e-…","cursor":"2026-09-16 00:00:00.001+00|91"}
{"instance_id":"8b6a3a2e-…","id":92, … }
400 when `since`, `until`, `component` or `limit` is not a form this server mints
```

The `user` principal only — an agent token is the uniform 403, an
unauthenticated call a 401. One JSON object per line, **oldest first** (an
export is a forward replay), with `core`'s `redactSecrets` applied to the
whole row, so a secret-named key anywhere in the collector- or
agent-authored `meta` is `***REDACTED***` before it leaves.

- **`since`** is a cursor from a previous export's last line, or a bare
  timestamp (which means "`|0`", i.e. from the start of that second). The
  same opaque-cursor grammar the polled lists use.
- **Every line carries its own `cursor`**, so a client resumes from the last
  line it wrote rather than from a trailer it would have to wait for.
- **`instance_id`** and, where the row names an agent, the qualified
  **`source_agent`** (`agent:<name>@<instance_id>`, S3 — see
  `docs/ops/instances.md`) are what let two ledgers merge without
  colliding. `runs` has no `source_agent` column; the agent rides in `meta`,
  stamped from the credential at the door, and the export reads `meta.agent`
  / `meta.source_agent` / `meta.principal`. `user` and `owner` are
  principals, not agents, and are never qualified.
- **Streaming.** The response is chunked and written as it is produced.
  A failure mid-stream **destroys the connection** rather than ending it
  cleanly — an aborted chunked body is HTTP's way of saying "this is not the
  whole thing", and `metistry runs export` reports it as an error instead of
  writing a truncated export that looks complete.
- The export is itself a `runs` row (`kind: export`, `tool: runs`, with the
  line count) — an audit export that is not audited would be a hole.

**Invariant 3, decided.** `runs` is special-cased for the watchdog's
liveness probes and nothing else, so an export is not a second licence to
open a connection. The query driver (`packages/queries`) is the only thing
that talks to Postgres here — but it buffers a whole result set and has no
streaming driver, so a single unbounded query for a year of runs would be
one enormous array in memory. What ships is the **named query
`runs_export.yaml` with a cursor parameter, paged**, and the streaming done
by the route looping over it: the SQL stays in the instance's `queries/`
where the owner can read and override it (D4), memory is bounded by one
page, and the client still gets bytes as they are produced. The cost is one
round trip per page instead of one held cursor — for an export that runs on
the owner's own machine, not a cost worth a second read path.

The CLI (`metistry runs export`, `docs/ops/cli.md`) is a client of this
route and never touches Postgres.

#### `GET /api/runs/:id` — one row of the ledger (`user` principal)

```
GET /api/runs/123
200 {"run":{…},"as_of":"…"}
404 no run 123 in the ledger
503 the named query `run_detail` is not loaded
```

`activity_feed` gives every event a `ref` of `runs:<id>`; this is what the tap
on it opens. Through the `run_detail` named query like every other read
(invariant 3) — component, kind, timing, provider/model, token and cache
counts, cost, the error if it failed, `meta`, and:

- **`tool_calls`** (plus `tool_calls_total`, `tool_calls_failed`) — the calls
  the same reply made, joined **exactly** on `meta.turn_id` (the id the
  assistant stamps on every brain tool call while answering one message,
  `docs/ops/assistant-tools.md`) or `meta.message_id`. A run with neither
  reports none, which is the honest answer: a ±N-minute window around a
  session would attribute another reply's calls to this one.
- **`shadow_*`** — the candidate provider/model, the deterministic agreement
  score, whether the tool-call sequence matched, the answer similarity, and
  what the shadow cost (`docs/ops/compute.md` "Shadow mode"). `null` on every
  unshadowed turn, which is also how "shadow mode is not configured" reads.
  The **transcripts themselves are not returned** — they are two full replies,
  and the drill-down wants the measure, not the text.

There is still no `runs` *list* endpoint: the timeline is `activity_feed` /
`runs_summary`, and the whole ledger is `GET /api/runs/export` above.

### Registries the clients read — instances and commands

#### `GET /api/instances` — the peer registry

```
GET /api/instances                             (user principal)
200 {"instances":[{"instance_id":"0a1b2c3d-…","name":"Second",
                   "origin":"https://second.example.com",
                   "last_seen":"2026-09-16T01:00:00.000Z",
                   "capabilities":["capture","knowledge"],"resources":[]}],
     "as_of":"2026-09-16T01:02:03.004Z"}
400 the file does not validate — the message names the field
503 no registry configured (degrades: absent)
```

The read side of `instances.yaml` for the app and the phone. The file is the
instance repo's and a §4.7 protected path, written only by `metistry
instances` as the `user`; the whole design, including why `resources` is
empty, is `docs/ops/instances.md`.

#### `GET /api/commands` — the composer's list, generated (`user` principal)

```
GET /api/commands
200 {"commands":[{"id":"/status","description":"Work items not yet closed, newest first",
                  "routes_to":"fast_path","tier":null,"model":null,"effort":null,
                  "query":"open_work","takes_argument":false}],
     "agents":[{"id":"@drey","description":"Drey","kind":"external",
                "present":true,"last_seen_at":"…"}],
     "as_of":"…"}
503 no rules.yaml is loaded (METISTRY_RULES_FILES)
```

`docs/product/ux-direction.md` ruled that discoverability is **generated, not
hand-maintained**, and until this route existed every client shipped a static
array with the gap marked in code — so any instance whose `rules.yaml`
differed from the shipped defaults was lied to by its own menu. This is the
one source: the instance's own router rules plus the agent registry.

What it derives, and from where:

| entry | from |
| --- | --- |
| `/note` | the router itself (`router.ts`) — a file, an inbox row, an instant ack, no model |
| `/<deep_alias>` | `rules.commands.deep_alias`, so an instance that calls it `/think` gets `/think` |
| `/model` | the general override, listing the instance's own tier names |
| one per `fast_path` rule | the rule's `match`, **only** where the pattern spells a command unambiguously |

`routes_to` is the router's own vocabulary (`note`, `fast_path`,
`model_override`); a model route carries the `tier` it takes and the
`model`/`effort` that tier resolves to **right now** — `compute.yaml`'s
assignments when it has any, else `rules.yaml`'s `tiers:` block — so a
reassignment shows in the menu without a restart. A fast path carries the
named query that answers it, and its one-line `description` **is that query's
own description**, so there is nothing to keep in sync.

**It refuses to guess.** A `fast_path` rule is a regex, and most regexes are
sentences: `^what('| i)?s (my |the )?(status|open work)\b` matches real
messages and is not something anybody types with a slash. So only `^/name…`
and `^/(a|b|c)…` yield commands; `^/s[ua]m`, `^/st(at)?us` and a branch
containing a space yield **nothing**, and one unreadable branch discards the
whole rule. A rule that yields no command is not a bug and is not hidden — it
is a rule you reach by writing the sentence. `takes_argument` says whether the
router needs text after the command.

**Order is deterministic** (the same discipline invariant 4 applies to the
router): `/` commands first, then `@` agents, each group sorted by `id`. That
is what a menu opened with nothing typed shows; the *client* re-ranks the same
list by prefix-then-substring-then-recency against the token being typed
(`design-system.md` §3.6). First match wins among `fast_path` rules, exactly
as in the router, so a later rule re-using a word does not overwrite it.

Agents come from the registry, `revoked` rows dropped. `present` means an
approved, unrevoked row that has authenticated at least once — a **pending**
enrolment (S2) is listed and never `present`, because it authenticates nothing
until the owner approves it.

An integration test routes every command the endpoint offers back through
`route()` and asserts the decision matches what the entry claims. Nothing else
in the repo holds the menu and the router together.

### Compute

#### `/api/compute*` — providers, assignments and spending limits (`user` principal)

```
GET  /api/compute                                     the same report as `metistry compute show --json`
GET  /api/compute/models[?provider=<name>]            live /v1/models, per provider, plus unconfigured local servers
GET  /api/compute/catalogue[?q=&provider=&refresh=true]   T4-18 — `compute models search --json`: grouped by model
POST /api/compute/assign          {tier|crew, model, effort?}   T8-6 — `tier: private` refuses an off_machine provider (400, naming assignments.tiers.private)
POST /api/compute/unassign        {tier|crew}            T4-18 — `compute unassign`; `default` is refused
POST /api/compute/budget          {scope, daily?, monthly?, action}
POST /api/compute/providers/test  {name, complete?}
200  the verb's own JSON result, plus `notes` (the lines the CLI would print) and `as_of`
400  the field that would permit it — including a `compute.yaml` that does not validate
403  `not granted` — an agent bearer, or a capture owner token
503  compute is not reachable from this console (see "Which shapes can write" below)
```

Until these existed, compute was **Mac-only**: `metistry compute` on the
machine holding the instance repo was the whole surface, so the phone could
see what a turn had cost and could not move it to a cheaper model. P6 ("every
client can do everything") was violated by construction, and that is what
`docs/product/app-ux-plan.md` §6 phase D is asking for.

**One implementation, not a second one.** Every verb here calls the same
exported function `metistry compute` calls
(`packages/cli/src/compute.ts`, `docs/ops/compute.md`): the instance's
`compute.yaml` is edited as a **YAML document** so comments, ordering and
hand-written blocks survive; the RESULT is re-parsed through core's schema and
the whole write is refused if it does not validate; and the write goes through
the reconciler as the **`user` principal** (invariant 2, D5). There is no
second editor and no second validator, so a CLI verb and the app's Compute
pane cannot come to mean different things.

**These are configuration, not "actions".** Invariant 10 closes the console's
*action* surface: an enumerated set of doors onto existing audited services,
each new one a product change rather than a prompt or a config line
(`docs/ops/actions.md`). `/api/compute*` is **not** on that list and is not
meant to be. It is the owner's own configuration of how the system behaves —
`user` principal only, no agent, no proposal, no `propose_action` kind, no
autonomy level that reaches it. `runAction` has no compute kind, which is that
sentence in code rather than in a comment.

**A secret never crosses this boundary.** `providers add`, `set` and
`remove` are deliberately **absent** (§2.2 M16). Adding a provider takes a
key; a key belongs on stdin into this instance's Keychain account, from the
hand of the person at the machine (`docs/ops/compute.md` "Secrets"), and the
switch, the base URL and which secret a provider uses are where prompts and
keys go — the Q8 table keeps them to the Mac. So **adding, configuring or
removing a provider, and anything that takes a secret, stays CLI/app-only.**
What `GET /api/compute` reports is the **reference** a provider authenticates
with (T4-18: `{{ secret.<name> }}`, one of this instance's secrets) and whether
this instance holds it — plus the provider's switch, billing and one tag:

```json
{"name":"openrouter","locality":"off_machine","zdr":true,
 "enabled":true,"tag":"cloud",
 "secret":"{{ secret.openrouter_api_key }}","secret_kind":"secret","secret_name":"openrouter_api_key",
 "secret_present":true,
 "models_assigned":["anthropic/claude-opus-4"],
 "budget":{"daily_usd":5,"monthly_usd":60,"action":"stop"}}
```

`secret_kind` is `secret` or `env` (an install variable, `env:NAME`, and
`secret_legacy: true` on the pre-T4-18 bare spelling); `billing` is present
only where the file sets it; `tag` is `local`, `cloud` or `subscription`.
Presence, never a value: with a login Keychain it is this instance's item;
without one (a container) it is whether the delivery variable is set. `POST
/api/compute/providers/test` does use the credential — a real
`GET <base_url>/models`, and with `complete: true` a one-token completion — and
reports only whether it worked.

**The catalogue** (`GET /api/compute/catalogue`, T4-18, C131) is every
**switched-on** provider's listing grouped by model through the model identity
table (`seed/model-identities.yaml`, overlaid by the instance's own, by key):

```json
{"query":"gemma",
 "providers":[{"name":"lmstudio","tag":"local","ok":true,"detail":"… → 3 model(s)","count":3,"read_at":"…"}],
 "skipped":[{"name":"ollama","why":"switched off — `metistry compute providers set ollama --enabled on`"}],
 "rows":[{"kind":"model","key":"gemma-3-4b","name":"Gemma 3 4B","maker":"Google","context":131072,"capabilities":["vision"],
          "places":[{"provider":"openrouter","model":"google/gemma-3-4b-it","ref":"openrouter/google/gemma-3-4b-it","tag":"cloud",
                     "zdr":true,"in_per_m":0.02,"out_per_m":0.04,"price_source":"listing","included":false,"cheapest":false}],
          "summary":{"local":true,"cloud":true,"from_in_per_m":0.02}}],
 "as_of":"…"}
```

A row is `kind: "model"` when the table maps it and `kind: "unmapped"` when it
does not — **one unmapped row per (provider, id)**, never merged with a
look-alike, keyed `<provider>/<id>`. `q` (at most 200 characters) keeps rows
where every word appears, best match first. The console keeps each provider's
listing for 15 minutes, per instance, in memory only; `refresh=true` re-reads
every switched-on provider now (C132's Refresh). A listing that cannot be read
is `ok: false` on its provider's line and the search goes on. No path on this
Mac is in the body. `400` for an empty or undeclared `provider`, a `refresh`
that is not `true`/`false`, or an over-long `q`.

**Unassign** (`POST /api/compute/unassign`, T4-18) removes a tier's or a crew's
assignment through the same YAML-document write as `assign` — the other half
of editing the tiers the dynamic router chooses from (Q1). `{tier: "default"}`
is `400`: `default` is reassigned, never removed. A target the file does not
assign is `400`, and nothing is written.

`GET /api/compute` adds three fields the CLI report does not carry:

- **`spend`** — `{instance:{daily,monthly}, providers:{<name>:{daily,monthly}}}`,
  folded from the **`spend` named query** (invariant 3: the same read path the
  engine checks before every billable call), so the pane shows a budget beside
  what has been spent against it. `null` when that query is not loaded — never
  a guessed zero.
- **`limits`** (T4-19, C130, C133) — every spending limit side by side, what
  Settings › Compute › Spending limits and the Usage popover read: this
  instance's, each provider's, and each project's daily budget, each beside
  what has been spent against it. Core's `spendingLimits` folds it from the
  `spend` and `projects_rollup` named queries (the read `GET /api/projects`
  makes, so the two panes cannot disagree about a project):

  ```json
  {"instance":{"kind":"usd","scope":"instance","field":"budgets.instance",
               "daily_usd":5,"monthly_usd":60,"action":"stop","spent":{"daily":1.25,"monthly":14.1}},
   "providers":[
     {"name":"openrouter","tag":"cloud","enabled":true,"kind":"usd","scope":"provider:openrouter",
      "field":"budgets.providers.openrouter","daily_usd":null,"monthly_usd":20,"action":"stop",
      "spent":{"daily":1.25,"monthly":14.1}},
     {"name":"plan","tag":"subscription","enabled":true,"kind":"window","scope":"provider:plan",
      "used":{"calls_today":7,"calls_this_month":37}}],
   "projects":[{"kind":"usd","scope":"project:drey","id":"drey","title":"Drey","daily_usd":2.5,
                "spent":{"daily":1.1},"mode":"autonomous","at_limit":"review"}]}
  ```

  A `usd` limit with nothing set reads `null` for both amounts and for
  `action` — state, not a default. **A provider billed by subscription has no
  dollar limit**: its plan's window is its limit, enforced by the provider, so
  its line is `kind: "window"` with the calls made in each window and no
  amount or action — and `POST /api/compute/budget` with `scope:
  "provider:<it>"` is `400` naming `budgets.providers.<it>` (the schema
  refuses it, so the CLI refuses it identically). A project's daily budget is
  set by `PUT /api/projects/:id`, not here; at it an autonomous project flips
  to review (`at_limit`), it is never a refusal. `spent`, `used` and
  `projects` are `null` when their query is not loaded.
- **`writable`** — whether the write verbs will work here, so a client greys
  the controls instead of discovering it on submit.

**Which shapes can write.** Every write verb OPENS the instance's own
`.metistry/compute.yaml`, edits the document and writes the whole thing back,
so the console has to be able to *read* that file. The compose shape
deliberately gives the console no instance mount (D5: the reconciler is the
sole holder of the instance repo), so there `METISTRY_INSTANCE_DIR` is unset
and every route answers `503` naming it. The launchd/native shape runs the
console as the user with the instance's own environment, and it works.

And one guard that is not about a caller's mistake at all: if the overlay in
force (`METISTRY_COMPUTE_FILES`) ends somewhere other than
`<instanceDir>/.metistry/compute.yaml`, the write is refused with both paths
named. Unguarded, the verb would find nothing at the path it opens, start from
a bare header, and deliver a four-line file over the real one — data loss
rather than a refusal. `apps/console/test/compute-routes.test.ts` holds it.

### Knowledge

```
GET  /api/knowledge/search | page | pages | links    see below
GET  /api/knowledge/fold | drafts | areas            see below — the owner's alone
POST /api/knowledge/conflicts/resolve      served — {path, keep, seen_sha}   409 stale — only a path in `conflict`   the owner's alone
GET  /api/knowledge/history?path=&limit=   served — a file's commits, through the bridge's `GET /vault/log`   the owner's alone
GET  /api/knowledge/version?path=&sha=     served — one file at one commit, through the bridge's `GET /vault/show`   the owner's alone
POST /api/knowledge/restore                served — {path, sha, seen_sha}: raises a Needs You request, never writes   409 stale   reach `local` — the owner on this Mac alone, not the phone (ruling 7)
```

**Resolving a conflict** writes one note through the vault bridge as `user`,
and only for a path the reconciler has in `conflict`.

```
POST /api/knowledge/conflicts/resolve
     {"path":"Areas/Health/sleep.sync-conflict-20260927-101500-ABCDEFG.md","keep":"mine","seen_sha":"<the copy's sha256>"}
200  {"ok":true,"path":"Areas/Health/sleep.md","kept":"mine","sha":"<the note's sha256>"}
409  {"error":{"code":"conflict",…},"reason":"stale","conflict":{"path","original","sha256","original_sha256"} | null}
```

- **`path` is the copy** — `payload.conflict.path` on the conflict's review
  (*Events become requests*), the one path the index has in `conflict`.
  `keep` is `mine` (the note as it stands; the copy goes) or `theirs` (the
  copy's bytes become the note; the copy goes). The answer's `path` is the
  note that remains and `sha` its content hash.
- **`seen_sha` is the side you give up**, as the review showed it:
  `conflict.sha256` to keep mine, `conflict.original_sha256` to take theirs,
  `""` when that side does not exist. What you discard must be what you saw.
- **`409 stale`** when it is not, with `conflict` as it stands — and when the
  path is **not in `conflict`** at all (settled from another device, or never a
  conflict), with `conflict: null`. Nothing is written either way, and neither
  is a failed answer: the review carries no `payload.error` for it.
- **The side you give up stays in history.** The bridge commits it, as
  `user`, before discarding it — a copy was never committed, and the note may
  hold an edit the sweep has not reached yet. If history cannot be made to
  hold it (git is mid-merge), the answer is `503` and nothing is discarded.
- **The Undo is the client's** (C136): Keep Mine and Take the Other act at
  once with ten seconds of Undo, held by the client *before* it sends. This
  route has no undo; after the ten seconds, the other side is a
  `GET /api/knowledge/version` away.
- **The review** clears at its source (`resolved_at_source`) when the copy
  goes. A settle refused or failed for any other reason — no bridge, the
  bridge's refusal, a throw — is written on the review as `payload.error`
  (C45), with `decision` the verb the button stands for (Keep Mine `allow`,
  Take the Other `accept_with_changes`), `door: "resolve_conflict"` and `keep`.
- No principal but the owner: an agent bearer and the capture owner token get
  the uniform `403`, before the body is read. **Restore** never writes
on its own: it raises a request carrying the before and the after, and Approve
writes the old bytes as a **new** commit as `user` (*Restore <path> to
<date>*) — history is preserved, always (§2.21). No agent principal can
restore or roll back.

#### `/api/knowledge/*` — the vault read path (`user` principal)

```
GET /api/knowledge/search?q=&mode=keyword|semantic|hybrid&limit=
200 {"q":"sleep","mode":"hybrid","hits":[{"path","title","description","snippet","score","source"}],
     "degraded":null,"as_of":"…"}
GET /api/knowledge/page?path=Areas/Health/sleep.md
200 {"path","content","sha256","bytes","as_of"}
GET /api/knowledge/pages?area=&prefix=&limit=&offset=
200 {"pages":[{"path","area","title","description","status","modified","indexed_at"}],
     "area":null,"prefix":"Areas/Health","limit":100,"offset":0,"as_of":"…"}
GET /api/knowledge/links?path=Areas/Health/sleep.md&limit=&offset=
200 {"path":"Areas/Health/sleep.md",
     "links":[{"direction":"outgoing","path","kind","title","description","status","resolved"}],
     "limit":100,"offset":0,"as_of":"…"}
400 q / mode / limit / offset / a filter's shape / a missing path — by name;
    or, for the OWNER, a path this door does not serve (the classification)
404 the page is not there, OR — for anyone but the owner — is not knowledge
    or is outside their grant (indistinguishable, on purpose)
503 no vault bridge configured; or, for `pages`/`links`, the named query is not loaded
```

The console has held a vault reader, lister and searcher since Phase 6 and
wired them only into `mcp-brain`'s tools — so knowledge was reachable by an
**agent** over MCP and by nothing the owner holds. These routes are that gap
closed, and the two that proxy are deliberately thin: the reconciler's `GET
/vault/search` and `GET /vault/read`, which serve them already
(`docs/ops/reconciler.md`, `docs/ops/knowledge-search.md`). Not streamed — the
bridge's hit list is bounded, a page is one file, and the list is one bounded
window of an index.

`mode` omitted means **"choose for me"** at the bridge (hybrid where vectors
exist, keyword otherwise) rather than a default invented in the console.
`limit` defaults to 20 and is capped at **100**, which is the bridge's own
ceiling: there is no offset and no cursor, and RRF fuses over a pool, so an
offset would re-rank rather than continue. "Top 100, honestly" is the
contract. `degraded` reaches the client rather than being swallowed (P5):
"keyword only — the embedder is down" is a **fact the UI states**, not an
error.

**What the bridge does not refuse, this does.** The reconciler's `/vault/read`
confines a path to the instance repo and stops there — it will serve
`.metistry/state/.env`, `.metistry/compute.yaml` or the root `CLAUDE.md`,
because `metistry update` and `metistry compute` write those files through the
same bridge and a read gate would break the write path. Knowledge is a
narrower thing than "a file in the instance repo", so this door serves
knowledge and nothing else — `classify(path) === "knowledge"`, which is
core's `isVaultPath`: no traversal, no leading slash, nothing inside a
dot-directory, not `Artifacts/`, not the root `CLAUDE.md` / `README.md`. The
same predicate `mcp-brain`'s `validKnowledgePath` applies to agents and the
indexer applies to the walk, so the three cannot drift.

**For the owner that is a classification, not a refusal** (P4, ruled
2026-09-19: "the owner should always have access to everything"). Their own
`Artifacts/` and `.metistry/` are not pages this door has, and it says so —
`400`, `reason: "not_knowledge"`, and `needs.door` naming the door that does
have them:

```
GET /api/knowledge/page?path=Artifacts/report.pdf
400 {"error":{"code":"invalid_request","message":"`Artifacts/report.pdf` is an artifact, not knowledge — …"},
     "reason":"not_knowledge","needs":{"door":"GET /api/artifacts"}}

GET /api/knowledge/page?path=.metistry/state/.env
400 {"error":{"code":"invalid_request","message":"`.metistry/state/.env` is machinery, not knowledge — …"},
     "reason":"not_knowledge","needs":{"door":"the file itself"}}
```

Not `404`, which would be this door claiming the file is not there, and not
`403`, which would be claiming a permission question nobody asked. The
machinery's "door" is the file itself, on disk and in git: **no door serves
it as a page, and not one byte of it crosses here.** A path that genuinely
has no page is still a plain `404`.

**For everyone else the answer is one sentence, whatever the reason.** Out
of scope, a draft, machinery, an artifact, a path that was never written:
`404`, `no such page …`, no `reason`, no `needs`. "Refused" and "absent"
have to be indistinguishable from outside, or the route is an oracle for
what exists where the caller cannot look. An agent asking for the same path
as the owner above still gets the one uniform
sentence, byte for byte the same as for a path that is not there.

**Grant areas.** All four routes filter through one predicate (`canSee(path,
scope)`): is this vault content at all, *and* does it fall under the scope's
areas. `links` applies it twice, once per end of an edge. A hit the scope does
not cover is **dropped**, never returned with a flag — a path is the sensitive half of a hit, and a filtered list must not
become a directory listing of what was filtered. The only principal that
reaches these routes today is `user`, whose scope is the whole vault (which is
still not "every path": the `isVaultPath` half applies to the owner too) — and
that scope is **derived from the credential** (`knowledgeScopeOf`), never a
constant at the call site, because a filter is only as honest as the scope it
is handed. An **agent** reaches knowledge under its grants on the `/mcp`
mount —
`knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_grep`,
where `knowledgeScope(principal)` produces exactly this shape from
`grants.areas` — and is the uniform `403` here, like everywhere outside
`/capture` and `/mcp` (CRIT-7). The narrowed form is implemented and tested so
that a narrower console principal, if one is ever minted, inherits the filter
rather than reinventing it at the call site.

**`GET /api/knowledge/pages` is the first of the two that are not proxies**
(the link graph below is the other). A page's bytes and a search ranking are
not derived state — there is no column holding a note
body — so those two go to the bridge. A page LIST *is* derived
(`knowledge_files` is the reconciler's own index, rebuilt from the vault by a
walk), so invariant 3 sends it through the named query
`seed/queries/knowledge_pages.yaml`, executed by `packages/queries` like every
other read. The route holds **no SQL**; a route that reached for `pool.query`
would be a second read path. No migration was needed: `0009_brain.sql` already
added `title`, `description`, `draft` (`docs/product/app-ux-plan.md` §6.1).

| Parameter | Meaning |
| --- | --- |
| `area` | the **derived** grouping, matched exactly. There is no area column — everywhere else in the system an area is a vault prefix (`Areas/Fsl`), so the column is the first two segments under `Areas/` *at any depth* (`Areas/Health/2026/sleep.md` is in `Areas/Health`) and the first segment anywhere else (`Journal`, `Me`, `Inbox`). A vault-root file like `now.md` has `null` — not `""`, so blank can keep meaning "every area" |
| `prefix` | a path prefix, **segment-wise**, the same semantics an area grant has: `Areas/Health` covers `Areas/Health/…` and never `Areas/Healthcare/…`, because a substring match is how a prefix filter leaks. A trailing slash is the same prefix; `/` is the whole vault |
| `limit` | default **100**, ceiling **500** — this route's own, not the bridge's 100: scalar columns over an indexed primary key are not a fused ranking. Out of range is a `400` naming the ceiling, never a silent clamp |
| `offset` | non-negative. The order is `path COLLATE "C"` ASC — the primary key, in **byte** order, so the window is total and stable and *the same on every cluster*. A bare `ORDER BY path` sorts in the database's own locale, and a glibc locale collation ignores punctuation at the primary level: `Areas/Health/sleep.md` lands before `Areas/Healthcare/…` under `C` and after it under `en_US.UTF-8`, so a client paging with `offset` would see a page twice or not at all depending on which machine the cluster was initialised on. (`mtime` is nullable and sync churns it constantly, which is why `0001` uses the content hash and not mtime to decide re-embedding, and why it is not the sort key) |

**Never in the list, and no parameter turns it off:** a `draft` note (the same
clause `mcp-brain` applies at every tier, so the owner's list and an agent's
index cannot disagree about what a draft is) and a `conflict` row (a file the
reconciler could not settle — its title and mtime are not facts yet). `status`
comes back so `dirty` — edited since the last walk — is visible rather than
guessed at.

**There is no `total`.** A count over the unscoped filter is exactly the
"directory listing of what was filtered" the grant-areas rule below refuses to
publish. Page until a window comes back shorter than `limit`. For a narrowed
scope that can stop early, and that is the deliberate trade: the alternative
publishes the size of what the caller may not see.

**A filter pointing outside the scope is an empty `200`, not a `400`** — the
same reasoning as the `404` above: refusing `prefix=.metistry` by name would
tell the caller which prefixes exist. Only the filter's *shape* is validated
(length, no backslash, no NUL); what it may select is decided row by row by
`canSee`. Rows reach the client **unprojected**, because an instance may
overlay `knowledge_pages.yaml` with columns of its own (D4) and a projection
in the console would swallow them; the one thing the route insists on is a
`path` it can judge, and a row without one is dropped.

**This is the only unscoped-shaped door onto that query.**
`knowledge_pages.yaml` declares `expose: route`, so `GET
/api/q/knowledge_pages` answers the `404` it answers an unknown name with —
and so does `queries_run` on `/mcp` — one endpoint per necessary operation
(ruled 2026-09-19). The owner is served at both doors since P4 (above);
every other credential, the capture owner token included, is not. The other door onto the same rows is `knowledge_list`,
which applies the same `canSeeUnder` to an agent's grant that this route
applies to the owner's scope. The generic door has no `canSee` filter and cannot have one: it
does not know that a column called `path` is a vault path, and it has no
principal scope to judge it against. Two doors onto the same rows would have
made the filter on this one optional, and it was reachable — the capture owner
token is `403` here and has always been admitted on `/api/q/<name>`. The
named-query section below describes the field.

**`GET /api/knowledge/links` is the fourth door, and the same kind of thing.**
The wikilink graph is derived too — the reconciler parses it out of the notes
on every walk and re-resolves a note's edges whenever the note or the path set
moves — so it is the named query `seed/queries/knowledge_page_links.yaml`,
`expose: route` for the same reason, over `knowledge_links` (`0001_init.sql`:
`from_path`, `to_path`, `kind`, primary key on all three, index on `to_path`,
so both directions are one indexed lookup). No migration.

| Field | Meaning |
| --- | --- |
| `path` (parameter) | **required** — the page whose links these are. A path the caller may not see is the same `404` a missing page gets: "this page has four backlinks" is a fact about a page. For the owner, a path that is not knowledge is the `400` classification the page route gives, in the same words — the two doors cannot drift |
| `direction` | `outgoing` — this page links there; `incoming` — that page links here |
| `path` (row) | always **the other end** of the edge. One list, one column, one predicate — two arrays would be two chances to filter them unevenly |
| `kind` | `wikilink`, `frontmatter` or `embed`. The same target reached two ways is **two edges**, so a client's row identity is the triple and not the path |
| `resolved` | whether the index holds a settled page there. `false` is an unresolved wikilink — a note not written yet, which is how a vault gets written; render it the way Obsidian does rather than dropping it |
| `title` / `description` / `status` | the target's, where the index knows it; the title falls back to the basename, decided server-side |

**Both ends are scoped**, which is the whole of the security story here: the
`path` parameter is checked before anything runs, and every row's `path` goes
through the same `canSee`. So a page inside a grant that links *out* of it,
and a page outside a grant that links *in*, both come back dropped rather than
listed — a backlink must not report the existence of a note in an area the
caller was never given.

**Never in the list:** an edge whose other end is a `draft` or an unsettled
`conflict`, at either end and at every tier — the same rule the page list
applies, so a draft cannot be discovered through the graph after being hidden
from the list. Dropped rather than blanked: a row saying "there is something
here you may not see" is the disclosure the rule exists to prevent.

Ordered **outgoing first, then by path in byte order, then by `kind`** — the
link table's primary key read the other way round, so the order is total and
`limit`/`offset` cannot repeat or skip an edge. `limit` defaults to 100 with a
ceiling of 500, like the page list. There is no `total`, for the page list's
reason. A page that does not exist is an empty `200`, not a `404`: it has no
links, and "refused" and "absent" stay indistinguishable.

#### `GET /api/knowledge/{fold,drafts,areas}` — the owner's three (T1-6)

```
GET /api/knowledge/fold?date=2026-09-28
200 {"fold":{"path":"Journal/Fold/2026-09-28.md","date":"2026-09-28","title","modified",
             "links":[{"path","title","kind","resolved"}]},
     "date":"2026-09-28","as_of":"…"}
200 {"fold":null,"date":null,"as_of":"…"}                    before the first fold
GET /api/knowledge/drafts?limit=&offset=
200 {"drafts":[{"path","area","title","description","modified"}],"limit":100,"offset":0,"as_of":"…"}
GET /api/knowledge/areas
200 {"areas":[{"area":"Areas/Health","description","pages":4,"last_change","named_by_fold":true}],"as_of":"…"}
400 date (not a calendar day, YYYY-MM-DD) / limit / offset — by name
403 any principal that is not the owner — the console's uniform `not granted`,
    decided in the route before any SQL runs
503 the named query is not loaded, naming its file
```

Screen 10's three asks (design-build-plan §2.10), each a named query run by
`packages/queries` and each `expose: route`: `seed/queries/knowledge_fold_latest.yaml`,
`knowledge_drafts.yaml`, `knowledge_areas.yaml`. No migration — `knowledge_files`
and `knowledge_links` already hold every column.

**Owner-only, at the route.** server.ts's management gate already answers an
agent bearer and the capture owner token `403` across `/api/knowledge/*`; these
three also refuse every principal that is not the owner **themselves**
(`may(…, {kind: "console", door: "console_management"})`), so a gate widened
by mistake still cannot hand one a draft. A draft is never served to an agent
by any door (screen 10 §3.2, C66); the fold's links and the areas name `Me/`
and the owner's own journal, which only the owner is shown (#255). **Agents
use `/mcp`** — and there, as at the generic `/api/q/<name>`, all three names
are the unknown-query refusal (`queries_list` does not list them), while
`knowledge_read`/`_search`/`_list` never return a draft, even inside a granted
folder. The owner is still served them at `/api/q/<name>` (P4).

| Route | What it is |
| --- | --- |
| `fold` | the newest `Journal/Fold/YYYY-MM-DD.md` — newest by the date in its **name**, so a fold caught up late does not jump ahead — on or before `date` when given; never a draft or conflicted fold. `links` are its outgoing edges: a link to a draft or conflict is dropped, one to a path no note lives at yet is `resolved: false`, and a target that is not knowledge (`.metistry/`, `Artifacts/`) is dropped by `canSee` even for the owner. The fold's **bytes** are `GET /api/knowledge/page` on its `path` — a note body is not derived state |
| `drafts` | every note whose frontmatter says `status: draft` — never a `conflict`, which the indexer also flags but which is settled by `POST /api/knowledge/conflicts/resolve` (T2-10), not Approve/Revise/Decline. Ordered by path in byte order; `limit` 100 by default, ceiling 500; no `total` |
| `areas` | one row per area, derived exactly as `pages` derives `area` (so `?area=<area>` on the page list opens it): `description` is its `<area>/README.md`'s frontmatter description (`null` until something writes one — C68), `pages` the settled count (never drafts or conflicts), `last_change` their newest `mtime`, `named_by_fold` whether the newest fold links into it — provenance, never a score (P5). A folder that is not knowledge is dropped by core's predicate. Unpaged: a vault has tens of areas |

#### `GET /api/knowledge/history`, `GET /api/knowledge/version` — a note's past (`user` principal; T10-4)

```
GET /api/knowledge/history?path=Areas/Health/sleep.md&limit=
200 {"path":"Areas/Health/sleep.md",
     "commits":[{"sha","path","change","subject","author","source","runs":[…],"turns":[…],"at"}],
     "limit":50,"as_of":"…"}
GET /api/knowledge/version?path=Areas/Health/sleep.md&sha=4c1d2e3f
200 {"path","sha","subject","author","source","runs","turns","at",
     "content","sha256","bytes","as_of"}
400 a missing path / a limit outside 1–200 / a sha that is not a commit id — by name;
    or, for the owner, a path this door does not serve (the classification, as on `page`)
403 any principal that is not the owner — the console's uniform `not granted`,
    decided in the route before the bridge is asked
404 (version) no such commit, a commit not on this vault's branch, or the file absent at it
503 no vault bridge configured
```

Git is the record (invariant 1), and the console holds no git (D5): both come
from the reconciler's bridge, read with the console's bearer —
`GET /vault/log?path=` and `GET /vault/show` (`docs/ops/reconciler.md`).

**`history`** is the file's commits, newest first, followed across renames
(`git log --follow`). Each commit names the file **as it was called then**
(`path`) — across a rename that is the old name, and it is the name to pass
to `version` for that commit — and what the commit did to it (`change`:
`added`, `modified`, `deleted`, `renamed`, `copied`, `type_changed`; `null` on
a merge that carried it unchanged). `at` is the author date in UTC. `author`
is git's author name (`Metistry <principal>` for the reconciler's own
commits); `source`, `runs` and `turns` are the commit's `Brain-Source:`,
`Metistry-Run:` and `Metistry-Turn:` trailers (§2.21, T10-1) — **provenance
to show, never authority**, and a trailer value that is not the shape the
committer writes is dropped rather than passed on. A commit whose name for
the file was never a note (moved in from `.metistry/`) is dropped by `canSee`.
`limit` defaults to 50; the ceiling is the bridge's 200. No cursor: a note's
history is short, and a longer look is a larger `limit`.

**`version`** is the file's bytes at one commit, as `content` (UTF-8, like
`page`) with their `sha256` and `bytes`, and the commit's own fields. `sha` is
a **commit id and nothing else** — 7 to 64 hex characters, abbreviated or
full; the answer carries the full one. A ref, `HEAD~1`, a `rev:path` or an
option-shaped string is `400` here and again at the bridge, so nothing but
hex ever reaches git's argv. A commit that exists but is not on this branch's
history (fetched and not yet integrated) is `404`, as is a file absent at
that commit — including the commit that deleted it; ask for the one before.

**Notes only, the owner only.** Both apply `page`'s rule to the path —
`.metistry/`, `Artifacts/`, the root `CLAUDE.md` are classified for the owner
and served to nobody — before the bridge is ever asked, for the owner too:
the history of the machinery is the CLI's, with the owner's hand on it. And
both are the owner's **alone**, like `fold`/`drafts`/`areas`: a note's
history holds every version of it, including what an edit since took out, so
no agent reads it — whatever its grants, and even through a gate widened by
mistake. Restore (T10-5) and roll back (T10-6) build on these two; neither
changes anything.

**The bridge does not merely trust that gate (ruled 2026-09-27, X-6).**
`GET /vault/show` has always refused a protected or non-vault path (`403`)
whichever bearer asks, bytes included. `GET /vault/log` did not — a
`.metistry/` path, or a whole-tree commit that happened to touch one, reached
either bearer with its subject and trailers, even though this door never
sent it one. `vault.log()` is now narrowed the same way `show` is, but to the
**owner bearer** rather than to nobody: for every other caller — the
console's bearer, which is what fronts an agent here — a `.metistry/` (or
root `CLAUDE.md`/`README.md`) `path` is `403 forbidden`, and a whole-tree
read drops any commit that touched one rather than redacting it.
`Artifacts/` is deliberately left out of this one: the artifacts service
resolves a version's commit through this same `GET /vault/log`, with the
console's own (non-owner) bearer, and was never part of the confidentiality
boundary `.metistry/` is. This is defence in depth, not a second copy of the
console's rule — `history`/`version` never send a protected `path` in the
first place, so the practical effect is on a caller that reaches the bridge
some other way (`apps/reconciler/src/vault.ts`,
`apps/reconciler/test/history.test.ts`).

#### `POST /api/knowledge/restore` — put a note back as it was (`user` principal; T10-5; reach `local`, ruling 7)

```
POST /api/knowledge/restore   {"path":"Areas/Health/sleep.md","sha":"4c1d2e3f","seen_sha":"<sha256 as rendered>" | ""}
202 {"ok":true,"proposal_id":"61","raised":true,"path","sha":"<full commit id>","date",
     "proposal":{"id","ts","kind":"improvement","source_agent":"console","trust":"user",
                 "payload":{"title","summary","body":{"kind":"before_after","heading","before":{"label","text"},"after":{"label","text"}},
                            "restore":{"path","sha","date","base_sha256","version_sha256"}},
                 "decision":"pending",…,"request":{…},"subject":null}}
409 {"error":{"code":"conflict",…},"reason":"stale","file":{"path","sha256","bytes"} | null}
400 a missing path / a sha that is not a commit id / a seen_sha that is not a sha256 or "" — by name;
    the file is already that version; or, for the owner, a path this door does not serve (the classification)
403 local_only for a passkey session (the owner's too, §2.3); forbidden for the capture token and an agent
404 no such commit, a commit not on this vault's branch, or the file absent at it
503 no vault bridge configured
```

**It never writes.** It raises **one** Needs You request — an *improvement*,
drawn as a before and after: the note as it is now, and the note at `sha` —
and answers `202` with the request as `GET /api/proposals` serves it. Only
**Approve** (`POST /api/proposals/:id`, `allow`) restores: it writes the
version's bytes back **as `user`, as a new commit** — *Restore <path> to
<date>* — so the history keeps every version, including the one it replaced.
Nothing is reset, checked out or rewritten, and the console holds no git to do
it with. The answer carries `applied` and `restored: {path, sha, sha256}`, and
the row keeps `payload.restored`. Revise and Decline write nothing.

**Stale, twice.** `seen_sha` is the file's **content hash as the client
rendered it** — the `sha256` `GET /api/knowledge/page` serves — or `""` for a
note that is not in the vault now (restoring a deleted note). A file that is
not that is `409 stale` with the file as it stands (`file: null` when it is
gone), and nothing is raised. Approve checks again: the note must still be the
"before" the request showed, and the version must still hash to the "after";
the write is a compare-and-swap on the "before". A note edited meanwhile is
`409 stale` there too — nothing written, the request still waiting with the
reason on it (C45); Decline it and restore again from the note as it is.

**One request per note and commit.** The request is a mirror (T1-8) whose
`source` is `{kind: "metistry", external_ref: "restore:<path>@<sha>"}`: asking
twice hands back the request already waiting (`raised: false`), and one raised
against a file that has changed since leaves the queue as
`resolved_at_source` and is replaced. Knowledge shows a page's request inline
by its `payload.restore.path` and answers it at the same door — answering it
there answers it in Needs You (screen 10 §3.1). Like every mirror, it does not
expire at 14 days.

**Notes only, the local owner only — at the tool.** Reach `local` (§2.1, §2.3
wins over §2.1's earlier "owner" draw — ruling 7, 2026-09-27): the owner on
THIS Mac alone, by the local owner token, so restore is not reachable from
the phone; a passkey session is `403 local_only` before the route runs at
all, the capture token and every agent bearer meet their own uniform
`forbidden` earlier still. The path must be one `page` serves; `.metistry/`,
`Artifacts/` and the root instructions are refused here for the owner too —
configuration is rolled back with the CLI's owner caller class (T10-6, M18).
And Approve restores only a request
**this console raised** (`source_agent: console`, stamped server-side) whose
`source` names the same path and commit: a restore-shaped payload on any other
row restores nothing and is refused, never read as a prompt improvement. No
agent principal can restore: no tool exposes it, and neither door admits one.

### The named queries — `GET /api/q/:name`

#### `GET /api/q/<name>` — the generic door onto the named queries

```
GET /api/q/open_work?limit=5
200 {"rows":[…],"as_of":"…"}
400 a param this query does not declare, or one of the wrong type
404 no such query — OR, for a credential that is not the owner, one the
    manifest keeps off this door (indistinguishable)
```

Invariant 3's read path, addressable by name: the YAML in `seed/queries/` plus
the instance's own `queries/` overlay (D4), params from the query string,
`{rows, as_of}` back. The panels and the Mac app read everything this way
(`docs/ops/board.md`, `docs/ops/threads.md`), which is what keeps a dashboard
from growing SQL of its own.

**`expose:` — which door a query is served through.** A manifest may carry one
optional field beside `name`, `description`, `params`, `sql` and `cache_ttl`:

| value | meaning |
| --- | --- |
| `generic` | the default, and what every manifest without the field means. Served here, by name |
| `route` | this query has an **endpoint of its own**, and that endpoint does something this door cannot. Asking for it here is the `404` an unknown name gets — **unless you are the owner**, who is served it |

The field exists because of `knowledge_pages` and `knowledge_page_links`.
It has since spread to every query whose rows carry a vault path beside a line
of the owner's own notes — `day_work`, the `vault_*` lookups, and `board`
(T1-2: `blocked_by_task` is the text of the todo a card waits on). For those
there may be no endpoint of their own at all: the owner reads `board` here,
where the panel and the Mac app always have, and every other credential gets
the unknown-query answer. `board_projects`, the counts, stays `generic`.
`GET /api/knowledge/pages` and `GET /api/knowledge/links` filter every row
they return through the caller's scope (`canSee` — for a link, at both ends);
the
generic door does not, cannot — it has no principal scope and no reason to
believe a column called `path` is a vault path — and would have handed the
whole index, and the whole graph, to anyone who could reach `/api/q/<name>`,
which includes the capture owner token that is `403` on `/api/knowledge/*`. One endpoint per
necessary operation (ruled 2026-09-19): the filter is not optional if there is
no second way in.

**The owner is served it.** Ruled 2026-09-19 ("the owner should always have
access to everything") and shipped as P4: the filter `expose: route`
protects is a filter on what an AGENT may see of the vault, and the owner's
scope IS the whole vault — so the scoped route and this one return them the
same rows, and the refusal was only ever a second door to remember. The
**capture owner token is not the owner** (the plan's tier 0, capture-only,
and `403` on `/api/knowledge/*`): for it, and for every other credential,
this door is unchanged byte for byte. That is the one credential the rule
was really about, and it is still refused.

Two properties worth stating:

- **The refusal is the unknown-query refusal, byte for byte** — same code,
  same status, same absent message, and no `reason` on the wire. A
  distinguishable `403` would make this door an oracle for which route-only
  queries a build has.
- **It is declared on the manifest, not in the server** (invariant 5). The
  server asks the store (`QueryStore.exposure(name)`), so a list of names
  inside the console cannot drift from the files, and an instance overlaying
  `knowledge_pages.yaml` keeps the property by keeping the line — dropping it
  re-opens the unscoped door, which is a change you make in your own vault
  with your eyes open. `apps/console/test/seed-queries.test.ts` pins the set
  of route-backed seed queries so that adding one is deliberate.

`expose` says nothing about *permission*: what a caller may reach is still
decided by the surface it calls (this door's principal gates, `mcp-brain`'s
`queries: true` grant for `queries_run`).

**It is honoured on both doors.** `queries_run` on the `/mcp` mount asks the
same `QueryStore.exposure(name)` and refuses a route-backed query with the
same unknown-query refusal, and `queries_list` does not name one
(`packages/mcp-brain/src/queries-tools.ts`). It had to: a `queries: true`
grant is a separate axis from the knowledge tier, so until 2026-09-19 an
agent at tier `none` — an agent `knowledge_search` will not tell a single
title — could page the entire vault index and the entire link graph through
`queries_run`, and a `tier: areas` agent could read the titles of every area
it was never granted. The ruling closed it: *"generally yes, I think all
queries including /mcp should be scoped and follow the same token based
enforcements."*

The scoped door that replaces it is `knowledge_list`, which runs the SAME two
named queries through the SAME filter — `canSeeUnder`, now lifted into
`packages/mcp-brain/src/knowledge.ts` so that this file's `canSee` and every
`knowledge_*` tool are one implementation rather than two that agree today.
Tier `index` lists titles anywhere in the index and reads nothing; tier
`areas` lists, reads and traverses links inside its prefixes, both ends of
every edge; tier `none` gets nothing (`docs/ops/assistant-tools.md`).

### Today and the vault's tasks

```
GET  /api/today?date=                        the day: vault tasks (Today's preset), work, the order, events, and the brief, standup and plan paths
GET  /api/vault-tasks?where=&order=&limit=&offset=   vault tasks by any filter (`compileTaskFilter`) — All, and its saved views
PUT  /api/today/order                        {date, task_keys}: the owner's order for the day; a key outside the day is 400
POST /api/today/add                          {key, date?}: Add to Today — capture a work item's task line onto the day; date must be the owner's current one
POST /api/vault-tasks/:task_key/check        {checked, seen_text, path?}   Idempotency-Key   409 stale, with the current line
POST /api/vault-tasks/:task_key/schedule     {do | someday, seen_text, path?}   Idempotency-Key   409 stale, with the current line
POST /api/vault-tasks/:task_key/link         {ref, seen_text, path?}   Idempotency-Key   409 stale, with the current line
POST /api/today/close                        {day, line?}   409 stale · 409 section_missing, with the request's id
```

**Tick and Defer** (§2.11) write through the vault bridge as `user`, with the
file's hash: Tick writes exactly `[x]` and `done <date>` (Undo is the same door,
the reverse); Defer writes `do <date>` or `someday` through `formatTaskLine`.
Nothing else on the line changes, and a line whose text is not the `seen_text`
the client rendered is refused `409 stale` with the line as it stands — which
is what makes both replayable from the PWA's offline outbox with an
`Idempotency-Key`. A `:task_key` under `.metistry/` is refused. **Close the
Day** writes the daily note's section through the reconciler's section
operation as `user`, then enqueues `plan-tomorrow`; markers missing is a `note`
request and no write (§2.13).

#### Tick — `POST /api/vault-tasks/:task_key/check` (T2-4)

```
POST /api/vault-tasks/mt-7f3k2a/check
Idempotency-Key: tick-0928-0001                    (optional; client-minted, ≤200 chars)
{"checked": true, "seen_text": "Send Dana the fixture format"}

200 {"ok": true,
     "line": "- [x] Send Dana the fixture format due 2026-09-28 done 2026-09-28 ^mt-7f3k2a",
     "task": {"path", "task_key", "anchor", "line_no", "text", "checked", "done_on"}}
409 {"error": {"code": "conflict", …}, "reason": "stale", "line": "<as it stands>" | null, "task": {…} | null}
```

- **The key** is the row's `task_key` exactly as `GET /api/today` returns it:
  an anchor (`mt-…`) or a hash key (`h:<sha256>:<n>`, percent-encode the
  colons or not). Anything else is `400`. The note it names comes from the
  named query `vault_task_by_key` (`expose: route`); the line is then found
  **in the note**, by the same key the reconciler's walk gives it, so a line
  that moved since the last walk is still found. Where one key names lines in
  two notes (the same sentence typed twice, or an anchor copy-pasted), the
  answer is `400` naming both paths, and `path` in the body says which.
- **`seen_text`** is the row's `text` — the line minus its fields and anchor.
  If the line is gone, its text differs, its box already says what `checked`
  asks for, or it was dropped (`[-]`) since the client drew it, the answer is
  `409 stale` carrying the line as it stands (`line: null` when it is gone),
  and nothing is written. The same `409` answers a note that changed between
  the door's read and its write (the write carries the read's hash).
- **The write** is core's `setTaskChecked`: the box to `x` (or a space) and
  one `done <today>` clause at the end of the trailing run, before the
  anchor — or, for Undo, that clause removed. The door re-parses its own
  output and refuses (`400`, nothing written) a line where anything but
  `checked` and `done_on` would read differently — a Tasks-plugin `✅` it did
  not write, a recurrence rule line (never itself a task). The date is today
  in `METISTRY_TZ`. The commit is `user`'s: `complete "<text>"` or
  `reopen "<text>"`.
- **Refused before anything is read:** a row whose note is not a knowledge
  note — `.metistry/`, any dot-directory, `Artifacts/`, the root `CLAUDE.md`
  or `README.md` — is `403`. An agent bearer and the capture owner token get
  the uniform `403` of the management gate; no credential, the uniform `401`.
- **`Idempotency-Key`** replays the first **successful** answer, with
  `Idempotency-Replayed: true`, for 24 hours; a second attempt still in
  flight waits for the first. The same key with a different body is `400`.
  Keys live in the console's memory, not the database: the note is the
  record, so after a console restart a replay is judged against the note —
  `409 stale` with the line, which already shows the first attempt's tick.
  An outbox repaints from either answer the same way. Refusals are never
  remembered; a retried refusal is judged again.
- **`503`** when the deployment has no vault bridge
  (`METISTRY_RECONCILER_URL`).

#### Defer — `POST /api/vault-tasks/:task_key/schedule` (T2-5)

```
POST /api/vault-tasks/mt-7f3k2a/schedule
Idempotency-Key: defer-0928-0001                   (optional; client-minted, ≤200 chars)
{"do": "2026-09-30", "seen_text": "Send Dana the fixture format"}
{"someday": true, "seen_text": "Send Dana the fixture format"}

200 {"ok": true,
     "line": "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s do 2026-09-30 ^mt-7f3k2a",
     "task": {"path", "task_key", "anchor", "line_no", "text", "checked", "due", "scheduled_for", "someday"}}
409 {"error": {"code": "conflict", …}, "reason": "stale", "line": "<as it stands>" | null, "task": {…} | null}
```

Everything *Tick* says about the key, `path`, `seen_text`, the refusals before
any read, the read's hash, `Idempotency-Key` and `503` holds here word for
word. What differs is the one edit, core's `setTaskScheduled`:

- **The body** is exactly one of `do` — a calendar day, `YYYY-MM-DD`; the
  client resolves *Tomorrow* or *Next Week* in the owner's zone before it
  sends — or `someday: true`. Both, neither, or anything else is `400`.
- **`do`** writes `do <date>`: in place of the line's `do` clause when it has
  one, else at the end of the trailing run, before the anchor. A `someday`
  token on the line goes, because a day was chosen. **`someday`** writes the
  bare word `someday` at the end of the run and takes every `do` clause off.
  `due` is never moved — it is a date the owner set. Commit: `defer "<text>"
  to <date>` or `… to someday`, as `user`.
- **English, never a glyph** (K6). The tokens are `formatTaskLine`'s own
  spelling; the door has no code path that writes a Tasks-plugin `⏳` or a
  `#someday` tag. A line whose day is already a `⏳`/`⌛` or a Dataview
  `[scheduled:: …]` is refused `400` and nothing is written: the door does
  not rewrite someone else's field, and will not write a second day beside
  it. Defer that one in the note.
- **Stale** (`409`, with the line): the text changed, the line is gone, or
  since the client drew it the line was ticked, dropped (`[-]`), or already
  deferred exactly so.
- **Refused** (`400`, nothing written): a recurrence rule line (defer the
  day's instance), and any line that would not re-parse as the same task with
  only its day changed.
- **One row at a time.** There is no bulk defer and no Skip here: Skip is
  bulk-only and belongs to Needs You (K2).
- **Finding them again:** the filter vocabulary's `someday` flag
  (`where: "someday"`) — `vault_tasks.someday`, written by the walk.

#### Link — `POST /api/vault-tasks/:task_key/link` (T4-25)

```
POST /api/vault-tasks/mt-7f3k2a/link
Idempotency-Key: link-0928-0001                    (optional; client-minted, ≤200 chars)
{"ref": "linear:MET-42", "seen_text": "Send Dana the fixture format"}

200 {"ok": true,
     "line": "- [ ] Send Dana the fixture format due 2026-09-28 linear:MET-42 ^mt-7f3k2a",
     "task": {"path", "task_key", "anchor", "line_no", "text", "checked", "done_on", "ext_refs"}}
409 {"error": {"code": "conflict", …}, "reason": "stale", "line": "<as it stands>" | null, "task": {…} | null}
```

The second half of *Send to Linear*: the tracker door files the issue
(`POST /api/trackers/:connection/issues`, below) and answers its `ref`; this
door writes it on the line. Everything *Tick* says about the key, `path`,
`seen_text`, the refusals before any read, the read's hash, `Idempotency-Key`
and `503` holds here word for word. It never calls the tracker. What differs
is the one edit, core's `setTaskRef`:

- **`ref`** is `linear:<TEAM-123>` or `gh:<owner>/<repo>#<n>` — exactly one;
  any other shape is `400`.
- **The write** adds the ref and one space at the end of the trailing run,
  before the anchor, and nothing else — the text, and so a hash key, is
  unchanged. Commit: `link "<text>" to <ref>`, as `user`.
- **Stale** (`409`, with the line): the text changed or the line is gone
  since the client drew it, or the line already carries this ref — or another
  of the same scheme (one issue per line, so a tick names one issue to close).
- **Refused** (`400`, nothing written): a recurrence rule line, and any line
  that would not re-parse as the same task with only the ref added.

#### Close the Day — `POST /api/today/close` (T2-8)

```
POST /api/today/close
{"day": "2026-09-28", "line": "Store interface frozen; recorder next."}

200 {"ok": true, "day": "2026-09-28", "path": "Journal/2026-09-28.md", "appended": false,
     "closed_at": "2026-09-28T21:14:03.000Z", "done": 6, "moved": {"2026-09-29": 3, "2026-10-02": 1, "someday": 1},
     "line": "Store interface frozen; recorder next.",
     "plan": {"enqueued": true, "routine": "plan-tomorrow"}}
409 {"error": {"code": "section_missing", …}, "reason": "unpaired", "at_line": 14,
     "day", "path", "request_id": 4121, "plan": {"enqueued": true, "routine": "plan-tomorrow"}}
409 {"error": {"code": "conflict", …}, "reason": "stale", "today": "2026-09-29"}
404 {"error": {"code": "not_found", …}, "day", "path", "plan": {…}}
```

- **What it writes.** The daily note's `metistry:day` section, through the
  reconciler's section operation (`POST /vault/section`) as `user` — the
  only way into that region, and a door that cannot touch a byte outside it.
  The body is written whole on every close, so closing again replaces it:
  `Closed at 5:14 PM · 6 done · 5 moved`, the owner's line
  (`**For tomorrow:** …`), then **Done** and **Moved** (`- <text> → <day or
  someday> · [[<note>]]`). Plain bullets, never a checkbox, so the walk finds
  no task in it. A note with no section yet gets `## Today · Metistry` and the
  markers appended at its end (`appended: true`); the seeded
  `Templates/Daily.md` places them.
- **Where the facts come from.** The named query `day_close`
  (`expose: route`): **done** is every line the index saw ticked that day
  (`done_on`) plus the Tick door's own record of the day, so a tick made a
  moment before the close counts; the latest act per line wins (a tick then
  Undo is not done). **Moved** is the Defer door's record of the day and
  where it sent each line — a deferral typed by hand in Obsidian is the
  owner's own edit and is not reported back. The day is counted in
  `METISTRY_TZ`, as the doors stamp their dates. `done` and `moved` in the
  answer are the fold line's numbers.
- **Then `plan-tomorrow` is enqueued** with the day closed (`closedDay`) and
  the answer returns — the plan renders in the background, one pass at a
  time, recorded as a `routine_run` with `meta.trigger: "close"`. A close
  always renders tomorrow's plan, so closing twice renders it twice, and the
  11:00 PM run supersedes an early render (docs/ops/automation.md). Every
  other guard of the routine holds. `plan.enqueued: false`, with a
  `reason`, where the console has no `plan-tomorrow` loaded.
- **Markers missing** — deleted, doubled, one alone, quoted in a code block,
  the heading left without them — is `409 section_missing` with the scan's
  `reason` and line (`at_line`), and **nothing is written into the note**.
  One `note` request (stored kind `knowledge`, from `console`) says the
  section could not be found and shows what would have been written; closing
  again while it is still open points at the same `request_id`. The close
  still completes: the plan is enqueued. A client shows the request, never a
  success.
- **`day`** is the day Today was drawn for, and must be today in
  `METISTRY_TZ`: a page left open past midnight is `409 stale` with `today`,
  and nothing is written or enqueued. **`line`** is optional, one line, at
  most 500 characters, trimmed; empty or `null` is none.
- **No `Journal/<day>.md`** is `404`: the door never creates the owner's
  note (apply `Templates/Daily.md`, then close again). The plan is still
  enqueued. An owner's edit outside the section between the door's read and
  its write is read again once, then `409 stale`.
- **Who**: the owner — an agent bearer and the capture owner token get the
  management gate's uniform `403`, no credential the uniform `401`. Not an
  action: no proposal can close the day. **`503`** with no vault bridge
  (`METISTRY_RECONCILER_URL`).

#### Today — `GET /api/today`, `GET /api/vault-tasks`, `PUT /api/today/order` (T2-7)

```
GET /api/today?date=2026-09-28

200 {"date": "2026-09-28",
     "tasks":  [<vault_tasks_query row>, …],
     "work":   [<day_work row>, …],
     "order":  ["mt-7f3k2a", "work:214"],
     "events": [<day_events row>, …],
     "tracker_closed": [{"task_key": "mt-7f3k2a", "ref": "linear:MET-41", "connection": "linear",
                         "key": "MET-41", "state": "done" | "canceled", "url": "https://linear.app/…"}, …],
     "brief": "Journal/Brief/2026-09-28.md" | null,
     "standup": "Journal/Standup/2026-09-28.md" | null,
     "plan": "Journal/Plan/2026-09-28.md" | null,
     "as_of": "<ISO instant>"}

GET /api/vault-tasks?where=due%20%3C%3D%20today&order=priority,%20due&limit=50&offset=0

200 {"where": "due <= today", "rows": [<vault_tasks_query row>, …], "more": false, "as_of": "<ISO instant>"}
400 {"error": {"code": "invalid_request", "message": "<the parser's refusal, naming the token>"}}

PUT /api/today/order
{"date": "2026-09-28", "task_keys": ["mt-7f3k2a", "work:214"]}

200 {"ok": true, "date": "2026-09-28", "order": ["mt-7f3k2a", "work:214"]}
400 {"error": {"code": "invalid_request", "message": "this key is not on 2026-09-28: mt-zz99 — …"}, "outside": ["mt-zz99"]}
```

- **Every row comes from a named query**, each `expose: route` so this
  owner-only door is the only one onto it: `vault_tasks_query`, `day_work`,
  `today_order`, `day_events`, `tracker_closed`. Rows are those queries' rows unchanged — a
  task row is exactly what `GET /api/vault-tasks` returns, and carries
  `someday` and `row_flags`.
- **The day** is `date`, or — left out — today in `METISTRY_TZ` (never `TZ`;
  with no `METISTRY_TZ` set, today in UTC). The calendar is read in the same
  zone. A `date` that is not a calendar day is `400`; any other parameter is
  `400`.
- **Today's preset**, in the one `where:` language (compiled by
  `compileTaskFilter`, like every other task filter): the open lines owed on
  or before the day — `due <= <date> or do <= <date>`, so what is overdue or
  was planned for an earlier day carries forward — ordered `priority, due`;
  then the lines ticked on the day (`done = <date> and status = done`), so a
  line ticked a moment ago is still there after the next walk, struck. A
  `#someday` line leaves the open list even when it still has a `due`.
- **`work`** is `day_work` for the day with the flags `waiting_on_me`
  (an agent is waiting on a line of yours), `blocked` (only your hand leaves
  it), `due`, `overdue` and `closed` (closed on the day), joined by `or`.
- **`tracker_closed`** — *Done in Linear* (T4-26): each OPEN line of the
  day (not ticked, not dropped) whose `linear:<KEY>` names an issue the
  tracker closed — its `work` row closed as `completed` (`state: "done"`) or
  `canceled` — by the Linear sync or by Close in Linear. The client shows
  *Done in Linear* on that row with a one-click Tick, which is the Tick door
  as `user`. **Nothing writes the owner's note from the source**: the line
  stays open, and on the day, until the owner ticks it. `[]` when none.
- **`order`** is the owner's drag order (`today_order`): a `task_key` or
  `work:<id>` each. Only keys the day still holds are served — a key whose
  line moved off the day is dropped, and the next drag clears it. Rows not
  in the order follow, in the order served.
- **`brief`, `standup`, `plan`** are the paths of the day's machine-written
  files, each named for the day it is *for* (`Journal/Plan/<date>.md` is
  that day's plan, written the evening before); `null` when the file is not
  there yet — or when the deployment has no vault bridge to ask. Read them
  with `GET /api/knowledge/page`.
- **`GET /api/vault-tasks`** compiles `where` and `order` (both optional; at
  most 500 characters each) with `compileTaskFilter` against today in
  `METISTRY_TZ`, over the whole vault. A filter outside the grammar is `400`
  with the parser's own message, which names the token — nothing is guessed
  or passed through. `limit` is 1–500 (default 50); `more` says whether
  `offset + limit` has another page. **The saved views** of All are stored
  `where:` strings (`SAVED_TASK_VIEWS`, `apps/console/src/today-routes.ts`),
  each one run of `vault_tasks_query`:

  | View | `where:` |
  | --- | --- |
  | Slipping | `carried >= 3 or overdue or names_person` |
  | Owed | `names_person and not waiting` |
  | Waiting on Others | `waiting` |

  **The grammar's additions (ruling 14, X-14)** — each still compiles to
  fixed bind params, never to SQL text:
  - **`carried` with an operator is the carry count**: whole days the line
    has been carried past the day it was owed (`carried_days`, the Today
    chip's "carried 3 days"), `carried >= 3`, `carried <= 2`,
    `carried = 4`; a line that is not carried counts 0. Alone, `carried` is
    still the flag. `carried = 0` / `carried <= 0` is `400` pointing at
    `not carried`, and `carried >= 0` (every line) is `400` too. It sorts:
    `order=carried desc`.
  - **`names_person`** is a flag: the line names a person (`@Jim`,
    `@[[Jim Fallon]]`) who is not the owner — the rows `assigned_to_me`
    does not hold. This door passes no owner page, so here it is any line
    that names someone. With `waiting` it is owed *by* them; without, owed
    *to* them. Rows carry it in `row_flags`.
  - **`not <flag>`** negates any flag (`not waiting`, `not someday`) and
    joins like any clause. Only a flag: `not` before a field, `not not`, a
    bare `not`, an unknown word after it, or a flag with its own negation
    is `400` with the parser's message. `and` and `or` still never mix.
- **`PUT /api/today/order`** takes `{date, task_keys}` — the whole order for
  the day, and nothing else (another field is `400`). Each key is a task key
  or `work:<id>`, at most 1000, none twice. **Every key must be one
  `GET /api/today` serves for that date**; otherwise the answer is `400`
  naming the keys (`outside`, the first ten) and nothing is written. On
  success the day's order is replaced whole — keys left out lose their
  place — in one statement. `[]` clears the day. The same body twice stores
  the same order (idempotent by nature). The write is audited (`runs` kind
  `today_order`, the day and the count — never the keys).
- The index is up to one walk behind the notes
  (`METISTRY_RECONCILE_INTERVAL_SEC`), so a line added in Obsidian a moment
  ago is not yet on the day, and its key is refused until it is.

#### Add to Today — `POST /api/today/add` (X-12; ruling 11)

```
POST /api/today/add
{"key": "ENG-123"}

200 {"ok": true, "date": "2026-09-28", "id": 41, "path": "Inbox/linear-ENG-123.md",
     "sha256": "<hex>", "replayed": false, "line": "- [ ] ENG-123 · Renew the SSL cert do 2026-09-28 linear:ENG-123"}
400 {"error": {"code": "invalid_request", "message": "2026-09-29 is outside Today's window — …"}}
404 {"error": {"code": "not_found", "message": "ENG-123 is not an issue the Linear sync has seen"}}
```

Ruling 11 (2026-09-27, `docs/product/decisions-log.md`): Linear issues stay
in `work` and Needs You, not the Board (T4-24) — this door is the "follow-up"
route for *Add to Today*, the mirrored `task` request's primary answer
(`sends: {door: "today"}`; a Linear issue is the one kind of work item wired
today).

- **`key`** is the same key the mirrored Needs You request names
  (`payload.key`) — a Linear issue key, `TEAM-123`. The door calls T4-24's
  own service (`addIssueToToday`, `collectors/linear/today.ts`) unchanged: it
  captures `- [ ] <title> do <date> linear:<KEY>` into `Inbox/` through the
  capture service, with the title Linear's own as the sync recorded it —
  never text the caller sends — and never writes the owner's own notes.
  `404 not_found` names an issue the sync has not seen.
- **Idempotent by the issue, not a header.** A second Add to Today for the
  same key returns the FIRST capture (`replayed: true`, same `id`, `path`,
  `sha256` and `line`) and writes nothing — the inbox's own unique index
  decides even when two presses race, so no `Idempotency-Key` is needed.
- **`date`, left out, is the owner's current day** (`METISTRY_TZ`, never
  `TZ`, as `GET /api/today` reads it). Given, it must equal that day exactly
  — **an item added to a day outside Today's window is refused** `400`,
  naming the window — because Add to Today means today, not an arbitrary day
  a client might compute wrong; a future or past `date` cannot be captured
  through this door at all.

### Calendar and mail — through the connection that can

```
POST /api/meetings/:event_id/note                 {}   201 {ok, event_id, path, created: true} · 200 {…, created: false}
POST /api/calendar/events/:id/move                {start, end}                 200 {ok, preview: {event_id, title, from, to, attendees}, others, warning, confirm_token, expires_in_sec, moved: false}
                                                  {start, end, confirm_token}  200 {ok, moved: true, event_id, event, others, refreshing}
POST /api/calendar/invitations/:id/respond        T4-17 — through the connection's `rsvp` capability (CalDAV's: packages/connections `previewReply` / `respondToInvitation`, T4-13)
POST /api/mail/messages/:id/draft                 T4-17 — through the connection's `draft` capability; never sends mail
```

**Where the calendar comes from.** Every calendar source syncs into one table,
`calendar_events` (0034), under its own `connection` — the eventkit sync
(`collectors/eventkit-calendar`, every 5 minutes, today and the next two weeks,
connection `eventkit`) and an ICS feed (`collectors/ics-calendar`, T4-12, under
the connection's own name; `docs/ops/connections.md`, *ICS feeds*) and a CalDAV
account (`collectors/caldav-calendar`, T4-13, under the connection's own name,
the owner's answer included; *CalDAV*) now; Google later (T4-14). Today
reads a day of it through the route-only `day_events` query; this door reads
one event through `calendar_event`. A row is one **occurrence**: its
`event_id` is the source's key for that one meeting — for EventKit, the
event's identifier, plus the occurrence's original date when it recurs
(`<identifier>_20260928T133000Z`, or `_20260928` all-day) — so a Monday
standup's note is that Monday's, and moving a one-off meeting keeps its note.
Each attendee carries a name, an address (lowercased, as `people_emails`
stores it), the one People page that claims the address (`person`, or null —
never a guess) and whether it is the owner; the event carries the owner's own
answer (`self_status`). **The invite body never arrives**: the eventkit bridge
does not ask its helper for it and drops it if sent, and `calendar_events` has
no column for it — dial-in codes and confidential agendas never reach anything
an agent reads.

**The meeting note** (§2.11) — the owner's *Open notes*:

- **One note per `event_id`.** The first call renders the owner's
  `Templates/Meeting.md` (core's engine, `source: user`; the meeting's start is
  the render's *now*, so `{{ date }}` is the meeting's day; `{{ calendar }}`
  reads `day_events`) and writes it as `user` to
  `Journal/Meetings/<date>-<topic>.md` — the day in the owner's zone
  (`METISTRY_TZ`), the topic the title lowercased with every run of anything
  but letters and digits one `-`. The note's frontmatter gains `event_id:`,
  which is how the reconciler's walk links it (`vault_meeting_refs`). `201`,
  `created: true`. Commit: `open notes for "<title>"`, as `user`.
- **Every later call is `200` with the same path**, `created: false`. The
  index answers first (where two notes claim one event, the shortest path,
  then byte order — a copy is the original's name with a suffix); the walk
  may be minutes behind, so the door also serialises calls for one event,
  remembers the path it wrote, re-derives the same file name, believes a file
  there only when its own frontmatter names this event, and writes
  create-only — it never overwrites a note. A file of that name that is
  another note's pushes the new one to `-2`, `-3`, …
- **Refused, nothing written:** an id no calendar holds (`404` — the sync may
  not have read it yet); `Templates/Meeting.md` missing (`404`, the file
  named); a body with any field (`400` — the title, day and template are the
  calendar's and the vault's, never the request's); an id with surrounding
  space, a control character, or over 1024 characters (`400`); no vault
  bridge (`503`).
- **Owner only**, like Tick: an agent bearer and the capture owner token get
  the uniform `403`. Not an action — no proposal can open a note. The ledger
  row (`kind: meeting_note`) carries the id and the outcome, never the title
  or the path.

**Move a meeting** (`POST /api/calendar/events/:id/move`, T2-12; §2.11, B10,
D7). The id is the event's `event_id` exactly as `GET /api/today` serves it.
Two calls, as every destructive tool is:

- **Preview — `{start, end}`** (ISO 8601 instants). Nothing moves. `200`,
  `moved: false`, with `preview` — the event as the calendar holds it now:
  `event_id`, `title`, `from: {start, end}`, `to: {start, end}` (UTC, to the
  second) and `attendees` as Today spells them (`{name, email, person, self}`;
  an organizer the calendar does not list among them is added) — plus `others`
  (how many people besides the owner are in it), `warning` — one sentence
  naming them, or **`null` when the event is the owner's alone**, so a focus
  block moves without one — and a single-use `confirm_token` valid for
  `expires_in_sec` (300).
- **Confirm — `{start, end, confirm_token}`**, the same times. The event moves
  — this occurrence only, never the series — and the answer is `200` with the
  event as moved, `moved: true`, and `refreshing: true` when the calendar sync was started so
  Today shows the new time at once (otherwise the next pass, within five
  minutes, does).
- **The rule lives at the bridge** (packages/mcp-eventkit `POST /events/move`):
  a confirm for an event with anyone else in it — every participant not marked
  as the owner, a room included, and an organizer who is not the owner — is
  refused unless it carries the **owner-door token** in `Metistry-Owner-Door`.
  This door presents it, on a confirm only; the assistant reaches the bridge
  with the bearer alone and never holds it, so its own confirm of such a move
  is refused (`403`) whatever it was told. Others are counted again at the
  confirm, so a guest added since the preview counts too.
- **The token.** `METISTRY_OWNER_DOOR_TOKEN_EVENTKIT`, in the install's `.env`,
  read by the eventkit bridge and the console and handed to nothing else (the
  assistant's environment is an allowlist). Mint it with
  `metistry secrets mint METISTRY_OWNER_DOOR_TOKEN_EVENTKIT`, then restart
  eventkit and the console. The bridge refuses to start with it equal to its
  bearer. Unset, owner-only events still move and an event with others in it
  answers `503` naming the command.
- **Refused, nothing moved:** an id no calendar holds (`404`); an event from a
  source this console cannot move through — anything but the eventkit sync's
  (`503`; the client offers *Open in Calendar*); a read-only calendar
  (`400`); a body with any other field, times that are not instants,
  or an end not after the start (`400`); no calendar bridge, or one not
  answering (`503`). A spent, expired or mismatched `confirm_token`, or an
  event whose times, people or organizer changed since the preview, is `409`
  with `reason: "stale"` and, where the bridge read it, the `event` as it
  stands — preview again.
- **Owner only**, like Tick: an agent bearer and the capture owner token get
  the uniform `403`. Not an action — no proposal can move a meeting. The
  ledger row (`kind: meeting_move`, tool `preview` or `confirm`) carries the
  id, the outcome and the count of others — never the title, the people or
  the times. Never the invite body: neither the bridge nor the table carries
  one.

### Scheduled — routines and syncs

```
GET    /api/scheduled                                served — every routine and sync, with its schedule and last run
GET    /api/scheduled/routines/:name                 served — one routine and its history
GET    /api/scheduled/syncs/:name                    served — one sync and its history
PUT    /api/scheduled/routines/:name/schedule        served — {days, at, tz?} | {every}
POST   /api/scheduled/routines/:name/pause           served
POST   /api/scheduled/routines/:name/resume          served
POST   /api/scheduled/routines/:name/run             served — Run Now: the runner's tick for one component, under the budget preflight
DELETE /api/scheduled/routines/:name                 served — Reset to Default: deletes the owner's entry
PUT    /api/scheduled/routines/:name/assignment      served — reach local: the actor, the task and the per-run grants
POST   /api/scheduled/routines                       served — reach local: New Routine
PUT    /api/scheduled/syncs/:name                    served — cadence, pause, raise toggles
POST   /api/scheduled/syncs/:name/run                served
```

Everything recurring lives under Scheduled (§2.5), layered manifest → `Me/profile.md`
→ `.metistry/scheduled.yaml`, the last written only through these doors — the
third and last protected path the console writes, schema-validated, and never
a product manifest. **Timing is inside the boundary** (a phone may change it);
**what runs is not**: a routine's actor, its task and its per-run grants, and a
new routine, are `local`. The code is `apps/console/src/scheduled-routes.ts`;
the file's rules are `docs/ops/scheduled.md`.

#### The shapes (the `user` principal)

Every field that has layers is `{value, origin}`, `origin` one of `default` (the
manifest) · `profile` (`Me/profile.md`) · `yours` (`scheduled.yaml`) — core's
`FIELD_ORIGINS`; a client renders the label and never works the layer out.

```
GET /api/scheduled
200 {"routines":[Routine…], "syncs":[Sync…],
     "timezone":"America/New_York",            the profile's zone, else METISTRY_TZ, else null
     "problems":[{name, field, message, holds}],  entries that do not fit their manifest (checkScheduled)
     "errors":[],                              the file's own errors when it does not validate — then it is not applied
     "as_of":"…"}

Routine = {"name":"morning-brief", "kind":"routine",
           "source":"product" | "extension" | "assignment",   an assignment is a New Routine
           "title":"Morning Brief",
           "schedule":{"value":{"days":"working_days","at":["07:00"]},"origin":"default"},
           "paused":{"value":false,"origin":"default"},
           "config":{"<key>":{"value":…,"origin":…}},          every key the manifest declares
           "actor":null, "task":null, "grants":null,           a New Routine's assignment
           "days":{"value":["mon",…],"origin":"profile"},      a time of day's weekdays; null for an interval
           "time_zone":{"value":"America/New_York","origin":"profile"},
           "next_run":"2026-09-29T11:00:00.000Z" | null,       null while paused or held
           "next_refused":{"reason":"no_working_days","why":"…"} | null,
           "last_run":{"run_id","at","ok","outcome","cost_usd","error"} | null,
           "is_default":true,                                  no entry — the **default** tag
           "held":null | "why the runner does not run it",
           "describe":"working days at 07:00"}
Sync    = {"name":"github-state", "kind":"sync", "connection":"github" | null, "title":"GitHub",
           "every":{"value":"15m","origin":"default"}, "paused":…, "raise":{"<rule>":{"value":true,"origin":…}},
           "next_run", "next_refused", "last_run", "is_default", "held", "describe"}

GET /api/scheduled/routines/:name   200 {"routine":Routine, "history":[{…last_run, "steps", "trigger"}], "as_of"}
GET /api/scheduled/syncs/:name      200 {"sync":Sync, "history":[…], "as_of"}
                                    404 nothing by that name here, or it is the other kind (the message names its door)
```

History is the named query `routine_history` — the component's own
`routine_run` or `collector_run` rows, newest first, 50; `trigger` is `run_now`
for a run the owner asked for.

```
PUT    /api/scheduled/routines/:name/schedule   {days, at, tz?} | {every}     → 200 {"ok":true, "routine":Routine, "as_of"}
POST   /api/scheduled/routines/:name/pause      {}                           → 200, as above
POST   /api/scheduled/routines/:name/resume     {}                           → 200; the entry goes when nothing is left in it
DELETE /api/scheduled/routines/:name                                         → 200 {…, "reset":true|false}  false: it had no entry
PUT    /api/scheduled/routines/:name/assignment {actor, task, grants?:{read}, schedule, paused?}  (local) → 200
POST   /api/scheduled/routines                  {name, actor, task, grants?:{read}, schedule, paused?}  (local) → 201 {"ok":true, "routine":Routine, "as_of"}
PUT    /api/scheduled/syncs/:name               {every?, paused?, raise?:{rule: bool}}   null returns a field to its default → 200 {"ok":true, "sync":Sync, "as_of"}
```

- **Written once, as you, or not at all.** Each is one edit of the file as a
  YAML document — comments and every other entry stay — through the reconciler
  as `user`, compare-and-swapped on the bytes read (a concurrent edit is
  re-read and re-applied, three times). A change that changes nothing writes
  nothing, so each door is idempotent by its own identity.
- **Validated first.** The result must parse under the closed schema and fit
  the component (a change that would hold it is refused). `400` names the
  field; nothing is written. An invalid file is never rewritten: every write
  answers `400` until it is fixed.
- **Never a manifest.** A routine with a manifest has no assignment door: `PUT
  …/assignment` on one is `400`. A New Routine has no default: `DELETE` on one
  is `400` (pause it). Per-run grants are read-only: `grants.write` is `400`,
  naming the ruling. The actor must be a live **crew** (`GET /api/agents`,
  kind `crew`) — a New Routine's run is one crew run.
- **New Routine** (`POST /api/scheduled/routines`, T3-8): a `name` of its own —
  lowercase kebab-case, `400` otherwise; `409 conflict` when a routine or sync
  with a manifest has it, or the file already has an entry by that name (`PUT
  …/assignment` changes a New Routine). The rest is the assignment, validated as
  above. `201` with the routine as the listing shows it.
- **A sync's connection is never set here** (`connection` in the body is
  `400`), and a sync whose entry names no connection yet cannot be given one
  here either — `400`, saying so.
- `503 not_available` when this console has no runner wired in, or — for a
  write — cannot write the file (no vault bridge; no instance directory;
  `METISTRY_SCHEDULED_FILE` naming a file other than the instance's). The
  message names which.

```
POST /api/scheduled/routines/:name/run   {}
POST /api/scheduled/syncs/:name/run      {}
202 {"ok":true, "name", "run_id":"8830", "started":true, "refused":null}
200 {"ok":false, "name", "run_id":null, "started":false, "refused":{"reason":"paused"|"held"|"running"|"blocked", "message"}}
404 nothing by that name here, or it is the other kind
```

**Run Now** is the runner's tick for one component (`runNow`,
`apps/console/src/runner.ts`), answered before the run finishes: the owner's
pause and a held entry apply (it says why — Resume first), a run already going
is not doubled, and the preflight runs, budget included (`blocked`, with the
fix). It does not wait for the component to be due, and it does not honour
the failure streak — it is how a fix is checked. The row carries
`meta.trigger: "run_now"`. A New Routine's run enqueues one crew run for its
actor (`docs/ops/scheduled.md`, "New Routines"); on a console whose runner has
no crew queue it answers `held`, saying so.

### Connections, secrets, variables, recordings — read here, written by the CLI

```
GET /api/connections           served — status, reach, tools and modes, used by: names, never a value
GET /api/connections/:name     served — one connection, its file and its provider's unit
GET /api/secrets               served — names, hosts, grants, last used: never a value
GET /api/variables             served — name, value, read by, used in: never a secret
GET /api/recordings/:id        T8-4 — a recording's retention state
```

Every write here is a CLI verb with the owner caller class (M7, M13, M14 below):
hosts, commands, credentials and the offer switch are the boundary, and a
secret's value never crosses the API in either direction.

#### `GET /api/connections` — the Connections list (`user` principal)

```
GET /api/connections
200 {"connections":[{"name":"github",
                     "type":"mcp",
                     "provider":"custom",
                     "description":"GitHub's MCP server",
                     "status":"ok",
                     "issues":[],
                     "reach":{"class":"command","command":"npx",
                              "args":["-y","@modelcontextprotocol/server-github"],
                              "cwd":null,"env":["GITHUB_PERSONAL_ACCESS_TOKEN"],
                              "runs_on":"host"},
                     "secrets":["github_read"],
                     "variables":[],
                     "tools":[{"name":"create_issue","group":"changes","mode":"ask"},
                              {"name":"search_issues","group":"reads","mode":"on"}],
                     "offer_to_agents":false,
                     "used_by":[{"kind":"sync","name":"github-state"}]}],
     "as_of":"2026-09-28T13:05:00.000Z"}
503 no instance directory in this deployment (degrades: absent)
```

One row per file in the instance's `.metistry/connections/`, sorted by name
(plan §2.6; `packages/connections`' `describeConnections`, the rows
`metistry connections list --json` prints). `type` is what it is (`mcp`,
`calendar`, …) and `provider` the connection-type unit that reaches it, or
`custom`. `reach` is how Metistry reaches it — `http` (`url`, `auth` scheme,
header and query-parameter **names**, `timeout_s`), `command` (`command`,
`args`, `cwd`, environment-variable **names**, `runs_on`) or `path`. `tools`
is the owner's per-tool policy: each tool's `group` (`reads` · `changes` ·
`starts_agent`) and `mode` (`on` · `ask` · `off`, drawn *Allow · Ask First ·
Never*). `used_by` is what reads it today — the syncs in `scheduled.yaml` that
name it; agents reach a connection through the lazy pair on `/mcp`
(`docs/ops/connections.md`), and until they are lent one an empty list is the
true answer (*Nobody yet*).

**`status`** is one of doctor's words, and `issues` says why, one sentence each:

| `status` | Means |
| --- | --- |
| `ok` | the file validates against its provider's unit and the door would let it through |
| `absent` | something it needs is not here: its provider's connection type (not installed — the file is not deleted), a variable it uses, or a secret's item in **this instance's** Keychain (a presence probe; never a value) |
| `failed` | the file does not validate or breaks a rule (a key pasted where a name belongs, a secret in a URL or on a command line), or `secrets.yaml` does not grant a secret to `connection:<name>`, or does not list the host an HTTP connection sends it to — exactly what the egress door would refuse, said before any call |

**Names, never values, by construction.** A row is built field by field; it
carries header, query and environment **names** and never a header or
environment value, and a secret is a name. A file that broke a rule shows its
name, `status: "failed"` and `issues`, and **nothing it holds** — the rule may
be a key pasted into the wrong place, and a row that repeated the file would
repeat the key.

**Nothing here dials.** A GET that started a command or reached a server would
be a read with a side effect; whether a connection answers is `metistry
connections test <name>` and `metistry doctor` on the Mac. The last check or
call the console itself made (`runs` rows `connection_check` /
`connection_call`, which `connection.health` announces) joins the row when the
console makes calls (T4-8b). Every write — add, set, policy, remove — is
`metistry connections` on the Mac (M13, `docs/ops/cli.md`): a connection file
says where Metistry reaches and with which credential, which is the boundary,
so no route writes one (invariant 10).

#### `GET /api/connections/:name` — one connection (`user` principal)

```
GET /api/connections/linear
200 {"connection":{…the row above…,
                   "file":".metistry/connections/linear.yaml",
                   "provider_unit":{"name":"linear","origin":"product",
                                    "provides":"mcp","capabilities":[],
                                    "implementation":"native","sync":null,
                                    "tools":[{"name":"list_issues","group":"reads"}]}},
     "as_of":"2026-09-28T13:05:00.000Z"}
404 no such connection — no file of that name, or a name that cannot be one
503 no instance directory in this deployment (degrades: absent)
```

The row, plus `file` (instance-relative) and `provider_unit`: the
connection-type unit's name, whether it is the product's or the owner's
extension, what it provides, its capabilities, how it is implemented, the
sync that reads it, and the tools it declares with the group each keeps
(a connection may not relabel one). `null` for a `custom` connection, an
uninstalled provider, or a file that does not validate.

#### `GET /api/secrets` — the Secrets list (`user` principal)

```
GET /api/secrets
200 {"secrets":[{"name":"github_write",
                 "hosts":["api.github.com"],
                 "grants":[{"to":"connection:github","mode":"on"},
                           {"to":"agent:devin","mode":"ask"}],
                 "expires":null,
                 "present":true,
                 "last_used":"2026-09-28T13:00:02.000Z"}],
     "as_of":"2026-09-28T13:05:00.000Z"}
400 secrets.yaml does not validate — the message names the field
503 no instance directory in this deployment (degrades: absent)
```

One row per secret in the instance's `.metistry/secrets.yaml`, sorted by
name (plan §2.14): `hosts` is *Sent only to*; `grants` is *Who may use it*,
each `{to: "connection:<name>" | "agent:<id>", mode: "on" | "ask" | "off"}` —
a grantee not listed is Off; `expires` is where the service says the value
stops working, or null. `present` is whether **this instance's** Keychain
account holds an item for the name, and `null` where the console has no
Keychain to ask (a container, Linux, or no `instance_id`). `last_used` is the
newest run that filled the secret in (the `secret_last_used` named query over
`runs.meta.secrets`, which the egress fill stamps with names — never values),
or null for never.

**Never a value, by construction.** The file's schema is strict, so a
`secrets.yaml` that tries to carry one does not load (the 400); the console
is handed a presence probe — `security find-generic-password` without `-w`,
bound to its own `instance_id` — and nothing that can read an item's data;
and a row is built field by field. Every write is `metistry secrets
set|replace|remove|hosts|grant` on the Mac (M7, `docs/ops/cli.md`). The
Keychain account is the instance's own, so a second instance's console —
even with the same file — reports the first's secret absent.

#### `GET /api/variables` — the Variables list (`user` principal)

```
GET /api/variables
200 {"variables":[{"name":"team_name",
                   "value":"Platform",
                   "read_by":["agent:researcher","connection:github"],
                   "used_in":[".metistry/agents/example/researcher.md",
                              ".metistry/connections/github.yaml"]}],
     "as_of":"2026-09-28T13:05:00.000Z"}
400 variables.yaml does not validate — the message names the variable and the reason, never the value
503 no instance directory in this deployment (degrades: absent)
```

One row per variable in the instance's `.metistry/variables.yaml`, sorted by
name (plan §2.14). `used_in` is every file under `.metistry/` (`state/`
excluded) that references `{{ variable.<name> }}` — or, for a connection file,
lists it under `variables:` — instance-relative; `read_by` is who those files
stand for: `agent:<id>` for an agent definition, `connection:<name>` for a
connection.

**Never a secret, by construction.** Core's `parseVariablesFile` refuses a
key-shaped value (*Store as Secret*), a secret's name (`api_key`,
`github_token`), a value holding `{{ … }}` (so no `{{ secret.x }}` can ride in
one), and — ruling 2 — a schedule or a time, by name (`standup_time`,
`timezone`) or by value (`09:15`, a cron line, a time zone). It refuses at the
parse, so a hand-edited file carrying one does not load: the 400 names the
variable and the reason, the ledger row records only that it failed, and no
row of that file is served. Every write is `metistry variables set|unset` on
the Mac (M14, `docs/ops/cli.md`), which also refuses a value equal to one of
the instance's own secrets.

### Outbound doors through a connection

```
POST /api/github/pulls/:owner/:repo/:number/review                  T2-13 — 409 stale unless the head SHA is the one shown
POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply       T2-13 — the same guard
POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve     T2-13 — the same guard
POST /api/trackers/:connection/issues                               T4-25 — an issue from a task line; idempotent by task key; 409 stale when the line is linked
POST /api/trackers/:connection/issues/:key/complete                 {}   200 {ok, connection, key, ref, url, state, changed} · 403 tool_off
```

The tracker doors go through a `tracker` connection's capability (Linear
first); *Send to Linear* is two doors, one service each — create the issue,
then link it on the line with `POST /api/vault-tasks/:task_key/link`.

#### Send to Linear — `POST /api/trackers/:connection/issues` (T4-25)

```
POST /api/trackers/linear/issues
{"task_key": "mt-7f3k2a"}
{"task_key": "mt-7f3k2a", "title": "Send Dana the fixture format", "team": "MET", "path": "Journal/2026-09-28.md"}

201 {"ok": true, "connection": "linear", "key": "MET-42", "ref": "linear:MET-42", "url": "https://linear.app/…/issue/MET-42/…",
     "created": true, "title", "task_key", "path"}
200 — the same body with "created": false: this task's issue, filed before
400 {"error": {…}, "reason": "team_required" | "unknown_team", "teams": [{"key", "name"}]} — nothing filed; send one of those keys as team
404 — :connection is not the connection the Linear sync reads; no task has the key
403 — the task's note is not a knowledge note; the connection's provider does not declare `create`
409 {"error": {…}, "reason": "stale", "line", "task": {…, "ext_refs"}} — the line already carries a `linear:` ref; nothing filed
429 — Linear's rate limit;  503 — no instance or no Linear connection, no vault bridge, or Linear refused or could not be reached
```

- **The task** is named by its key exactly as `GET /api/today` returns it,
  and the line is read **in the note** (the vault bridge, as *Tick* reads
  it; `path` where a key names two notes). The issue's title is the line's
  text as it stands — or `title`, when the client lets the owner edit it —
  made one line and cut to Linear's 255 characters. Nothing else of the note
  leaves: no description, no path, no other field. This door writes nothing
  of the owner's; the client then calls the Link door with the answer's `ref`
  and `path`, and the line's `seen_text`.
- **Idempotent by task key**, with no state of its own: the issue is created
  with an id derived from the connection, the note and the task key
  (`trackerIssueId`), and that id is looked up first. A second press, a retry
  after a lost answer, or another client answers the issue already filed —
  `200`, `created: false`, no mutation sent. Two sends that race meet at
  Linear, which refuses the second id; the door looks it up and answers it.
  So a failed Link can always be retried from the start.
- **The team** is `team` (a key the owner's Linear user is in), or their only
  team. With several and none named, or a key that is not theirs, the answer
  is `400` with the teams to choose from, and nothing is filed.
- **The connection** is the one the Linear sync reads (a `.metistry/scheduled.yaml`
  `syncs.linear.connection`, or the one Linear connection), named in the path;
  its provider must declare the `create` capability. Every request goes
  through core's `guardedFetch` with the connection as the grantee: the key
  is filled at the door for `api.linear.app` only, never on a URL; no redirect
  is followed; everything that comes back is redacted. The audit row names the
  connection, the task key, the issue and the secret used — never the text.
- **Not an action.** No proposal can file an issue at any autonomy level; an
  agent bearer and the capture owner token get the management gate's uniform
  `403`.

#### Close in Linear — `POST /api/trackers/:connection/issues/:key/complete` (T4-26)

```
POST /api/trackers/linear/issues/MET-42/complete
{}

200 {"ok": true, "connection": "linear", "key": "MET-42", "ref": "linear:MET-42",
     "url": "https://linear.app/example/issue/MET-42", "state": "done", "changed": true}
403 {"error": {"code": "forbidden", "message": "Close in Linear is set to Never for linear — …"}, "reason": "tool_off"}
```

- **When a client calls it.** Ticking a task whose line carries `linear:<KEY>`
  (the Tick door, `POST /api/vault-tasks/:task_key/check`) offers *Close
  <KEY> in Linear*. The setting is the connection's tool mode for
  `complete_issue` — `GET /api/connections/:name`'s `tools` row, and unlisted
  means Ask First (the provider declares the tool; `metistry connections
  policy <name> complete_issue allow|ask|never` sets it):
  **Ask First** — the client offers it, and the owner's press is this call;
  **Allow** (*always*) — the client makes this call itself right after the
  tick, the second call; **Never** — the client does not offer it, and this
  door refuses `403` with `reason: "tool_off"` and sends nothing. The Tick
  door never calls Linear, and this door never writes the note.
- **The path names everything.** `:connection` is a connection's name (a
  `tracker` connection whose provider is `linear` and declares `complete`);
  `:key` is the issue's key as the line spells it (`TEAM-123`). The body is
  `{}` or empty — a field is `400`.
- **What leaves**, through the connection's egress door (the key filled for
  `api.linear.app` only, `Authorization: <API_KEY>`, no redirect followed):
  a read of the issue, then — only if it is still open — one fixed mutation
  moving it to its team's first `completed` workflow state (Linear's *Done*,
  unless the team reordered them). The issue is named by Linear's own id
  when the sync has seen it, else by its key.
- **Idempotent by nature.** An issue Linear already has completed — or
  canceled — is answered as it stands, `changed: false`, and only the read
  is sent. `state` is `done`, or `canceled` for one Linear had canceled.
- **What it writes** is Postgres: the issue's `work` row closes
  (`meta.closed_reason: completed`, as the sync would record it) and its
  `task` request resolves at source. Never a vault file. Audited as `runs`
  kind `tracker`, tool `complete_issue`: the connection, the key and the
  secret's name — never its value.
- **Refusals**, each before anything changes: `400` a key that is not one or
  a body with fields; `404` no connection by that name, one that is not a
  Linear tracker, or an issue Linear does not have (`reason: not_found`);
  `403` the connection's provider cannot `complete` (`no_capability`) or the
  owner set Never (`tool_off`); `503` the connection cannot be opened or its
  key is not delivered (`connection_failed` — `metistry secrets sync --to
  env`, then restart the console), Linear refused the key or failed
  (`linear`), or no instance directory in this deployment; `429` Linear's
  rate limit. An agent bearer and the capture owner token get the uniform
  `403`; no credential, `401`.

#### Pull requests

```
POST /api/github/pulls/:owner/:repo/:number/review                {event: approve|request_changes|comment, body?, head_sha}
     201 {ok, review_id, url, head_sha}
POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply     {body, head_sha}
     201 {ok, comment_id, thread_id, url}
POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve   {head_sha}
     200 {ok, thread_id, resolved}
400 — no head_sha, or not the full 40-character SHA; an event outside the three; Request Changes, a comment or a reply without words; a field the door does not take
404 — a thread that is not on this pull request (or none this token can see)
409 {error, reason: "stale", pull: {repo, number, head_sha, state}} — the PR's head is not the one shown, or it is no longer open; nothing was posted
503 — no github_write for this console, or its Sent only to list does not name api.github.com; GitHub unreachable or refusing the token
```

A pull request request's answers (§2.12: Approve, Request Changes, Reply) are
not decisions on the request row — `POST /api/proposals/:id` refuses them —
they are these doors, which post to GitHub **as the owner** through the one
client holding the owner's `github_write` secret (§2.11, T2-13). That client
is handed to these doors alone: never to the MCP mount, never to a sync (the
GitHub sync reads with its own read-only token and can send nothing but GETs
and GraphQL queries). `github_write` is delivered to the console by
`metistry secrets sync --to env` when `secrets.yaml` names it, and is sent
only to `api.github.com`, only while its *Sent only to* list says so
(`docs/ops/cli.md`).

**The head SHA shown must match.** `head_sha` is the request's
`payload.head_sha` — the head the sync read when it raised the request, the
one the card's diff is of — and it is required. Each door reads the PR (a
thread door, the thread's PR) from GitHub itself before it posts; a head that
is not the one shown, or a PR no longer open, is `409 stale` with the PR as it
stands, and nothing is posted. A review is also pinned to that commit
(`commit_id`), so GitHub refuses it if the PR moves between the check and the
post. A thread id is the node id the request's `payload.threads[].id` carries
(`PRRT_…`), and must be a thread of the PR in the path.

**What a landed review settles.** Approve stores `allow` on the PR's waiting
request, Request Changes `accept_with_changes` with the owner's words as
`feedback`, and both record `payload.review {id, url, event, head_sha, at}` —
the GitHub sync does not ask again for that head, and asks again when the PR
is pushed. A comment, a reply or a resolve posts and leaves the request
waiting. The request also resolves at its source (`resolved_at_source`) when
the review lands on GitHub another way, the PR goes back to draft, or it
closes — with a receipt saying which (`payload.cleared.what`: *You approved it
on GitHub*, *Back to draft on GitHub*, *Pushed again on GitHub — the new head
is a new request*, *Merged on GitHub*, *Closed on GitHub*; §*Mirrors* above).
An agent's `requests_create` kind `pull_request` for the same PR is the same
card: whichever asked second is in `payload.also_asked`. A post GitHub
refused, or one that could not be sent, leaves the
request pending with `payload.error {code, message, decision, door:
"pr_review", action, at}` (C45); a stale answer writes nothing on the row.

GitHub does not let an account approve its own pull request: a PR an agent
opened under the owner's account is answered `400` with GitHub's words, and
the request keeps waiting with them.

**An issue assigned to the owner** (T4-23, R7) — with the GitHub sync's
*An issue is assigned to you* on (`syncs.github-state.raise.assigned`, the
default) — is one `task` request (`source {kind: "github", external_ref:
"gh:<owner>/<repo>#<n>", person: <author>}`, `payload {title, body (an
excerpt), event: "github_assigned", repo, number, url, author}`), raised once
per assignment: one the owner answered is not asked again while it stays
assigned. It clears at its source when the issue is closed (*Closed on
GitHub*) or given to someone else (*Assigned to someone else on GitHub*).

### Prose feedback

```
POST   /api/prose/:id/feedback    {rating: 1 | -1, note?}   200 {"ok":true,"feedback":{rating,note,ts}}
DELETE /api/prose/:id/feedback                              200 {"ok":true,"feedback":null}
404 — :id is not a runs row;  400 — a rating that is not 1 or -1, a note that is not a string
```

A 👍/👎 on any piece of generated prose that is not a chat reply — a meeting
briefing, Next Up's one line, a revision explanation (B7 of
`today-hub-requests.md`, C33 open). `:id` is a `runs.id`: the one id already
stable wherever prose is produced (every model turn logs one `runs` row,
`0001_init.sql`), so this needed no second id-minting scheme. An upsert on
that id, exactly like a reply's (`prose_feedback`, migration `0031`,
`docs/ops/reply-feedback.md`'s pattern applied to a sibling table) — one
judgement per `runs` row, revisable, deletable. A reply's own rating is
unchanged: `POST /api/messages/:id/feedback` still keys on
`outbound_messages.id` and stays the chat-specific route.

### Live changes — `GET /api/events`

```
GET /api/events                       Last-Event-ID: 1790000000000123   (optional)
200 content-type: text/event-stream; charset=utf-8
retry: 3000

id: 1790000000000124
event: work.changed
data: {"work_id":214}

: heartbeat
401 {"error":{"code":"unauthenticated",…}}        no credential
403 {"error":{"code":"forbidden","message":"not granted"}}   an agent bearer, the capture token
429 {"error":{"code":"rate_limited",…}}           METISTRY_EVENTS_MAX_STREAMS streams already open
503 {"error":{"code":"not_available",…}}          no events hub in this deployment
```

**Server-Sent Events, at reach `owner`**: typed events carrying **ids, never
bodies**, so a client learns *what* changed and refetches it through the route
that already enforces who may read it. The stream therefore opens no new read
path (invariant 3) and can leak nothing the routes would not; no event reaches
an agent. The same credential passes the same gate as every other owner route,
and it works through any proxy that passes HTTP. A reconnect sends
`Last-Event-ID` and the console replays from a ring buffer (the last 1,000
events or 10 minutes), or sends `resync` when the gap is larger. Through `metistry
console session --stdio` a request marked `stream: true` returns `{id, event}`
lines until it is cancelled — one subscription per app. `GET /api/identity`
advertises the stream as the `events` capability; polling with `since` cursors
stays the fallback, and token-by-token reply streaming is not in v1 (it would
put bodies in the stream).

**On the wire.**

- **Ids** are decimal integers, increasing, and opaque to a client: hand the
  last one back as `Last-Event-ID` and never do arithmetic on it. They start at
  the console's start time × 1000, so a restarted console begins above every
  id the last one issued.
- **A fresh subscriber** (no `Last-Event-ID`) gets one id-only frame first —
  `id: <head>` and a blank line. It dispatches nothing (the WHATWG rule for a
  frame with no `data`) but sets the client's last event id, so a stream that
  hears nothing before it drops still resumes from where it opened. Through
  `console session --stdio` it arrives as `{id, event: {id}}` — no `type`, no
  `data` (through 0.13.0 the session dropped it, and the Mac had no cursor
  until the first real event).
- **A resuming subscriber** gets exactly the events after its id, in order,
  then the live stream — or, when any of them is gone (older than the ring,
  from before this console started, an id this console never issued), one
  `resync` numbered at the head: refetch every visible screen, then resume
  from its id.
- **A heartbeat** — a `: heartbeat` comment — every 20 s
  (`METISTRY_EVENTS_HEARTBEAT_MS`) keeps a proxy from closing an idle stream,
  and at each one the console **asks the credential again**: a revoked
  session's stream ends within one heartbeat.
- **A slow subscriber** (256 KiB of frames unsent) is disconnected rather than
  buffered; its reconnect replays or resyncs.
- **The console's own LISTEN** is re-established by itself when the database
  connection drops, and every subscriber is sent `resync` when it comes back —
  what changed while nobody listened is not in the ring.

**Where events come from** (migration 0035; the rules are `mapBatch` in
`apps/console/src/events.ts`). Seven tables carry a trigger that notifies
`{table, op, id}` — never a column value; the console gathers a burst for
250 ms, looks the rows up once per table, and says each thing once per burst:

| Table | Event |
| --- | --- |
| `runs` | `run.started` on insert; `run.finished` once when it finishes; `turn.progress` at both ends of a row carrying `meta.turn_id` (a tool call in a turn). When it finishes, by `kind`: `routine_run` → `routine.status`; `collector_run` → `sync.status`, except the reconciler's pass → `vault.reconciled` when it changed files; `runner` → the status of the routine or sync named in `meta.run_kind`; `budget` → `budget.state` (`meta.scope`); `config_write` → `config.changed` (`meta.path`); `vault_sync` → `vault.sync` (`meta.state`); `connection_call` / `connection_check` → `connection.health` on a failure or a recovery (`meta.connection`); the Update Check's own `routine_run` → `release.available` (`meta.release_available`) |
| `proposals` | any change → `needs_you.changed` with the pending, un-snoozed count |
| `work` | any change → `work.changed`; a row claimed by an agent → `presence.changed` too |
| `inbox` | any change → `capture.new` |
| `artifact_comments` | any change → `thread.changed` for its task or its artifact |
| `outbound_messages` | insert → `message.new` |
| `agents` | a change, with a heartbeat alone (`last_seen_at` inside the same minute) throttled in the trigger → `presence.changed` |

The `runs` kinds a ticket still to land writes (`config_write`, `vault_sync`,
`connection_call`) are mapped by the `meta` key named here; that is the
contract those writers meet. Whatever a rule would emit passes one guard
before it is numbered (`payloadRefusal`): exactly the type's fields, each an
id, a name, a state token or a count. Anything else is logged and never sent.

**A snooze ending is the one change the trigger cannot see** (ruling 17,
X-17): `later` writes `snoozed_until` into the future, so that write already
notifies like any other; but the moment it *ends* is only `snoozed_until <=
now()` becoming true, and nothing writes a row for the clock moving. The
console re-asks the same pending, un-snoozed count on its own — every
`SNOOZE_POLL_MS` (default 30 s, `apps/console/src/events.ts`) — and says
`needs_you.changed` only when that count has actually moved since the last
time either it or a trigger-driven batch said so. Until this, a snooze coming
due reached the Mac only on its own five-minute poll.

The catalogue is `packages/core/src/events.ts` (`EVENT_CATALOGUE`, the payload
types in `EventPayloads`), one row per type. Numeric ids are JSON numbers; a
count "is not a body".

<!-- client-api:events:begin -->
| Event | Payload | Emitted when | The client refetches | Reach |
| --- | --- | --- | --- | --- |
| `run.started` | `{run_id, kind, turn_id?}` | a `runs` row starts | `GET /api/runs/:id` | owner |
| `run.finished` | `{run_id, kind, turn_id?}` | a `runs` row finishes | `GET /api/runs/:id` | owner |
| `turn.progress` | `{turn_id}` | a tool call in a turn starts or ends | `GET /api/turns/:turn_id/progress` — the working indicator | owner |
| `message.new` | `{message_id, thread}` | a reply is stored | `GET /api/messages?since=` | owner |
| `presence.changed` | `{agent_id}` | a claim, a lease, a heartbeat (throttled) | `GET /api/q/agent_presence` | owner |
| `needs_you.changed` | `{waiting}` | a request is raised, decided or snoozed | `GET /api/proposals?since=` | owner |
| `work.changed` | `{work_id}` | a task moves or changes | `GET /api/q/board` | owner |
| `thread.changed` | `{work_id \| artifact_id}` | a room or a thread gets a message | `GET /api/work/:id/thread`, `GET /api/artifacts/:id/comments` | owner |
| `capture.new` | `{inbox_id}` | a capture lands or is classified | Activity (`GET /api/q/activity_feed`) | owner |
| `vault.reconciled` | `{changed}` | a reconcile pass finishes with changes | Today and Knowledge (`GET /api/today`, `GET /api/knowledge/pages`) | owner |
| `vault.sync` | `{state}` | a commit, push, pull or conflict | `GET /api/vault/status` | owner |
| `routine.status` | `{name}` | a routine run finishes | `GET /api/scheduled/routines/:name` | owner |
| `sync.status` | `{name}` | a sync run finishes | `GET /api/scheduled/syncs/:name` | owner |
| `connection.health` | `{connection}` | a check or a call fails or recovers | `GET /api/connections/:name` | owner |
| `config.changed` | `{file}` | a protected write (`config_write`) | the pane showing it | owner |
| `budget.state` | `{scope}` | a limit is crossed | `GET /api/compute` | owner |
| `release.available` | `{version}` | the daily Update Check routine finds a newer runtime | `GET /api/identity` | owner |
| `resync` | `{}` | the replay gap was too large | every visible screen | owner |
<!-- client-api:events:end -->

`vault.sync`'s `state` is one of `commit`, `push`, `pull`, `conflict`
(`VAULT_SYNC_STATES`). A client ignores a type it does not know: a new type is
an additive change and keeps the version.

### The vault's git

```
GET  /api/vault/status     served — branch, ahead and behind, last commit, last push, any conflict
POST /api/vault/rollback   served — reach local: raises a Needs You request with the preview
```

#### `GET /api/vault/status` — where sync stands (`user` principal)

```
GET /api/vault/status
200 {"branch":"main",
     "remote":"origin",
     "ahead":2, "behind":0,
     "last_commit":{"sha":"4c1d2e3f…","subject":"Tick 1 task","author":"user",
                    "at":"2026-09-28T12:58:01.000Z"},
     "last_push":{"at":"2026-09-28T12:58:31.000Z","ok":false,"remote":"origin",
                  "error":"fatal: unable to access '…': Could not resolve host: github.com"},
     "last_pull":{"at":"2026-09-28T13:00:00.000Z","ok":true,"remote":"origin"},
     "conflict":null,
     "policy":{"push":"after_commit","pull":{"every":"5m"}},
     "as_of":"2026-09-28T13:05:00.000Z"}
503 no vault bridge in this deployment, or the reconciler did not answer (degrades: absent)
```

The reconciler's own `GET /vault/status`, fetched with the console's bridge
bearer and parsed **strictly** (core's `vaultStatusSchema`) before it is sent
on, so the route carries these fields and nothing else — never a note's
content. `remote` is where pushes go (`origin` when there is one); with no
remote, `remote`, `ahead` and `behind` are null. `ahead` counts commits the
remote has not got — every commit, when the remote has never had the branch;
`behind` counts the remote's commits not yet here, as of the last fetch.
`last_commit.author` is the principal the reconciler stamped (`Brain-Source:`),
or git's author for a commit made outside it. `last_push` and `last_pull` are
the last attempt (`ok: false` carries git's last error line, any
`user:secret@` in a URL masked). `last_push` is the last push that went out
or failed — a sync that found nothing to send is not one — and both are since
the reconciler last started (null before the first). `conflict` is `{paths}`
while a conflict stops the sync (§2.21 rule 3: no push until a later pull
integrates cleanly) or the owner has a merge in progress with unmerged paths,
else null.

`policy` is the sync policy in force — `deployment.yaml`'s `vault:` block over
its defaults (`push: after_commit`, `pull: {every: 5m}`): `push` is
`after_commit`, `manual` or `{every}`; `pull` is `{every}`. `push_override`
appears while `METISTRY_PUSH_SCHEDULE` overrides `push` (this release only),
and `error` while the file does not validate — the last good policy keeps
running. The policy is set with `metistry vault settings` on the Mac (M18,
`docs/ops/cli.md`), never through a route. Every commit, push, pull that
brought something, and conflict is a `vault.sync` event; a client refetches
here. The Mac draws this route as Settings ▸ Instance ▸ History (T10-7).

#### `POST /api/vault/rollback` — roll back, through Needs You (reach `local`)

```
POST /api/vault/rollback
{"commit":"4c1d2e3f"}  |  {"to":"2026-09-26"}  |  {"file":"Areas/Plan.md"}  |  {"file":"Areas/Plan.md","to":"2026-09-20T08:00:00-04:00"}
     + "include_config": true   (the CLI's --include-config; see below)
202 {"ok":true, "proposal_id":"62", "raised":true,
     "preview":{"reverts":["9ab8c7d6…"], "files":["Projects/Metistry/Roadmap.md"],
                "skipped_config":[".metistry/compute.yaml"], "config":[], "include_config":false,
                "head":"4c1d2e3f…", "base":{"sha":"1f2e3d4c…","subject":"Start the plan","author":"user","date":"…"},
                "revert_count":1, "commits":[{"sha","subject","author","date"}], "changes":[{"path","change"}]},
     "proposal":{…the row, as GET /api/proposals serves it…}}
400 not one target; a commit that is not 7–64 hex; a `to` that is not a day or an ISO timestamp;
    nothing to roll back (or nothing but configuration)
403 local_only for a passkey session (the owner's too); forbidden for the capture token and an agent;
    forbidden for a `file` that is configuration without include_config
404 a commit not in this vault's history      409 the preview could not be computed cleanly
503 no vault bridge in this deployment
```

Changes nothing. The console asks the reconciler for a **preview**
(`POST /vault/revert` with `dry_run`, `docs/ops/reconciler.md`) and raises one
Needs You request — an `improvement` raised by `console`, trust `user`, a
before and after naming the commits it undoes and the files it puts back —
one per target and history (asking twice answers `raised: false` and the same
id). `head` is the history the preview was computed on; `reverts` and `files`
are what Approve will undo and change; `skipped_config` is configuration the
history would change and the rollback leaves alone.

**Approve** (`POST /api/proposals/:id`, `allow`) runs the revert as `user`:
one NEW commit, pinned to `head` and held to the previewed change set — a
change set that moved is `409 stale`, nothing reverted, the request still
waiting. The answer carries `rolled_back: {runs_in: "console", sha, files}`.
Revise and Decline change nothing. A rollback touches files only and never
rewrites history; undo is rolling back the rollback's commit.

**Configuration** — every `.metistry/` path, `CLAUDE.md`, `README.md` — is
never reverted by the console: its bearer cannot. A request raised with
`include_config: true` (by `metistry vault rollback --include-config`)
previews configuration as `config`, and its Approve answers
`rolled_back: {runs_in: "cli"}` and reverts nothing — the waiting CLI makes
the change with the owner-class bearer (M18, `docs/ops/cli.md`). The route is
`local`: history and the remote are the boundary (§2.21). The Mac's
Settings ▸ Instance ▸ History ▸ Roll Back… asks it for the last commit, one
commit or a day (never with `include_config`), and shows the answer's
`preview` — the commits undone and the files put back — before anything is
approved (T10-7); it draws the control only for the local owner token.

## The closed action set

Invariant 10: what an agent may **propose**, and what the owner's Approve runs
— a closed, enumerated set, each a door onto a service the owner's own routes
already call (`docs/ops/actions.md`, `packages/core`'s `ACTION_KINDS`):

| Action | The service it is a door onto |
| --- | --- |
| `dispatch` | a task to a compute target — `POST /api/tasks/:id/dispatch` |
| `task_update` | the tasks service — status, owner, project, title, as `PATCH /api/tasks/:id` |
| `comment` | a message into a task's room or onto an artifact version — `POST /api/work/:id/comments`, `POST /api/artifacts/:id/comments` |
| `capture` | the capture sink — `POST /capture` |
| `connection_call` | the connections pool — one tool of one connection, `approved`; args closed to `{connection, tool, args, confirm_token}`; its effective mode is never `allow` (Q5). Raised only by `connections_call` on an Ask First tool, never by `propose_action`; Approve runs the payload the proxy previewed (T4-9, below) |

A new action is a product change — a row here, a case in `runAction`, a test —
never a prompt or a config line. The console's **configuration** routes
(`/api/compute*`, the Scheduled doors) are not actions and are on no agent's
list: they are the owner's own hand.

## Management-only — what the Mac does outside the API

The Mac app uses the CLI or the filesystem **only** for these, each because the
console cannot or must not do it (credentials, the machine, code that runs):

| # | Action | CLI verb (owner caller class) | Why not the API |
| --- | --- | --- | --- |
| M1 | Install, first run, runtime seed | `metistry init`, `runtime install`, `up`, `down`, `migrate-*` | the console is not running yet, or is what is being installed |
| M2 | Update and roll back the runtime | `metistry update [--channel\|--version\|--rollback]` | replaces the console itself |
| M3 | Deployment shape | `metistry deployment set-shape` | moves the data between shapes |
| M4 | Keep awake, and the lid-closed setting | `metistry deployment set-keep-awake [<value>] [--enabled\|--sleep-on-battery\|--sleep-lid-closed true\|false]` (the object form, T4-20; `docs/ops/cli.md`) | a machine setting; the lid dialog never runs a command |
| M5 | Service lifecycle and logs | `metistry restart\|stop\|start [service]`, `logs` | the supervisor's local socket; a remote stop locks the owner out |
| M6 | Doctor | `metistry doctor --json` | local probes: launchd, containers, TCC |
| M7 | Secrets | `metistry secrets set\|replace\|remove\|hosts\|grant\|migrate-scope\|purge-shared` | the login Keychain; a value never crosses the API |
| M8 | Instance repository | `metistry connect-repo` | git remote and credentials |
| M9 | Connect a local tool | `metistry connect <tool>` | writes the tool's own config files |
| M10 | The assistant's identity | `metistry identity set` (T2-16) | `.metistry/identity.yaml` |
| M11 | Linked instances | `metistry instances add\|remove\|refresh` | a trust relationship with another origin |
| M12 | Agent definitions | `metistry agents define <id>` (T4-6) | `.metistry/agents/**` — how an actor behaves |
| M13 | Connections | `metistry connections add\|set\|remove\|policy\|test` (T4-8) | `.metistry/connections/**` — hosts, commands, credentials, tool modes, the offer switch |
| M14 | Variables | `metistry variables set\|unset` (T4-4) | `.metistry/variables.yaml` — text agents read |
| M15 | Extensions | `metistry extensions add\|remove\|list` (T4-5) | `.metistry/extensions/**` — what the product loads |
| M16 | Compute providers | `metistry compute providers add\|remove\|set` | keys and base URLs — where prompts go |
| M17 | Models on this Mac | `metistry compute models install\|load\|unload` | this Mac's disk and memory |
| M18 | The vault's git policy and rollback | `metistry vault settings`, `metistry vault rollback <commit\|--to date\|--file path>` (T10-2, T10-6) | the repository's history and its remote; a rollback still waits for Approve in Needs You |

**Device-local, no CLI and no API:** global hot keys, the capture bar's
placement and window preferences, the login item, reading TCC state, the
instance chooser and recents, and **controlling a recording** — the app talks
to the local live-capture bridge directly; what a recording produces reaches
Metistry through `POST /capture` like any capture.

## What a remote client may do

**The line:** *a remote client may act inside the boundary; only the Mac may
change the boundary itself* — what runs, where data may go, which credentials
exist. Reach enforces it; a client hiding a control is never the control.

| Setting or act | Phone / PWA | Mac | Why |
| --- | --- | --- | --- |
| Needs You answers, ticks, defers, Close the Day, captures, chat | write | write | the daily acts |
| Board, projects (mode, daily budget), rooms, artifact comments | write | write | inside the boundary |
| Agents: grants, projects, autonomy, revoke, approve an enrolment | write (audited and alerted, as today) | write | who may do what, inside the boundary |
| Agents: register or rotate a bearer; edit a definition | read | write | a new credential; how an actor behaves |
| Scheduled: pause, resume, Run Now, a schedule, Reset, sync cadence and raise toggles | write | write | timing, inside budgets |
| Scheduled: a routine's actor, task or per-run grants; New Routine | read | write | changes what runs |
| Compute: the assistant's model and effort, spending limits | write | write | spends within configured providers |
| Compute: providers, keys, base URLs, installing models | read | write | where prompts and keys go; this Mac's disk |
| Connections: status, tools, used by | read | read | — |
| Connections: add, configure, tool modes, Offer to agents | — | write | hosts, commands, credentials, agent reach |
| Secrets: names, hosts, grants, last used | read | read | a value is never shown anywhere |
| Secrets: set, replace, remove | — | write | the Keychain |
| Variables | — | write | Mac-only by design |
| Instance: name, mention, mark | read | write | |
| Instance: path, ports, linked instances | — | write | local filesystem; trust with other origins |
| Services: health (`GET /api/status`); Doctor on the Mac | read | read | Doctor's probes are local (M6) |
| Services: restart, stop, start, logs; Keep Awake | — | write | the machine; a remote stop locks the owner out |
| Updates: versions | read | read | |
| Updates: update, roll back, runtime source | — | write | replaces running code |
| Account: devices, revoke a device, Sign Out Everywhere | write | write | a lost phone is revoked from another device |
| Account: console sign-in, instance repository | — | write | |
| Sessions: *Let the assistant learn*, retention | write | write | the session-fold and purge routines' settings, through the Scheduled doors (§2.5) |
| Sessions: Purge Now | — | write | irreversible |
| Live Capture, Keyboard, Advanced | — | write | this Mac |
| Live changes (`GET /api/events`) | read | read | ids only |
| Linear: create an issue from a task, close one, link a task | write | write | the daily acts, through the connection's own tool modes |
| Vault: history of a file, the sync status | read | read | |
| Vault: restore a file, roll back, the push and pull policy | — | write | history and the remote are the boundary; each rollback still waits for Approve |

The `local` reach is what makes the Mac column true for the rows a phone may
only read: agent registration and rotation (F-13), a routine's assignment and
New Routine, Purge Now and a vault rollback are `local` rows in the table. The
rest of the Mac-only column is the CLI (above).

## Outside the contract

- **The PWA shell** — `GET` of any non-`/api` path when the console serves a
  web root (`apps/console/web/`, and `/vendor/simplewebauthn.js`) — is static
  files, not routes: it renders before sign-in and says nothing the login page
  does not.
- **The MCP protocol on `/mcp`** — its tools, schemas and `tools/list` — is
  `docs/ops/assistant-tools.md`'s; this table records only the door.
- **The reconciler's `/vault/*` bridge** is a service-to-service API under a
  bridge token (`docs/ops/reconciler.md`), never reached by a client.
