# Connections — the files, the pooled client, and what it refuses

A **connection** is anything outside Metistry it reaches for the owner (plan
§2.6). This page is the contract `packages/connections` implements (T4-8a):
how a connection file is read, how Metistry dials one, and what the dial makes
impossible. The file's schema is F-3's (`packages/core/src/connections.ts`,
`docs/ops/extensions.md` *Connection files*); the verbs are `metistry
connections` (M13, `docs/ops/cli.md`); the read routes are `GET
/api/connections(/:name)` (`docs/ops/client-api.md`).

**This release dials MCP servers** — over Streamable HTTP or by starting a
command (stdio). The other types have their own consumers and tickets: agent
connections (targets, T4-11), tools generated for API, feed and files
connections (T4-10), calendar and mail providers (T4-13…T4-15). A
**tracker** or **calendar** connection is read by its provider's sync —
Linear is the first tracker (T4-24, *Linear* below), an ICS feed the first
calendar (T4-12, *ICS feeds* below). Asking the pool to dial any of those is refused `not_built`,
naming where it arrives.

## The file, read

`.metistry/connections/<name>.yaml`, one per connection, named for it.
`packages/connections` reads every file against the connection-type registry
(the product's `seed/connection-types/` and the owner's `.metistry/extensions/`,
`loadKind("connection-type")`) and gives each one of three verdicts — never
fatal: a bad file is one row that says why, and every other connection loads.

| Verdict | Means |
| --- | --- |
| `ok` | it validates against its provider's unit and this package's rules |
| `absent` | its `provider` is not installed — the connection turns absent, naming the missing unit, and nothing is deleted (§2.7) |
| `failed` | the schema refuses it, it does not match its provider's unit (a tool relabelled from Changes to Reads, a field the type does not have), or it breaks a rule below |

**The rules this package adds to the schema**, each a refusal with its reason,
because the schema permits them and the egress door would catch only some of
them later, one call at a time:

- **A literal that looks like a key**, anywhere a value is typed — a header, an
  argument, an `env:` value, the description. A connection file holds names;
  the value is a secret (`metistry secrets set <name>`), written as
  `{{ secret.<name> }}`. Core's `looksLikeKey` (T4-4's heuristic) judges the
  text outside `{{ … }}`, and is biased to refuse: a path with a random-looking
  segment (an OS temp directory) reads as a key too.
- **A `{{ secret.x }}` in a URL or its query** — a URL lands in logs and
  histories. A secret goes in a header.
- **A `{{ secret.x }}` on a command line or in a working directory** — every
  process on the Mac can read another's argv. A secret goes in `env:`, given to
  that command only.
- **A `{{ secret.x }}` in a path reach**, which has nowhere to send one.
- **An `Authorization` header beside an auth shortcut** that writes one.

A YAML error is reported by its code and line only — never the parser's
snippet of the source, which would echo whatever was pasted there.

## The listing

`describeConnections` builds the rows every surface shows — `GET
/api/connections`, `metistry connections list`, and the Mac's Connections view
(T6-13a). A row carries **names**: a header's, a query parameter's, an
environment variable's, a secret's — never a header or environment value. A
file that broke a rule shows its name, `failed`, and why, **and nothing it
holds**: the rule may be a key in the wrong place.

Beyond the file's verdict the row says what the caller can know and a call
would meet, **before any call is made**:

- `absent` — a variable it uses is not set; a secret it lists has no item in
  **this instance's** Keychain (asked through a presence probe, which cannot
  read a value);
- `failed` — `secrets.yaml` does not grant a secret to `connection:<name>`, or
  an HTTP connection sends a secret to a host that is not on the secret's
  *Sent only to* list (the same refusal the egress door makes).

*Used by* is what reads it today: the syncs in `scheduled.yaml` that name it,
and the sync its provider declares when that sync reads it (the rule *A sync
reading its connection* below applies).
Agents reach a connection through the lazy pair `connections_list` /
`connections_call` (below); until a host mounts the pool behind them and
agents carry grants, an empty list is the true answer (*Nobody yet*).

## The pooled client

`ConnectionPool` holds one long-lived MCP client per connection — a stdio
child or a Streamable HTTP session — opened on first use, reused, closed after
ten idle minutes (the host's `idleMs`) or when the connection's plan changes (an
edit to its file, to a variable it uses, or to a grant its command's
environment depends on), with the server's `tools/list` cached until it sends
`notifications/tools/list_changed`. The pool reads the catalog on every call,
so an edit takes effect without a restart. It is a library: the process that
holds it is the one whose calls it makes — `metistry connections add|test` and
`metistry doctor` in the CLI today, and the console (a supervisor child) once
it mounts the pool behind the lazy pair. A proxied call's `runs` row is
written by mcp-brain itself (below), so a host does not also write one from
the pool's `connection_call` event for it; `connection_check` is the CLI's.

The host sets the clocks: the CLI reads `METISTRY_CONNECTION_CONNECT_TIMEOUT_MS`
(default 30 s — a cold `npx -y …` downloads first) and
`METISTRY_CONNECTION_CALL_TIMEOUT_MS` (default 60 s, the SDK's own), and doctor
`METISTRY_CONNECTION_CHECK_TIMEOUT_MS` (default 15 s).

**Refused before anything is dialled** — no child started, no request sent —
each a `ConnectionRefused` with a code:

| Code | When |
| --- | --- |
| `tool_not_listed` | the tool is not in the file's `tools:`. **The file is the allowlist**: the server is never asked about a tool the owner did not list |
| `tool_off` | the tool is at Never |
| `needs_approval` | the tool is at Ask First and the caller holds no approval of this call — only the console's Approve of the Needs You request sets it (T4-9) |
| `caller_credential` | the caller's own bearer is in the arguments |
| `unknown_connection`, `not_ready` | no such file; a file that is `failed` or `absent`, with its issues |
| `variable` | a `{{ variable.x }}` that does not fill |
| `secret` | a command's environment needs a secret that is not granted **on** to `connection:<name>` (Ask First cannot hold there: an environment is filled once, at spawn, so there is no call to approve), or has no item |
| `runs_elsewhere` | `runs_on` names a place this process is not |
| `not_built` | a type, provider or auth scheme this release does not dial (`basic` and `oauth` sign-in arrive with T4-10) |
| `other_host` | an HTTP connection's request to another origin, or a redirect — a redirect is not followed |

**The caller's bearer is never forwarded upstream.** The MCP authorization
spec says a server "MUST NOT pass through the token it received from the MCP
client" — the confused deputy. Here it is structural: an HTTP transport's
headers are built from the connection file and nothing else; a command's
environment is built from the file and nothing else — **never this process's**
(the SDK adds `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`, and
nothing of the console's or the CLI's own, so no install token, database
password or agent bearer can reach a child); and a call whose arguments carry
the caller's bearer is refused.

**A secret goes only where its policy says.** Every HTTP request goes through
core's `guardedFetch` (T4-2) with the connection as the grantee: a `{{ secret.x
}}` in a header is filled only for a host on that secret's *Sent only to* list,
over https (or loopback), and only when the owner granted it to
`connection:<name>` — otherwise `EgressRefused` (`host_not_listed`,
`not_granted`, `needs_approval`, `missing_secret`, …) before a byte is sent.
Everything that comes back — HTTP bodies and headers, a command's tool results,
errors, a child's stderr quoted in an error — is redacted: a value becomes
`***REDACTED secret.<name>***`. Each call reports the secret **names** it
carried, for its `runs` row (`recordSecretUse`).

**What is not closed in this release — said plainly.** A command connection's
child is **not network-confined**: a granted secret in its environment is the
child's to use (§2.14's rule for a local process), and where it sends it is the
child's own traffic. The supervisor's egress proxy has one allowlist for its
confined children (the assistant, the reconciler) and no per-connection list;
confining a connection's child needs a per-child allowlist in the proxy and a
Seatbelt profile for it, which are not this ticket's files. An HTTP connection
has no such gap: its requests are made by the pool, through the door. So
prefer an HTTP server where one exists, and grant a command connection only
the secret it needs.

## The lazy pair — how an agent reaches one (T4-8b)

Agents never dial a connection. On `/mcp` two tools stand in front of all of
them (`packages/mcp-brain/src/connections-tools.ts`, plan §2.6, C115):

- **`connections_list`** — with no argument, the connections lent to the
  caller, each with its status and the tools it may call, read without
  dialling; with `connection`, those tools' own descriptions and input
  schemas, fetched from the upstream on demand. No upstream tool is ever on
  the bridge's eager `tools/list` — that is the "lazy".
- **`connections_call`** — one tool of one connection, through the host's
  pooled client (`ConnectionsProxy`: this package's `ConnectionPool` for
  `tools`/`call`, `describeConnections` for `list`).

**Who reaches which connection** is core's `may()` (`mayConnection`), at the
tool:

| Caller | Reaches a connection when |
| --- | --- |
| the owner | always |
| the assistant | always — a connection not offered to agents is the assistant's and the syncs' (C115) |
| an external agent | it is **offered** (`offer_to_agents: true`) **and** named in the credential's `grants.connections` |
| a crew | the same, **and** its manifest's `uses` names the `connections` group — the group without the grant reaches nothing, the grant without the group is refused at the door |
| the capture token | never |

A connection the caller cannot reach answers exactly like one that does not
exist (`not_found`, *no such connection: <name>*): which connections the owner
holds is not a borrower's to learn.

**How a tool runs is the owner's per-tool policy** (T4-9). A tool at Never, or
one the file does not list, is *no such tool* — refused and not offered, token
or not. `connections_list` names every other tool with how it runs:

| `runs` | The tool | `connections_call` |
| --- | --- | --- |
| `now` | a Read at Allow | runs at once |
| `confirm` | Changes things / Starts an agent at Allow | **preview-then-confirm** (CLAUDE.md): the first call answers `{status: "preview", arguments, confirm_token, expires_in_sec}` and dials nothing; the call runs when the caller sends the same `connection`, `tool` and `arguments` with `confirm_token` |
| `owner` | anything at Ask First | answers `{status: "pending", proposal_id}` and raises an `action` of kind `connection_call` in Needs You; nothing runs until the owner's Approve, and no caller's token runs it (`docs/ops/actions.md`). From an **unattended** run, deferred instead — below |

**Ask First pauses when the owner is there and defers when nobody is** (C59;
T4-22). One credential answers the owner's message at 11 AM and a routine's
turn at 6:02 AM, so the run says which it is: `_meta`
`com.foldedspacelabs.metistry/interactive`, beside the turn handle
(`docs/ops/assistant-tools.md`). With `false`, an Ask First call answers
`{skipped: true, reason: "waits_for_you", proposal_id}` at once — not an error,
not a wait — and still raises the same request in Needs You (its provenance
says `deferred: true`); its row carries `mode: ask`, `outcome: deferred` and
`unattended: true`. The run finishes without the step and reports it: the
assistant's drain reads its own deferred rows back and names them on the run's
row and in its output. The bit grants nothing — a deferred call runs only on
the owner's Approve, exactly as a paused one, and still counts against
`METISTRY_CONNECTION_ASKS_PER_HOUR`. Absent or malformed is interactive: a
client that never sends it gets `pending`, as before.

**The confirm token** is 32 random bytes, returned once. The server keeps its
SHA-256 and the SHA-256 of the canonical `{principal, connection, tool, args}`
it previewed, on the preview's own `runs` row (`meta.confirm`), never the token.
It runs **once**: the presentation that spends it is one atomic `UPDATE`, so a
replayed token — or one presented for other arguments, by another caller, or
after `METISTRY_CONNECTION_CONFIRM_TTL_S` (default 900 s) — is `409 conflict`
and runs nothing (`meta.refusal`: `confirm_spent`, `confirm_other_payload`,
`confirm_expired`, `confirm_unknown`). A preview whose arguments carry the
caller's own bearer is refused before anything is recorded. The pool refuses
Ask First again before it dials unless the console says the owner approved.

**Rate limits come from `runs`**, per caller, per connection, over the last
hour: `METISTRY_CONNECTION_CALLS_PER_HOUR` (default 120) counts calls that were
dialled — a preview is not one — and `METISTRY_CONNECTION_ASKS_PER_HOUR`
(default 20) counts Ask First requests raised, because Needs You is the owner's
attention. Over either is `rate_limited` (429) naming the limit, before anything
is dialled or queued.

**What crosses the wire.** The answer is the pool's redacted content, every
string through the §4.20 sanitizer. A refusal from the pool or the egress door
reaches the caller as a code and a sentence built from names the caller sent;
the pool's own sentence — which names secrets, variables and hosts — goes to
the `runs` row as `meta.detail`, where the owner reads it. The caller's bearer
reaches the proxy only as `caller.bearer`, so a call whose arguments carry it
is refused `caller_credential`; it is never sent upstream.

**The audit.** Every `connections_call` — refusals included — is one `runs`
row of kind `connection_call`: the principal as `component`,
`meta.connection`, `meta.connection_tool`, the secret NAMES it carried in
`meta.secrets` (so *last used* on the Secrets list counts it), and
`meta.is_error` when the upstream's tool reported failure — plus
`meta.group`, `meta.tool_mode` (the owner's policy), `meta.mode` (what the call
did: `call`, `preview`, `ask`, `confirmed`) and `meta.dialled`. An Approve is a
`connection_call` row too, written by the console (`tool: approve`, `mode:
approved`). The
`connection_calls` named query (`expose: route`) reads them back by
connection, principal, since and ok.

**Not yet wired — said plainly.** This release ships the gate, the tools and
the record, and the console takes a `connectionsProxy` it hands to both `/mcp`
and the Approve path. Its `main.ts` does not yet build one (a `ConnectionPool`
over the instance's catalog), and
an agent's registry `grants` do not yet carry `connections` (the console's
grant validator and a crew's manifest are where they will), so today both
tools answer `not_available` on a live console and no agent is lent anything
— the fail-closed end of every axis.

## `check()`

`checkConnection` is the connection's `check()` (core's frozen shape): dial it
through the pool, `initialize`, `tools/list`, and compare what the server
offers with what the file lists.

| Status | Means |
| --- | --- |
| `ok` | it answered, and every listed tool is on offer |
| `degraded` | it answered, and a listed tool is gone — a call to it will fail |
| `absent` | configured, but something it needs is not here: the command, a secret's item, a variable, its connection type |
| `failed` | the file is wrong, the credential is refused at the door, or the server cannot be reached — the error verbatim, redacted |

`meta` carries `tools_seen`, `listed`, `missing`, `unlisted` (offered and not
listed — refused until the owner lists one) and `read_only_hint` (what the
server marks read-only: a hint, never a control). `metistry connections test`
prints it; `metistry doctor` has one row per connection, and a connection
never fails the install there — `failed` is reported as `degraded` with the
check's own verdict in `meta.check_status`, because a connection is someone
else's server.

## A sync reading its connection

A `calendar`, `mail` or `tracker` connection's provider is product code — a
connection type whose `implementation` is `builtin` — and a sync (the
collector the type names in `sync:`) reads it on an interval. What the sync
opens is `openSyncHttp` (`packages/connections`, `sync.ts`):

- **Which connection.** `scheduled.yaml`'s `syncs.<sync>.connection` when the
  owner names one; otherwise the one `ok` connection whose provider declares
  that sync — adding the connection is enough. Two and none named is refused
  (`failed`, naming `syncs.<sync>.connection`) rather than one silently
  winning; none at all is `absent`, and the sync writes nothing.
- **Where it may go.** The connection's URL must be the provider's own origin
  (Linear: `https://api.linear.app`) or the sync refuses it before anything is
  sent. A provider with no origin of its own — an ICS feed lives anywhere —
  names none, and the pin is the connection's own URL's origin. The `fetch` it hands the sync refuses any other origin and follows no
  redirect (`other_host`), and every request goes through core's
  `guardedFetch` with `connection:<name>` as the grantee — the same door the
  pool uses: filled only for a host on the secret's *Sent only to* list, over
  https, only when granted; everything that comes back redacted.
- **Where a value comes from.** A sync runs in the console, which never reads
  the Keychain. `metistry secrets sync --to env` delivers every secret a
  sync-read connection lists as `METISTRY_SECRET_<NAME>` (as it delivers a
  provider key to the engine, T4-18), and the sync's source reads it back.
  Unlike the engine's provider key, the value is never put on a request by
  its caller — the door fills it or refuses. Restart the console after the
  sync so it holds the line.
- **The owner's switches.** `syncs.<sync>.raise` in `scheduled.yaml`; a rule
  the file does not mention takes the collector manifest's default.

## Linear

The first `tracker` provider (plan §2.6, §4 Q22): GraphQL at
`https://api.linear.app/graphql`, a **personal API key** sent as
`Authorization: <API_KEY>` — no `Bearer`, which Linear's OAuth tokens take.
Capability `read` in this release; *Send to Linear* (`create`, T4-25) and
*Close in Linear* (`complete`, T4-26) add theirs when they land.

```sh
metistry secrets set linear_api_key                    # the value on stdin
metistry secrets hosts linear_api_key api.linear.app
metistry secrets grant linear_api_key connection:linear on
metistry connections add linear --type tracker --provider linear \
  --url https://api.linear.app/graphql \
  --auth api_key --auth-header Authorization --secret linear_api_key --no-discover
metistry secrets sync --to env                         # delivers it to the console; restart the console
```

**The sync** (`collectors/linear/`, every 15 minutes) reconciles the open
issues assigned to the key's own user into `work` — `external_ref
linear:<KEY>`, kind `issue`, with `meta` naming the connection, state,
priority and url — as `github-state` does for GitHub. An issue that leaves the
list is looked up once by id and its row closed with `meta.closed_reason`
(`completed`, `canceled`, `unassigned` or `gone`). The client sends read
queries only: a document that is not a `query` operation is refused before it
leaves (`not_a_query`).

**Needs You.** With `syncs.linear.raise.assigned` on (the default), each
assigned issue raises one `task` request — a mirror (T1-8): source `linear`,
the issue's creator as the person, trust `external` (the words are Linear's).
It clears as `resolved_at_source` when the issue is closed or given to someone
else; if it comes back, it is raised again. One the owner answered is not
raised again while the assignment lasts.

**Add to Today** — the task request's primary answer — captures `- [ ] <title>
do <today> linear:<KEY>` into `Inbox/` through the capture service
(`addIssueToToday`, `collectors/linear/today.ts`): `inbox.source` `linear`,
idempotent per issue (principal `tracker:linear`, key `linear:<KEY>`), so a
second press returns the first capture and writes nothing. The title is the
one the sync recorded, never text the caller sends; nothing writes the owner's
own notes. *The console door that calls it is not built yet* — the frozen
route table (plan §2.1) has no route for the `today` door.

## ICS feeds

The first `calendar` provider (plan §2.6; T4-12): an iCalendar subscription
feed (`.ics`), capability `read` — a subscription has no way back. Any
calendar that publishes one: a team or holiday calendar, a sports schedule, a
calendar made public in Google or iCloud.

```sh
metistry connections add holidays --type calendar --provider ics \
  --url https://example.com/holidays.ics --no-discover
```

Write a `webcal://` address as `https://`; plain `http://` is refused
(`not_https`).

**The sync** (`collectors/ics-calendar/`, every 15 minutes) reads the feed
through the door — pinned to the feed's own origin, no redirect followed, the
body capped at 10 MB — and writes today and the next two weeks into
`calendar_events` under the connection's name, beside the eventkit sync's rows
(T2-11): the same row, the same window, the same one-statement replacement, so
Today reads one table for every source. What it reads:

- **Recurrence** — `RRULE` (DAILY, WEEKLY, MONTHLY, YEARLY; INTERVAL, COUNT,
  UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), `RDATE`,
  `EXDATE`, and `RECURRENCE-ID` overrides (a moved, retitled or cancelled
  occurrence). A rule it does not expand (BYYEARDAY, BYWEEKNO, BYHOUR…, an
  HOURLY or finer FREQ) skips that series and is counted in `sync_state`
  (`skipped_rules`), never guessed at.
- **Time zones** — `…Z` is UTC; a `TZID` is an IANA zone when the runtime
  knows it, else the feed's own `VTIMEZONE` rules (Outlook's "Pacific Standard
  Time"), else the calendar's zone, and `sync_state.unknown_zones` names it; a
  floating time is the calendar's zone (`X-WR-TIMEZONE`), else the owner's
  (`METISTRY_TZ`); **an all-day date is the owner's midnight to midnight**. A
  series keeps its wall time across DST; a time DST skips moves forward by the
  gap, one it repeats is the earlier.
- **Keys** — an occurrence is keyed as EventKit's bridge keys one: the UID for
  a one-off, `<uid>_<original start>` for a series' occurrence
  (`_20260928T130000Z`, or `_20260928` all-day), so a moved occurrence keeps
  its meeting note.
- **Never the invite body.** `DESCRIPTION`, `COMMENT`, `ATTACH` and an alarm's
  text are never read, and `calendar_events` has no column for one. A feed does
  not say which attendee is the owner, so `self_status` is null.

**A feed address that carries a token is a secret** — Google's *secret address
in iCal format*, a published iCloud calendar, a `?token=` link. The file
refuses one (`reach.http.url: this looks like a key`), and `{{ secret.x }}` in
a URL is refused at the file and at the egress door (`secret_in_url`). **So
this release reads public feed addresses only**; how a secret that *is* a URL
reaches the wire is open for the owner (T4-12's PR). For a private Google or
iCloud calendar today: the eventkit bridge reads whatever the Mac's Calendar
shows, and CalDAV (T4-13) and Google (T4-14) are the read-and-reply providers.

One sync reads one connection: with two ICS connections, name the one it reads
in `scheduled.yaml` (`syncs.ics-calendar.connection`).

## Decisions made here

- **New connection defaults (the owner's answer to Q15, 2026-09-26).** Reads
  Allow · Changes things Ask First · Starts an agent Ask First; offer to agents
  off. A tool a custom server offers is filed under Changes things: the MCP
  spec calls tool annotations hints from an untrusted server, so `readOnlyHint`
  is shown and never acted on — the owner promotes a tool with `metistry
  connections policy`.
- **A tool that starts an agent is drawn in the Write column** of the
  permissions table (T4-6's reading, kept): the table has Read and Write, and
  starting an agent changes the world. `describePermissions` already does so.
- **The words are the owner's: Allow · Ask First · Never** (ruled 2026-09-26);
  the file keeps F-3's `on | ask | off`, and the CLI accepts both.
- **A GET never dials.** The console lists files; whether a server answers is
  `test` and `doctor`, and — from T4-8b — the console's own calls.
