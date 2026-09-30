# Extensions — kinds, registries, and what stays closed

**A plugin is a directory with a manifest** (invariant 5; plan §2.7). Everything
the owner asked to be extendable is a *kind*: a manifest schema in
`packages/core/src/manifest.ts`, a contract, and a registry built from manifests
rather than from a list in code. **Product units and the owner's extensions go
through the same registry** — an extension is never a second-class path, and a
product unit is never special-cased.

An extension names values from Metistry's vocabularies. It never adds one: the
[closed list](#closed-on-purpose) below is where the security and language
boundaries are, and a change to any of them is a product change.

## Where units live

| Origin | Where | Who changes it |
| --- | --- | --- |
| **product** | in the repo: `seed/`, `routines/`, `collectors/`, `packages/mcp-*` | a PR |
| **extension** | `<instance>/.metistry/extensions/<name>/` — reserved and protected (`packages/core/src/instance-layout.ts`) | the owner's hand ([`metistry extensions add`](#metistry-extensions--m15), M15) |

Each unit is `<dir>/<unit>/manifest.yaml`. The extensions directory holds units
of every kind side by side; each registry takes the ones whose `type` is its
kind.

## The kinds

| Kind | Unit | Contract | Registry (replaces) |
| --- | --- | --- | --- |
| `connection-type` | `manifest.yaml`: `provides`, `transports`, config `fields`, `capabilities`, `tools` with their group, optional `sync` (and `also_read_by`), `implementation`, and an agent type's `dispatch` | `check()`; the bridge wire contract when it runs as a process | connection types (new); known-service forms — the app renders fields, no per-service Swift |
| `provider` (compute) | `manifest.yaml`: `type: provider` and a `provider:` block — exactly what `compute.yaml` carries under `providers.<name>` (base URL, auth as a secret reference, locality, data policy, …) | `providers test` | `COMPUTE_TEMPLATES` → `seed/compute-templates/<name>/` + extensions (T4-5) |
| `bridge` | `packages/mcp-*/manifest.yaml` | the wire contract, `check()`, lazy discovery, preview-then-confirm, redaction; `requires_tcc` from a closed enum | bridge discovery by manifest |
| `routine` | manifest + code (product), or no code (an assignment in `scheduled.yaml`) | declared `config` fields, default `schedule`, declared output paths, `requires` | `routines/index.ts`'s array (T4-5) |
| `collector` / sync | manifest + code | declared `needs_you` raise rules, the connection type it reads | `collectors/index.ts`'s array (T4-5) |
| `agent` (actor) | `.metistry/agents/**.md` | the agent manifest | exists |
| named query | `queries/*.yaml` | `expose`, params | exists (overlay) |
| target | `targets/<name>/manifest.yaml` (for one release) | folds into connection type `agent` (T4-11): a type's `dispatch:` block | the target registry (T4-5), which reads agent connections beside `targets/` (T4-11) |

**In this program** the registries and data-only extensions ship. Code from an
extension never runs inside the console: an extension that needs code runs as a
process — a stdio or HTTP MCP child under the supervisor, behind the egress
allowlist — and that is designed in the plan's §5 and built after this program.

## Registries

`packages/core/src/registry.ts` — one generic loader for every kind.

```ts
const types = await loadRegistry(manifestKind("connection-type"), [
  { dir: "seed/connection-types", origin: "product" },
  { dir: ".metistry/extensions", origin: "extension" },
]);
types.get("google-calendar");   // { name, manifest, origin, path, replaced? }
types.overlaid();               // extensions that replaced a product unit
types.skipped;                  // [{ path, origin, name?, reason }]
```

The rules, each tested in `packages/core/test/registry.test.ts`:

- **Validate, and skip with the reason — never fatal.** A manifest that fails
  its schema, cannot be read, or is not YAML is skipped with why; every other
  unit still loads (the runner's rule, `apps/console/src/runner.ts`).
- **`schema: 1`.** Every manifest a registry loads carries it. A missing version
  is skipped (*schema: missing — every manifest carries schema: 1*); an unknown
  major is skipped with the version named (*schema: 2 is not a version this
  Metistry reads*). Every product manifest carries it — collectors, routines,
  targets, provider templates, bridges, services — and CI holds every one to it
  (`apps/console/test/manifests.test.ts`). Kinds that predate the key still
  validate without it through `validateManifest`, but no registry loads one.
  **An owner's older overlay** — a `.metistry/targets/<name>/manifest.yaml`
  written before this — is skipped until it gains the line: the product's unit
  is then in force, and the console log, `metistry doctor`'s *registries* row
  and `metistry extensions list` all name the file.
- **Overlay by name (D4).** An extension with a product unit's name wins; the
  unit records what it `replaced`, so doctor can say so, and Reset to Default
  removes the extension. Origin decides, not source order. Two units of the
  **same** origin with one name are ambiguous: the second is skipped, never
  silently ordered.
- **A directory is named for its unit**, so `metistry extensions remove <name>`
  removes the right one, and a symbolic link is not followed — a unit lives in
  the tree it is loaded from. A product tree that prefixes directory names
  (`packages/mcp-brain` holds the bridge `brain`) opts out with
  `dirNameIsName: false`.
- **A unit of another kind is passed over**, not skipped — it belongs to another
  registry. `metistry extensions list` (T4-5) is where an extension no registry
  claims is reported. An unreadable manifest has no kind to read, so every
  registry that scans its directory reports it.

`buildRegistry(kind, candidates)` is the same logic with no disk, for callers
that already hold the manifests.

### The kinds that load through a registry

`REGISTRY_KINDS` (`registry.ts`) is the closed list of **kinds** — a new kind
needs a schema and a consumer, so it is a product change. It is never a list of
units: a new unit of any of these is a directory, and there is no line to add
anywhere in code. `loadKind(kind, roots)` builds one from the product's
directory and the owner's.

| Kind | Product units | Loaded by | An extension may |
| --- | --- | --- | --- |
| `collector` | `collectors/<name>/` | the console's runner, the watchdog's silent-collector probe | **overlay** — replace a product collector's manifest |
| `routine` | `routines/<name>/` | the same | **overlay** |
| `target` | `targets/<name>/` (and the owner's older `.metistry/targets/`) | the console (dispatch, `GET /api/targets`) | add a target, or replace one |
| `provider` | `seed/compute-templates/<name>/` | `metistry compute providers add --from`, the hints that name templates | add a template, or replace one |
| `connection-type` | `seed/connection-types/<name>/` (the first ship with T4-12–T4-15) | the connections package (T4-8a) | add a type, or replace one |

Not here, on purpose: `bridge` and `service` are code, so an extension one is a
process extension (§5, after this program); `agent` lives in `.metistry/agents/`
(M12). An extension of those kinds is reported as *unclaimed*, never loaded.

**Code comes only from the product.** A collector or routine is a manifest and
a `run.ts`. The registry says the unit exists; `collectors/index.ts` and
`routines/index.ts` find its compiled `<name>/run.js` in their own package
**by name** (`unitCode`, `joinCode`) — so an extension that replaces
`github-state`'s manifest (a different schedule, say) runs the product's
`github-state` code under it, and an extension collector with a name no
product collector has is skipped: *no product collector is named "x" — a
collector is product code, and code from an extension runs only as a process
(plan §5)*. A product unit whose code is missing is skipped the same way.

**Where each process looks.** The console and the watchdog read the product's
directories from their working directory (`METISTRY_COLLECTORS_DIR`,
`METISTRY_ROUTINES_DIR`, `METISTRY_TARGETS_DIRS` — its first entry is the
product's, the rest the owner's) and the extensions from
`METISTRY_INSTANCE_DIR`'s `.metistry/extensions/`. A process that cannot see
its instance — the compose console (D5) — loads product units only, and its
log says so. Every skip is one log line naming the file and the reason.

## `metistry extensions` — M15

```
metistry extensions list [--json]
metistry extensions add <dir> [--dry-run]
metistry extensions remove <name> [--dry-run]
```

`.metistry/extensions/` defines what the product loads, so it is a §4.7
protected path: every write is the owner's hand, through the reconciler with
the owner-class bearer as `user` (the console's bearer is refused there by the
reconciler's authority table). There is no API route.

**`add <dir>`** copies one directory into `.metistry/extensions/<name>/`, where
`<name>` is its manifest's `name`. Two tests, and a refusal from either writes
nothing:

1. **Data only.** One flat directory of `manifest.yaml` and `.yaml`, `.yml`,
   `.md` or `.txt` files, UTF-8, at most 1 MiB. A script, an executable (any
   name), a symbolic link or a subdirectory is refused by name. Hidden entries
   (`.DS_Store`, `.git/`) are left behind and listed.
2. **Would it load?** The unit is put through its kind's registry beside the
   product's units and the owner's others, exactly as the product will load
   it. A unit the registry would skip — no `schema: 1`, a manifest its schema
   refuses, a kind no registry takes, a collector naming no product collector,
   a second unit of one name — is refused with the registry's own reason.

That second test is where the [closed list](#closed-on-purpose) holds at the
door: an unknown capability, the refused `send`, an unknown field kind, a bridge
asking for a TCC grant, a unit of a made-up kind such as `action-kind` — each is
refused, and no vocabulary changes (the T4-5 tests,
`packages/core/test/registry-kinds.test.ts` and
`packages/cli/test/extensions.test.ts`).

An extension already installed under that name is refused: `remove` it first.

**`list`** shows every unit in `.metistry/extensions/` and what became of it:
`loaded`, `overlay` (with the product unit it replaces), `skipped` (with the
reason) or `unclaimed` (no registry takes its kind, with why). `metistry doctor`
carries the same facts in one *registries* row across every kind: units per
kind, every overlay, every skip (`degraded`, never `failed`).

**`remove <name>`** deletes the directory. For an overlay that is **Reset to
Default** — the product's unit is back in force, and the verb says which. What
referred to a removed unit is not touched: it turns `absent`, naming the
missing unit; nothing else is deleted.

## Connection types

A **connection** is anything outside Metistry it reaches for the owner (§2.6).
Its *type* says what kind of thing it is; its *provider* is a `connection-type`
unit that knows how to reach it — or `custom`, configured by hand.

```yaml
# seed/connection-types/google-calendar/manifest.yaml (T4-14 ships the real one)
schema: 1
name: google-calendar
type: connection-type            # the kind marker every manifest carries
provides: calendar               # the connection type it provides
transports: [http]               # http | command | path
fields:
  - key: account
    kind: oauth
    label: Google account
    oauth:
      client_id: <Metistry's public client id>   # not a secret
      pkce: true
      redirect: loopback                         # loopback | broker
      bring_your_own: allowed
      authorize_url: https://accounts.google.com/o/oauth2/v2/auth
      token_url: https://oauth2.googleapis.com/token
      scopes: [https://www.googleapis.com/auth/calendar.events]
  - { key: calendar_id, kind: text, label: Calendar, default: primary }
capabilities: [read, write_own, rsvp]
tools:
  list_events:        { group: reads }
  respond_invitation: { group: changes }
sync: google-calendar            # optional: the sync unit that reads it
implementation: { kind: builtin, module: google-calendar }
```

**Why `provides` and not `type`.** `type` is the key every manifest is
discriminated on, and `agent` is both a manifest type (a crew) and a connection
type (somewhere work is sent). One key cannot mean both, so the kind is
`type: connection-type` and the connection type is `provides`.

| Key | Is |
| --- | --- |
| `provides` | one of `mcp` · `agent` · `api` · `feed` · `files` · `calendar` · `mail` · `tracker` |
| `transports` | the reach classes a connection of this type may use: `http` · `command` · `path` (C118) · `imap` (a mailbox, T4-15 — only a `mail` type that declares `auth: [basic]`) |
| `fields` | the config the app renders — each a `key` (snake_case), `kind`, `label`, optional `help`, `required` (default true) |
| `capabilities` | from the type's closed vocabulary (below) |
| `tools` | `<tool>: { group, description? }` — no mode; the mode is the owner's |
| `auth` | optional: the sign-in schemes a connection of this type may use (`none` · `bearer` · `basic` · `api_key` · `oauth`). Absent: any but `basic`. **`basic` is accepted only by a type that lists it** (CalDAV's app password, T4-13; IMAP's, T4-15) — the CLI and the file check both refuse it elsewhere |
| `sync` | the sync unit that reads connections of this type; its default schedule lives in that unit's manifest (§2.5) |
| `also_read_by` | optional: further sync units that read the same connection (T4-11 — Devin's `devin-knowledge` beside `devin-sessions`); needs `sync`, each named once |
| `implementation` | `native` (the type's own handler — a data-only extension) · `builtin` + `module` (product code in `packages/connections`) · `bridge` + `bridge` (an existing bridge, e.g. `eventkit`). Default `native` |
| `dispatch` | an `agent` type's (T4-11), and required on a builtin one: `dispatcher` (closed: `devin-session` · `github-issue` — `AGENT_DISPATCHERS`), `data_policy` (`allow`, `deny_sources`, `max_brief_bytes` — what a brief may carry), `purposes` (`<snake_case>: { label, preamble }`) with `default_purpose`, `result` (`via: report_queue`, `status_via`), optional `cost` and Devin's `max_acu`. An overlay of the type is how the owner widens its data policy (D4) |

**Field kinds** (closed): `text` · `secret` · `variable` · `url` · `choice` ·
`oauth`. A field of any other kind is refused. A `secret` field can never carry
a `default` — a value in a manifest is a published secret. A `choice` lists
`options: [{ value, label }]`, and its default must be one of them.

**Capabilities** (closed, per type). Today and Needs You consume capabilities,
never provider names.

| Type | Capabilities |
| --- | --- |
| `calendar` | `read` · `write_own` · `rsvp` |
| `mail` | `read` · `draft` — **`send` is refused by name: nothing sends mail** |
| `tracker` | `read` · `create` · `complete` |
| `mcp` · `agent` · `api` · `feed` · `files` | none — consumed through their tools |

**Tool groups:** `reads` · `changes` · `starts_agent` (*Reads · Changes things ·
Starts an agent*). **Modes:** `on` · `ask` · `off` — drawn *Allow · Ask First ·
Never* (the owner's words, ruled 2026-09-26) — the owner's per-tool policy,
defaulting to **Ask First** (CLAUDE.md). A new connection starts at Reads Allow,
Changes things Ask First, Starts an agent Ask First (Q15; `docs/ops/connections.md`).

**Native handlers and their reach.** `native` runs a connection through the
type's own handler, which speaks: `mcp` and `agent` — `http`, `command`; `api`
and `feed` — `http`; `files` — `path`, `http`. `calendar`, `mail` and `tracker`
have no native handler: a provider of those is `builtin` or a `bridge`, and a
`custom` connection of those types is refused.

### The OAuth client model

An `oauth` field carries the client it signs in with (§2.6). Metistry ships one
public client id per provider that supports public clients; the flow is PKCE
with a loopback redirect the Mac app opens; tokens go from the provider to the
instance with no Metistry server in the path.

| Key | Rule |
| --- | --- |
| `client_id` | the shipped public id — not a secret. Absent: nothing ships; the owner brings their own |
| `client_secret` | **refused by name.** A manifest is public. A provider that needs a confidential secret goes through the broker (`redirect: broker`, built when the first such provider is scheduled — §5), and a bring-your-own secret is a per-instance secret |
| `pkce` | required; **`true` whenever `redirect: loopback`** — a public client without PKCE is an interceptable code |
| `redirect` | `loopback` (127.0.0.1, one callback) · `broker` (`auth.metistry.app`, modelled, not built) |
| `bring_your_own` | `allowed`, the only value, and the default — every OAuth connection accepts the owner's own client |
| `authorize_url`, `token_url` | **https only**, no credentials in the URL |
| `scopes` | required and non-empty — they are what a reviewer reads to know what the client can reach |

## Connection files

`.metistry/connections/<name>.yaml`, written only by the CLI (`metistry
connections`, M13). Schema: `connectionFileSchema` in
`packages/core/src/connections.ts`; how a file is read, listed and dialled —
and the rules `packages/connections` adds to the schema — is
[`docs/ops/connections.md`](connections.md).

```yaml
name: work-calendar
type: calendar
provider: google-calendar        # a connection-type name, or custom
reach: { http: { url: "https://www.googleapis.com/calendar/v3", auth: oauth } }
secrets: [google_calendar_token] # names only — never a value
variables: []
config:                          # values for the provider's fields
  account: { token: "{{ secret.google_calendar_token }}" }
tools:
  list_events:        { group: reads,   mode: on }
  respond_invitation: { group: changes, mode: ask }
offer_to_agents: false
```

- **`reach`** is exactly one of `http` (`url`, `auth`, `query`, `headers`,
  `timeout_s`), `command` (`command`, `args`, `cwd`, `env`, `runs_on: host |
  container`) or `path` (`path`, `include`, `skip`, `watch`).
- **`auth`** is a shortcut: `none` · `bearer` + `secret` · `basic` + `username`,
  `secret` · `api_key` + `header`, `secret` · `oauth` (+ `field` when the type
  has more than one oauth field). A bare string is shorthand: `auth: oauth`.
  A **custom** connection signing in with OAuth (C118, T4-10) has no field to
  take its client from, so the shortcut carries it: `client` (the model
  above — `authorize_url`, `token_url`, `scopes`, `pkce`, `redirect` — with no
  `client_id` or `client_secret` in it), `token`, `client_id` and an optional
  `client_secret`, each a `{{ secret.name }}`; the client id is always the
  owner's own. A typed connection is refused these keys:

  ```yaml
  reach:
    http:
      url: https://mcp.example.com/mcp
      auth:
        scheme: oauth
        client: { authorize_url: "https://auth.example.com/authorize", token_url: "https://auth.example.com/token", scopes: [read], pkce: true, redirect: loopback }
        token: "{{ secret.example_oauth_token }}"
        client_id: "{{ secret.example_client_id }}"
  ```
- **Values take text, `{{ secret.name }}` and `{{ variable.name }}`** — nothing
  else in double braces. Every secret or variable a value uses must be listed in
  `secrets` / `variables`, because those lists are what the grant check and the
  egress guard read.
- **`config`** keys are the provider's field keys. A `secret` field's value is a
  `{{ secret.name }}` reference, never text; a `variable` field's is a
  `{{ variable.name }}`; an `oauth` field's is `{ token, client_id?,
  client_secret? }`, each a secret reference — the last two are the owner's own
  client (§2.6). A `custom` connection has no config: its settings are its
  reach.
- **`tools`**: a tool the type declares keeps the type's group — a file that
  relabels a `changes` tool as `reads` is refused. `mode` defaults to `ask`.
- **Syncs** for a connection live in `scheduled.yaml` (§2.5), never here.

`connectionIssues(connection, type)` joins a connection to its provider's unit
from the registry. With no unit installed, the connection is **absent**, naming
the missing provider; nothing is deleted.

## Closed on purpose

A change to any of these is a product change, never a manifest. A plugin names
values from them and never adds one.

| Vocabulary | Where |
| --- | --- |
| `ACTION_KINDS` | `packages/core/src/actions.ts` |
| the `Resource` union in `may()` (one new `connection` variant, T4-8b) | `packages/core/src/access.ts` |
| `tccGrant` | `packages/core/src/manifest.ts` |
| `INTENTS` | `packages/core/src/intent.ts` |
| `BUDGET_ACTIONS` | `packages/core/src/compute.ts` |
| `EXPOSURES` | `packages/queries/src/index.ts` |
| `EFFORTS` | `packages/core/src/tiers.ts` |
| the request **body** kinds | F-5 |
| the template directives and filter flags | `packages/core/src/template.ts`, `packages/core/src/task-filter.ts` |
| each connection type's **capability** vocabulary | `CONNECTION_CAPABILITIES`, `packages/core/src/connections.ts` |
| the reach classes | `REACH_CLASSES`, `connections.ts` |
| the field-kind vocabulary | `FIELD_KINDS`, `connections.ts` |

`connections.ts` also closes the connection types, the tool groups and modes,
the auth schemes and the OAuth redirect modes.

## Enums that become registries

Each of these moves onto a registry, so a new one is a unit, not an edit to a
list. **Done (T4-5):**

- `collectors/index.ts` and `routines/index.ts` (static arrays) → the collector
  and routine registries, code found by name
- `COMPUTE_TEMPLATES` (`packages/cli/src/compute.ts`) → the provider registry,
  `seed/compute-templates/<name>/manifest.yaml` + extensions
- targets → the target registry (the console's `TargetRegistry` loads through it)
- `DEVIN_PURPOSES` (`apps/console/src/devin.ts`) → the Devin connection
  type's `dispatch.purposes` (T4-11)
- connection types → the registry is ready (`loadKind("connection-type", …)`);
  its first units and its consumer come with T4-8a and T4-12–T4-15
- the connection known-service list → the connection-type units that ship them:
  the calendar's (`icloud-calendar`, `fastmail-calendar`) with T4-13, the
  mail's (`gmail-mail`) with T4-15

**Still to move, each with the ticket that owns it:**

- `targetManifest.transport` (`packages/core/src/manifest.ts`) → retired with
  the `targets/` manifests after the one release they still load (T4-11 moved
  their content into agent connection types; `AGENT_DISPATCHERS` is the
  closed set that replaces the enum)
- `CREW_MODELS` (→ compute references, T4-6)
- `SECRET_SCOPES` (→ removed, §2.14, T4-3)
- the proposal kind → request type mapping (→ the F-5 table, open to new types
  that pick a closed body)
- `inbox.source` values (a capture-source registry — no ticket yet)
- Swift's per-service setting forms, and the Mac app's `ComputeTemplate` enum
  (→ rendered from field schemas and the provider registry)

## Edge cases, decided

- **A name collision** between a product unit and an extension: the extension
  wins, doctor says so, and Reset to Default restores the product's.
- **An extension removed while referenced** (a routine's actor, a connection's
  provider): the referrer turns `absent` naming the missing unit; nothing is
  deleted.
- **A manifest that fails validation** is skipped with its reason, never fatal.
- **Versioning:** every manifest carries `schema: 1`; an unknown major is
  refused with the version named.
