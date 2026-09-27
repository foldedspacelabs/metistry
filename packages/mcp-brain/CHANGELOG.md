# @foldedspacelabs/metistry-mcp-brain

## 0.13.0

### Minor Changes

- 42021b1: Access hardening (T2-2). **Revise on an access request can only grant less**
  (C40): `accept_with_changes {area}` is refused with a `400` unless the area is
  the one asked for or a folder under it, and the refusal writes nothing — no
  grant, no override, no `payload.error`; it carries `asked`. **The answer
  carries the prior tier** (C41): `granted.prior_tier` on the response and on
  `payload.granted`. **The escalation ceiling leaves a record** (C42):
  `request_access`'s third ask after two declines writes a `runs` row of kind
  `access_ceiling` (exported as `ACCESS_CEILING_KIND`, with `AccessCeilingMeta`),
  and `GET /api/agents` lists them as `access_ceilings`, grouped per (agent,
  area), until the agent holds the area or is revoked.
- 739564d: **One commit per act (T10-1, plan §2.21).** The reconciler's committer keys each commit by the act that made it instead of by `(principal, group)` per flush window: an explicit `group`, else the intent's `turn`, else its `run`, else the write alone. A commit carries `Brain-Source: <principal>` plus `Metistry-Run: <runs.id>` and `Metistry-Turn: <turn id>` trailers where known; two acts of one principal on the same path in one window fold into one commit carrying both. The bridge's intent gains `turn` and `run` (ids only — anything else is `invalid_request`, so a body cannot forge a trailer). The sweep of out-of-band edits is one `user` commit per sweep whose subject names its files (*Edits from Obsidian: 3 notes*). `knowledge_write` now sends the reply's turn handle and its call's `runs.id` instead of a per-agent group, so two replies in one flush window are two commits.
- 5e8f8d1: A work row says what it is about (T1-1, C85). Migration `0026_work_description.sql` adds `work.description` (nullable text, durable). `TasksService.create` takes `description` and `update` takes it on the board arm, capped at `DESCRIPTION_MAX` (2,000 characters); blank is stored as none, and `Task.description` is `null` when nobody wrote one. `tasks_create` accepts it. `tasks_update` has no `description` key, so an agent sets a description at create and never edits it. The owner edits it with `PATCH /api/tasks/:id {"description": …}`, without a claim; `null` or blank clears it, and it cannot ride with a holder status. Every task route's `task`, the `board` query's rows and MetistryKit's `BoardCard` carry it; `TaskPatch` gains `description` and `TaskPatch.describing(_:)`.

### Patch Changes

- Updated dependencies [152022a]
- Updated dependencies [942372e]
- Updated dependencies [95fb504]
- Updated dependencies [df37d39]
- Updated dependencies [3d2e818]
- Updated dependencies [4451f77]
- Updated dependencies [3a1ff8c]
- Updated dependencies [6592f91]
- Updated dependencies [bf33ee1]
- Updated dependencies [bd29463]
- Updated dependencies [9ac7949]
- Updated dependencies [3f9d719]
- Updated dependencies [4cba65a]
- Updated dependencies [be25ade]
- Updated dependencies [c38dc4e]
- Updated dependencies [a927e61]
- Updated dependencies [06c854e]
- Updated dependencies [ec21783]
- Updated dependencies [a1f1113]
- Updated dependencies [24a9ddb]
- Updated dependencies [8c9dde6]
- Updated dependencies [8217e01]
- Updated dependencies [37f0ed2]
- Updated dependencies [5e8f8d1]
  - @foldedspacelabs/metistry-core@0.13.0
  - @foldedspacelabs/metistry-tasks@0.13.0
  - @foldedspacelabs/metistry-artifacts@0.13.0
  - @foldedspacelabs/metistry-queries@0.13.0

## 0.12.0

### Patch Changes

- 1edc2f7: **`Me/` and the user's own journal are refused at the tool for every non-user principal — new pages included.** `knowledge_write`'s ownership rule only ever ran against a note that already existed, so a brand-new page under `Me/` or the user's own `Journal/<date>.md` went straight through the default bare-vault grant every instance ships with — `Me/` is discovered, never assumed, and the daily journal is the user's alone (daily-flow-spec §5.1, §6.6). `core`'s `may()` now refuses the PATH itself, ahead of ownership, on both the `knowledge_write` tool and the reconciler's bridge (`writeAllowed`) — the second check exists because a routine's own commit (`plan-tomorrow`, the fold's routine half) reaches the vault directly and never asks `may()` at all. `Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are each a routine's own reserved subdirectory and are unaffected. The seed vault also gains `Resources/README.md`, matching `People/` and `Projects/` — `seed/assistant-prompt.md` already told the fold to create entity pages there.
- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [c69abc3]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0
  - @foldedspacelabs/metistry-artifacts@0.12.0
  - @foldedspacelabs/metistry-tasks@0.12.0
  - @foldedspacelabs/metistry-queries@0.12.0

## 0.11.0

### Minor Changes

- 4f43f9c: **Access requests, after the owner read them: you see everything, an agent may
  escalate once, and the assistant may ask.** Three rulings of 2026-09-19 on the
  `request_access` loop.
  
  **Your own access is never narrowed by a rule about agents.** The area
  validator that refuses `Artifacts/…` is now `validAgentAreaGrant` — the
  prefix shape plus "an agent read path would actually serve it" — and
  `validAreaPrefix` is the shape alone. The refusal is typed where an agent's
  grant is typed (the grants form, `request_access`), because an `Artifacts/`
  grant is inert: every knowledge read path refuses it, so it reads in the
  registry like access and gives none. Your own artifacts are untouched and
  still `GET /api/artifacts`, over the real vault; and where the knowledge door
  cannot serve one — it reads the index, which has never walked `Artifacts/` —
  it now points you at the door that has the bytes instead of saying "no such
  page". An agent asking for the same path still gets the one uniform sentence,
  byte for byte the same as for a path that is not there.
  
  **A decline is told to the agent, and it may escalate exactly once.** Asking
  again for an area you declined no longer files a second identical row and no
  longer vanishes into a dedupe: the tool answers with the decision you gave —
  declined, when, your note — and offers `escalate: true` with a fuller reason.
  That writes ONE new proposal flagged `escalated` with the prior id on it, and
  Needs You renders *asked again after a decline*. Decline that too and the area
  is closed at the tool: a third ask is refused with "ask the owner directly".
  One open ask per (agent, area) throughout, and the flag comes off the record
  rather than the caller's word for it. Enforced at the tool, not prompted.
  
  **The assistant may ask now.** It was refused because `ensureInternalAgent`
  replaces an internal row's grants from `METISTRY_ASSISTANT_AREAS` at every
  console start, so an approval would have been silently undone. Approving an
  `access_request` for an internal row now also records the area in
  `agent_grant_overrides` (migration 0023, additive), which `ensureInternalAgent`
  merges on top of the configured areas on the way in. Configuration stays the
  floor; the approval survives the restart; revoking the credential clears its
  approvals. A crew is still refused at the decision — its scope is a manifest
  file, and that is an edit, not a grant.
  
  Cost on the surface every agent pays: 40 definition tokens for the escalation
  (one optional boolean and a clause), 4,224 → **4,264** against the 5,000 line.
  The tool count is unchanged at 26.
- 5cc302d: **Behaviour change: `knowledge_write` refuses a note with no `source:` in its
  frontmatter, instead of treating it as free to write.** A hand-written note —
  one you wrote in Obsidian, an editor, or on another device — never carries
  `source:`, and `knowledge_write` is a whole-file replace. The old default
  read "no source" as "nobody owns this yet", which meant the assistant could
  read a note you wrote by hand and re-emit it whole from a model turn,
  overwriting it. It is now treated the same as an explicit `source: user`:
  the assistant's own notes, and the evening fold's, still write and update
  freely; every other existing note — including an unsourced one — is
  `forbidden` ("owned by \<source\>; propose instead") and new notes are still
  always free.
  
  The one exemption is `now.md` at the vault root, by exact name: the seed
  template now ships it with `source: assistant` so a fresh instance never
  needs the exemption, but an instance created before this change has a
  `now.md` with no frontmatter yet, and the assistant is required to keep
  writing it every day. The exemption stops mattering the moment `now.md` is
  stamped once, which the very first write after this change does.
  
  If you have written knowledge to your vault by hand and want the assistant
  to be able to update it going forward, the assistant can `propose` the
  change instead, or you can add `source: assistant` to that note's
  frontmatter yourself.
- 57ceb02: **`request_access`: an agent asks for the area it was refused, and the owner
  grants it in Needs You.** Ruled 2026-09-19, the upgrade path proposed in
  #216 and refined in #221. Tier `index` could already see that a page exists,
  be refused its content, and be told which area would unlock it — and then had
  nowhere to put that. The only mechanism was a free-text `requests_create`
  report and a hope.
  
  Now the refusal names a tool: `request_access {area, reason}` writes ONE
  `proposals` row of kind `access_request` with the ask, the reason and what the
  credential holds today, deduplicated on `(agent, area)` while it is pending
  (migration 0022's partial unique index, so a retry storm is one row). It
  **grants nothing** — it is a row. Every tier may ask, `none` included (and
  since the follow-up ruling below, every principal, the assistant included).
  The area is validated at the tool with the same rule the grants validator
  uses, so a crafted prefix (`..`, `.metistry/`, `Artifacts/`, lowercase, the
  bare vault) never reaches a proposal, let alone a grant.
  
  The owner answers it with the three answers every request already takes.
  **Approve calls `writeGrants` — the same function `PUT /api/agents/:id/grants`
  calls**, with the same `validateGrants` and the same `agent_admin` audit row,
  `via: triage`; **Revise** grants a narrower prefix instead (`{area}` on the
  existing triage route); **Decline**, Later and Skip grant nothing. The
  console's mutating surface gains no verb and no route (invariant 10): this
  kind is a new branch onto a service that already existed. It widens by exactly
  the prefix asked for — never `queries`, never a second area, never one already
  covered — and a revoked agent cannot be granted anything: revoking settles its
  pending asks as `deny`.
  
  `packages/core` gains `validAreaPrefix` / `AREA_PREFIX_RE` /
  `AREA_PREFIX_REFUSAL`, lifted out of the console so both doors refuse the same
  strings in the same sentence, and `validAgentAreaGrant` — the same shape plus
  "a read path would actually serve it", which is what refuses `Artifacts/…` on
  an AGENT's grant (it was always an inert grant; every read path ignores it).
  
  Cost on the surface every agent pays: 189 definition tokens, taking the eager
  `tools/list` from 4,035 to **4,224** against the 5,000 line — still smaller
  than the 4,979 it carried a week ago with one tool fewer. The tool COUNT
  ceiling in `ops/scripts/check-tool-surface.mjs` moved 25 → 26 deliberately,
  with the reasoning written beside the number; the tool after this one fails
  that check again.

### Patch Changes

- 4a778f9: **One decision function.** P0 and P1 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, commissioned
  by the owner's "can we simplify the grant/access controls surface and make it
  more consistent?" and approved 2026-09-20. **No behaviour change**, held by a
  golden test rather than by care: every refusal's `(code, message)` is asserted
  byte-identical to `origin/main`.
  
  **P0 — the move.** `canSeeUnder`, `underAreas`, `validKnowledgePath`,
  `areaOf`, `SCOPE_REQUIRED` and `scopeRequired` leave
  `packages/mcp-brain/src/knowledge.ts`; `canSee`, `grantedScope`,
  `OWNER_SCOPE`, `NO_SCOPE`, `filterHits` and `filterPages` leave
  `apps/console/src/knowledge-routes.ts`. Both now live in
  `packages/core/src/access.ts` and both files re-export them — mcp-brain's with
  a `@deprecated` note, for one release. The console's authorization rules were
  being served out of one BRIDGE's package (§2.9); a second bridge would have
  had to import a sibling bridge to get them.
  
  **P1 — `may(principal, verb, resource): Decision`.** Every door in §1.4 asks
  it: `/mcp`'s knowledge, queries, tasks, action and crew tools; the console's
  agent 403, its management gate, `GET /api/q/<name>` and `/api/knowledge/*`.
  Each check that used to live in a handler is now a case in one table that
  returns the same code and the same sentence it returned before — so the file
  reads as a catalogue of the five dialects §2.5 found, which is the point:
  unifying them is one reviewable diff here instead of fourteen strings in
  eleven files.
  
  A refusal carries a closed `reason` (`scope_required`, `tier_required`,
  `queries_required`, `role_required`, `autonomy_required`,
  `membership_required`, `not_member`, plus `not_exposed` for the route-only
  query and `not_knowledge` for a path that is not vault content) and, where a
  remedy already existed in prose, a machine-readable `needs`: the area a
  `request_access` would name, or the autonomy entry the user would raise. The
  wire envelope is unchanged — `error.code` and `expose` are exactly what they
  were (invariant 8).
  
  **Storage does not move**: registry rows for external agents, the environment
  for the instance's own assistant, the manifest for a crew. `may()` decides and
  never writes; every widening still goes through the console's one grants door
  and its one audit row (invariant 2), and the `Role × Verb × Resource` table is
  CODE in `core`, never loadable from a file (invariant 10).
  
  **Two tests ship with it.** `packages/core/test/access.golden.json` is the
  committed catalogue of every `(code, reason, message, needs)` a door can
  answer with, each entry carrying the wording it had at `origin/main` and the
  `file:line` it was read off. `packages/mcp-brain/test/may-surface.test.ts`
  walks all 27 tools × the five roles asserting every pair is decided, that no
  tool is usable by nobody, and — by a grep over the package's source — that
  `kind ===` / `tier ===` appears in exactly one file, the credential →
  principal mapping.
  
  `role: "crew"` exists and nothing produces it yet: `authenticateAgent` still
  collapses a crew's row to `external`, which is P2's job. The owner is still
  decided by the rules rather than short-circuited (P4). Neither is changed
  here.
- 1bf5c76: **A crew's toolset is enforced at the door.** P2 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
  2026-09-20. **One behaviour change, and it is the point of the phase** — read
  the next paragraph before you upgrade an install that runs crews.
  
  **What changes for a running crew.** A crew names TOOL GROUPS in its manifest
  (`uses:`), and until now that list was applied by the process that dispatched
  the run: `apps/assistant/src/tools.ts` filtered `tools/list` and refused an
  unlisted call with the text `"mcp__brain__tasks_comment" is not in this run's
  tool list`. `/mcp` had never heard of `uses` — `AgentPrincipal` carried no
  such field — so the door admitted those calls. Five of the eight groups
  (`rooms`, `artifacts`, `tasks`, `capture`, `requests`) had no server-side gate
  at all; the only thing holding them was a `Set.has` in another process. Now
  the console resolves a crew's `uses` from the manifest it loaded, attaches it
  to the principal at authentication, and the door refuses anything outside it
  before the tool body runs:
  
  ```json
  { "error": { "code": "forbidden",
               "message": "tasks_comment is not in this crew's toolset — writer holds knowledge, requests (`uses:` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying." } }
  ```
  
  One `runs` row on the crew's own id, the uniform envelope, `reason:
  not_in_uses` in `may()`'s decision. The runner's client-side list stays as
  **defence in depth** — the model is still not offered a tool it cannot use —
  but it is no longer the control, and the comment at that filter says so.
  CLAUDE.md's rule over all the others is "enforce at the tool, never by
  prompting"; a filter in the caller is neither.
  
  **`crew` is a real role.** `agents.kind` has stored three values since Phase 5
  (`crews.ts` writes `'crew'`) while the console collapsed anything not
  `internal` to `external` at authentication, so a crew reached `/mcp`
  indistinguishable from a foreign agent (§2.3). `authenticateAgent` now passes
  the row's own kind through, `principalOf` maps it to the `crew` role that
  `may()` has had a table for since P1, and three things follow: the toolset
  gate above, a `crew` that can no longer reach `request_access` at the door
  (it is a never-tool, so it is in no group), and a `source` on the principal
  that is the crew's manifest rather than a fourth prose reconstruction of
  "your scope is configuration, not a grant".
  
  **Migration `0025_agent_role.sql`** (additive; rollback note in the file): a
  CHECK holding `agents.kind` to the three values it already stores, and a
  nullable `grant_source` column recording which of the three places a row's
  grants came from — `registry` (the owner's hand), `environment` (`.env`,
  replaced at every console start), `manifest` (a crew's `scope:`). NULL on
  existing rows and read as `registry`. Nothing decides on it: `may()` never
  reads it.
  
  **Nothing else moved.** Every other refusal is byte-identical — the golden
  catalogue (`packages/core/test/access.golden.json`) asserts it entry by entry,
  and the one changed entry carries both what the caller used to say and what
  the door says now, so the behaviour change is a reviewable diff rather than a
  sentence in a PR. Misuse tests ship with it (invariant 8): a crew bearer
  refused a non-`uses` tool at `/mcp` with no client filter in the loop, a crew
  whose manifest cannot be read holding NO tools rather than all of them, an
  external agent unable to become a crew through a body or a header, and the
  CHECK refusing a fourth kind.
- b6586de: **One vocabulary, one renderer, and the owner is never refused their own
  vault.** P3 and P4 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
  2026-09-20. P4 carries the **owner-visible change** below; P3 changes what
  refusals SAY, not what they decide.
  
  **P3 — one wording per reason.** §2.5 found five dialects across fourteen
  refusal sites. `REFUSAL` in `packages/core/src/access.ts` is now one sentence
  per `reason`, built in one place: the shape is one per reason, the facts in it
  are substituted. So `queries_list` and `queries_run` refuse in the same words,
  `knowledge_write` and `agents_delegate` give the same "belongs to the instance
  assistant alone" sentence, and a tier miss names the tier the tool needs and
  the tier the credential holds — in the console's own words for them (`none` /
  `titles` / `folders`).
  
  Silence became a type rather than an accident at a call site: `tell: "hide"`
  is the refusal deliberately identical to "there is nothing here", it carries
  no `needs`, and `formatRefusal` drops its `reason` on the way out. Four things
  hide — a row outside your projects, a route-only query, the console's uniform
  403, and a knowledge path you may not even list (the 2026-09-19 boundary: an
  area is named only for a page whose existence you can already see).
  
  New in `core`: `describeScope(principal)` (the triple: role · access ·
  extras), `formatRefusal(decision)` (the §3.2 envelope), `classify(path)`,
  `notKnowledge(path)`, `TIER_LABEL`, `ROLE_LABEL`, `sourceLabel`,
  `RULED_TOOLS`, `NO_SUCH_PAGE`, and `tell` on `Refusal`. **Removed**:
  `scopeAsPrincipal` (the P0 seam P4 deletes — `/api/knowledge/*` takes the
  principal now), and the three refusal-string constants it replaces
  (`NOT_A_VAULT_PATH`, `NOT_KNOWLEDGE`, `ARTIFACTS_SIGNPOST`).
  
  **P4 — the owner is refused nothing.** "The owner should always have access to
  everything" (ruled 2026-09-19) is a short-circuit at the top of `may()`, with
  no exception clause below it. Safe only because `classify()` splits what a
  path IS from what anyone may do with it: `Artifacts/` and `.metistry/` are not
  knowledge paths, so the rule never has to be weakened to keep an agent out of
  the machinery.
  
  Two owner-visible changes, and they are the two §2.6 found:
  
  - **`GET /api/q/<name>` serves the owner a route-exposed query.** The filter
    `expose: route` protects is a filter on what an AGENT may see of the vault;
    the owner's scope is the whole vault. The capture owner token is NOT the
    owner and is refused byte for byte, which is the credential that rule was
    always about.
  - **`GET /api/knowledge/page` and `/links` classify instead of refusing.** The
    owner's `Artifacts/` and `.metistry/` answer `400` with
    `reason: "not_knowledge"` and `needs.door` naming the route that has the
    bytes (`GET /api/artifacts`, or "the file itself"), where they used to
    answer `404`. **No door serves `.metistry/state/.env` as a page, and not one
    byte of it crosses here** — the classification is the whole answer.
  
  **Agents gain nothing from P4.** Every agent, crew and assistant refusal is
  byte-identical to what it answered before, which the golden file asserts entry
  by entry: the four `changed` entries under P4 are all `who: "owner"`.
  
  **Surfaces.** `metistry agents list` is new (P3 §2.10 — the CLI rendered
  grants not at all). `GET /api/agents` carries each row's rendered `scope` and
  `grant_source`; an `access_request` payload carries `current_scope`. The
  console's Agents panel and Needs You card print what they are sent instead of
  holding spellings of their own. Tool descriptions moved onto the same words
  and got smaller: brain's definition tokens 4264 → 4255 against a >5000 budget.
- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [9c9da4a]
- Updated dependencies [1bf5c76]
- Updated dependencies [b6586de]
- Updated dependencies [579662f]
- Updated dependencies [57ceb02]
- Updated dependencies [45b64df]
- Updated dependencies [9ec30d5]
- Updated dependencies [7f9ceb7]
- Updated dependencies [23cc47f]
  - @foldedspacelabs/metistry-core@0.11.0
  - @foldedspacelabs/metistry-artifacts@0.11.0
  - @foldedspacelabs/metistry-tasks@0.11.0
  - @foldedspacelabs/metistry-queries@0.11.0

## 0.10.0

### Minor Changes

- 7782cf4: **A wire change: `turn_id` is out of all 25 tool schemas and rides in the
  call's `_meta`.** The correlation handle that groups one reply's tool calls in
  the activity feed was merged into every tool's `inputSchema` — 3,774 chars ≈
  **944 definition tokens, 19% of the entire advertised surface**, for a field
  that is not a parameter and is "never trusted for anything else". Measured on
  this checkout: the eager surface goes **19,914 chars / ~4,979 tokens →
  16,140 / ~4,035**, and the credential-gated 26-tool surface 20,972 / ~5,243 →
  17,047 / ~4,262, so it no longer crosses the >5k line that gates
  `discovery: lazy` at all. No capability was removed and no description
  changed (`docs/research/2026-09-19-code-mode-mcp.md` §2.4, ruled 2026-09-19).
  
  **Where it went.** `_meta` on `tools/call`, the MCP spec's own carrier for
  request metadata, under `com.foldedspacelabs.metistry/turn_id`
  (`packages/mcp-brain/src/turn-id.ts`, exported as `TURN_ID_META_KEY`). The
  assistant's tool host mints one per host — i.e. one per reply — and sends it
  on every call. That also moves the handle from the model's hands into the
  client's: the seed prompt used to ask the assistant to invent an id and pass
  it faithfully on every call, which was a convention, not a control.
  
  **Compatibility, one release.** A client still sending `turn_id` inside
  `arguments` keeps correlating exactly as before: the bridge lifts it into
  `_meta` at the door, beside the deprecated-name rewriter, before any schema
  sees it. Tolerated, advertised nowhere. Two behaviour changes worth knowing:
  a malformed handle is now **dropped rather than failing the call** (a join key
  is not a control), and `turn_id` no longer appears in any `tools/list`, so a
  client that discovers arguments from the schema will stop sending it.

### Patch Changes

- 7782cf4: **The definition-token budget is checked in CI, for every bridge.** The
  manifest schema has always stated the rule — `discovery: lazy` "is for bridges
  past >20 tools / >5k definition tokens" — but only `mcp-brain`'s own test
  enforced it, on itself, so a second bridge could cross the line in silence.
  `ops/scripts/check-tool-surface.mjs` now measures every bridge manifest under
  `apps/` and `packages/` and fails the build past the budget, printing the
  per-bridge numbers and the headroom on every run.
  
  A bridge is measured through a `toolSurface()` export on its package entry —
  the same instinct as `check()` making `metistry doctor` generic — and
  `mcp-brain` ships the reference implementation: it stands up the real server
  and reads a real `tools/list`, so the number is production's definitions
  rather than a snapshot. A bridge without that export is reported
  declared-only. On the tool-count axis the current number is acknowledged
  rather than waived, so the **next** tool forces the lazy decision instead of
  landing quietly.
- 8fc0e5e: **One scope rule for every knowledge read, on both doors.** `expose: route`
  closed the console's generic `GET /api/q/<name>` over the page list and the
  link graph and left the other generic door open: `queries_run` on the `/mcp`
  mount ran any named query for any holder of a `queries: true` grant. That
  grant is a separate axis from the knowledge tier, so it was a way past the
  tiers entirely — an agent at tier `none`, which `knowledge_search` will not
  tell a single title, could page the whole vault index and the whole wikilink
  graph; a `tier: areas` agent could read the titles of every area it was never
  granted. Ruled 2026-09-19: *"all queries including /mcp should be scoped and
  follow the same token based enforcements."*
  
  **`queries_run` honours `expose`.** It asks the same `QueryStore.exposure(name)`
  the console asks and refuses a route-backed query with the **unknown-query
  refusal, byte for byte** — same code, same `no such query: <name>` — and
  `queries_list` does not name one, because a list that named a query the runner
  refuses would publish the route-only set in the same breath. Read off the
  manifests, never matched against a list in the server (invariant 5).
  
  **The scoped door beside it is `knowledge_list`**, which runs the SAME two
  named queries through `packages/queries` and filters them with the same
  function the console's routes use. `links_for: <path>` lists one page's links
  in both directions out of `knowledge_page_links`, with **both ends** of every
  edge scoped — a backlink cannot report that a note exists in an area the
  caller was never granted — and needs an `areas` grant covering the page,
  because a backlink names a note. Without a vault bridge the listing comes from
  the reconciler's index (`knowledge_pages`) instead of the tool being
  `not_available`, and every entry carries path, title and one-line description
  — never content, at any tier. It rides `knowledge_list`'s existing definition
  rather than arriving as a new tool pair because the eager `tools/list` budget
  now sits within 80 characters of the 5k line a new tool would have to buy with
  `discovery: lazy` (`packages/mcp-brain/test/brain.test.ts`).
  
  **That function is now singular.** `canSeeUnder(path, areas)` lifts into
  `packages/mcp-brain/src/knowledge.ts`, beside the `underAreas` it always
  called and the `isVaultPath` core always owned; `apps/console`'s `canSee` is a
  rename over it, and `knowledgeScope` gains `canList` — the same question asked
  about a TITLE rather than content. Tier `index` may be told a page exists
  anywhere in the index (that is the discovery the tier is for: an agent finds
  `Areas/Health/sleep.md` so it can ask you for the area that holds it) and may
  read none of it; tier `areas` lists and reads its prefixes; tier `none` gets
  nothing and is told "not granted", never "not found". The same lift hardened
  `knowledge_list`'s bridge branch, which applied no vault-path rule at all: a
  tier `index` browse of the vault root listed `.metistry/`, `.obsidian/`,
  `Artifacts/` and the root `CLAUDE.md` — machinery, and not knowledge for the
  owner either.
- 0171bc0: **`scope_required`: the refusal names the area, once existence is already visible.**
  Ruled 2026-09-19 (PR #216 judgement call B): tier `index` — or `links_for` on
  a page whose title a grant does not cover — could already see a settled
  page's title through `knowledge_search`/`knowledge_list`, but `knowledge_read`
  and `knowledge_list { links_for }` answered the bare "not granted" anyway,
  leaving an agent to guess which area to ask you to widen. That refusal is now
  structured for a page it could already see (never for a path merely shaped
  like one, never a draft — existence still does not leak either way):
  `isError: true`, the ordinary `error.code: "forbidden"` underneath
  (invariant 8's envelope is unchanged), plus `reason: "scope_required"` and
  `grantedScope` — the page's own parent directory — alongside it.
  `error.message` spells out the same thing in a sentence naming
  `requests_create` as the door (there is no `request_access` tool today) and
  that you approve it from Needs You.
  
  Tier `none` and a path that fails the vault-path rule are untouched — still
  the uniform "not granted", nothing new to distinguish. `Outcome` gains an
  `expose` field (`packages/mcp-brain/src/outcome.ts`) alongside the existing
  audit-only `meta`, so a refusal can opt into carrying structured, wire-visible
  detail without changing what every other `fail(...)` call in this package
  sends: `meta` still never reaches the caller. No tool description grew — the
  eager `tools/list` stays under the 5k-token line — the extra detail lives in
  the response body a refusal already produces.
- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0
  - @foldedspacelabs/metistry-artifacts@0.10.0
  - @foldedspacelabs/metistry-tasks@0.10.0
  - @foldedspacelabs/metistry-queries@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [6b3d645]
  - @foldedspacelabs/metistry-queries@0.9.1
  - @foldedspacelabs/metistry-artifacts@0.9.1
  - @foldedspacelabs/metistry-core@0.9.1
  - @foldedspacelabs/metistry-tasks@0.9.1

## 0.9.0

### Minor Changes

- f57b3b0: **The instance directory is the Obsidian vault.** Open the folder `metistry
  init` made and your notes are right there — `Journal/`, `Me/`, `Inbox/`,
  `now.md` — with nothing of the machinery in the way. Everything that is not
  knowledge moved into `.metistry/`: identity, rules, compute, the config
  directories, the lock, and the derived `state/` that holds Postgres, the
  `.env` and downloaded models. Obsidian ignores dot-prefixed folders, which is
  the whole reason for the dot — the vault root and the install's own files can
  finally be the same directory without one of them cluttering the other.
  
  Vault paths lose their prefix with it: a note is `Areas/Fsl/Drey.md`, a
  capture is `Inbox/…`, and a read grant covering everything is spelled `/`.
  
  **The protected set became a place rather than a list.** Anything under
  `.metistry/` is the user's hand alone — except `.metistry/state/`, which is
  derived and nobody's record — plus the root `CLAUDE.md` and `README.md`.
  That is one rule the reconciler enforces at the tool, instead of seven
  filenames each component had to remember. Neither those two root files nor
  `Artifacts/` are indexed as knowledge: your instructions and your bundles are
  yours to read, not search results.
  
  This ships the layout for NEW instances. An existing instance keeps working
  unchanged and `metistry doctor` now says which shape it is in; the verb that
  moves one is the next change.

### Patch Changes

- 76f82a2: **An instance that has not run `metistry migrate-layout` is read again.**
  `db/migrations/0021` recorded that "a legacy instance keeps working unchanged
  until the verb runs". Verified against a clone of a real pre-ruling instance,
  it did not: #193 moved every path to `.metistry/` and every reader spelled the
  new one, so `metistry compute show` reported no providers while the instance's
  `compute.yaml` declared one, `metistry identity` exited 1 on an instance whose
  `identity.yaml` was right there, `metistry version` omitted the pin, `doctor`
  read `shape compose` off a `deployment.yaml` it never opened and probed the
  wrong half of the install, `metistry secrets`/`console`/`connect` could not
  find `state/.env` at all — which on a launchd install means every rendered
  plist's `__ENV_FILE__` points at a file that does not exist — and `up` would
  have `initdb`'d a second, empty Postgres cluster at `.metistry/state/pg`
  beside the live one.
  
  Two of the breaks were safety, not convenience. The §4.7 protected set became
  the `.metistry/` PLACE, which took the legacy machinery at the instance root
  out of it: on a legacy instance the assistant could write `identity.yaml`,
  `rules.yaml`, `metistry.lock`, `queries/` and `instance-migrations/` through
  `brain-commit` (invariant 2). And the knowledge walk, which now starts at the
  instance root, indexed those same files plus every byte of the gitignored
  `state/` — a Postgres cluster included — as notes.
  
  `resolveInstanceLayout(instanceDir)` in core is the fix: one `detectLayout`
  read, then the right relative-path table (`LEGACY_INSTANCE_LAYOUT` mirrors
  `INSTANCE_LAYOUT` key for key), with `instanceFile()` / `instanceStatePath()`
  as the reader's one-line call. Every reader goes through it — identity,
  rules, compute, deployment, the lock, the peer registry, `.env`, the Postgres
  data and socket dirs, the supervisor's config/socket/bin, `ports.yaml`, the
  models dir, the assistant's state dir, `doctor`'s compute overlay, the
  console's identity/peers/inbox, and the reconciler's inbox prefix (whose SQL
  predicate must match migration 0015's partial index on a legacy instance, not
  0021's). Writers are untouched: `instancePath`/`metistryPath` still spell the
  flat layout, because there is one layout to write and two to read.
  `isProtectedPath` and `isVaultPath` cover the legacy root names
  unconditionally — they receive a path and no instance directory, and the set
  is strictly safer on a flat instance, which has no business holding lowercase
  machinery at its root.
  
  `metistry update` now **refuses** to pin a version past 0.8.x onto a legacy
  instance, before it fetches, builds or migrates anything, printing the
  `migrate-layout` line to run; `--allow-legacy` overrides. Regression tests run
  one fixture in both shapes through the same readers, so a reader that resolves
  only one of them fails.
- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0
  - @foldedspacelabs/metistry-artifacts@0.9.0
  - @foldedspacelabs/metistry-tasks@0.9.0
  - @foldedspacelabs/metistry-queries@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.8.1
  - @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-queries@0.8.1
  - @foldedspacelabs/metistry-tasks@0.8.1

## 0.8.0

### Minor Changes

- 6aa64c2: **Approve now does something on an `action`.** `action` was a word in the
  console's view map that nothing emitted; it is now a request kind carrying a
  **closed** `payload.action = {kind, args}` — exactly four kinds
  (`dispatch`, `task_update`, `comment`, `capture`), held in `packages/core` as
  data plus a zod schema each, so an unknown kind or an unnamed argument is a
  `400` naming the field. Allowing one runs it through the *same service call the
  owner's own click makes* (`dispatch()`, `TasksService.update()`,
  `workComment()`, `captureToInbox()`), as the `user` principal, with the
  proposal's `source_agent` recorded as `on_behalf_of` and the result written
  back to `payload.result`. A refusal leaves the row **pending** carrying the
  error — and nothing is half-applied, because one action is one service call.
  No sending, no git, no shell, no grants: every kind is a door onto something
  the console could already do, never a new power (taskuary review ADOPT 6).
  
  **Autonomy levels, and widening is now allowed — by your hand only** (A3 /
  OPEN-2). `agents.autonomy` gains `{level: observe | propose |
  act_within_scope, actions: {<kind>: allow | propose | deny}}` beside the §4.21
  narrowing keys, so one record answers both "how much room" and "which action".
  The level is a **ceiling** and the per-kind entry the value — the effective
  mode is the lower of the two, which is what makes "it only ever runs on its own
  at `act_within_scope`" arithmetic rather than a rule that could be forgotten.
  Defaults: everything `deny` at `observe` (**and with no level at all**, so this
  release widens nobody), everything `propose` at `propose`, and
  `comment`/`capture`/`task_update` `allow` at `act_within_scope` while
  `dispatch` stays `propose` — off-machine is a human decision by default. A
  change that raises anything is admitted only through `PUT
  /api/agents/:id/autonomy` (the `user` principal) and the new `metistry agents
  autonomy <id> --level … --allow <kind>`; every other caller is narrowing-only
  by default, and every raise writes a `runs` row `agent_admin` /
  `autonomy_widened` plus one Needs You alert, so a raised bar is never silent.
  
  **`propose_action` in mcp-brain**, in its own crew grant group `actions` (the
  same opt-in rule `rooms` follows). It answers `executed` or `pending`; a denied
  kind is a `forbidden` envelope naming `autonomy.actions.<kind>`. Registration
  is **lazy by credential**: an agent whose table admits nothing is not offered
  the tool, which is every agent until you set a level — so the eager definition
  surface stays at 25 tools / ~4.9k tokens for everyone, and an opted-in
  principal carries 26 knowingly. Deferring on the credential costs none of the
  +1 discovery turn a meta-tool index would.
  
  Needs You renders an action's kind, argument preview, reason and result; the
  Agents panel shows each agent's level and resolved table with widen/narrow
  controls. `docs/ops/actions.md` is the whole design.
- 6fd4c28: The console's API contract for a client that is not always connected
  (`docs/ops/console-api.md`, from the 2026-09-11 research note): a public
  `GET /api/identity` (`instance_id`, `name`, `icon`, `version` — read from
  `identity.yaml` through `METISTRY_IDENTITY_FILES`, 503 when absent) so a
  phone can name an instance before sign-in and recognise it after its origin
  moves; an `Idempotency-Key` header on `POST /capture`, scoped to the
  credential class, that returns the original row on replay — one file, one
  inbox row even when attempts race (migration `0014`, unique index on the
  inbox row) — with `Idempotency-Replayed: true`; `409 conflict` carrying the
  winning decision when a proposal was already settled (unknown stays `404`);
  and opaque `since` cursors on `GET /api/messages` and `GET /api/proposals`
  (`cursor`, `more`), where a rating moves a message and a decision moves a
  proposal, so a reconnect after hours is one bounded pull per list. The
  plain lists are unchanged.
- 367f456: **Rooms: a conversation can now hang on a task, not only on a deliverable.**
  A comment thread anchors to a `work` row as well as an artifact version
  (migration `0018` — one nullable `work_id`, a check constraint enforcing
  exactly one parent, and one room per row), so agents can negotiate scope
  before anything is published. Two new tools, `tasks_comment {work_id, body}`
  and `tasks_thread {work_id}`, under the same project grant as `tasks_*`.
  
  **A room cannot address anyone** — no `to_agent`, no `@name`, no addressee
  field anywhere on the path — so posting wakes nobody and triggering stays with
  `agents_delegate`. Because it is the same table, the shipped escalation
  applies unchanged: ten consecutive agent messages and the next one is not
  stored; the room becomes an owner item with its transcript, and a human
  message resets the run. **Resolving is the owner's hand alone**: one console
  route, no tool, and nothing on a timer.
  
  Also: a **Rooms** tab listing every conversation across both anchors, with the
  escalation reason rendered as a sentence; the last of a task's room riding
  along in a crew's brief under `METISTRY_BRIEF_THREAD_BYTES` (default 4096);
  and `proposals.work_id`, set server-side, so a proposal can finally say which
  work row it came from.
  
  Crews reach the new tools through a new `rooms` group in `uses` — its own
  group rather than part of `tasks`, so no existing crew gains the ability to
  speak without a manifest edit.

### Patch Changes

- cde0691: **The inbox moved inside the vault, and human edits became first-class.**
  Captures live at `Knowledge/Inbox/` — Obsidian's vault root is `Knowledge/`,
  so that is the only place it can see them, add to them and edit them — and
  they are tracked, so git carries them: the inbox used to be the one thing a
  `docker compose down -v` rebuild could not bring back (invariant 1).
  `docs/ops/inbox.md`.
  
  - **One sink, every door.** `POST /capture`, the `/note` fast path, the
    bridge's `capture` tool and the collectors all write through the
    reconciler's vault bridge with `expected_sha256: ""` — must not exist — so
    a capture can never land on a file someone already wrote. The console still
    holds no part of the instance repo (D5, invariant 7), and each capture is a
    commit. With no bridge configured it degrades to a plain directory: capture
    keeps working, and moving those files into `Knowledge/Inbox/` later is
    enough for the scan below to pick them up.
  - **Files you write yourself are indexed.** The reconcile loop already walks
    the vault by content hash, so it now also reconciles `Knowledge/Inbox/`: a
    note you added in Obsidian gets a triage row, an edit to a capture
    refreshes its hash and — if it had already been classified or accepted —
    sends it back to `inbox-drain`, because a refinement is new information. A
    `rejected` row stays rejected; a deleted file archives its row rather than
    losing it; the file coming back re-opens it. No new watcher, no new
    component talking to Postgres (invariant 3).
  - **`knowledge_write` can no longer overwrite a note it has not seen.**
    Omitting `expected_sha256` used to mean "unconditional", which meant an
    edit *you* made to a page the assistant owns could vanish with no conflict
    and no trace but the commit. It now means create-only: an existing note
    answers `conflict` with the current hash, so changing a note requires
    `knowledge_read` first. Misuse test ships with it.
  - **Big captures.** Above `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB) a
    capture goes to `Knowledge/Inbox/.large/`, which the instance gitignores:
    Obsidian still sees a 40 MB screen recording, the repo does not carry it.
  - **`metistry migrate-inbox`** moves an existing instance — files (`git mv`
    for what git tracks), `.gitignore`, and `inbox.path` rows to the
    repo-relative form `db/migrations/0001_init.sql` always documented — with
    `--dry-run`, idempotent, restarting nothing. A second instance that already
    moved its inbox to a lowercase `Knowledge/inbox/` is renamed through a temp
    name, because macOS is case-insensitive and `git mv` would otherwise move
    the directory inside itself.
  
  Migration `0015_inbox_in_vault.sql` is additive: a partial unique index makes
  "one row per inbox file" true at the database, since the capture path and the
  scan both reach that directory now.
- 23d72db: **Four rulings from 2026-09-17, each one closing an open question rather than
  adding a surface.**
  
  **One cloud template ships (OPEN-7).** `seed/compute-templates/zen.yaml` is
  gone: a seeded template is a promise to keep a base URL, a price table and a
  retention claim true, and OpenCode Zen's were ours to chase. `openrouter` is
  the one cloud; Zen and every other OpenAI-compatible provider is reached the
  way `compute.yaml` always allowed — a hand-written `providers:` block, or
  `--base-url` over the nearest template. `COMPUTE_TEMPLATES` and the Mac app's
  picker both lose the entry, and the C13 non-ZDR warning is now proved against
  a hand-written cloud, because no shipped template is non-ZDR any more.
  
  **`critical: true` belongs on `assignments.default` (OPEN-4).** The flag was
  already enforced; what carries it was open. The seed now marks the default
  assignment, with the consequence written beside it: under a budget's
  `action: critical_only` the turn you are waiting on keeps being answered while
  routines and delegation stop. The mark travels with the assignment, so
  `tiers.routine` has to stay declared for the pause to reach the evening fold —
  the seed says so, and a test uncomments the seed's own example to prove it.
  
  **The board's Assigned column is read "Addressed to" (OPEN-5).**
  `work.owner` is informational — a name on the card, not a lease; the lease is
  `claimed_by`, and claiming is what moves a row to In Progress. A rename of
  what the user reads only: the derived value stays `assigned`, so every drop's
  route, board.yaml and the `runs` ledger are untouched, and a new test pins the
  label and the key apart.
  
  **`agents_delegate` advertises each crew's description (H8).** The assistant
  saw crew names and nothing else, so which helper fitted a brief was guesswork
  the registry corrected by refusal — after the brief was written.
  `CrewDispatcher.names(): string[]` becomes `crews(): CrewSummary[]`, and the
  `crew` field's description now carries `<name> — <description>` from each
  manifest. It is in the tool definition rather than a prompt line, so it
  travels to whichever model `compute.yaml` assigned, and it is read off the
  registry at registration, so an edited manifest lands on the next call rather
  than the next restart. Capped at 20 crews and 120 characters each: the roster
  is spent out of the same definition-token budget the eager surface is measured
  against.
- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [f27e0af]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
- Updated dependencies [367f456]
  - @foldedspacelabs/metistry-core@0.8.0
  - @foldedspacelabs/metistry-tasks@0.8.0
  - @foldedspacelabs/metistry-artifacts@0.8.0
  - @foldedspacelabs/metistry-queries@0.8.0

## 0.7.1

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.7.1
  - @foldedspacelabs/metistry-core@0.7.1
  - @foldedspacelabs/metistry-queries@0.7.1
  - @foldedspacelabs/metistry-tasks@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0
  - @foldedspacelabs/metistry-artifacts@0.7.0
  - @foldedspacelabs/metistry-tasks@0.7.0
  - @foldedspacelabs/metistry-queries@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.6.0
  - @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-queries@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.5.0
  - @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-queries@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0

## 0.4.0

### Minor Changes

- c32b27d: Add `tasks_close` — the vocabulary fix deferred from the 2026-09-09 rename
  (`docs/product/glossary.md` lists tasks' own verbs as `claim · renew ·
  release · close`, but closing went through `tasks_update {status:
  "closed"}`). `tasks_close` is a thin wrapper over the same `tasks.update`
  host handler (`id`, optional `note`) — no new DB path. `tasks_update`
  keeps `status: closed` working for compatibility; its description now
  points callers at `tasks_close` for finishing a task in one call.
  `tasks_close` joins the `tasks` crew tool group (`CREW_TOOL_GROUPS` in
  core) alongside the other holder verbs, and the assistant's `BRAIN_TOOLS`
  allowlist. The eager surface is now 23 tools, 18,369 chars ≈ 4.6k
  definition tokens — still well under PoC-17's 5k-token lazy-discovery
  line.

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0
  - @foldedspacelabs/metistry-artifacts@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0
  - @foldedspacelabs/metistry-queries@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.3.1
  - @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-queries@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1

## 0.3.0

### Minor Changes

- c07a12c: `knowledge_write` now enforces ownership as well as authorship: an update to
  an existing markdown note whose frontmatter `source` is neither the caller's
  own id nor `knowledge-fold` is refused (`forbidden: owned by <source>; propose
  instead`). New notes are unaffected, and `source` is still stamped from the
  credential rather than the argument, so "notes I wrote" stays a fact rather
  than a claim. Hosts pass their vault reader as the new optional fifth argument
  to `writeKnowledge` (the brain server wires `cfg.readKnowledge` through
  automatically); when a read fails the write is refused rather than waved
  through. `ownershipRefusal` and `frontmatterSource` are exported.
- Knowledge fold (the evening turn that turns accepted items into Journal and entity pages), `import-sessions` and `kind: session` captures, `knowledge_list`/`knowledge_grep` and vault notes as MCP resources under one scope helper, the simplified vocabulary (22 primary tools with call-time aliases; Approve / Revise / Decline; Auto / Supervised), cost discipline ((model, effort) tiers, session roll at task boundaries, cache read/write metrics and a prompt lint), the bundled runtime build (Node, Postgres 17 + pgvector, git — signed), TCC helpers as signed app bundles whose grants survive rebuilds, Sparkle tooling pinned, npm Trusted Publishing, and the GitHub OAuth App shipped as the default for `connect-repo`.
- ad185f2: One vocabulary everywhere. Eight nouns (knowledge, capture, request, task,
  artifact, project, agent, activity) and one verb set per object, in the UI, the
  notifications, the briefs and the tool names. Eleven brain tools were renamed —
  `report` → `requests_create`, `tasks_list_ready` + `tasks_mine` → `tasks_list
  {filter}`, `tasks_heartbeat` → `tasks_renew`, `artifact_*` → `artifacts_*`,
  `crew_dispatch` → `agents_delegate` — and the old spellings keep working for one
  release (resolved at call time, recorded in `runs.meta.alias`, not listed by
  `tools/list`). In the console, Needs You now reads Approve / Revise / Decline
  and project mode reads Auto / Supervised. `docs/product/glossary.md` is the one
  page that holds the vocabulary.

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-artifacts@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0
  - @foldedspacelabs/metistry-queries@0.3.0

## 0.2.0

### Minor Changes

- 66d5c08: `queries_list` / `queries_run` on mcp-brain — invariant 3's one read path
  (named, parameterized queries, never free-form SQL) out to agents. An
  agent lists what's available (name, description, param types/defaults)
  and runs one, capped at 200 rows with truncation noted. The instance's
  own assistant always has it; an external agent needs an explicit
  `queries: true` grant (`PUT /api/agents/:id/grants`), a separate axis
  from the knowledge tier.
  
  Every mcp-brain tool also now takes an optional `turn_id` (≤ 64 chars,
  `[A-Za-z0-9_-]`), recorded on the tool's `runs` row (`meta.turn_id`); the
  `activity_feed` query surfaces it so one reply's tool calls group
  together. The seed assistant prompt tells it to generate one per reply.
  
  Crews never get `queries_list`/`queries_run` — a named query is not
  filtered by a crew's scope/projects the way every other tool group is.
- 4774e08: Phase 6 — embeddings on reconcile, and semantic search behind the same
  grants.
  
  The reconciler embeds settled notes as it reconciles (local Ollama
  `nomic-embed-text`, model and dim per row) and gains
  `POST /embeddings/rebuild`. `GET /vault/search` and mcp-brain's
  `knowledge_search` take `mode=keyword|semantic|hybrid`, defaulting to
  hybrid once vectors exist and keyword before that. Every mode keeps the
  grant tier and the draft exclusion in SQL. With no embedder running,
  search still answers in keyword and the index is unaffected.
  
  Migration 0012 adds `knowledge_files.embedded_hash` / `embedded_model`
  (additive, derived).
- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
