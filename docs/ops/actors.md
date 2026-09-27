# Actors — one model for everything that acts

An **actor** is anything that acts on the instance: the assistant itself, a
**crew** it delegates to, or an **external** agent that connects in (plan §2.4,
ruling 4). Chat runs the assistant actor; a routine names an actor and a task
(§2.5); a crew run is an actor with a brief; the permissions table renders an
actor.

**Storage does not move.** There is no `actors` table and no migration. An
actor is *composed*, by one pure resolver, from what already exists: the
`agents` registry row, a crew's manifest, `identity.yaml` and `compute.yaml`.
This document is that composition, field by field. The types are
`packages/core/src/actor.ts`. F-2 froze them; T4-6 implemented them:
`resolveActor` in `actor.ts`, `describePermissions()` beside `describeScope` in
`access.ts`, and the console's half — loading the sources, and serving
`permissions` on `GET /api/agents` and `GET /api/agents/:id/definition` — in
`apps/console/src/actors.ts` (docs/ops/client-api.md).

## The type

```ts
type Actor = AssistantActor | CrewActor | ExternalActor;   // discriminated on `kind`
type ResolveActor = (id: string, sources: ActorSources) => Actor | null;
```

Every variant is assignable to the plan's §2.4 interface (a type-level test
pins this). Two differences from the plan's sketch, both deliberate:

- Arrays are `readonly`, which is core's convention (`ScopeView`'s arrays are too).
- `tools.groups` is `CrewToolGroup[] | null`. `null` means the actor has no
  allowlist (the assistant, an external agent: each tool's own rule is the whole
  gate, see `allowedTools`). `[]` means a crew that holds no tools. The two
  must never be the same value.

The variants make three things impossible to write, not just untested:

| Actor | `definition` | `compute` | `limits` | `tools.groups` | `permissions.role` | lines it may hold |
| --- | --- | --- | --- | --- | --- | --- |
| `assistant` | `AssistantDefinition` | `{ kind: "router" }` | `null` | `null` | `assistant` | any `PermissionRow` |
| `crew` | `CrewActorDefinition` | `model` or `same_as_assistant` | `ActorLimits` | `CrewToolGroup[]` | `crew` | `CrewPermissionRow` |
| `external` | `null` | `null` | `null` | `null` | `agent` | `ExternalPermissionRow` |

## The mapping table: `agents.kind` → actor

`ACTOR_OF_AGENT_KIND` (data, frozen, tested against migration 0025's CHECK):

| `agents.kind` | actor `kind` | role `may()` decides on |
| --- | --- | --- |
| `internal` | `assistant` | `assistant` |
| `crew` | `crew` | `crew` |
| `external` | `external` | `agent` |

This is the same mapping `principalOfRow` (`apps/console/src/agents.ts`) and
the console's `principalOf` already make. A stored value outside the three
resolves as `external`, the narrowest kind. That is `authenticateAgent`'s rule:
a row with an unknown kind must never end up holding *more*.

## `resolveActor(id, sources)` — the rules

`ActorSources` is loaded by the host (the console) and passed in, so the
resolver does no I/O. Core imports no Postgres, no vault and no config.

| Source | What it is | Host today |
| --- | --- | --- |
| `assistant.id` | the assistant's registry id | `INTERNAL_ASSISTANT_ID` (`"assistant"`) |
| `assistant.identity` | `identity.yaml`: `name`, `mention`, `mark` | the D4 overlay's pick (`overlayFilesFromEnv(env, "identity")`) |
| `assistant.files` | `identity.yaml`, root `CLAUDE.md`, `.metistry/assistant-prompt.md`: those that exist, in that order | `INSTANCE_LAYOUT.identity`, `.assistantInstructions`, `.assistantPrompt` |
| `registry(id)` | one `agents` row | `listAgents` / a single-row read; `AgentRow` is assignable to `ActorRegistryRow` |
| `crew(id)` | a loaded manifest, prompt and file | `CrewRegistry.get(id)`, with `where` made relative |
| `compute` | `compute.yaml`, parsed | the console's compute loader; `emptyCompute()` when absent |
| `connections(id)` | the connection names this actor may reach | `() => []` until F-3 / T4-8 |
| `grantHistory(id)` | approvals and per-run routine grants | 0023 + `access_request` proposals; `routines: []` until T3-8 |

Resolution, in order:

1. **`id === sources.assistant.id` always resolves to an `AssistantActor`.**
   Chat runs the assistant with or without a credential. When its row is live,
   permissions come from the row (step 4). When the row is missing or revoked
   (`METISTRY_ASSISTANT_TOKEN` unset: the console revokes the row and the
   assistant runs with no tools), the scope is the empty one
   (`{ tier: "none", areas: [], queries: false, projects: [] }`), `source` is
   `environment` and `lines` is `[]`, because nothing it does reaches a door.
2. **No row, or a revoked row → `null`.** A revoked credential acts as nothing.
   The roster's collapsed *Revoked* group renders from the registry row, not
   from an actor.
3. **A pending row (S2) resolves.** The owner deciding whether to let it in
   sees exactly what it would hold.
4. **By the row's kind** (`ACTOR_OF_AGENT_KIND`):
   - `internal` → `AssistantActor`, with the assistant's definition (by the
     column's own definition, `internal` *is* the instance's assistant).
   - `crew` → `CrewActor` when `crew(id)` is loaded. When it is not loaded →
     `null`: the next crew sync revokes a row whose manifest is gone
     (`syncCrews`).
   - `external`, or anything else → `ExternalActor`.

## Field by field

| Field | assistant | crew | external |
| --- | --- | --- | --- |
| `id` | `agents.id` — a slug, never the name | = manifest `name` | `agents.id` |
| `displayName` | `identity.name` | manifest `name` (the registry's `"<name> (crew, <area>)"` is a registry label, not this) | row `display_name` |
| `definition` | `{ kind, identity, files: assistant.files }` | `{ kind, area: manifest.area, description: manifest.description ?? null, prompt, files: [file] }` | `null` |
| `permissions.role` | `assistant` | `crew` | `agent` |
| `permissions.scope` | from the row (below) | from the row (below) | from the row (below) |
| `permissions.autonomy` | row `autonomy` (level + actions) | row `autonomy` (synced from the manifest's) | row `autonomy` |
| `permissions.source` | `"environment"` | `{ manifest: file.path }` | `"registry"` |
| `permissions.lines` | `describePermissions()` (below) | same | same |
| `tools.groups` | `null` | manifest `uses` → `crewGroupOf`, deduplicated, in `CREW_TOOL_GROUPS` order | `null` |
| `tools.connections` | `connections(id)` | `connections(id)` | `connections(id)` |
| `compute` | `{ kind: "router" }` | see *Crew compute* | `null` |
| `limits` | `null`: the engine's defaults and `compute.yaml`'s budgets apply | `{ maxTurns: manifest.max_turns, budgetUsdPerRun: manifest.budget_usd_per_run }` | `null` |

**Permissions come from the row for every kind**, because the row is what the
door reads (`authenticateAgent` → `principalOf` → `may()`). Each column of
§2.4's *Permissions from* is where the owner **changes** a permission, and the
row is where those changes are **composed**:

- The assistant's row is written at every console start by `ensureInternalAgent`:
  unscoped by default (C52), narrowed by `METISTRY_ASSISTANT_AREAS`, with
  `agent_grant_overrides` (0023) merged on top.
- A crew's row is re-synced from its manifest's `scope`, `projects` and
  `autonomy` by `syncCrews`. The manifest's `uses` is the one part that never
  lands on the row: it rides on the principal, as `principalOfRow` does it.
- An external agent's row is the registry itself: `grants`, `projects`, `autonomy`.

Rebuilding a permission from its original sources would be a second policy,
and it could disagree with the door.

**Scope from a row** is `principalOfRow`'s derivation, unchanged:
`{ tier: grants.tier, areas: grants.areas, queries: grants.queries === true,
projects, autonomy }`. One special case: an `internal` row whose `projects` is
`[]` gets `projects: null`, meaning every project.

**An actor is a Principal.** `{ id, role: permissions.role, scope:
permissions.scope, source: permissions.source }`, plus `uses: tools.groups` for
a crew (a group name is a valid `uses` entry), is exactly the principal the door
decides on. So `describeScope()` of that principal is the actor's one-line
triple.

### Crew compute

The frontmatter's `model:` takes three forms (T4-6 widened the schema, which
admitted only the legacy aliases, `CREW_MODELS`; `crewModelIssue` is the rule).
`crewCompute` (`actor.ts`) is what the actor says; `resolveCrewAssignment`
(`compute.ts`) is the same rule for the runner (`apps/assistant/src/crew-drain.ts`),
and a test holds the two together — an actor never claims one model while its
run uses another. A pinned reference whose provider `compute.yaml` does not
declare parks the run with the fix named; it never runs on something else.

| `model:` | `compute` |
| --- | --- |
| `<provider>/<model>` (`modelRefIssue` passes) | `{ kind: "model", ref, effort: manifest.effort }` |
| `same_as_assistant` | `{ kind: "same_as_assistant" }` |
| legacy `haiku \| sonnet \| opus`, with `assignments.crews.<id>` set | `{ kind: "model", ref: that.model, effort: that.effort }` |
| legacy, with no `assignments.crews.<id>` | `{ kind: "same_as_assistant" }` |

The last row keeps today's behaviour exactly. `resolveAssignment` sends an
unassigned crew to `assignments.default`, which is what *same as the assistant*
means (§4 Q14: the assistant's **default tier**, model and effort, never the
router). With no `assignments:` at all, nothing runs either way. The legacy rows
are read for one release; after that, doctor warns (plan §2.4 *Where tiers go*).
`ref` is typed `` `${string}/${string}` ``, so narrow a `string` with
`modelRefIssue(ref) === undefined` before building one.

## `describePermissions()` — Resource × Read × Write

One line per resource (screen 7 §4.1). **An empty cell is `—`: absence is the
denial.** A row with both cells empty is left out, and `lines: []` means the
actor holds nothing. Rows come in this order: Knowledge, Work, Artifacts,
Inbox, Queries, Agents, then connections by name. `Queries` and `Agents` are not
in the screen's drawing. They are here because the legend says *anything not
listed is not granted*, and a power that is held but has no row would make that
legend false.

**The table renders `may()`. It never repeats it.** A tool contributes to a
cell only when `may(principal, "act", { kind: "tool", name }).ok`. That check
already includes a crew's `uses` (`mayToolset`), the tier gates, the
assistant-only tools and `CREW_NEVER_TOOLS`, so the table cannot say something
the door does not do.

| Tool or action | Row · column | Entry key → label |
| --- | --- | --- |
| `knowledge_search`, `knowledge_list`, `knowledge_read`, `knowledge_grep` | Knowledge · Read | tier `index` → `titles` → *Titles only*. Tier `areas` → one entry per area, verbatim. `areas: null`, or `VAULT_ROOT_AREA` (`/`) in the list → `/` → *The whole vault* (never a folder named `/`). |
| `knowledge_write` | Knowledge · Write | the same area entries as Read ("writes never exceed reads"). Only the assistant reaches it. |
| `tasks_list`, `tasks_thread` | Work · Read | `projects: null` → `*` → *All tasks*. Otherwise one entry per slug. |
| `tasks_create` | Work · Write | `create` → *Create* |
| `tasks_claim`, `tasks_renew`, `tasks_release`, `tasks_update`, `tasks_close` | Work · Write | `update` → *Update* |
| `tasks_comment` | Work · Write | `comment` → *Comment* |
| `artifacts_get`, `artifacts_list` | Artifacts · Read | `projects: null` → `*` → *All*. Otherwise one entry per slug. |
| `artifacts_publish` | Artifacts · Write | `publish` → *Publish* |
| `artifacts_comment`, `artifacts_resolve` | Artifacts · Write | `comment` → *Comment* |
| `artifacts_review` | Artifacts · Write | `review` → *Review* |
| `capture` | Inbox · Write | `capture` → *Capture* |
| `queries_list`, `queries_run` | Queries · Read | `named` → *Named queries* |
| `agents_delegate` | Agents · Write | `delegate` → *Delegate* |
| `propose_action` | none of its own | it gates the four action kinds below |
| action `dispatch` | Work · Write | `dispatch` → *Dispatch* |
| action `task_update` | Work · Write | `update` → *Update* |
| action `comment` | Work · Write **and** Artifacts · Write | `comment` → *Comment*. Its schema takes a `work_id` or an `artifact_id` (C53). |
| action `capture` | Inbox · Write | `capture` → *Capture* |
| `requests_create`, `request_access` | **not in the table** | Asking is not a power. Every credential may ask, and asking grants nothing (`mayUseTool`). |

Every name in `RULED_TOOLS` and every `ACTION_KINDS` kind appears exactly once
above. The table is data beside `RULED_TOOLS` — `TOOL_PERMISSION_CELLS` and
`ACTION_PERMISSION_CELLS` in `packages/core/src/access.ts` — and
`packages/core/test/permissions.test.ts` holds it to `RULED_TOOLS`, to
`ACTION_KINDS` and to **this table, parsed**, the same way `may-surface.test.ts`
pins `RULED_TOOLS` to the bridge's `TOOL_NAMES`. A tool added later cannot be
missing from the table by accident, and this document cannot drift from the
code.

Rules for filling the cells:

- **Knowledge Write** holds the same area entries as Read ("writes never
  exceed reads"), less any area the write door refuses outright — `Me/` and
  the owner's own journal (`isUserOwnedPath`), whose only writer is the owner.
  The table asks `may(…, "write", knowledge)` for each, rather than drawing a
  power the door would not honour.
- **Project-scoped tool verbs** (the Work and Artifacts tools) appear only when
  the project scope is not empty (`null`, or a non-empty list). `tasks_*` have
  no tool-level gate beyond a crew's `uses`, and membership is decided per row,
  so an actor with `projects: []` "sees the tools and finds nothing"
  (`access.ts`). Its row says that.
- **Action verbs** appear when `propose_action` is admitted and
  `effectiveActions(autonomy)[kind] !== "deny"`. `asks` is `mode === "propose"`
  (⏱). An action runs as the owner's own click (`apps/console/src/actions.ts`),
  so the proposing actor's project scope is not the gate. Autonomy is.
- **One entry per key in a cell.** When a verb can be reached two ways (for
  example `tasks_update` directly and the `task_update` action), `asks` is
  `true` only if *every* way asks.
- **`null` and `[]` render differently.** `areas: null` is *The whole vault*;
  an empty area list is no Knowledge entry. `projects: null` is *All tasks*;
  `projects: []` is no Work entry.
- **Connections** (F-3, T4-8): one row per `tools.connections` name, labelled
  with the name and marked ⧉ by the renderer. There is one entry per tool whose
  mode is `on` or `ask` (`asks` for `ask`). A tool in group `reads` goes in Read,
  one in `changes` goes in Write, and `off` is absent. The connection file's
  schema is F-3's; this table fixes only where connections land. (A
  `starts_agent` tool — the third of `TOOL_GROUPS` — acts, so it is drawn in
  Write; F-3 / T4-8 may rule otherwise.)

**Provenance** is carried on each entry. The screen puts a marker only on
entries that are not `base`:

| `provenance` | When | Marked as |
| --- | --- | --- |
| `{ kind: "base", source }` | how the actor holds it by default: every verb, project and query entry, and every area not listed below. `source` is `permissions.source`. | nothing. For the assistant, `source: "environment"` reads as *configuration, not a grant* (C52, `sourceLabel`). |
| `{ kind: "approved", proposalId }` | an area in `grantHistory.approved`. For an internal row that is `agent_grant_overrides` (0023). For an external row it is an approved `access_request` proposal's `payload.granted.area` that the row still holds. | *approved in Needs You · #n* |
| `{ kind: "routine", routine }` | an area a routine's per-run grant adds (`grantHistory.routines`). It is shown as an extra Knowledge · Read entry, computed as if that grant were applied, and only when the knowledge read tools would then be admitted (for a crew, `knowledge` ∈ `uses`). One entry per (area, routine). It is not in `permissions.scope`, which is the base. | *during \<routine\> only* |

**In words.** The rows are data; one function says a cell —
`permissionRowText` (`access.ts`): the row's label (a connection's marked
`⧉`), then each cell's entries comma-separated, each its `label`, `⏱` when it
asks, and `(approved in Needs You · #n)` or `(during <routine> only)` when it is
not the base. An empty cell is `—`. `metistry agents list` calls it; the
console's panel (`apps/console/web/app.js`) and MetistryKit (`PermissionRowText`,
over the `PermissionRow` wire types its `PermissionsTable` component draws)
carry copies that `apps/console/test/pwa-reads.test.ts` and
`apps/macos/tests/kit/permissions-table-tests.swift` hold to the recorded
`GET /api/agents` fixture in the same strings — one table, three surfaces.

## Made impossible by the types

T4-6's bold tests are enforced here as types, and
`packages/core/test/types/actor.types.ts` pins them:

- **Knowledge Write never appears for a non-assistant role.** In
  `CrewPermissionRow` and `ExternalPermissionRow`, the Knowledge row's write
  cell is the empty tuple.
- **Only the assistant has an Agents row** (`agents_delegate`). **A crew never
  has a Queries row** (`CREW_NEVER_TOOLS`). An external agent may have one, by
  grant.
- An external actor cannot carry a definition or compute. A crew cannot be on
  the router. A legacy alias is not a model reference.

`describePermissions()` computes rows for any principal. So `resolveActor`
narrows a crew's or an external agent's rows through one checked function. If a
forbidden row shows up there, that function **refuses** it (it throws). It never
filters the row out silently. U3: a refusal is a code path with a test.

## Not in the model

These are facts about a registry row or about the roster, not about an actor.
They stay where they are: presence and claims (`agent_presence`), spend, last
seen, `remote` and `pending` (S2), the *Revoked* group, and the escalation
ceiling (C42).

## Open questions (raised by F-2, not decided by it)

1. **Per-run *write* grants.** §2.5's `scheduled.yaml` example gives a routine
   `grants: { read: [...], write: [Journal/Digest/] }`, and screen 7 §3.2 draws
   *"…and write `Journal/Digest/`"* for a crew. Three things disagree with
   that: T4-6's bold test (*Knowledge Write never appears for a non-assistant
   role*), `CREW_NEVER_TOOLS` (`knowledge_write`), and the one-writer rule
   (§4.11). The types follow the test and the code, so a per-run write has no
   cell (`ActorGrantHistory.routines` carries read areas only). If the owner
   rules that a routine's `write:` is the runner writing on the crew's behalf,
   nothing here changes. If the ruling is that the crew itself writes, then
   `CrewPermissionRow` and the door change together.
2. **A second `internal` row — closed by T4-6.** `POST /api/agents` now mints
   `external` rows only and refuses `kind: internal` before anything is written
   (`AGENT_KIND_REFUSAL`). A row that predates this still resolves as an
   `AssistantActor` (the door gives it the assistant's role), with the
   assistant's definition and the router.
3. **`mark` versus `icon`.** Decided by T2-16: the plan and C123 say *mark*,
   and `identity.yaml`'s key stays `icon:`. `AssistantIdentity.mark` reads it;
   `metistry identity set --mark` writes it; `GET /api/identity` keeps
   serving it as `icon`.
4. **`CLAUDE.md` in the definition.** §2.4 lists the root `CLAUDE.md` as part
   of the assistant's definition. The engine currently composes
   `identity.yaml` + `assistant-prompt.md` only (`apps/assistant/src/prompt.ts`).
   The file is listed because it defines the assistant (the owner's operating
   instructions). Whether the engine reads it is outside this model.
5. **Effort under `same_as_assistant`.** It takes the default tier's effort
   along with its model, and a crew's own `effort:` is not used. That is today's
   behaviour whenever an assignment applies. If a crew's effort should override
   it, `same_as_assistant` would need an `effort` field.
