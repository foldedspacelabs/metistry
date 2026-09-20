# Grants and access, simplified (2026-09-19)

Commissioned by the owner the same day, verbatim:

> This is getting a bit complicated though, can we simplify the grant/access
> controls surface and make it more consistent?

and the sentence the whole proposal turns on:

> The owner should always have access to everything. Agents, however, should
> only have access to what they're granted.

Nothing here is built. **Every claim about this repo was read off this
checkout on 2026-09-19** and cites `file:line`; the owner's instance was not
read and no database was touched. Where the inventory disagrees with the plan
or with the brief, it says so rather than routing around it (CLAUDE.md).

## The short version

1. **There are fourteen gating axes, not four.** §1.5 lists them. The owner's
   own count — three tiers, the `Artifacts/` case, the `queries` boolean, the
   per-tool never-lists — is an undercount; it misses `kind`, `projects`,
   two independent autonomy blocks, `expose`, the crew `uses` allowlist, the
   enrolment state, and the management gate. Eight of the fourteen can refuse
   a single knowledge read.
2. **One knowledge read passes five to seven checks in four files**, and the
   *owner's* read of the same page passes five in three (§1.4). They agree
   today because `canSeeUnder` was deliberately lifted to one implementation
   on 2026-09-19 (`packages/mcp-brain/src/knowledge.ts:92`). That was the
   right move and it is the model for everything else in this document.
3. **"The owner has everything" is not true today, in two places**, and both
   are the same mistake: a validator written to narrow agents is applied to
   the owner (§2.6). The owner cannot read `.metistry/compute.yaml` through
   the knowledge door, and cannot run an `expose: route` query through the
   generic door.
4. **The assistant is the one principal that cannot ask.** `request_access`
   refuses `kind: internal` at the tool
   (`packages/mcp-brain/src/access.ts:78`) and the console refuses the
   widening again at triage (`apps/console/src/server.ts:1331`). The reason is
   sound — an internal row's grants are replaced from the environment at every
   console start — but the consequence is that the principal the owner talks to
   daily has no move but an `.env` edit (§2.4).
5. **A crew's toolset is enforced in the caller, not at the door.**
   `uses` is filtered client-side in the assistant process
   (`apps/assistant/src/tools.ts:146` and `:149`); `/mcp` has never heard of
   it, because `AgentPrincipal` carries no `uses` field at all
   (`packages/mcp-brain/src/types.ts:19-39`). This is the one finding in the
   document that touches "enforce at the tool, never by prompting" directly
   (§2.2).
6. **`kind` has three stored values and two typed ones.** `crews.ts` writes
   `'crew'` (`apps/console/src/crews.ts:261`); `AGENT_KINDS` is
   `["external","internal"]` (`apps/console/src/agents.ts:35`);
   `authenticateAgent` coerces anything not `internal` to `external`
   (`:278`). Three behaviours downstream key off a distinction the principal
   no longer carries (§2.3).
7. **Refusals speak five dialects.** Four error codes, and inside `forbidden`
   alone: an empty message, `"not granted"`, a sentence naming an `.env`
   variable, a sentence naming an HTTP route *and* a CLI command, and one
   refusal with a machine-readable `reason` + `grantedScope`. Exactly one of
   the fourteen refusal sites tells a caller what would unlock it in a form a
   program can read (§2.5).
8. **The proposal is one function, one envelope, one renderer** —
   `may(principal, verb, resource)` in `core`, a refusal carrying
   `reason` + `needs`, and one `describeScope()` every surface renders
   (§3). Five phases, the first of which is a pure move with no behaviour
   change (§4). Invariants 2, 8 and 10 are checked line by line in §5.

---

## 1. The inventory

### 1.1 Principal kinds — every way a request acquires an identity

Identity is always derived from the credential. Nothing in a request body or
a tool argument is ever read as identity; the code says so in four places and
does it in four places.

| # | principal | where it is produced | what proves it |
| --- | --- | --- | --- |
| P1 | **passkey session** (`kind: "session"`) | `apps/console/src/server.ts:341` | `metistry_session` cookie against `sessions` |
| P2 | **local owner** (`kind: "local_owner"`) | `apps/console/src/server.ts:348`, `apps/console/src/local-owner.ts:138` | `METISTRY_LOCAL_OWNER_TOKEN` **and** a loopback/trusted peer address |
| P3 | **owner token** (`kind: "owner_token"`) | `apps/console/src/server.ts:354`, `apps/console/src/auth-store.ts:128` | a row in `owner_tokens` — the capture Shortcut, any address |
| P4 | **agent, external** | `apps/console/src/agents.ts:256` | bearer → `agents` row, `kind != 'internal'` |
| P5 | **agent, internal** | same function, `:278` | bearer → `agents` row, `kind = 'internal'` |
| P6 | **crew** | same function — **and it comes out as P4** | a per-run bearer minted at `apps/assistant/src/crew-drain.ts:120` and burned at `:148` |
| P7 | **no credential** | — | `GET /api/identity`, `GET /health`, the PWA shell, the four `/auth/*` ceremonies |

P1 and P2 collapse to one predicate, `isUser()` (`server.ts:147`), and that
collapse is deliberate and correct: "everything a passkey session may do, the
local owner token may do". P3 does **not** collapse into it — it is the plan's
tier 0, capture-only, and the management gate excludes it by name
(`server.ts:735`).

Two gates sit above everything else and are not part of the grant model at
all, but refuse first:

- **revocation**: `revoked_at IS NULL` in the authenticating `UPDATE`
  (`agents.ts:265`).
- **pending enrolment (S2)**: `(NOT remote OR approved_at IS NOT NULL)` in the
  same `WHERE` (`agents.ts:265`). The comment at `:249-255` explains why it is
  in the clause rather than a branch, and it is right.

### 1.2 The grant record

```ts
// apps/console/src/agents.ts:41  (and packages/mcp-brain/src/types.ts:28)
interface Grants { tier: "none" | "index" | "areas"; areas: string[]; queries?: boolean }
```

Written by exactly one function, which is the best thing in the current
design: `writeGrants` (`apps/console/src/server.ts:1116`) is reached by the
owner's own `PUT /api/agents/:id/grants` (`:1015`) and by an approved
`access_request` at triage (`:1350`), with one validator
(`agents.ts:147`), one store call (`:545`) and one `agent_admin` audit row.

Three other records sit beside it on the same row and are not grants, but gate:

| record | shape | written by |
| --- | --- | --- |
| `projects: string[]` | membership | `PUT /api/agents/:id/projects` → `setProjects` (`server.ts:1019`, `agents.ts:553`) |
| `autonomy.{level,actions}` (A3) | the only keys that can **widen** | `PUT /api/agents/:id/autonomy` → `setAutonomy(…, {allowWidening:true})` (`server.ts:1034`, `agents.ts:589`) |
| `autonomy.{may_dispatch_to,accept_from,max_open_bundles}` (§4.21) | narrow only | same route, same validator (`agents.ts:185`) |

And three **sources** the same row can come from, which is the load-bearing
complication:

- **registry** — external agents; the owner's hand, durable.
- **environment** — internal: `ensureInternalAgent` (`agents.ts:306`) does
  `ON CONFLICT … SET grants = EXCLUDED.grants` on **every console start**
  (`apps/console/src/main.ts:60`). Default `ASSISTANT_DEFAULT_AREAS = ["/"]`
  (`agents.ts:75`).
- **manifest** — crews: `syncCrews` re-derives `grants` from `scope:` through
  the same validator and `UPDATE`s it on every sync
  (`apps/console/src/crews.ts:110`, `:276`).

Nothing on the row records which of the three it is. Every door that needs to
know re-derives it from `kind`, in prose, three times
(`access.ts:66`, `server.ts:1331-1337`, `manifest.ts:225-231`).

### 1.3 Knowledge scope — the one part that was already simplified

Ruled 2026-09-19 and shipped, and it is the template for §3:

| function | file:line | what it decides |
| --- | --- | --- |
| `isVaultPath` | `packages/core/src/instance-layout.ts:232` | is this path **knowledge at all**? (no dot-dirs, not `Artifacts/`, not root `CLAUDE.md`/`README.md`, no traversal) |
| `validKnowledgePath` | `packages/mcp-brain/src/knowledge.ts:54` | `isVaultPath` + length + no NUL/backslash |
| `underAreas` | `:64` | prefix match; `""` (from `/`) matches everything |
| `canSeeUnder(path, areas\|null)` | `:92` | **the one rule for every knowledge read on both doors** |
| `knowledgeScope(principal)` | `:125` | tier → `{prefixes, canRead, canList, visibleTitlesOnly, excludeDrafts}` |
| `canSee(path, scope)` | `apps/console/src/knowledge-routes.ts:178` | a rename over `canSeeUnder` |
| `OWNER_SCOPE` / `NO_SCOPE` | `:133` / `:136` | `{areas: null}` / `{areas: []}` |
| `grantedScope(principal)` | `:160` | an agent's `grants` → the console's scope shape |
| `knowledgeScopeOf(auth)` | `apps/console/src/server.ts:170` | credential → scope, fail-closed |

`canRead` is `tier === "areas" && canSeeUnder(path, areas)`; `canList` is
`tier !== "none" && canSeeUnder(path, tier === "areas" ? areas : null)`
(`knowledge.ts:132-133`). The asymmetry is deliberate and documented: tier
`index` may be told a page exists anywhere and may read none of them.

`grantedScope` deliberately does **not** reuse `knowledgeScope`'s return value
(`knowledge-routes.ts:143-154`), because `prefixes: null` means two different
things in the two shapes — "no prefix restriction on titles" there, "every
page's content" here. That comment is the clearest statement in the repo of
why the current model is hard: **one field, two meanings, kept apart by
prose.**

### 1.4 The doors, and what each one checks

**Door A — `POST /mcp`** (`server.ts:488`). Agent bearers only; the console's
own `authenticate` is not even reached.

| tool group | gate | file:line |
| --- | --- | --- |
| `capture`, `requests_create` | none beyond authentication | `server.ts:298`, `:317` |
| `request_access` | `kind !== "internal"` | `access.ts:78` |
| `tasks_*` (7) | `memberOf(principal, project)` → `not_found` | `scope.ts:25`; `server.ts:378,388,398,408,418,435` |
| `tasks_comment`/`tasks_thread` | project membership, via the artifacts service | `thread-tools.ts:56,70` |
| `knowledge_search` | `tier !== "none"` + `canList` | `server.ts:469` |
| `knowledge_read` | `scope.canRead`, then `scopeRequired` if listable | `knowledge.ts:325-332` |
| `knowledge_list` / `links_for` | `scope.canList` / `scope.canRead` | `knowledge-fs.ts:216,248,267,278,287,318` |
| `knowledge_grep` | `tier === "areas"` + prefix `canRead` | `knowledge-fs.ts:436-437` |
| `knowledge_write` | `kind === "internal"` **then** `tier==="areas" && underAreas` | `knowledge-write.ts:305,313` |
| `artifacts_*` (6) | project membership, `not_found`/`forbidden` | `artifacts-tools.ts:23-24` |
| `agents_delegate` | `kind === "internal"` | `crew-tools.ts:112` |
| `queries_list`/`queries_run` | `kind === "internal" \|\| grants.queries === true` | `queries-tools.ts:47,79,97` |
| `queries_run` name | `store.exposure(name) === "generic"` | `queries-tools.ts:69,102` |
| `propose_action` | **not registered** unless `admitsAnyAction` | `action-tools.ts:71` |
| `propose_action` call | `effectiveActions(autonomy)[kind] !== "deny"` | `action-tools.ts:104-109` |
| MCP resources | `tier === "areas"` | `knowledge-resources.ts:55` |

**Door B — the console's management surface.** `if (auth.kind === "agent")
return forbidden` (`server.ts:532`) closes the whole console to agents.
Then `if (!isUser(auth))` (`:735`) enumerates what an `owner_token` may not
reach: devices, logout, proposals (single + batch), reply feedback, agents
(list/create/`AGENT_ROUTE`), projects, runs export, run detail, instances,
commands, `isComputeRoute`, `isKnowledgeRoute`, `isTaskOpRoute`,
`isArtifactRoute` — `forbidden`; everything else — `not_found`. Above that
gate, three things an `owner_token` *can* do: `POST /capture` (`:494`),
`POST /message` (`:550`), `GET /api/q/<name>` (`:639`), plus `GET /api/status`
and `GET /api/whoami`. `GET /api/targets` and dispatch are `isUser`-only at
`:707`.

**Door C — `GET /api/q/<name>`** (`namedQueryDoor`, `server.ts:292`). Any
query whose manifest says `expose: generic`. A query marked `expose: route`
gets the **unknown-query refusal byte for byte** so the door is not an oracle.
Three seed queries carry `expose:` today (`seed/queries/knowledge_pages.yaml`,
`knowledge_page_links.yaml`, `cache_report.yaml`); `packages/queries/src/index.ts:47,161`.

**Door D — `/api/knowledge/*`** (`knowledge-routes.ts`), owner-only in
practice, scope-filtered by `knowledgeScopeOf` regardless.

**Door E — the six answers to a request** (`server.ts:1172-1178`, `:205`):
`allow`, `deny`, `accept_with_changes`, `accept_as_work`, `later`, `skip` —
with a `decision`-kind proposal substituting its own stored `options` for the
first three. `later` and `skip` are universal; the batch route admits only
`later`, `skip`, `deny` (`:207`), because the others each do something
per-kind.

**Door F — the crew manifest.** `uses` groups
(`packages/core/src/manifest.ts:183`), `CREW_NEVER_TOOLS` refused by the
schema (`:231`, `:251`), `scope:` refused the bare vault (`:315`),
`autonomy.level` admitted because `agents/` is a §4.7 protected path.

### 1.5 The fourteen axes

| # | axis | values | where it is decided | can it refuse a knowledge read? |
| --- | --- | --- | --- | --- |
| 1 | `grants.tier` | none / index / areas | `agents.ts:37` | **yes** |
| 2 | `grants.areas[]` | TitleCase prefixes, or `/` | `agents.ts:147` | **yes** |
| 3 | `grants.queries` | boolean | `queries-tools.ts:48` | yes (the page-list query) |
| 4 | `projects[]` | slugs; empty+internal = all | `scope.ts:20,25` | no |
| 5 | `kind` | internal / external / (crew) | `agents.ts:278` | **yes** (write, queries, ask) |
| 6 | `autonomy.level` + `.actions` | A3 ceiling × table | `core/actions.ts:175` | no |
| 7 | `autonomy.{dispatch,accept,bundles}` | §4.21 narrowing | `agents.ts:185` | no |
| 8 | `uses` groups | 8 groups | `manifest.ts:183`, enforced `tools.ts:146` | **yes**, client-side |
| 9 | `CREW_NEVER_TOOLS` | 5 names | `manifest.ts:231` | yes, at manifest validation |
| 10 | `expose` | generic / route | `queries/index.ts:161` | **yes** |
| 11 | `isVaultPath` / `validAreaPrefix` | path shape | `instance-layout.ts:232,148` | **yes — for the owner too** |
| 12 | management gate `isUser` | boolean | `server.ts:147,735` | yes (door D) |
| 13 | `remote` + `approved_at` | pending | `agents.ts:265` | yes (nothing authenticates) |
| 14 | `revoked_at` | revoked | `agents.ts:265` | yes |

### 1.6 The matrix as it IS

`y` = yes; `p` = partial, see the note; `—` = refused; `n/a` = unreachable by
that principal at all. "assistant" is P5, "agent" is P4 at tier `areas`,
"crew" is P6, "capture tool" is P3.

| capability | owner (P1/P2) | assistant | agent (granted) | crew | capture tool |
| --- | --- | --- | --- | --- | --- |
| read a knowledge page | **p¹** | y | y (in areas) | y (in `scope`) | — |
| list page titles | **p¹** | y | y (tier ≥ index) | y | — |
| grep page contents | n/a² | y | y (tier areas) | y | — |
| write a knowledge page | via reconciler | y | — | — (never) | — |
| capture to the inbox | y | y | y | y (if `uses`) | **y** |
| raise a request | y (n/a — it is their queue) | y | y | y (if `uses`) | — |
| **ask for an area** | n/a | **—³** | y | —⁴ | — |
| run a named query | **p⁵** | y | `queries:true` only | — (never) | **y⁵** |
| tasks: list/claim/close | y (board routes) | y | in `projects` | in `projects` | — |
| speak in a room | y | y | in `projects` | if `uses: rooms` | — |
| artifacts: publish/review | y | y | in `projects` | if `uses: artifacts` | — |
| delegate to a crew | y (dispatch) | y | — | — (never) | — |
| propose an action | n/a (they *are* the approver) | autonomy | autonomy | autonomy + `uses` | — |
| answer a request | **y** | — | — | — | — |
| edit grants / autonomy | **y** | — | — | — | — |
| read `.metistry/*` | **p⁶** | — | — | — | — |

1. The owner's knowledge door refuses `Artifacts/`, `.metistry/` and the root
   `CLAUDE.md` — `canSee(path, OWNER_SCOPE)` still runs `isVaultPath`
   (`knowledge-routes.ts:178-179`, `server.ts:855-858`).
2. There is no `GET /api/knowledge/grep`; the owner's content search is
   `/api/knowledge/search`, a different shape.
3. `access.ts:78` + `server.ts:1331`. §2.4.
4. Refused twice: `CREW_NEVER_TOOLS` at manifest validation
   (`manifest.ts:231`) and `server.ts:1331` at triage — but **not** at `/mcp`,
   where a crew reads as `external` (§2.3).
5. Only `expose: generic`. The owner is refused the other three at the
   generic door as well (§2.6).
6. Through `/api/compute*`, not through knowledge.

---

## 2. The inconsistencies

Each is stated as a fact with a line, then what it costs.

### 2.1 Four overlapping answers to "may this agent see this page"

`tier`, `areas`, `queries`, and `expose` all bear on one question, and until
2026-09-19 `queries: true` was a documented way *past* the tier: the page list
is a named query, so an agent at tier `none` could run `queries_run
knowledge_pages` and page the whole index (`docs/ops/assistant-tools.md:50-58`).
The fix was to mark two manifests `expose: route` and refuse them at
`queries_run` — correct, and it means **the knowledge boundary is now
maintained in a YAML field on a query file**. Add a twenty-second query whose
rows carry paths and forget the field, and the hole is back. There is no test
that can catch it generically, because the rule is "does this query's output
contain a vault path", which nothing declares.

### 2.2 A crew's toolset is enforced in the caller, not at the door

`crewToolNames(uses)` (`apps/assistant/src/crew.ts:53`) is passed as `allow:`
to `mcpToolHost`, which filters `tools/list`
(`apps/assistant/src/tools.ts:146`) and refuses an unlisted call
(`:149-150`). That is the whole enforcement of `uses`. `/mcp` cannot
enforce it: `AgentPrincipal` has no `uses` field
(`packages/mcp-brain/src/types.ts:19-39`), so the server does not know a crew
from any other external agent.

**What limits the exposure, honestly:** the crew's bearer is minted per run
and burned after (`crew-drain.ts:120`, `:148`), and the only holder is the
assistant process. So this is a process boundary, not an open door. **What it
still costs:** the comment at `tools.ts:150` says "the allowlist is the
control", and it is — but the control is in the caller. `uses: [knowledge]`
does not stop a crew calling `tasks_comment`; only the client filter does.
Five of the eight groups are *also* gated server-side for other reasons
(`knowledge_write`, `agents_delegate`, `queries_*` by `kind`;
`propose_action` by autonomy; knowledge by tier), which is why this has never
bitten. `rooms`, `artifacts`, `tasks`, `capture` and `requests` are not.

CLAUDE.md's principle over all others is "enforce at the tool, never by
prompting". This is not prompting — but it is not at the tool either.

### 2.3 `kind` has three values and the principal carries two

`crews.ts:261` inserts `kind = 'crew'`. `AGENT_KINDS` is
`["external","internal"]` (`agents.ts:35`). `authenticateAgent` collapses it:
`kind: row.kind === "internal" ? "internal" : "external"` (`:278`). The
column has no CHECK constraint — `db/migrations/0007_agents.sql:12` comments
"durable: external | internal" and stores a third value.

Three consequences, all live:

- **A crew may call `request_access` at `/mcp`.** `access.ts:78` refuses only
  `internal`, and a crew reads as `external`. The manifest schema refuses
  `uses: request_access` (`manifest.ts:231`) and the client filter would not
  offer it — but the door would take it. The row would then be refused at
  triage by a *different* rule (`server.ts:1331`, `current.kind !== "external"`,
  which reads the row, not the principal), with a sentence about the crew's
  manifest. Three checks, in three files, for one rule, and the one at the
  door is the one that does not hold.
- **`toPrincipal`** re-derives `agent_kind` from the already-coerced value
  (`artifacts-tools.ts:24`), so the artifacts module cannot tell a crew from a
  foreign agent either.
- **`validateGrants({kind: "internal"})`** admits the bare vault `/`; a crew
  goes through it as `external` (`crews.ts:110`) — correct today, by
  coincidence of the call site rather than by the principal's own type.

### 2.4 The assistant cannot ask

`request_access` refuses `kind: internal` with a 34-word explanation
(`access.ts:66`, `:78`); triage refuses the widening again
(`server.ts:1331-1337`). The *reason* is airtight — `ensureInternalAgent`
replaces the grants from `.env` on every console start (`agents.ts:306`), so
an approval would silently vanish — and the refusal names the remedy
(`METISTRY_ASSISTANT_AREAS`).

But look at what the owner actually gets. The external agent that hits a wall
raises one row in Needs You and the owner taps Approve. The **assistant** that
hits the same wall is told to raise a free-text `requests_create`, which the
owner reads, and then hand-edits a `.env` file and restarts the console. The
principal with the most reason to ask has the worst path, and the asymmetry is
an artefact of *where the grant is stored*, not of what is safe.

Note that `ASSISTANT_DEFAULT_AREAS` is `["/"]` (`agents.ts:75`), so this bites
only on an instance that narrowed it — which is exactly the instance that
would need it.

### 2.5 Refusals speak five dialects

| situation | code | message | machine-readable remedy |
| --- | --- | --- | --- |
| tier `none` on knowledge | `forbidden` | `"not granted"` | none (`knowledge-fs.ts:111,278`) |
| listable but unreadable page | `forbidden` | a sentence naming the area and `request_access` | **`reason` + `grantedScope`** (`knowledge.ts:187`) |
| unlistable page | `forbidden` | *(none)* | none (`knowledge.ts:329`) |
| task outside projects | `not_found` | *(none)* | none (`server.ts:378`) |
| create into a non-member project | `forbidden` | *(none)* | none (`server.ts:435`) |
| `knowledge_write` by a non-internal | `forbidden` | *(none)* — the tool's *description* carries it | none (`knowledge-write.ts:305`) |
| `agents_delegate` by a non-internal | `forbidden` | `"not granted"` | none (`crew-tools.ts:112`) |
| `queries_*` without the grant | `forbidden` | *(none)* | none (`queries-tools.ts:79,97`) |
| `queries_run` on a route query | `not_found` | `"no such query: X"` — deliberately indistinguishable | n/a (`queries-tools.ts:64-65`) |
| `propose_action` on a denied kind | `forbidden` | names the route **and** the CLI command | `{action, mode}` in `meta`, not on the wire (`action-tools.ts:104-109`) |
| `request_access` by internal | `forbidden` | names the env var and the doc | none (`access.ts:66`) |
| agent bearer on the console | `forbidden` | *(none)* | none (`server.ts:532`) |
| `owner_token` on management | `forbidden` / `not_found` | *(none)* | none (`server.ts:763,765`) |

The mechanism to fix this already exists and has exactly one user:
`Outcome.expose` is merged onto the wire envelope at `server.ts:557`, and
`scope_required` is the only thing that uses it. Everything else either says
nothing or says it in prose the model has to parse.

Two of these are *deliberately* uninformative and must stay so: the
route-query refusal (an oracle for which route queries exist) and the
project-scope `not_found` (a row outside your projects does not exist for
you). A uniform envelope has to be able to express "there is nothing to tell
you" without that reading as a bug.

### 2.6 The owner is narrowed by validators written for agents

Two places, and the brief names the shape exactly:

- **`canSee(path, OWNER_SCOPE)`** runs `canSeeUnder`, which runs
  `validKnowledgePath` → `isVaultPath` (`knowledge-routes.ts:178`,
  `knowledge.ts:92-95`). `OWNER_SCOPE` is `{areas: null}` — "no prefix
  restriction" — but the *classification* check still applies, so the owner's
  own `/api/knowledge/read` refuses `.metistry/compute.yaml`, `Artifacts/…`
  and the root `CLAUDE.md`. `server.ts:855-858` documents this as intentional
  ("every vault path, which is not every path"), and for the *indexer* it is
  plainly right. For the *owner's read* it is a routing accident: those files
  are reachable through `/api/compute*` and the artifacts routes, so nothing
  is actually protected — the owner just has to know which door.
- **`namedQueryDoor`** (`server.ts:292`) refuses `expose: route` **to every
  caller**, the owner included. The rule exists so an agent cannot page the
  vault index unscoped (`:283-290`). The owner is collateral: they get
  `/api/knowledge/pages` instead, which is the same rows through the same
  query — so again, nothing is protected, there is just a second door.

Neither is a hole. Both are places where "the owner has everything" is false
in the code and true in intent, which is precisely the kind of drift the brief
asks to end.

### 2.7 Three storage sources, re-derived in prose at every door

§1.2. `kind` is a proxy for "where do this row's grants come from", and three
separate files reconstruct the sentence: `access.ts:55-67` (internal → the env
var), `server.ts:1331-1337` (internal → the env var; crew → the manifest
path), `manifest.ts:225-231` (crew → the manifest). A fourth consumer — a CLI
renderer — would write it a fourth time.

### 2.8 Two shapes for the same grant, kept apart by comments

`knowledgeScope(principal).prefixes` and `KnowledgeScope.areas` are both
`readonly string[] | null` and **`null` means different things**
(`knowledge-routes.ts:143-154`). The comment explaining why they must not be
renamed into each other is eleven lines long. Separately,
`packages/mcp-brain/src/surface.ts:36` builds a measurement principal with
`{tier: "areas", areas: []}` — a grant `validateGrants` would refuse outright
(`agents.ts:165`). Harmless, because it is a harness; symptomatic, because the
two representations of a grant are not one type.

### 2.9 The policy predicates live in a bridge package

`apps/console/src/agents.ts:31` imports `underAreas` and `ACCESS_REQUEST_KIND`
from `@foldedspacelabs/metistry-mcp-brain`; `knowledge-routes.ts:38` imports
`canSeeUnder` and the two query-name constants from the same place. The
dependency arrow is fine (apps → packages) — but the console's authorization
rules are being served out of one bridge's package, and a second bridge would
have to import a sibling bridge to get them.

### 2.10 One renderer does not exist

The brief asks for grants "rendered identically in the CLI (`metistry
agents`), the console, Needs You, and the tool descriptions". Today:

- **CLI**: `metistry agents` has exactly one subcommand, `autonomy`
  (`packages/cli/src/main.ts:1169-1171`). There is no `metistry agents list`
  and no grant rendering. Grants are set through `metistry connect --areas`
  (`:895-905`).
- **console**: `apps/console/web/app.js:765` — `ACCESS_LABEL = {none:"none",
  index:"titles", areas:"folders"}`, rendered at `:780-782`, with the
  `queries` checkbox at `:850`.
- **Needs You**: `app.js:668-670` renders an `access_request` with a *third*
  vocabulary and its own hand-written `index → areas` trade-off note at `:670`.
- **tool descriptions**: the rules are restated in English in
  `server.ts:338` (`request_access`), `:503-505` (`knowledge_write`),
  `crew-tools.ts:101`, `queries-tools.ts:62`.

Four vocabularies for one record, and the CLI has none.

---

## 3. The proposal: one model

### 3.1 Role + scope

```ts
// packages/core/src/access.ts  (new; pure data + functions, no pg, no config)
type Role = "owner" | "assistant" | "agent" | "crew" | "tool";

type Verb = "list" | "read" | "write" | "propose" | "act";

type Resource =
  | { kind: "knowledge"; path: string }
  | { kind: "query";     name: string; exposure: "generic" | "route" }
  | { kind: "project";   slug: string | null }
  | { kind: "action";    action: ActionKind }
  | { kind: "agent";     id: string }        // the registry itself
  | { kind: "config";    file: string };     // .metistry/*, identity, compute

interface Principal {
  id: string;
  role: Role;
  scope: {
    areas: readonly string[] | null;   // null = every knowledge path. OWNER ONLY.
    queries: boolean;
    projects: readonly string[] | null; // null = every project
    autonomy: ActionAutonomy;
  };
  /** Where the scope came from, so no door re-derives it from `role`. */
  source: "registry" | "environment" | { manifest: string };
}

function may(p: Principal, verb: Verb, r: Resource): Decision;
type Decision = { ok: true } | { ok: false; reason: Reason; needs?: Needs; tell: "refuse" | "hide" };
```

Four properties, each of which kills one of §2's findings:

1. **`role: "owner"` short-circuits `may` to `{ok:true}` for every verb and
   every resource.** That is the owner's sentence made arithmetic rather than
   a default nobody chose. It is safe *only because* `Resource` is a closed
   tagged union — `.metistry/compute.yaml` is `{kind:"config"}`, not a
   knowledge path, so "the owner may read everything" never has to be
   weakened to keep an agent out of the machinery. This is the crux of the
   whole proposal (§3.3).
2. **`tell: "hide"`** is how "there is nothing to tell you" survives a uniform
   envelope: a `hide` decision renders as the door's existing uniform
   `not_found`, with no `reason` and no `needs`. Project scope and route-only
   queries take it (§2.5's two deliberate cases); everything else takes
   `refuse`.
3. **`crew` is a role, not a coerced `external`.** `may` can then hold `uses`
   — carried on the principal, resolved from the crew's registry row at
   `authenticateAgent` — so `uses` becomes a door check rather than a client
   filter (§2.2), and the three scattered "is this a crew" rules collapse to
   one.
4. **`source` is a field**, so the "your scope is configuration, not a grant"
   sentence is written once and rendered everywhere (§2.7).

### 3.2 The refusal envelope

One shape, additive over what `server.ts:557` already merges:

```json
{ "error": { "code": "forbidden", "message": "…" },
  "reason": "scope_required",
  "needs":  { "grant": { "tier": "areas", "area": "Areas/Health" } } }
```

`reason` is a closed enum — `scope_required`, `tier_required`,
`queries_required`, `role_required`, `autonomy_required`,
`membership_required`, `not_member` — and `needs` is the *machine-readable*
form of what would unlock it, which is exactly what `request_access` needs as
input and what the console's Approve applies. `scope_required` already ships
in this shape (`knowledge.ts:187`); this generalises it and changes nothing
about `error.code`, so invariant 8's envelope is untouched.

The rule that makes it honest: **`needs` is produced by `may()`, never by a
tool body.** A tool that hand-writes a remedy sentence is the thing this
replaces.

### 3.3 Resource classification is not permission

The single conceptual change. Today `isVaultPath` does two jobs: it says what
counts as knowledge (for the indexer, correctly) and it narrows the owner (for
the knowledge door, accidentally — §2.6). Split them:

- `classify(path) -> "knowledge" | "artifact" | "config" | "machinery"` in
  `core`, with `isVaultPath` retained as `classify(p) === "knowledge"` so the
  indexer's behaviour is byte-identical.
- `may(owner, read, {kind:"config", file})` → `{ok:true}`; the *knowledge*
  route still only serves knowledge resources, because that is what it is a
  route to — not because the owner is forbidden.

This is what lets the owner's rule be stated with no exception clause.

### 3.4 One place, one function, one renderer

- **`packages/core/src/access.ts`** holds `may`, `Decision`, `Reason`,
  `classify`, and the moved `canSeeUnder`/`underAreas`/`validKnowledgePath`.
  `core` is the right home: it already holds `actions.ts`, `manifest.ts` and
  `instance-layout.ts`, imports no pg and no config, and everything else
  already depends on it — which also undoes §2.9's bridge-as-policy-host.
- **`describeScope(principal): ScopeView`** in the same file: one structure
  with the labels, the areas, the queries flag, the projects, the effective
  action table, and `source`. `metistry agents list`, the console's Agents
  panel, the Needs You `access_request` card, and the tool descriptions all
  render *that*. The labels (`none`/`titles`/`folders`) move out of
  `app.js:765` into it.
- **Grants stored once, in the place they already are**: registry rows for
  external, `.env` for internal, manifest for crews. The proposal does not
  move storage — it records which one it was, and refuses a widening at one
  place instead of three.

### 3.5 What this does NOT solve, stated plainly

- **§2.1's `expose` field is still a YAML flag on a query file.** `may` can
  refuse a `{kind:"query", exposure:"route"}` resource uniformly, which is
  better than a check at one tool — but "does this query's rows carry vault
  paths" remains undeclared and unprovable. The honest fix is a per-query
  `returns: paths` declaration validated against the SQL's output columns, and
  that is a separate piece of work (open question 4).
- **The `index` → `areas` trade** (a tier-`index` agent that accepts an area
  grant loses its whole-vault title browse — `agents.ts:476-481`,
  `app.js:670`) is a consequence of tier being one ordinal. A `{list: all,
  read: [areas]}` scope would express it; that is a model change with a
  migration, and it is open question 2.
- **The assistant's asking path** (§2.4) is not fixed by `may()`; it needs a
  decision about where an assistant's scope lives (open question 1).

---

## 4. Migration, effort, and which tests move

Ordered so that each phase is separately shippable and the first one cannot
change behaviour.

| phase | what | behaviour change | effort |
| --- | --- | --- | --- |
| **P0** | Move `canSeeUnder`, `underAreas`, `validKnowledgePath`, `SCOPE_REQUIRED`, `scopeRequired`, `areaOf` from `packages/mcp-brain/src/knowledge.ts` to `packages/core/src/access.ts`; re-export from mcp-brain for one release. | **none** — pure move | ~half a day |
| **P1** | `may()` + `Decision` + `Reason`/`Needs`. Every door calls it; each existing check becomes a `may` case that returns the *same code and the same message it returns today*. Add `needs` only where a remedy already exists in prose. | **none by construction** — a golden test asserts every refusal's `(code, message)` is byte-identical to today's | 1–2 days |
| **P2** | `role` replaces the coerced `kind`. `crew` becomes a real role: `authenticateAgent` reads the row's `kind` without collapsing, `uses` rides on the principal, `/mcp` enforces it. Additive migration: `agents.kind` gains a CHECK for the three values it already stores; new nullable `grant_source` column. | **one**: a crew's `uses` becomes a door refusal instead of a client filter. That is the point (§2.2). A crew calling outside `uses` gets `forbidden` where it previously got the client's `"not in this run's tool list"`. | 1–2 days |
| **P3** | `describeScope()`; `metistry agents list` (new); the console panel, the Needs You card and the tool descriptions all render it. Vocabulary unified to one triple. | cosmetic, visible | 1–2 days |
| **P4** | `classify()`; owner short-circuits `may` unconditionally; `/api/q/<name>` and `/api/knowledge/*` stop narrowing the owner. | **one**: the owner can read a route-exposed query through the generic door and `.metistry/*` through the knowledge door. Needs the owner's ruling (open question 3). | 1 day |
| **P5** *(optional)* | `needs`-driven asking: the console's Approve reads `needs.grant` instead of `payload.area`, so any refusal that produced a `needs` can be turned into a request by the same mechanism. | additive | 1 day |

Total **5–8 days** for P0–P4, which is a refactor rather than a feature and
should be read that way. P0 and P1 alone (~2 days) deliver most of the
consistency win; P2 is the one that closes a real gap.

**Tests that move, and the ones that should be written:**

- `apps/console/test/knowledge-routes.test.ts` (`canSee`/`OWNER_SCOPE`/
  `filterPages`/`filterHits`, ~20 cases) → `packages/core/test/access.test.ts`,
  unchanged assertions.
- `packages/mcp-brain/test/brain.test.ts`'s tier and scope cases become
  `may()` cases; the bridge keeps only "this tool calls `may` with the right
  resource".
- `apps/console/test/agents.integration.test.ts`'s `ensureInternalAgent` and
  `validateGrants` cases are untouched (storage does not move).
- **New, and this is invariant 8's "misuse tests ship with the interface":**
  one property test that enumerates `TOOL_NAMES` × the five roles and asserts
  *every* pair is decided by `may()` and nothing else — i.e. no tool body
  contains its own `kind ===` or `tier ===` comparison. That test is what
  stops the model re-fragmenting, and it is the single most valuable artefact
  of the whole exercise.
- One golden file of every `(reason, needs)` pair, so a refusal's wording is a
  reviewable diff rather than a string in a handler.

---

## 5. The invariants, explicitly

**Invariant 2 — shared responsibility, enforced at the tool.** Unchanged and
strengthened. `may()` decides; it never writes. Every widening still goes
through `writeGrants` (`server.ts:1116`), one validator, one audit row. The
proposal adds `source` so "this scope is the user's hand, not a grant" is a
field rather than three prose reconstructions — which makes the *refusal* to
widen a configured row enforceable in one place instead of three (§2.7).
`needs` carries what would unlock a refusal; it grants nothing, exactly as
`request_access` grants nothing today (`access.ts:5-12`).

**Invariant 8 — security survives full code visibility; the network is not a
boundary; misuse tests ship with the interface.** `error.code` and the
envelope are untouched; `reason`/`needs` ride in the additive slot
`server.ts:557` already merges. The two refusals that must stay uninformative
keep a `tell: "hide"` that renders as today's uniform `not_found` — expressed
in the type, so a future contributor cannot make them chatty by accident. The
enumeration test in §4 is the misuse test for the interface. Fail-closed is
preserved: `may` returns `{ok:false}` for any `(role, verb, resource)` it does
not have a rule for, and the enumeration test makes an unhandled pair a build
failure rather than a default.

**Invariant 10 — the console's mutating surface is closed.** No new action, no
new route, no new verb. P5 is explicitly *not* "an agent may propose a grant":
`needs` is a description of a refusal, and Approve remains a door onto
`writeGrants`. `ACTION_KINDS` is unchanged (`core/actions.ts:34`) and its
comment — "deliberately absent: … any change to grants or autonomy" — stays
true.

One thing to watch, and it is the only place the proposal touches invariant
10's spirit: making `may()` data-driven must not become "policy is
configuration". The `Role × Verb × Resource` table is **code in `core`**,
reviewed in a PR, never a YAML file. If it ever becomes loadable, a new
permission arrives by config line, which is exactly what invariant 10 forbids.

---

## 6. Open questions (the owner's)

1. **Where does the assistant's scope live?** (§2.4) Three options: keep
   `.env` (today), move to a reconciler-owned protected file under
   `.metistry/` so the assistant can ask and an approval survives a restart,
   or let the registry hold it and have `ensureInternalAgent` stop replacing
   grants (only creating them). The second matches the brief's "grants stored
   once (the reconciler-owned file for internal…)" and is the only one that
   lets the assistant use the same door every other principal uses. It is also
   the only one that changes where a secret-adjacent decision is stored, so it
   is yours.
2. **Is `tier` one ordinal, or two independent scopes?** (§3.5) Today
   accepting an area grant *narrows* a tier-`index` agent's title browse
   (`agents.ts:476-481`). `{list: all | [areas], read: [areas]}` would express
   both, at the cost of a grant migration. Worth it, or is the trade a
   feature?
3. **Should the owner's knowledge door serve `.metistry/` and route-exposed
   queries?** (§2.6, P4) "The owner has everything" says yes. The counter-case
   is that one door per resource class is clearer than one door that serves
   everything to one principal. I lean to: keep the doors, but make the
   *reason* classification rather than permission, so the rule has no
   exception. Your call on whether P4 ships at all.
4. **Should a named query declare whether its rows carry vault paths?** (§2.1)
   `expose: route` is currently the whole of the knowledge boundary for
   derived state, and it is a field somebody has to remember. A
   `returns: { paths: <column> }` declaration would let one filter be applied
   generically — and would let `may()` scope a query's *rows* rather than
   refusing the query.
5. **Is P2's behaviour change acceptable?** Moving `uses` enforcement to the
   door is the only phase that changes what a running crew sees on a refusal.
   Low blast radius (the crew's own client already refuses the same calls), but
   it is a behaviour change on a live path and you asked for none.
6. **Does `metistry agents list` want to exist?** (§2.10) The brief assumes it
   does; today there is only `metistry agents autonomy`. It is the cheapest
   item in P3 and the one that makes the "rendered identically" test
   meaningful, but it is a new CLI verb.

---

## Contradictions and corrections to the brief

Reported rather than routed around (CLAUDE.md), and not acted on.

- **There are no `board_*` tools.** The brief names "the three `board_*`" as a
  merge candidate. `board` and `board_projects` are **named queries**
  (`seed/queries/board.yaml`, `board_projects.yaml`;
  `docs/ops/board.md:16`), reached through `queries_run` and
  `GET /api/q/`, and they cost nothing on the tool surface. The closest real
  sibling sets are `tasks_claim`/`tasks_renew`/`tasks_release` and
  `artifacts_*`; they are costed in the companion document.
- **`metistry agents` does not render grants today** (§2.10). The brief's
  "rendered identically in the CLI (`metistry agents`)" describes a surface
  that has to be built, not unified.
- **The four-axis count is an undercount** (§1.5). Fourteen axes; eight can
  refuse a knowledge read. The brief's four are the four that are *visible in
  the grants form*, which is itself a finding: the other ten are invisible to
  the owner at the moment they grant.
- **Plan §4.20's "not granted, not not-found" rule is not uniform.** The plan
  (`metistry-build-plan.md:1424-1426`) says a scope denial returns "not
  granted", not "not found". Knowledge obeys it; `tasks_*` and `artifacts_*`
  deliberately return `not_found` for a project-scope miss
  (`server.ts:378`, `artifacts-tools.ts:6-7`), which is the right call for a
  collaboration boundary and contradicts the plan as written. **The plan is
  not edited here**; §3.2's `tell: "hide"` is how the proposal expresses both
  rules without either being an exception.

---

## Sources

Repo facts cite `file:line` against this checkout at
`47fe7c5` (2026-09-19). Prior art this builds on rather than repeats:

- `docs/ops/assistant-tools.md` — the tier table, the `expose: route` ruling,
  "a new read capability is a named query".
- `docs/ops/actions.md` — A3 / OPEN-2, the autonomy table, the widening rules.
- `docs/ops/auth.md` — the two owner credential classes and why `isUser` is
  one predicate.
- `docs/research/2026-09-19-code-mode-mcp.md` §1.4 — SEP-1881
  (scope-filtered tool discovery) is the pattern `propose_action`'s
  conditional registration already implements; §3.3's three properties are the
  conditions any capability proxy is reviewed against.
- `metistry-build-plan.md` §4.11 (tiers 0–2), §4.19 (trust rules), §4.20
  (principal), §4.21 (autonomy) — the design these implement.
