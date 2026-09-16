# The console's API for a client that is not always connected

Server-side pieces, all small, that the phone's offline design needs
(`docs/research/2026-09-11-multi-instance-and-offline-client.md`) and the
PWA benefits from today — plus the three SAM adopts that touch this API
(S1, S2, S5 in `docs/plan-refresh-2026-09-13.md` §1, reasoned in
`docs/research/2026-09-13-google-sam-review.md`). Everything else about the
door is `docs/ops/auth.md`; capture is `docs/ops/capture-shortcut.md`;
ratings are `docs/ops/reply-feedback.md`; the peer registry these serve is
`docs/ops/instances.md`.

## `GET /api/identity` — who this instance is, before sign-in

```
GET /api/identity
200 {"instance_id":"8b6a3a2e-…","name":"Metis","icon":"🦉",
     "capabilities":["artifacts","capture","dispatch","knowledge","queries","tasks"],
     "version":"0.8.0","as_of":"2026-09-11T02:18:47.001Z"}
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

The fields come from `identity.yaml` through the same overlay rule the
assistant uses for its prompt: `METISTRY_IDENTITY_FILES`, colon-separated,
last existing file wins; the default is `seed/identity.yaml` then
`$METISTRY_INSTANCE_DIR/identity.yaml`. No `name` + `instance_id` → 503 and
a startup warning (degrades: absent). `metistry init` stamps the id.

### `capabilities` — coarse, and deliberately uninformative (S1)

The vocabulary is fixed and lives in `packages/core`
(`CAPABILITIES`): **`artifacts` · `capture` · `dispatch` · `knowledge` ·
`queries` · `tasks`**. Each is a tool *group*, and each is derived from what
this console actually has wired, so an instance cannot advertise something
it would then answer `not_available` for:

| group | present when |
| --- | --- |
| `capture`, `tasks` | always — `/capture` and the tasks service need nothing configured |
| `knowledge` | a vault to read (the reconciler's bridge, D5) |
| `artifacts` | the vault client the artifacts module stores through (§4.21) |
| `queries` | at least one named query loaded (invariant 3's read path) |
| `dispatch` | at least one compute target configured (§4.18) |

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
which of six doors exist; what they still cannot do is open one.

## Approve-before-enroll for remote agents (S2)

An agent whose bearer will be presented **from off this machine** does not
get to start working because a token was minted. SAM's `join` leaves an
enrollment PENDING until an administrator approves; invariant 2 says the
credential surface is the user's hand, so the same rule holds here.

```
POST /api/agents            (user principal)
{"id":"devin","display_name":"Devin","kind":"external","remote":true}
201 {"id":"devin","token":"…","pending":true,"proposal_id":412}

POST /api/agents/devin/approve   (user principal)
200 {"approved":true,"proposals":[412]}
404 — no such row, revoked, or never remote (nothing to approve)
```

- `remote` is optional and defaults to `false`; it must be a boolean, and
  `kind: internal` can never be remote (an internal agent's token comes
  from the user's own environment, which *is* the approval, §4.11).
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
  one answer cannot drift.
- `GET /api/agents` carries `remote`, `approved_at` and a derived
  `pending`. `metistry connect <tool> --remote` sets the flag; `metistry
  connect --list` shows `pending`. Loopback tools stay immediate, and
  `--remote` is decided at enrolment — it is refused on a row that already
  exists rather than widening it.

Approval is **not** a grant: a row let in still holds the default-deny
`{tier: "none", areas: []}` it was minted with. Two different questions,
answered separately.

## `Idempotency-Key` on `POST /capture` — a retry is not a second note

```
POST /capture
Authorization: Bearer <owner or agent token>   (or the session cookie)
Idempotency-Key: 6f2c4e0a-…                     (client-minted, ≤200 chars)

201 {"id":42,"path":"Knowledge/Inbox/1757556000000-note.md","sha256":"…"}
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
door insert as before. An empty or oversized key is a `400`.

`path` is relative to the instance repo root: captures live in the vault at
`Knowledge/Inbox/` so Obsidian can see and edit them (`docs/ops/inbox.md`).

`POST /api/messages/:id/feedback` needs no key: it is an upsert on the
message id, so a replay is already the same row. `POST /message` is not
idempotent and not meant to be queued (a reply three hours late into a
moved-on thread is confusing); the research note says why.

## `409` for a settled decision, `404` for an unknown one

```
POST /api/proposals/17  {"decision":"allow"}
200 {"ok":true}
409 {"error":{"code":"conflict","message":"already decided"},
     "decision":"deny","decided_at":"2026-09-11T01:02:03.004Z"}
404 {"error":{"code":"not_found","message":"not found"}}
```

Decided from another device, or from this one before it went offline: the
first answer to arrive wins (delivery order, not wall-clock), the second
gets `409` **with the winner**, so a client shows what actually happened
rather than "failed". Never re-triaged. This is also why the phone must not
queue decisions by default — a lease or a decision is a statement about
server state at delivery time.

## A refusal names the field that would permit it — except on the door

```
400 {"error":{"code":"invalid_request","message":"area must be a TitleCase Knowledge/... prefix"}}
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

## `since` cursors on the polled lists — a reconnect is one bounded pull

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
  *everything that changed*, each row carrying `decision` and `decided_at`,
  so a reconnect learns what was settled while it was away instead of
  showing a stale queue. Without `since` it is the triage queue as before —
  pending only.

`runs` has no *list* endpoint; the activity feed is the `runs_summary` /
`activity_feed` named queries, which take their own parameters. The whole
ledger, for merging two instances' timelines, is the export below.

The client's side of the contract — drain the outbox head-first, then pull
each list with its cursor, then repaint — is in the research note.

## `GET /api/runs/export` — the audit ledger as NDJSON (S5)

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

## `GET /api/instances` — the peer registry

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
