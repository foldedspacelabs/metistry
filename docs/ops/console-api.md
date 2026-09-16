# The console's API for a client that is not always connected

Three server-side pieces, all small, that the phone's offline design needs
(`docs/research/2026-09-11-multi-instance-and-offline-client.md`) and the
PWA benefits from today. Everything else about the door is
`docs/ops/auth.md`; capture is `docs/ops/capture-shortcut.md`; ratings are
`docs/ops/reply-feedback.md`.

## `GET /api/identity` — who this instance is, before sign-in

```
GET /api/identity
200 {"instance_id":"8b6a3a2e-…","name":"Metis","icon":"🦉",
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

## `Idempotency-Key` on `POST /capture` — a retry is not a second note

```
POST /capture
Authorization: Bearer <owner or agent token>   (or the session cookie)
Idempotency-Key: 6f2c4e0a-…                     (client-minted, ≤200 chars)

201 {"id":42,"path":"1757556000000-note.md","sha256":"…"}
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

`runs` has no list endpoint; the activity feed is the `runs_summary` /
`activity_feed` named queries, which take their own parameters.

The client's side of the contract — drain the outbox head-first, then pull
each list with its cursor, then repaint — is in the research note.
