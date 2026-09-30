# Connections — the files, the pooled client, and what it refuses

A **connection** is anything outside Metistry it reaches for the owner (plan
§2.6). This page is the contract `packages/connections` implements (T4-8a):
how a connection file is read, how Metistry dials one, and what the dial makes
impossible. The file's schema is F-3's (`packages/core/src/connections.ts`,
`docs/ops/extensions.md` *Connection files*); the verbs are `metistry
connections` (M13, `docs/ops/cli.md`); the read routes are `GET
/api/connections(/:name)` (`docs/ops/client-api.md`).

**The pool reaches MCP servers** — over Streamable HTTP or by starting a
command (stdio) — **and API, feed and files connections through the tools
Metistry generates for them** (T4-10, *Generated tools* below). Every HTTP
auth shortcut dials: none, bearer, an API-key header, Basic (a type that
declares it) and **OAuth** (T4-10, *OAuth* below). The other types have their
own consumers and tickets: an **agent** connection is a target a task is
dispatched to (T4-11, *Agent connections* below), and calendar and mail
providers are T4-13…T4-15. A **tracker** or **calendar** connection is read
by its provider's sync — Linear is the first tracker (T4-24, *Linear* below),
an ICS feed the first calendar (T4-12, *ICS feeds* below). A **mail** connection
is a mailbox over IMAP (T4-15, *Mail over IMAP* below) — a reach class of its
own. Asking the pool to
dial one of those is refused `not_built`, naming what reaches it instead.

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
- **An OAuth sign-in that names its client in the wrong place** (core's
  schema, C118): a custom connection carries its client model on the auth
  shortcut — `client: { authorize_url, token_url, scopes, pkce, redirect }`
  (https endpoints, scopes declared, PKCE on a loopback) beside `token`,
  `client_id` and an optional `client_secret`, each a `{{ secret.name }}` — and
  is refused without one; a typed connection takes its client from its
  connection type and keeps the references in its `oauth` field
  (`config.<field>`), and is refused the custom shape. A client id or secret
  written as text is refused: the owner's client is a secret.

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
  *Sent only to* list (the same refusal the egress door makes) — or an IMAP
  connection's app password is not listed for its exact `host:port`.

The reach is summarised by class: `http` (URL, auth scheme, header and query
names), `command` (command, arguments, environment names), `path`, and `imap`
(host, port, `tls` or `plain`, `auth: basic` — never the username).

An **OAuth** connection says more before any call: `absent` — *not signed in
yet* — until its token secret has an item, and `failed` while a sign-in
secret may not go where it must (the token secret to the token endpoint and
the service, the owner's client id to the authorize and token endpoints).

*Used by* is what reads it today: the syncs in `scheduled.yaml` that name it,
and the sync its provider declares when that sync reads it (the rule *A sync
reading its connection* below applies).

Beside the rows, the listing serves **the installed connection types**
(`describeConnectionTypes`; `GET /api/connections` → `types`, and each
detail's `provider_unit.type`, T6-13b): every unit the registry loads — seed
and extensions alike — with its fields **by kind** (`text` · `secret` ·
`variable` · `url` · `choice` · `oauth`), so the Mac renders a known service's
form from the manifest and no service has Swift of its own. A `secret` field
carries no default by schema, and an `oauth` field is served as its kind alone
— nothing of the client. Filling a field is `metistry connections add|set
--config KEY=VALUE` (`docs/ops/cli.md`), judged against the same manifest.
Agents reach a connection through the lazy pair `connections_list` /
`connections_call` (below), which the console mounts over its own pool
(T4-10); who reaches which is the owner's offer switch and each agent's grant.

## The pooled client

`ConnectionPool` holds one long-lived MCP client per connection — a stdio
child or a Streamable HTTP session — opened on first use, reused, closed after
ten idle minutes (the host's `idleMs`) or when the connection's plan changes (an
edit to its file, to a variable it uses, or to a grant its command's
environment depends on), with the server's `tools/list` cached until it sends
`notifications/tools/list_changed`. The pool reads the catalog on every call,
so an edit takes effect without a restart. It is a library: the process that
holds it is the one whose calls it makes — `metistry connections add|test` and
`metistry doctor` in the CLI, and **the console**, which builds one pool over
the instance's catalog and mounts it behind the lazy pair and the Approve path
(T4-10, *The console's pool* below). A proxied call's `runs` row is
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
| `secret_reference` | the arguments carry a `{{ secret.… }}` reference (T4-10). The door fills a reference wherever it finds one, so a reference a caller writes — into an issue body, say — would be a value the caller chose where to send. Refused for every connection, before anything is dialled; the wire says `invalid_request` |
| `sign_in` | an OAuth connection that cannot sign in: no client id (the type ships none and the owner brought none), the broker (designed, not built), or the provider refused the refresh (`invalid_grant` — sign in again with `metistry connections authorize <name>`). A sign-in with no item is the egress door's `missing_secret`, naming the token secret |
| `unknown_connection`, `not_ready` | no such file; a file that is `failed` or `absent`, with its issues |
| `variable` | a `{{ variable.x }}` that does not fill |
| `secret` | a command's environment needs a secret that is not granted **on** to `connection:<name>` (Ask First cannot hold there: an environment is filled once, at spawn, so there is no call to approve), or has no item |
| `runs_elsewhere` | `runs_on` names a place this process is not |
| `not_built` | a connection the pool does not dial: an agent connection (dispatch, T4-11), a calendar, mail or tracker (its provider's sync), a builtin provider's, or a command reach on a type with no generated tools |
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
connection, principal, since and ok. `activity_feed` (Ruling 28) shows the
same row on the timeline — connection and upstream tool named, never an
argument or a secret — and `turn_progress` joins it into the strip of one
turn's calls like any other tool row.

**The console's pool** (T4-10; the owner's ruling of 2026-09-30, Q10 — open
since #374). The console builds **one** `ConnectionPool` over the instance's
catalog (`apps/console/src/connections-proxy.ts`) and hands it to `/mcp` and to
the Approve path that runs an Ask First call. Its values are the ones
`metistry secrets sync --to env` delivers as `METISTRY_SECRET_<NAME>` — every
secret an `ok` MCP, API, feed or files connection lists, beside a sync's
(`consoleSecretNames`) — filled at the egress door for each secret's listed
hosts; the console never reads the Keychain. After adding a connection or
signing one in, run `sync --to env` and restart the console. A console with no
instance directory (the compose shape) builds no pool, and both tools answer
`not_available` — the fail-closed end. An agent's registry `grants` carry
`connections` (X-8), and a crew needs its manifest's `connections` group too.

## `check()`

`checkConnection` is the connection's `check()` (core's frozen shape): dial it
through the pool, `initialize`, `tools/list`, and compare what the server
offers with what the file lists. A generated type has no server to list
tools: the check reaches the service once (a GET, the feed read, the folder
listed) and compares the tools Metistry generates with the file.

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
opens is `openSyncHttp` (`packages/connections`, `sync.ts`) — or, for a
mailbox, `openSyncImap` (T4-17): the same choice of connection and the same
delivered secret, handed to the IMAP provider's own host guard (*Mail over
IMAP*, below) instead of an HTTP door:

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
- **OAuth sign-in** (`auth: oauth` — Google Calendar, T4-14). The delivered
  secret is the connection's **refresh token**; the sync's door fills
  `Bearer {{ secret.<token> }}` with an **access token** minted from it at the
  token endpoint (T4-10's `OAuthTokens`: its own guarded request, pinned to
  that endpoint, no redirect) and held in the console's memory — one per
  connection, reused across runs until a minute before it expires. A sync
  that knows its provider's hosts passes them (`tokenHosts`), and the token
  secret's *Sent only to* list must be **exactly** those, or the connection
  is not opened and nothing is sent (`failed`, naming the `metistry secrets
  hosts` line). A refused refresh is `sign_in`, naming `metistry connections
  authorize <name>`.
- **One connection, several syncs** (T4-11). A type names its first sync in
  `sync:` and any others that read the same connection in `also_read_by:` —
  the Devin connection is read by `devin-sessions` and by `devin-knowledge`.
  Each finds it by the same rule; `sync:` is the one `add` names in
  `scheduled.yaml`.
- **A further origin is the code's, never the file's.** A sync may name an
  origin its product code reaches for the same service beside the
  connection's own (`devin-knowledge` names `https://mcp.devin.ai`, where the
  repo wikis are); nothing in a connection file can add one, and the key is
  still filled only for the hosts its *Sent only to* list names.
- **The connection's config.** The sync is handed the connection's text
  config values (`config.repos`, `config.org`) — never a secret field's.

**Which collectors are syncs of a connection (T4-11).** Beside Linear and
the calendar providers (ICS, CalDAV, Google Calendar): **GitHub** (`github-state` reads the
`github` tracker connection — its read-only token, its `repos`; still
read-only, `readOnlyGithub` wraps the door, and pinned to
`https://api.github.com`), and **Devin** (`devin-sessions` and
`devin-knowledge` read the `devin` agent connection — its key, its `org` and
`repos`). A connection that is there but wrong fails the run by name; it
never falls back to an older key. **For one release** a collector with no
connection still reads its legacy environment (`METISTRY_GITHUB_TOKEN` +
`METISTRY_GITHUB_REPOS`, `METISTRY_DEVIN_API_KEY`), so an install keeps
running until the owner adds the connection. Two stay outside, and why:
**AWS Costs** signs each request with SigV4, which needs the secret key's
value in the process to compute the signature — a door that fills a
reference cannot sign; and **Calendar** (`eventkit-calendar`) reads the
eventkit bridge with the bridge's own token, which is the bridge's wire
contract, not a connection's secret.

```sh
metistry secrets set github_token                     # a read-only fine-grained PAT, on stdin
metistry secrets hosts github_token api.github.com
metistry secrets grant github_token connection:github on
metistry connections add github --type tracker --provider github \
    --url https://api.github.com --auth bearer --secret github_token \
    --config repos=owner/a,owner/b --no-discover
metistry secrets sync --to env                        # then restart the console
```

## Agent connections — targets as connections (T4-11)

An **agent** connection is somewhere work is sent (plan §2.6): today's two
HTTP targets, `targets/devin-sessions` and `targets/github-issues`, moved
into connection types — `seed/connection-types/devin/` and
`seed/connection-types/github-issues/`. The split is where each thing
belongs:

| Where | What |
| --- | --- |
| the **type** (`dispatch:`) | the dispatcher (closed: `devin-session`, `github-issue`), the **data policy** a brief is held to, the **purposes** with their preambles (Devin's — `DEVIN_PURPOSES` moved here), the result path, the cost, Devin's ACU ceiling |
| the **connection** | where it goes (`reach.http.url`), the key it goes with (`secrets`, by name), and its fields: Devin's `org` (and `repos` for its wikis), GitHub Issues' `repo` |

**Dispatch is unchanged.** The console's target registry
(`apps/console/src/dispatch.ts`) reads the instance's agent connections
afresh on every `GET /api/targets` and every `POST /api/tasks/:id/dispatch`
and presents each as the target `dispatch()` already knows: the same data
policy check, the same `runs` row, the same work-row binding, the same
return path (`devin-sessions` polls a Devin session home; `github-state`
reconciles the issue). A connection of the same name as a `targets/`
manifest wins (D4) — except the crews' `local-crew`, which a connection can
never take.

**What changes is where the key comes from.** A connection-backed target's
requests go through the connection's door (`openAgentHttp`,
`packages/connections`): the key is a `{{ secret.x }}` reference in the
Authorization header, filled by core's `guardedFetch` for the hosts its
*Sent only to* list names, only when granted to `connection:<name>`; the
response is redacted; no redirect is followed. GitHub Issues is pinned to
`https://api.github.com` whatever the file says. The console fills these
secrets from `metistry secrets sync --to env` (`consoleSecretNames` lists an
agent connection's).

**Refused, each before anything is sent:**

| Refusal | Why |
| --- | --- |
| a brief or task title carrying `{{ secret.… }}` or `{{ variable.… }}` — 400 | the door fills a reference wherever it finds one, so a brief never carries one (the pool's `secret_reference`, T4-10) |
| a key not granted to the connection, or bound for a host its list does not name — 409 *target unavailable*, by name | the egress door's rule |
| a repo that is not `owner/repo` (or a `.`/`..` part), an org that is not an id — the connection is unavailable, naming why | they go in a URL path |
| a purpose the target's type does not take — 400 | the purposes are the type's |
| an agent connection named `local-crew` | it is the crews' target |

**The data policy is the type's**, so a connection file cannot widen it.
Devin's is empty on purpose (a third party with a train-on-your-data
default may be sent no vault citation); the owner widens it by overlaying
the type — `.metistry/extensions/devin/manifest.yaml` — exactly as a target
was widened by overlaying the target.

**Not through the proxy.** An agent may not dispatch through
`connections_call`: the pool refuses an agent connection `not_built`, and a
task is sent only by the owner's dispatch door.

```sh
metistry secrets set devin_api_key                    # the cog_ key, on stdin
metistry secrets hosts devin_api_key api.devin.ai mcp.devin.ai
metistry secrets grant devin_api_key connection:devin on
metistry connections add devin --type agent --provider devin \
    --url https://api.devin.ai --auth bearer --secret devin_api_key \
    --config org=org-… [--config repos=owner/repo] --no-discover
metistry secrets sync --to env                        # then restart the console

metistry secrets set github_write_token               # Issues read/write + Metadata on ONE repo
metistry secrets hosts github_write_token api.github.com
metistry secrets grant github_write_token connection:github-issues on
metistry connections add github-issues --type agent --provider github-issues \
    --url https://api.github.com --auth bearer --secret github_write_token \
    --config repo=owner/repo --no-discover
```

**For one release** the `targets/` manifests and their `env:` keys load
beside the connections, so an install's dispatch keeps working until the
owner adds them; a `targets/` Devin manifest dispatches with the Devin
type's purposes.

## Linear

The first `tracker` provider (plan §2.6, §4 Q22): GraphQL at
`https://api.linear.app/graphql`, a **personal API key** sent as
`Authorization: <API_KEY>` — no `Bearer`, which Linear's OAuth tokens take.
Capabilities `read` (the sync), `create` (*Send to Linear*, T4-25) and
`complete` (*Close in Linear*, T4-26).

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
(`completed`, `canceled`, `unassigned` or `gone`). The sync sends read
queries only: a document that is not a `query` operation is refused before it
leaves (`not_a_query`); the one change the client can send is Close in
Linear's fixed mutation, below.

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
own notes. The console door that calls it is `POST /api/today/add` (X-12,
`docs/ops/client-api.md`); a GitHub `task` mirror is not wired to it yet (X-58).

**Send to Linear** — from a task line, two doors, one service each
(docs/ops/client-api.md): `POST /api/trackers/<connection>/issues
{task_key, title?, team?}` files the issue, and `POST
/api/vault-tasks/<task_key>/link {ref, seen_text}` writes `linear:<KEY>` on the
line. The first goes through the connection the sync reads, only while its
provider declares `create`, with the same door as the sync: the key filled for
`api.linear.app` only, no redirect followed. It sends one fixed mutation
(`issueCreate` with an id, a team and a title — `createLinearIssue`,
`packages/connections/src/linear-issue.ts`) and nothing else of the note. It is
**idempotent by task key** with no state of its own: the issue's id is derived
from the connection, the note and the task key, and looked up before anything
is created, so a second press answers the first issue and two presses racing
meet at Linear, which refuses the second id. The team is the one named, or the
owner's only team; with several, the answer lists them. The issue is filed
unassigned and without a due date or priority — the title alone.

**Completion both ways** (T4-26). *Metistry → Linear:* ticking a task whose
line carries `linear:<KEY>` offers *Close <KEY> in Linear* —
`POST /api/trackers/<connection>/issues/<KEY>/complete`
(`collectors/linear/complete.ts`), which reads the issue and, if it is still
open, sends one fixed mutation moving it to its team's first `completed`
state; an issue already closed is left as it is. The setting is the
connection's tool `complete_issue`, which the `linear` type declares under
*Changes things*:

```sh
metistry connections policy linear complete_issue ask     # Ask First (the default): the client offers it
metistry connections policy linear complete_issue allow   # always: the client closes it after every tick
metistry connections policy linear complete_issue never   # the door refuses, and nothing is sent
```

Never is enforced at the door, not in the client. The door opens the
connection the path names through the same egress door the sync reads
through, and writes Postgres only — the issue's `work` row closes and its
request resolves at source. *Linear → Metistry:* an issue closed in Linear
closes its `work` row on the sync's next pass, and `GET /api/today` names
each open line carrying its key in `tracker_closed`, which the client shows
as *Done in Linear* with a one-click Tick. **No sync path writes a vault
file**: the owner's line stays open until the owner ticks it.

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
ICS reads public feed addresses only** — and stays that way: the owner ruled
on 2026-09-30 (Q8) that there is **no secret-in-URL door** and private ICS
feeds stay out. For a private Google or iCloud calendar: the eventkit bridge
reads whatever the Mac's Calendar shows, and CalDAV (*CalDAV* below; T4-13)
and Google Calendar (*Google Calendar* below; T4-14, signed in with Google)
are the read-and-reply providers.

One sync reads one connection: with two ICS connections, name the one it reads
in `scheduled.yaml` (`syncs.ics-calendar.connection`).

## CalDAV — iCloud, Fastmail, any RFC 6638 server

The first calendar Metistry can **answer** (plan §2.6, §4 Q7 first; T4-13):
CalDAV with an **app password**, capabilities `read`, `write_own` and `rsvp`.
Three connection types over one builtin module (`caldav`): `icloud-calendar`
and `fastmail-calendar` — known services, each naming its server — and
`caldav` for any other.

```sh
metistry secrets set icloud_app_password                  # an app-specific password, on stdin
metistry secrets hosts icloud_app_password caldav.icloud.com
metistry secrets grant icloud_app_password connection:icloud on
metistry connections add icloud --type calendar --provider icloud-calendar \
  --url https://caldav.icloud.com/ \
  --auth basic --username you@icloud.com --secret icloud_app_password --no-discover
metistry secrets sync --to env                            # delivers it to the console; restart the console
```

| Type | Server | Username | Password |
| --- | --- | --- | --- |
| `icloud-calendar` | `https://caldav.icloud.com/` (and the account's own `p<NN>-caldav.icloud.com`) | the Apple Account's email | an app-specific password (account.apple.com) |
| `fastmail-calendar` | `https://caldav.fastmail.com/dav/` | the account's email | an app password with CalDAV access |
| `caldav` | the server's CalDAV address | as the server says | an app password, where the server has them |

**Sign-in** is Basic (RFC 7617) with the app password as a secret of the
connection: the file says `auth: { scheme: basic, username, secret }`, the
sync holds `Basic {{ secret.<name> }}`, and the egress door encodes and fills
it — for a host on the secret's *Sent only to* list, over https, when granted
to `connection:<name>` — or refuses (`sync.ts`, *A sync reading its
connection*). The password is never in a URL, the file, a log, a run or an
error; a server that echoes it gets the secret's name back.

**Basic sign-in is CalDAV's alone**: the three types declare `auth: [basic]`,
and core's `connectionIssues`, the CLI and `openSyncHttp` refuse basic on any
connection whose type does not (a tracker, a feed, a custom MCP server).

**Refused at the file** (`caldavConnectionIssues`, before anything is sent or
written): **a Google address — *Google needs sign-in with Google*** (Google's
CalDAV takes OAuth only and answers Basic with a 401; Google Calendar is its
own type, T4-14); a known service pointed anywhere but its own hosts; plain
`http://` off this Mac; any sign-in but an app password.

**iCloud's numbered host.** iCloud keeps each account's calendars on a host of
its own (`p<NN>-caldav.icloud.com`). A connection reaches one origin, so the
first sync names that host and fails, sending it nothing: `metistry
connections set icloud --url https://p<NN>-caldav.icloud.com/` and `metistry
secrets hosts icloud_app_password p<NN>-caldav.icloud.com`, and the next run
reads it. The same holds for any server that names an address on another
origin (`other_host`).

**The sync** (`collectors/caldav-calendar/`, every 15 minutes): discovery
(the principal, its calendar home, its **calendar user addresses** and whether
it schedules), every calendar in the home that holds events, and a
`calendar-query` for today and the next two weeks — each event expanded by the
ICS provider (recurrence, zones and keys exactly as *ICS feeds* reads them)
into `calendar_events` under the connection's name. Unlike a feed, the server
says who the owner is: the attendee whose address is one of the owner's is
`self`, and their answer is `self_status` — what an invitation request (T4-17)
reads. `sync_state` records the window, the calendars and resources read, and
whether the server schedules. Never the invite body.

**Invitation requests** (T4-17; `syncs.caldav-calendar.raise.invitation`, on by
default — the eventkit sync raises them too): a meeting still to come whose
owner's answer is needs-action and which someone else organises raises one
`invitation` request per meeting (its UID), cleared when the owner answers —
here or in their calendar — or the meeting is cancelled or passes
(`collectors/invitations.ts`; `docs/ops/client-api.md`, *Invitation and
message requests*). The Mac's own calendar cannot answer one; a CalDAV
connection holding the same meeting answers for it.

**Reply** (`rsvp`; `previewReply`, then `respondToInvitation`): RFC 6638
§3.2.2 — an attendee changes `PARTSTAT` in its own copy and the server "MUST
deliver an iTIP REPLY". **Only the owner's own attendee line changes** — in the
event and in each moved occurrence the owner is in: `PARTSTAT` set, `RSVP` and
`SCHEDULE-STATUS` dropped, the line refolded at 75 octets. Every other byte is
the server's, a VALARM's attendee (an email alarm) included. Answers:
`accepted`, `tentative`, `declined`; a series is answered whole. Refused:
`not_invited` (the owner organises it, or is not an attendee), `no_scheduling`
(the server does not implement RFC 6638, names no address for the owner, or
the organizer's copy says `SCHEDULE-AGENT=CLIENT` — a reply that would never
arrive), `not_found`.

**Write own** (`write_own`): create (`previewCreateEvent` / `createOwnEvent`,
`If-None-Match: *`, the resource named for its UID, no organizer and no
attendee), change a title, place or time (`previewChangeEvent` /
`changeOwnEvent`) and delete (`previewDeleteEvent` / `deleteOwnEvent`) — **only
an event nobody else is in**: changing a meeting would send every attendee an
update, which this capability never does (`not_own`). A series is not
rewritten (`unsupported`).

**Preview, then confirm.** Every change previews first — which lines change,
as whom, to whom — with the event's ETag; the confirm names that ETag, is
re-derived from the server's copy (never a body the caller sends) and written
with `If-Match`, so an event that changed in between is refused (`changed`),
never overwritten. The confirm token and who may press it belong to the
console door — **Respond** is `POST /api/calendar/invitations/:id/respond`
(T4-17: the connection is found among every calendar holding the meeting, by
its provider's `rsvp`; refused, *Open in Calendar*, where none can);
`write_own`'s door is not built yet. No agent reaches any of it: a calendar
connection is not dialled as MCP.

## Google Calendar — signed in with Google (T4-14)

Google Calendar through the Calendar API v3 (plan §2.6, §4 Q7 second; ruling
2026-09-30, Q8): the `google-calendar` connection type, capabilities `read`,
`write_own` and `rsvp`, over one builtin module (`google-calendar`). Google's
CalDAV takes OAuth only, so this is the one way Metistry answers a Google
invitation — and there is **no secret-in-URL door**: Google's *secret address
in iCal format* stays out.

```sh
metistry connections add google --type calendar --provider google-calendar \
  --url https://www.googleapis.com/calendar/v3/ --auth oauth
metistry connections authorize google                    # the browser opens at accounts.google.com
metistry secrets sync --to env                           # delivers the sign-in to the console; restart the console
```

**Sign-in is Metistry's own OAuth door** (*OAuth* below, T4-10): PKCE, a
one-shot listener on 127.0.0.1, the `state` checked, the code exchanged at
`oauth2.googleapis.com` through the egress door; the **refresh token** kept in
this instance's Keychain as the connection's token secret, the **access
token** only in the memory of the process that dials. The scope is
`https://www.googleapis.com/auth/calendar.events` and nothing else — events
on calendars the owner can reach, no calendar list, no settings, no Gmail —
so the sync reads the owner's **primary** calendar.

**The client.** The type's manifest ships **Metistry's public client id** — the
maintainer's *Desktop* client in Folded Space Labs' Google Cloud project,
public by design: an installed app cannot keep a secret, Google says so, and
PKCE is what binds a code to its sign-in. **Until that client exists the
manifest ships none**, and a connection signs in with the owner's own
(`metistry secrets set google_client_id`, `metistry secrets hosts
google_client_id accounts.google.com oauth2.googleapis.com`, `metistry
secrets grant google_client_id connection:google on`, then `add … --client-id-secret
google_client_id` or `metistry connections set google --client-id-secret
google_client_id`). **A bring-your-own client id always overrides the
shipped one.** A client secret — Google may ask for the one its Desktop
clients carry — is always the owner's secret (`--client-secret-secret`,
hosts `oauth2.googleapis.com` only), never a manifest's.

***Google hasn't verified this app.*** Until Google verifies Metistry's
client, Google shows that warning for its sensitive `calendar.events` scope.
The connection type says so — the oauth field's `help`, which `metistry
connections authorize` prints before the browser opens when the shipped
client is used (and the Mac's connection sheet shows) — *choose Advanced,
then Go to Metistry*. Removed from the manifest when verification completes.

**Exactly two hosts.** The first sign-in writes the token secret's policy:
sent only to `oauth2.googleapis.com` (the refresh token, to mint an access
token) and `www.googleapis.com` (the access token), granted to the connection
alone. The sync holds it to **exactly** those two (`GOOGLE_TOKEN_HOSTS`): a
list that says more or less, and the connection is not opened. Every request
is pinned to `https://www.googleapis.com` and follows no redirect.

**Refused at the file** (`googleCalendarConnectionIssues`): a connection
anywhere but `https://www.googleapis.com/calendar/v3/`; any sign-in but
Google's (`auth: [oauth]` — never an app password); headers or query
parameters of its own.

**The sync** (`collectors/google-calendar/`, every 15 minutes):
`events.list` on the primary calendar for today and the next two weeks, with
`singleEvents=true` — Google expands each series, and each occurrence's own id
(`<series>_20260928T133000Z`) is its `event_id` — into `calendar_events` under
the connection's name. It asks with `fields=` for named fields only: **the
description, the meeting link and the dial-in are never requested**, and
never read if a server sends them. Google marks the owner's attendee
(`self`), so `self_status` is the owner's own answer. A cancelled occurrence
and a working-location marker are skipped and counted in `sync_state`.

**Reply** (`rsvp`; `previewGoogleReply`, then `respondToGoogleInvitation`):
the Calendar API's `attendees[].responseStatus` is writable, and
`attendeesOmitted` "can be used to only update the participant's response".
**The PATCH body is exactly** `{"attendeesOmitted": true, "attendees":
[{"email": "<the owner's address>", "responseStatus": "<answer>"}]}` — the
owner's own answer and the address that names it; no other attendee, no
time, no title. `sendUpdates=all`, so the organizer hears it as they would
from Calendar. Answers `accepted`, `tentative`, `declined`, for the
occurrence named (a series' id answers the series). Refused: `not_invited`
(the owner organises it, or is not an attendee), `unsupported` (not a
meeting, or Google left out the guest list), `not_found`.

**Write own** (`write_own`): create (`previewCreateGoogleEvent` /
`createOwnGoogleEvent` — the preview mints the event's id, so a second
confirm finds it made, `exists`), move or retitle (`previewChangeGoogleEvent`
/ `changeOwnGoogleEvent` — one occurrence of a series moves alone) and
delete (`previewDeleteGoogleEvent` / `deleteOwnGoogleEvent`), each with
`sendUpdates=none` — **only an event nobody else is in**, organised by the
owner (`not_own`); a series itself is not rewritten, and an out-of-office or
working-location event is changed in Google Calendar (`unsupported`).

**Preview, then confirm** — as CalDAV's: the preview reads the event now and
says the exact body the confirm will send, with the event's ETag; the confirm
names that ETag, re-reads the event, re-derives the body from Google's copy
and writes with `If-Match`, so an event that changed in between is refused
(`changed`), never overwritten. The console doors that call these — Respond
(`POST /api/calendar/invitations/:id/respond`, T4-17: a series is answered
at its master, `recurringEventId`, so one card is one answer) and own-event
changes — hold the confirm token; no agent reaches any of it (a calendar
connection is not dialled as MCP). The sync raises invitation requests as the
CalDAV sync does (`syncs.google-calendar.raise.invitation`, on).

## Mail over IMAP — Gmail, any IMAP server

The first `mail` provider (plan §2.6, §4 Q8; T4-15): IMAP with an **app
password**, capabilities `read` and `draft`. **Nothing sends mail** — there is
no SMTP anywhere, and IMAP cannot send. Two connection types over one builtin
module (`imap`): `gmail-mail`, a known service pinned to `imap.gmail.com:993`,
and `imap` for any other server. The Gmail API is not used (§4 Q8).

**Gmail needs 2-Step Verification and an app password.** Google ended
password sign-in for IMAP on 2025-03-14, except for app passwords (Google
Workspace, *Transition from less secure apps*). Turn on 2-Step Verification
(myaccount.google.com → Security), make an app password
(myaccount.google.com/apppasswords — 16 letters, without the spaces Google
shows), and check IMAP is on in Gmail (Settings → Forwarding and POP/IMAP; a
Workspace admin can turn it off). Then:

```sh
metistry secrets set gmail_app_password                   # the app password, on stdin
metistry secrets hosts gmail_app_password imap.gmail.com:993
metistry secrets grant gmail_app_password connection:gmail on
metistry connections add gmail --type mail --provider gmail-mail \
  --imap imap.gmail.com:993 --username you@gmail.com --secret gmail_app_password
metistry connections test gmail                           # signs in, lists folders, finds [Gmail]/Drafts
metistry secrets sync --to env                            # the mail sync reads it: then restart the console
```

| Type | Server | Username | Password |
| --- | --- | --- | --- |
| `gmail-mail` | `imap.gmail.com:993`, TLS — nowhere else | the Google Account's address | an app password (2-Step Verification on) |
| `imap` | the server's IMAP host (`--imap host[:port]`, 993 unless given) | as the server says | an app password, where the server has them |

**A reach class of its own.** A mailbox is not an HTTP service, a command or a
path, so the file says `reach: { imap: { host, port, security, username,
secret } }` (core's `reachSchema`; port 993, `security: tls` by default). A
connection type reached by `imap` must provide `mail` and declare `auth:
[basic]` — a username and an app password is the only sign-in.

**The host guard** (core's `planSocketEgress`, run before anything is dialled —
the socket's counterpart of `guardedFetch`): the app password goes only to the
exact `host:port` on the secret's *Sent only to* list (`imap.gmail.com:993`,
not `imap.gmail.com`), only over TLS — verified certificate and host name, TLS
1.2 or later — and only when granted to `connection:<name>`; each refusal is
the door's own code (`host_not_listed`, `cleartext`, `not_granted`,
`needs_approval`, `missing_secret`). The value is written into the one LOGIN
command and nowhere else, and learned by the redactor first: a server that
echoes it, or an error that carries it, shows `***REDACTED
secret.<name>***`. `security: plain` (`--plain`) is for a server on this Mac —
a local mail bridge — and is refused for any other host.

**Refused at the file** (before anything is written or dialled): a mail
submission port (25, 465, 587, 2525); plain off loopback; a host that is not a
lowercase host name (no scheme, port or path); a username with a quote,
backslash, control character or template; Gmail pointed anywhere but
`imap.gmail.com:993` over TLS; an `imap` type without `auth: [basic]`; a
custom mail connection (nothing runs it).

**No code path can send — a closed command set.** Every command line passes
one function (`imapCommandLine`) that knows nine commands — `CAPABILITY`,
`LOGIN`, `LIST`, `EXAMINE`, `UID SEARCH`, `UID FETCH`, `APPEND`, `NOOP`,
`LOGOUT` — each with one fixed argument shape. `SELECT`, `STORE`, `COPY`,
`MOVE`, `EXPUNGE`, `DELETE`, `CREATE`, `RENAME`, `STARTTLS` and `AUTHENTICATE`
are refused by name; a body fetch, a flag store, or a second command after a
line break is refused before a byte is written (`command_refused`). A
submission port is never dialled, even when handed one directly.

**Read** (`readHeaders`): `EXAMINE` — read-only, so reading never marks a
message read — then `UID SEARCH` (all, or since a day) and one `UID FETCH` of
fixed items: `UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE
FROM SENDER REPLY-TO TO CC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID
AUTO-SUBMITTED PRECEDENCE)]`. The items are a constant, so **no body is ever
fetched** — §4.12's rule, *the reference, not the content*. Each message comes
back with a `ref` (`<connection>/<mailbox>/<uidvalidity>/<uid>`), its header
text decoded (RFC 2047, RFC 6532), stripped of bidi and zero-width controls and
a leading slash (core's `sanitizeForAgent`) and capped, `automated` when a list
or an automatic sender says so (the deterministic prefilter §4.12 asks for),
and **`source: comms`** — the provenance the data policy's `deny_sources`
names, so a brief that carries it never leaves the machine (`checkBrief`,
`docs/ops/targets.md`). At most 500 messages per read, the newest.

**Draft** (`draft`; `previewDraft`, then `appendDraft`): a plain-text RFC 5322
message (UTF-8, base64 body; To and Cc as addresses only — no Bcc), threaded
with `In-Reply-To` and `References`. The preview returns the exact bytes, a
digest and where it would go; the confirm re-renders from the same input with
the preview's date and Message-ID and **refuses a different digest**
(`changed`), writing nothing. `APPEND` takes no mailbox from the caller: it
writes to the one mailbox the server marks `\Drafts` (RFC 6154) — else a
top-level `Drafts` — flagged `\Draft \Seen`, and never to Sent or an Outbox
(`no_drafts` when there is none). The owner sends it from their mail app. The
confirm token and who may press it belong to the console door (`POST
/api/mail/messages/:id/draft`, T4-17).

**`check()`** (`metistry connections test`, doctor): sign in, `LIST`, find
Drafts, `EXAMINE INBOX` — no message fetched — `LOGOUT`. `ok`; `degraded`
when there is no Drafts mailbox (reading works, a draft would be refused);
`failed` on a refused sign-in — *sign in with an app password (for Gmail:
2-Step Verification on, then an app password)* — or an unreachable server or
certificate; `absent` with no app password in this instance's Keychain.
`meta` is `{ mailboxes, drafts, inbox_messages }`. The pool opens a mailbox
only for the IMAP module (`openImap`) and never dials one as MCP; no agent
reaches it.

**The sync** (`collectors/mail-messages/`, every 15 minutes, T4-17): both IMAP
types declare `sync: mail-messages`, so `metistry secrets sync --to env`
delivers the app password to the console and the sync opens the mailbox
through `openSyncImap` — the host guard above, nothing dialled until a
session opens. Each pass reads the headers of the last week of `INBOX`, and
of the mailbox marked `\Sent` (only its `In-Reply-To` and `References` — which
messages the owner answered), and raises a **`message` request** for each
message that looks like it waits on the owner's reply — **inferred from the
headers alone**, by rules, and saying so (`payload.inferred`, the reason in
words): the owner's address (the sign-in name) in To — R7, the source names
the owner; from a person, not the owner, a list, an automatic sender or a
no-reply address; unanswered; and a reply in a conversation or written to the
owner alone. Once per message (by Message-ID); cleared when the owner
replies, it leaves the inbox, or it is a week old. A sign-in name that is not
an address raises nothing (`sync_state.owner: unknown`). No body is fetched,
so none can reach a request, the assistant or an agent; reading a body to
infer from waits on §4.12's PoC-13 re-run bar. `syncs.mail-messages.raise.message`
turns the raise off.

**Draft Reply** is `POST /api/mail/messages/:id/draft` (T4-17): the message's
headers read again by its reference (`readMessage`), the reply addressed from
them — Reply-To, else From; never an address the caller sends — previewed,
then APPENDed to Drafts only as previewed. Nothing sends.

## Generated tools — an API, a feed, files (T4-10)

A connection that is not an MCP server is reached through tools Metistry
generates for it (C115: "non-MCP types get generated tools") — offered by the
same lazy pair, fetched only by `connections_list { connection }` and never on
the bridge's eager `tools/list`, and held to every rule above: the file's
`tools:` is the allowlist, the owner's mode decides how each runs, every
request leaves through the egress door, every call is a `connection_call`
row. The set is closed (`packages/connections/src/generated.ts`):

| Type · reach | Tool | Group | Does |
| --- | --- | --- | --- |
| api · http | `get` | Reads | GET a path under the connection's URL; answers the status, the content type and the body (JSON parsed) |
| api · http | `request` | Changes things | POST, PUT, PATCH or DELETE under the URL; a JSON body as JSON, a string as text |
| feed · http | `list_items` | Reads | RSS 2.0, RSS 1.0 or Atom: id, title, link, date, a short summary |
| feed · http | `get_item` | Reads | one item by id, its full summary |
| feed · http | `search_items` | Reads | items whose title or summary holds the words |
| files · path | `list_files` | Reads | one folder level: path, file or folder, size |
| files · path | `read_file` | Reads | a text file (a binary one is refused) |
| files · path | `search_files` | Reads | matching lines, with their paths and line numbers |
| files · http | `read_page` | Reads | the page at the URL, HTML reduced to text |

`metistry connections add` writes them **every one at Ask First** — the
default for a proxied tool (CLAUDE.md), taken whole for a service nobody has
yet seen answer through Metistry; `policy <name> <tool> allow` moves one. A
tool that changes something (`request`) is preview-then-confirm at Allow and
waits for the owner's Approve at Ask First, like any proxied tool.

What each makes impossible, before anything is sent: **leaving the
connection** — an API path is relative and resolves under the URL (same
origin, same path prefix; a scheme, `//host`, a leading `/`, `..` or an
encoded climb is refused), a files path resolves under the folder (`..` and an
absolute path are refused, and a symbolic link that leads outside is refused
once resolved; a listing and a search do not follow links at all); **a
caller's query parameter replacing one the file sets**; **a caller's header**
(the headers are the file's and the auth shortcut's). Hidden files stay hidden
and the include and skip patterns apply (`*` within a name, `**` across
folders; a pattern with no `/` matches a name anywhere). Every read is capped
— 256 KB of an answer or a page, 5 MB of a feed, 1 MB of a file, 5,000 files
per search — and says so. A redirect is not followed (`other_host`).

## OAuth — a public client, PKCE, a loopback redirect (T4-10)

The plan's model (§2.6): an installed app cannot keep a secret, so a
connection signs in as a **public client** — PKCE (RFC 7636) and a loopback
redirect — with no Metistry server in the path. The client comes from:

| Connection | Client id | Client secret |
| --- | --- | --- |
| a known service (`google-calendar`, T4-14) | the type's manifest ships one — or **your own**, `config.<field>.client_id: {{ secret.x }}` (`metistry connections set <name> --client-id-secret x`), which overrides it | none; your own, where the provider needs one (`--client-secret-secret`) |
| a custom connection (C118) | **always your own** — nothing ships one — beside the client model the connection carries (`--authorize-url`, `--token-url`, `--scope`) | your own, where needed |

**Signing in is the owner's hand alone**: `metistry connections authorize
<name>` (`docs/ops/cli.md`), which the Mac app runs (M13). It listens on
**127.0.0.1 only** — a rule, not a default: there is no host to pass — on a
port the system picks, for **exactly one callback**: the first request to
`/callback` is the answer, whatever it says, and the listener stops accepting
before it replies (or at the timeout). The `state` it sent is compared in
constant time before the code is looked at; another state is refused and
nothing is exchanged. The provider's `error=` is kept by its code alone,
never its text. The code goes to the token endpoint with the PKCE verifier,
the loopback it was sent to and the client — **through the egress door**,
pinned to the token endpoint's origin, no redirect followed, a
bring-your-own client id or secret filled (form-encoded) only for a host on
its *Sent only to* list. A bring-your-own client id also goes in the
authorize address the browser opens (OAuth puts it there), so it must list
the authorize endpoint's host too, and be granted to the connection, before
the browser opens.

**What is kept is the refresh token** — the connection's token secret, in this
instance's Keychain (§2.6: "the refresh token is a credential"). A provider
that issues none is refused rather than kept: the sign-in would stop working
within the hour. The first sign-in writes the token secret's policy: sent
only to the token endpoint's host and the service's, granted `on` to the
connection alone. **An access token is never stored**: the process that dials
(the console, or the CLI's `test`) mints one from the refresh token at the
egress door when a request needs it, holds it in memory until a minute before
it expires, and fills it as that same token secret — `Authorization: Bearer
{{ secret.<token> }}` — so the token secret's *Sent only to* list and grant
decide where the access token may go. Both are redacted wherever they come
back.

**The assistant cannot start a flow.** It has no shell (invariant 9); the
proxy it reaches has three doors — list, tools, call — none of which signs
in; and nothing it runs in or reaches (the console, the bridge, the engine,
the reconciler, the supervisor) imports the flow — a test holds each of them
to it (`packages/connections/test/oauth-reach.test.ts`). A call to an OAuth
connection that is not signed in is refused before anything is sent.

**The broker** (`redirect: broker`) is modelled in the schema and refused
where a flow would start (`sign_in`): it is designed, not built (§5).

## A sync's first connection (T4-10; ruled 2026-09-27)

A sync reads the one `ok` connection its provider declares, or the one
`scheduled.yaml` names (*A sync reading its connection* above). `metistry
connections add` writes that name the first time: when the provider is
product code a sync reads and `scheduled.yaml` names no connection for the
sync yet, it adds `syncs.<sync>: { connection: <name> }` — edited as a
document, so the owner's comments and every other entry survive — through the
reconciler as the owner. An entry that already names a connection is left as
it is. The Scheduled pane changes a sync's interval, pause and Needs You
rules, and keeps refusing to set its connection.

## The permissions table — *Through Metistry* (T4-10)

A proxied connection is one more row of the permissions table
(`docs/ops/client-api.md`, *permissions*; screen 7 §10): its Reads under
Read, its Changes things and Starts an agent under Write, by the owner's mode
(Never absent, Ask First ⏱), and every entry's provenance `proxy` — *reached
through Metistry*, said once by the row's ⧉. Which rows an actor has is the
proxy's own rule, asked through `may()`: the assistant every connection, a
borrower only those offered and granted, a crew only with its `connections`
group as well.

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
- **Generated tools start at Ask First, every group** (T4-10), not Q15's
  Reads-Allow: they reach a service no one has yet seen answer through
  Metistry, and CLAUDE.md's default for a proxied tool is Ask.
- **The console fills the secrets of every connection it dials** (T4-10):
  `secrets sync --to env` delivers an MCP, API, feed or files connection's
  secrets, where until the pool was wired it delivered a sync's alone — and,
  from T4-11, an agent connection's, since the console dispatches through it.
- **An agent type's purposes are not tools** (T4-11). Devin's purposes live
  in the type's `dispatch.purposes`, not as `starts_agent` tools: dispatch is
  the owner's own door, so a per-tool Ask would ask the owner about their
  own click, and a tool would put the connection on the proxy's listing,
  where it is not reachable.
- **Legacy keys for one release** (T4-11): a sync with no connection reads
  its old environment, and the `targets/` manifests still dispatch with
  `env:` keys, so `metistry update` breaks nothing before the owner adds the
  connections; a connection, once there, always wins.
- **A rotated refresh token lives in memory** (T4-10): the process that dials
  cannot write the Keychain, so a provider that rotates refresh tokens hands
  the new one to the running console only; after a restart the stored one is
  used again, and a provider that revoked it answers `invalid_grant` — sign in
  again.
- **A caller-written secret reference is refused** (T4-10, found in passing):
  the door fills `{{ secret.x }}` wherever it finds one, so the pool refuses a
  call whose arguments carry one (`secret_reference`) for every connection.
