# The console's API for a client that is not always connected

Server-side pieces, all small, that the phone's offline design needs
(`docs/research/2026-09-11-multi-instance-and-offline-client.md`) and the
PWA benefits from today — plus the three SAM adopts that touch this API
(S1, S2, S5 in `docs/plan-refresh-2026-09-13.md` §1, reasoned in
`docs/research/2026-09-13-google-sam-review.md`). Everything else about the
door is `docs/ops/auth.md`; capture is `docs/ops/capture-shortcut.md`;
ratings are `docs/ops/reply-feedback.md`; the peer registry these serve is
`docs/ops/instances.md`. `metistry console call <METHOD> <path>`
(`docs/ops/cli.md`) is the generic CLI client for any authenticated route
below, as the `user` principal — the scripting seam behind `console
whoami`, rather than a bespoke `curl` incantation.

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

The fields come from `.metistry/identity.yaml` through the same overlay rule the
assistant uses for its prompt: `METISTRY_IDENTITY_FILES`, colon-separated,
last existing file wins; the default is `seed/identity.yaml` then
`$METISTRY_INSTANCE_DIR/.metistry/identity.yaml`. No `name` + `instance_id` → 503 and
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

`POST /api/messages/:id/feedback` needs no key: it is an upsert on the
message id, so a replay is already the same row. `POST /message` is not
idempotent and not meant to be queued (a reply three hours late into a
moved-on thread is confusing); the research note says why.

## `409` for a settled decision, `404` for an unknown one

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

## `if_unchanged` — a decision is an answer to the row you were shown

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

## `accept_as_work` — one extra verb, where the row carries a suggestion

```
POST /api/proposals/17  {"decision":"accept_as_work"}
200 {"ok":true,"work":{"id":214,"title":"renew the wildcard cert","project":null}}
400 when the row carries no valid `payload.suggested_work`, or is not kind knowledge|report
```

Offered only on a `knowledge` or `report` proposal whose payload carries
`suggested_work: {title, project?, kind?}` — validated **server-side against
the stored row**, never against the request, exactly like the option set of a
`decision` proposal. It inserts the `work` row (owner-less, unclaimed), sets
`proposals.work_id`, and decides the proposal `allow`. `project` that is not a
project slug is dropped rather than invented; an unknown `kind` is a refusal
rather than a silent fall back to `task`. `docs/ops/reply-feedback.md` has the
rest, including why this leaves §4.12 intact.

## `allow` on an `action` — the verb that does something

```
POST /api/proposals/31  {"decision":"allow"}
200 {"ok":true,"action":{"kind":"dispatch","ref":"gh:owner/repo#41","url":"…","run_id":9001}}
400 the stored payload.action does not validate — the message names the field
409 / 422 / 503 the SERVICE refused (a lease, a data policy, no vault bridge):
    the proposal stays pending, carrying payload.error, and you decide again
```

An `action` proposal carries a closed `payload.action = {kind, args}`
(`dispatch | task_update | comment | capture`). Allowing it runs the action
through the **same service call the owner's own route makes**, as the `user`
principal, with the proposal's `source_agent` recorded as `on_behalf_of`; the
result lands in `payload.result` and in a `runs` row. The action runs *before*
the row is decided — as the `improvement` path does — so a refusal leaves a
pending proposal rather than a settled decision that did nothing. Nothing is
half-applied, because one action is one service call. `docs/ops/actions.md`
has the enum, the autonomy table, and why `dispatch` stays human by default.

Rows an agent was allowed to run on its own arrive already decided `auto` —
never in this queue, always in the timeline.

## `PUT /api/agents/:id/autonomy` — the one route that may widen

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

## `POST /api/proposals/batch` — one verb, many rows

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

## A refusal names the field that would permit it — except on the door

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
  *everything that changed*, each row carrying `decision`, `decided_at` and
  `snoozed_until`, so a reconnect learns what was settled while it was away
  instead of showing a stale queue. Without `since` it is the triage queue as
  before — pending only, now minus anything `later` put down until an instant
  that has not arrived. A snooze deliberately does **not** move the cursor: it
  names a future instant, and a cursor that jumped forward would skip live
  rows.

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

## The task routes — the board's drags, and nothing else (`user` principal)

```
PATCH /api/tasks/:id   {status?, owner?, project?, title?}
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
`owner`/`title`/`project` need no claim; `in_progress | blocked | closed` are
the holder's, so closing a card you do not hold answers `409 … held by X, not
by user — claim it first`. Mixing the two arms in one body is a `400` naming
both fields, because the looser gate must never carry the stricter arm's write.

**Assignment is the human's alone.** `owner` exists on this route and on no
agent surface: `tasks_update`'s schema has no `owner` key and its status enum
has no `open`. That is collaboration rule 4 enforced by absence rather than by
a check — a human may address a card to any crew, and an agent cannot address
one at all. If an agent verb ever gains assignment, `crossKindRefusal` is the
guard it needs (`docs/research/2026-09-11-local-models-openrouter-opencode.md`).

## `/api/compute*` — providers, assignments and budgets (`user` principal)

```
GET  /api/compute                                     the same report as `metistry compute show --json`
GET  /api/compute/models[?provider=<name>]            live /v1/models, per provider, plus unconfigured local servers
POST /api/compute/assign          {tier|crew, model, effort?}
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

**A secret never crosses this boundary.** `providers add` and `providers
remove` are deliberately **absent**. Adding a provider takes a key; a key
belongs on stdin into the login Keychain, from the hand of the person at the
machine (`docs/ops/compute.md` "Secrets"), and provider credentials are
*user*-scoped — shared by every instance on that Mac, and never one
instance's to hand out over HTTP. So **adding or removing a provider, and
anything that takes a secret, stays CLI/app-only.** What `GET /api/compute`
reports is the **NAME** of the secret a provider authenticates with and
whether an item of that name exists:

```json
{"name":"openrouter","locality":"off_machine","zdr":true,
 "secret":"METISTRY_OPENROUTER_API_KEY","secret_present":true,
 "models_assigned":["anthropic/claude-opus-4"],
 "budget":{"daily_usd":5,"monthly_usd":60,"action":"stop"}}
```

Presence, never a value. `secret_present` needs a login Keychain to be
truthful, so it is `false` wherever there is none (a container): the honest
`false`, not a missing field. `POST /api/compute/providers/test` does use the
credential — a real `GET <base_url>/models`, and with `complete: true` a
one-token completion — and reports only whether it worked.

`GET /api/compute` adds two fields the CLI report does not carry:

- **`spend`** — `{instance:{daily,monthly}, providers:{<name>:{daily,monthly}}}`,
  folded from the **`spend` named query** (invariant 3: the same read path the
  engine checks before every billable call), so the pane shows a budget beside
  what has been spent against it. `null` when that query is not loaded — never
  a guessed zero.
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

## `GET /api/q/<name>` — the generic door onto the named queries

```
GET /api/q/open_work?limit=5
200 {"rows":[…],"as_of":"…"}
400 a param this query does not declare, or one of the wrong type
404 no such query — OR one the manifest keeps off this door (indistinguishable)
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
| `route` | this query has an **endpoint of its own**, and that endpoint does something this door cannot. Asking for it here is the `404` an unknown name gets |

The field exists because of `knowledge_pages` and `knowledge_page_links`.
`GET /api/knowledge/pages` and `GET /api/knowledge/links` filter every row
they return through the caller's scope (`canSee` — for a link, at both ends);
the
generic door does not, cannot — it has no principal scope and no reason to
believe a column called `path` is a vault path — and would have handed the
whole index, and the whole graph, to anyone who could reach `/api/q/<name>`,
which includes the capture owner token that is `403` on `/api/knowledge/*`. One endpoint per
necessary operation (ruled 2026-09-19): the filter is not optional if there is
no second way in.

Two properties worth stating:

- **The refusal is the unknown-query refusal, byte for byte** — same code,
  same status, same absent message. A distinguishable `403` would make this
  door an oracle for which route-only queries a build has, which is the same
  reasoning behind the `404` on `/api/knowledge/page`.
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

## `/api/knowledge/*` — the vault read path (`user` principal)

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
400 q / mode / limit / offset / a filter's shape / a missing path — by name
404 the page is not there, OR is not knowledge (indistinguishable, on purpose)
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
narrower thing than "a file in the instance repo", so the narrowing happens
**here**, on core's `isVaultPath`: no traversal, no leading slash, nothing
inside a dot-directory, not `Artifacts/`, not the root `CLAUDE.md` /
`README.md`. The same predicate `mcp-brain`'s `validKnowledgePath` applies to
agents and the indexer applies to the walk, so the three cannot drift.

A refusal answers **`404`, not `403`** — for the same reason a decision on an
unknown proposal does: the owner may read `.metistry/compute.yaml` with a text
editor or `metistry compute show`, and the honest thing to say on the
*knowledge* route is "there is no such page", not "there is one and you may
not have it". "Refused" and "absent" are indistinguishable from outside.

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
(ruled 2026-09-19). The other door onto the same rows is `knowledge_list`,
which applies the same `canSeeUnder` to an agent's grant that this route
applies to the owner's scope. The generic door has no `canSee` filter and cannot have one: it
does not know that a column called `path` is a vault path, and it has no
principal scope to judge it against. Two doors onto the same rows would have
made the filter on this one optional, and it was reachable — the capture owner
token is `403` here and has always been admitted on `/api/q/<name>`. The
section above it describes the field.

**`GET /api/knowledge/links` is the fourth door, and the same kind of thing.**
The wikilink graph is derived too — the reconciler parses it out of the notes
on every walk and re-resolves a note's edges whenever the note or the path set
moves — so it is the named query `seed/queries/knowledge_page_links.yaml`,
`expose: route` for the same reason, over `knowledge_links` (`0001_init.sql`:
`from_path`, `to_path`, `kind`, primary key on all three, index on `to_path`,
so both directions are one indexed lookup). No migration.

| Field | Meaning |
| --- | --- |
| `path` (parameter) | **required** — the page whose links these are. A path the caller may not see is the same `404` a missing page gets: "this page has four backlinks" is a fact about a page |
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

## `GET /api/commands` — the composer's list, generated (`user` principal)

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

## `GET /api/runs/:id` — one row of the ledger (`user` principal)

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
