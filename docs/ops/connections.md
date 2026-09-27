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
connections (T4-10), calendar, mail and tracker providers (T4-12…T4-15,
T4-24). Asking the pool to dial one of those is refused `not_built`, naming
where it arrives.

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

*Used by* is what reads it today: the syncs in `scheduled.yaml` that name it.
Agents reach a connection through the lazy pair `connections_list` /
`connections_call` and their grants (T4-8b); until then an empty list is the
true answer (*Nobody yet*).

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
the lazy pair lands (T4-8b), which also writes each call's `runs` row from the
pool's events (`connection_call`, `connection_check`).

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
| `needs_approval` | the tool is at Ask First and the caller holds no approval of this call (T4-9's Approve sets it) |
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
