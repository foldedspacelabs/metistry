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
| **extension** | `<instance>/.metistry/extensions/<name>/` — reserved and protected (`packages/core/src/instance-layout.ts`) | the owner's hand (`metistry extensions add`, M15 — T4-5) |

Each unit is `<dir>/<unit>/manifest.yaml`. The extensions directory holds units
of every kind side by side; each registry takes the ones whose `type` is its
kind.

## The kinds

| Kind | Unit | Contract | Registry (replaces) |
| --- | --- | --- | --- |
| `connection-type` | `manifest.yaml`: `provides`, `transports`, config `fields`, `capabilities`, `tools` with their group, optional `sync`, `implementation` | `check()`; the bridge wire contract when it runs as a process | connection types (new); known-service forms — the app renders fields, no per-service Swift |
| `provider` (compute) | one YAML: base URL, auth as a secret reference, `billing`, locality, data policy, catalogue endpoint | `providers test` | `COMPUTE_TEMPLATES` (`packages/cli/src/compute.ts`) → `seed/compute-templates/` + extensions |
| `bridge` | `packages/mcp-*/manifest.yaml` | the wire contract, `check()`, lazy discovery, preview-then-confirm, redaction; `requires_tcc` from a closed enum | bridge discovery by manifest |
| `routine` | manifest + code (product), or no code (an assignment in `scheduled.yaml`) | declared `config` fields, default `schedule`, declared output paths, `requires` | `routines/index.ts`'s array |
| `collector` / sync | manifest + code | declared `needs_you` raise rules, the connection type it reads | `collectors/index.ts`'s array |
| `agent` (actor) | `.metistry/agents/**.md` | the agent manifest | exists |
| named query | `queries/*.yaml` | `expose`, params | exists (overlay) |
| target | — | folds into connection type `agent` | `targetManifest.transport` enum (`manifest.ts`) |

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
  Metistry reads*). Kinds that predate the key still validate without it through
  `validateManifest` — so CI keeps passing — but the registry requires it: T4-5
  adds `schema: 1` to each product manifest as it moves that kind onto a
  registry.
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
| `transports` | the reach classes a connection of this type may use: `http` · `command` · `path` (C118) |
| `fields` | the config the app renders — each a `key` (snake_case), `kind`, `label`, optional `help`, `required` (default true) |
| `capabilities` | from the type's closed vocabulary (below) |
| `tools` | `<tool>: { group, description? }` — no mode; the mode is the owner's |
| `sync` | the sync unit that reads connections of this type; its default schedule lives in that unit's manifest (§2.5) |
| `implementation` | `native` (the type's own handler — a data-only extension) · `builtin` + `module` (product code in `packages/connections`) · `bridge` + `bridge` (an existing bridge, e.g. `eventkit`). Default `native` |

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
Starts an agent*). **Modes:** `on` · `ask` · `off`, the owner's per-tool policy,
defaulting to **Ask** (CLAUDE.md).

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

`.metistry/connections/<name>.yaml`, written only by the CLI (M13 — T4-8a).
Schema: `connectionFileSchema` in `packages/core/src/connections.ts`.

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

T4-5 moves each of these onto a registry, so a new one is a unit, not an edit to
a list:

- `collectors/index.ts` and `routines/index.ts` (static arrays)
- `targetManifest.transport` (`packages/core/src/manifest.ts`)
- `CREW_MODELS` (→ compute references)
- `COMPUTE_TEMPLATES` (`packages/cli/src/compute.ts`)
- `DEVIN_PURPOSES` (`apps/console/src/devin.ts` → the Devin connection type)
- `SECRET_SCOPES` (→ removed, §2.14)
- the proposal kind → request type mapping (→ the F-5 table, open to new types
  that pick a closed body)
- the connection known-service list
- `inbox.source` values (a capture-source registry)
- Swift's per-service setting forms (→ rendered from field schemas)

## Edge cases, decided

- **A name collision** between a product unit and an extension: the extension
  wins, doctor says so, and Reset to Default restores the product's.
- **An extension removed while referenced** (a routine's actor, a connection's
  provider): the referrer turns `absent` naming the missing unit; nothing is
  deleted.
- **A manifest that fails validation** is skipped with its reason, never fatal.
- **Versioning:** every manifest carries `schema: 1`; an unknown major is
  refused with the version named.
