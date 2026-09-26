# @foldedspacelabs/metistry-core

## 0.12.0

### Minor Changes

- 2080ce5: **One type for everything that acts.** Core adds the actor model (`actor.ts`, plan §2.4): `Actor` — the instance's assistant, a crew it delegates to, or an external agent — with its definition, permissions, tools, compute and limits, plus `PermissionRow` (the permissions table's Resource × Read × Write, provenance per entry), the `agents.kind` → actor mapping table, and the `ResolveActor` signature. Types only; nothing resolves yet. The shape makes the rules that matter unrepresentable rather than merely tested: a crew's or an external agent's Knowledge row has no write cell, only the assistant has the Agents (delegate) row, a crew never has a Queries row, and an external actor carries no definition or compute. `docs/ops/actors.md` is the source mapping, field by field.
- 7bf6db6: **The client API, version 1 — one contract for every client, as data and as a
  document.** `@foldedspacelabs/metistry-core` exports the route table
  (`CLIENT_API`: method, path, reach, principals, idempotency, `409` reasons,
  cursor, and whether it is served yet — 120 rows: every route the console
  serves, and every route §2.1 of the design plan freezes ahead of its ticket) with `matchRoute`, `servedRoute` and `noRouteMessage`; the live-changes
  catalogue (`EVENT_CATALOGUE`, the payload types in `EventPayloads`, every
  event's reach `owner`); `API_VERSION` and the `Metistry-API-Version` header
  name; and `events` joins the `CAPABILITIES` vocabulary.
  
  The console answers `api_version: 1` in `GET /health` and `GET /api/identity`
  and the version header on every response. It reads the table before it
  dispatches anything to the owner: a route the table does not list as served is
  a `404` that names the routes beside it, so a handler cannot become an
  undocumented door and a route frozen ahead of its ticket stays unserved until
  it lands. `docs/ops/client-api.md` is the contract in words (it replaces
  `docs/ops/console-api.md`, now a pointer); a conformance test holds the table
  to the server — every served row reaches a handler, nothing unlisted is
  served, each row admits exactly the credentials it records — and a document
  test holds the table to the document line for line.
- ac8a137: **The connection and extension model (§2.6, §2.7).** A `connection-type`
  manifest joins `manifestSchema` — `provides` one of eight connection types,
  config `fields` from a closed field-kind vocabulary, `capabilities` from each
  type's closed vocabulary (`send` on mail is refused by name), tools by group,
  and an `implementation`. An `oauth` field carries the OAuth client model: a
  public `client_id`, PKCE required on a loopback redirect, `bring_your_own:
  allowed`, https-only endpoints and declared scopes — and a `client_secret` is
  refused. `connectionFileSchema` validates `.metistry/connections/<name>.yaml`
  (secrets and variables by name only; a tool's mode defaults to Ask), and
  `connectionIssues` joins a connection to its type. `Registry<Kind>`
  (`loadRegistry`, `buildRegistry`, `manifestKind`) loads units from
  directories, overlays an extension over a product unit by name, skips a unit
  that fails with its reason, and requires `schema: 1`. Every manifest may now
  carry `schema: 1`; any other value is refused with the version named.
- c69abc3: **The owner can now see WHY an action's mode is what it is, not just what it is.** `effectiveActions()` resolved the (kind → mode) table but dropped the reason, so `metistry agents autonomy`, the console's registry panel and MetistryKit each had to recompute it to say whether a mode was set, defaulted, or clamped to the level's ceiling — and clamped is the one case where the owner's own setting is being overridden. Core adds `effectiveActionsDetailed()` beside it (`effectiveActions` is now a projection of it, so the two cannot drift), and every surface reads that one function instead: `metistry agents autonomy` marks each row set / dimmed-default / clamped-with-ceiling and says the modes as **Allow · Ask First · Never**; `GET /api/agents`'s `scope.autonomy` carries a `detailed` table beside the plain one, so a console never re-derives it; MetistryKit's `AgentRecord` decodes the same table into `actionsDetailed`.
- aafc41a: **An intent enum and answer-token scoring, both closed and both decided in
  code.** `INTENTS` joins `ACTION_KINDS` as a closed list a reviewer can read —
  sixteen things a message can *say*, each with the description the model is
  actually shown, and one-token letter codes GENERATED from the list rather than
  written down beside it. `choice.ts` adds the technique: constrain the answer to
  one token, ask for `top_logprobs`, renormalise over the closed alphabet, and
  compute TypeSafe's published confidence statistic `(n·peak − 1)/(n − 1)`. It
  decides nothing — no tier, no model, no field that could hold one — and the
  per-server request shapes it builds were each measured rather than read off a
  README. Also here: `intentGuard`, a deterministic out-of-distribution check
  that runs *before* any request (an English classifier has been measured at
  0.000 accuracy and 0.952 confidence on out-of-script input, so confidence
  gating cannot catch it), `rules.yaml`'s `intent:` schema, which fails at LOAD
  on a threshold outside [0,1] or an intent this build does not know, and
  `assignments.intent` in `compute.yaml`, which is refused at load unless its
  provider is on-machine and never falls back to `assignments.default`.
- 56be405: **The reach gate: minting an agent bearer is the owner on this Mac.** The
  console reads reach `local` off the client API table and enforces it before
  any handler runs: a `local` route admits the local owner token from a loopback
  peer and nothing else, and a passkey session — even one from `127.0.0.1` — is
  refused `403 local_only` with a message naming the route and the Mac app, and
  audited. `POST /api/agents` and `POST /api/agents/:id/rotate` are now `local`:
  a new credential is a boundary change. The local owner token from any other
  peer is the uniform `401` it always was; the capture owner token and agent
  bearers keep their uniform `403 forbidden`. `metistry connect` mints through
  the local owner token and is unaffected; the legacy PWA's agent panel can no
  longer register or rotate an agent.
  
  `@foldedspacelabs/metistry-core` adds the `local_only` error code (`403`),
  `isLocalRoute` and `localOnlyMessage`. The client API conformance test now
  checks every row's reach for every credential kind.
- d930fba: **One request type table, in core — and `action` reads *action*.** Every
  request in Needs You is a `proposals` row with a free-text `kind`; the owner
  reads one of twelve types instead (`docs/product/glossary.md`).
  `packages/core/src/requests.ts` is now the only place that says which: stored
  kind → type, the type's body from the closed set (choices · diff · thread ·
  before and after · preview · to-dos · excerpt), its primary verb, Revise and
  Decline, and the decisions each stores (`describeRequest`). It replaces the
  two copies that had drifted — the CASE in `pending_requests` and the morning
  brief's own map, both of which called an agent's `action` a *note* (C80).
  
  The brief imports the table. The query cannot import TypeScript, so it
  carries the table's `requestWordSql()` rendering verbatim, and the console's
  seed-query tests refuse any other text, run the query over every stored kind
  against the table, and read every `INSERT INTO proposals` in the product so a
  new writer cannot add a kind the table does not map. A kind the table does
  not know reads as a *report* drawn as an excerpt with Dismiss its only answer
  — never as the raw kind, and never with an Approve whose meaning nobody
  reviewed. `pending_requests`' title fallback now says the owner's word too
  (*note request*, not *knowledge request*).
- 73977f8: **The Scheduled model's schema, frozen: `scheduled.yaml`, a closed schedule
  shape, field origins, and the next-occurrence signature.** A schedule is
  `{days, at, tz?}` or `{every: 5m|15m|1h|6h}` and nothing else — `every`
  outside the four, a cron string, `8:00`, a UTC offset and the two forms mixed
  are each refused with one line naming the field (`scheduleSchema`). `days`
  takes weekdays or two sets that follow the profile, `working_days` and
  `eve_of_working_days`, defined once in `resolveDays`; with no working days in
  the profile a set resolves to `null`, never to a guessed Monday–Friday.
  `scheduledSchema` / `parseScheduled` validate `.metistry/scheduled.yaml`:
  routine overrides, New Routine assignments (actor, task, per-run grants that
  are vault prefixes an agent may hold, a required schedule, no config) and
  syncs. Parsing rewrites nothing, and an invalid file returns `value: null`
  — never an empty overlay, which would un-pause a paused routine.
  `FIELD_ORIGINS` (`default` · `profile` · `yours`) and `Sourced<T>` carry where
  a resolved value came from. `NextOccurrence` is a type only — its body is
  T3-1's — and `manifestScheduleSchema` accepts a legacy cron string in a
  product manifest for one release. Nothing reads the file yet.
- a8ccdfc: **The TCC enum gains three grants for live capture.** `screen_recording`,
  `microphone`, `audio_capture` join `tccGrant` (§2.15, Q6) alongside the
  existing five; the enum stays closed, and a bridge declaring any of the new
  grants is held to the same PoC-1 rule as every other TCC bridge — `transport:
  http`, `runs_on: host` only.

### Patch Changes

- 1edc2f7: **`Me/` and the user's own journal are refused at the tool for every non-user principal — new pages included.** `knowledge_write`'s ownership rule only ever ran against a note that already existed, so a brand-new page under `Me/` or the user's own `Journal/<date>.md` went straight through the default bare-vault grant every instance ships with — `Me/` is discovered, never assumed, and the daily journal is the user's alone (daily-flow-spec §5.1, §6.6). `core`'s `may()` now refuses the PATH itself, ahead of ownership, on both the `knowledge_write` tool and the reconciler's bridge (`writeAllowed`) — the second check exists because a routine's own commit (`plan-tomorrow`, the fold's routine half) reaches the vault directly and never asks `may()` at all. `Journal/Plan/`, `Journal/Fold/` and `Journal/Standup/` are each a routine's own reserved subdirectory and are unaffected. The seed vault also gains `Resources/README.md`, matching `People/` and `Projects/` — `seed/assistant-prompt.md` already told the fold to create entity pages there.
- 87fc443: **`@foldedspacelabs/metistry-core/test-env` gains `testDb()` — the one guarded way a test opens Postgres.** `await testDb(pg.Pool)` refuses, before a socket opens, unless `METISTRY_TEST_DB_NAME` is set, names a `metistry_test_*` database, and is not a `METISTRY_DB_NAME` any install's `.env` on the machine is configured with; it connects with host/port/user/password from `METISTRY_DB_*` only, then checks `SELECT current_database()` and ends the pool rather than hand over the wrong one. Companions: `testDbConfig`, `testDbEnv` + `assertScratchDb` (for code under test that reads `METISTRY_DB_*`), `recreateScratchDb` / `dropScratchDb` (a suffixed database of a suite's own), `installDbNames`. Core still does not depend on `pg` — the caller passes the constructor. Every product test now goes through it; previously a shell with only `METISTRY_DB_PASSWORD` set could send a suite at the live install's Postgres on 5432.

## 0.11.0

### Minor Changes

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
- 579662f: The sole committer runs confined, and every confined child's egress passes
  one allowlisting door.
  
  **`ops/sandbox/reconciler.sb`.** Under the `launchd` shape the reconciler —
  the only process that holds the instance repo's working tree and the only
  place git runs (D5) — now runs under a Seatbelt profile, as the job's root
  process, so git and all 172 of its helpers inherit it. It writes the
  instance repo and tmp and nothing else; reads the product checkout, the node
  runtime, a real git's prefix and `~/.gitconfig` by name; execs node and that
  git and **no shell**; dials the console, Postgres, the on-machine embedder
  and the egress proxy, and binds only its own bridge port. D5 was a design
  intention; it is now a kernel rule. `metistry up` (and `--dry-run`) prints
  the profile each child will run under, and `metistry doctor` gains a
  `sandbox` row that reads the answer back out of `supervisor.json`'s argv.
  `METISTRY_RECONCILER_SANDBOX=0` swaps in `ops/sandbox/unconfined.sb`, a real
  file that says `(allow default)`, so "not confined" is never invisible.
  
  **`/usr/bin/git` is not a git** — it links against `libxcselect.dylib` and
  is the xcode-select shim, which dies under a profile. `up` resolves a real
  git by absolute path (bundled runtime, then a non-shim git on `PATH`, then
  the Command Line Tools) and declines to confine the job when it finds none.
  
  **The egress door.** `sandbox-exec` filters outbound by port and cannot name
  a host, so `assistant.sb` carried `(remote tcp "*:443")` with an honest note
  that its host list was documentation rather than enforcement. Both profiles
  now allow exactly one loopback port, and a CONNECT proxy in the supervisor
  listens there: an allowlist derived from this install's `compute.yaml`
  providers and its instance repo's git remotes, exact host and port matching
  (no wildcards), a 256-bit bearer per child so a refusal can name who asked,
  a `runs` row per refusal, and no TLS interception whatsoever — CONNECT only,
  so it learns a host name and never a byte of the tunnel. Children reach it
  through `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`; git reaches it through
  `METISTRY_GIT_HTTP_PROXY` → `-c http.proxy`. `supervisor.json` gains an
  `egress` block, read before any child is spawned, so no child can widen it.
  
  **Pushing still works, through `GIT_ASKPASS`.** git executes every
  credential helper through `/bin/sh` — including the built-in `osxkeychain`
  that `metistry connect-repo` configures — and this profile has no shell, so
  a confined push would have died on the helper. `GIT_ASKPASS` is exec'd
  directly, by absolute path, with no shell, so: the token stays in the login
  Keychain where `connect-repo` put it, the **supervisor** reads it there once
  at spawn (unconfined, the parent, and the item is filed `-A` so there is no
  prompt), and hands it to the child in its environment; a `#!<node>` shim
  `up` generates prints it when git asks and can do nothing else. The
  credential is never in argv, never in `supervisor.json`, never on disk.
  `git.ts` adds `-c credential.helper=` — git's documented reset — only when
  there is an askpass, so an unconfined install is untouched. Proven by a real
  push to a real bare repository over real HTTPS through the CONNECT tunnel,
  under `sandbox-exec`.
  
  **SSH remotes stay unsupported while confined**, and `up` still warns:
  `ssh` is not exec-able, granting it would mean granting the sole committer
  `~/.ssh`, and ssh's `ProxyCommand` runs through a shell so it could not
  reach the egress proxy either. Use an HTTPS remote or the off switch.
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
- 7f9ceb7: **A todo is a plain English line, and Metistry reads it.** Two new pieces of
  public API in `core`, both pure: `parseTaskLine` / `formatTaskLine` for a
  `- [ ]` line in a vault note, and `compileTaskFilter` for the `where:` /
  `order:` vocabulary that templates, the app's filter chips and the Obsidian
  plugin all speak.
  
  The fields on a task line are English-shaped trailing tokens — `- [ ] Draft
  the Q4 plan due friday p1 size l type planning +drey` — and they are a run at
  the END of the line: the first token that is not a field ends it, so `Ask
  @Jim about the pricing deck` assigns nobody and the text stays exactly as
  typed. `due friday` resolves against `METISTRY_TZ` and the day it was read on,
  which is recorded, so a relative date is never silently re-read as a different
  one tomorrow. A field Metistry cannot read is never guessed: `due nextweek`
  sets no date and sets a parse warning instead. Dataview's `[due:: 2026-09-22]`
  and the Obsidian Tasks plugin's emoji are read, so a vault that already uses
  them is not locked out, and nothing here can emit either one back.
  
  `compileTaskFilter` turns `where: "due <= today or overdue"` into bind
  parameters for one named query. It is not SQL, it is never interpolated into
  SQL, and anything outside the closed vocabulary is refused with a message the
  caller renders — a `where:` containing SQL is refused, not escaped.
- 23cc47f: **The daily note is rendered from a template you edit.** `core` gains the
  template engine of `docs/product/daily-flow-spec.md` §6 (P1-6):
  `renderTemplate(text, ctx)` and `validateTemplate(text)`, plus
  `metistry templates check` in the CLI to run the second one from a terminal.
  
  Eight directives and one block form, and the ceiling is the point — a ninth
  verb is a product decision, not a config line:
  
  | directive | what it renders |
  | --- | --- |
  | `{{ date format: "YYYY-MM-DD" offset: 1 }}` | a date in the instance's zone |
  | `{{ tasks where: "due <= tomorrow or overdue" order: "priority, due" as: "list" }}` | the vault's `- [ ]` lines, as links to the notes they live on |
  | `{{ recurring due: today }}` | §4's recurrence rules |
  | `{{ calendar day: tomorrow }}` | the eventkit bridge's events for a day |
  | `{{ work where: "blocked or waiting_on_me" }}` | the `work` rows a day needs |
  | `{{ requests limit: 5 }}` | what is waiting on the owner |
  | `{{ include "Me/Working Style.md#Prioritisation" }}` | a section of a vault file, spliced verbatim |
  | `{{ prose "summarise yesterday in three lines" }}` | a slot the fold fills — fold templates only |
  | `{{ section "Today" if_empty: "hide" }}` … `{{ /section }}` | a heading that vanishes when nothing is under it |
  
  What the engine cannot do is enforced by its shape rather than asked for in a
  comment. `where:`/`order:` go through `compileTaskFilter` and leave as bind
  params of one named query, so no directive can put text into SQL (invariant
  3); `{{ work where: … }}` is a separate, tiny flag list over `day_work`'s
  board states, refused outright on anything outside it, because one vocabulary
  stretched over two tables would compile against one and mean nothing against
  the other. `prose` never reaches a model here: it produces a bounded request object
  the fold routine fulfils on the turn it already takes, and it is refused
  outright in a template whose output the assistant may not write (D14).
  `include` splices literal text and evaluates nothing inside it, so a template
  that includes itself renders a note rather than looping. And a recurring rule
  is materialised into a `- [ ] … ^mt-…` line only when the render's `source` is
  the user's own hand; every routine gets the same rule as a proposal, because
  no routine writes a task into a note you own (D4).
  
  Every failure is visible and none is fatal (§6.4): an unknown directive, a
  `where:` the vocabulary refuses, an unreachable calendar, a query that is not
  configured — each renders one `> ⚠️ metistry: …` line naming the template and
  the line number, and the rest of the file still renders. A day with no plan
  because the calendar was down is the worst possible outcome. A missing
  template writes nothing at all and is reported as a configuration fact.
  
  Every rendered file ends with a provenance footer — the template, its sha256,
  when it was rendered and by which engine — so "why does my plan look like
  that" has an answer that names a file. Output is capped
  (`METISTRY_TEMPLATE_MAX_BYTES`, 16 KB) and truncates with the fold's own
  `…and N more`.
  
  `metistry templates check [<file>]` validates every file in the vault's
  `Templates/` and prints each finding as `path:line  message`. It reads nothing
  but the files — no database, no calendar, no vault lookups — so it answers on
  a laptop with nothing running, which is what §6.5 needs: a template change
  takes effect at the next run, and this is how you find out before the run
  does.

### Patch Changes

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
- 9c9da4a: **`metistry compute cache-report` — OPEN-6's measurement as one command**
  (ruled 2026-09-17: ship automatic top-level `cache_control` first, measure
  later). `metistry compute cache-report [--since 7d] [--json]` reads the `runs`
  ledger through the new named query `cache_report`
  (`GET /api/q/cache_report` — invariant 3's one read path, and no console route
  or action of its own, so invariant 10's mutating surface is untouched) and
  joins it to `compute.yaml`'s `pricing:` rates, which the ledger cannot know. A
  table per provider/model, grouped by tier and by the `caching:` mode that was
  in force, with turns, cache reads and writes, hit ratio, recorded cost and a
  net dollar saving; one verdict line against an 80 % threshold, under the 89 %
  after a task boundary that `docs/research/2026-09-cost-optimization.md`
  records, because a real install rolls sessions. The saving is net of the write
  premium and may be negative — a prefix rebuilt every turn is the finding, not
  a number to floor at zero — and is absent, naming the field that would fill
  it, wherever no `pricing:` entry publishes a rate. It calls no model and
  writes nothing.
  
  **Usage mapping now covers Anthropic's native shape.** `cache_read_input_tokens`
  was not read at all, and `input_tokens` on that wire is the *fresh* remainder
  with both cache counts reported beside it rather than inside it.
  `usageFromResponse` recognises the shape by its anchor field (`prompt_tokens`
  = the OpenAI/OpenRouter form, already a total; `input_tokens` = the native
  form, summed back into one), so `runs.tokens_in` means the whole billed prompt
  whichever endpoint answered and a ratio over it is comparable across
  providers.
  
  **Every engine turn now records the cache, and what caching was asked for.**
  Crew runs wrote provider, model, tokens and cost but dropped
  `cache_read_tokens`/`cache_write_tokens` and `cost_source`; shadow runs
  dropped the same two on their own provider's row. Both carry them now. And a
  reported zero is no longer flattened into "nothing reported": the engine keeps
  the counter absent until a response carries the field, so NULL means the
  provider said nothing (the field name is wrong) and 0 means it said zero (the
  prefix is not stable) — two findings with different fixes. `runs.meta.caching`
  records the mode in force for that turn, since `compute.yaml` is hot-reloaded
  and cannot answer later what was true earlier.
  
  **Fixed:** `main()`'s `compute` case hardcoded `fetchFn: fetch` instead of
  honouring the `io.fetchFn` test seam, so a test driving those verbs through
  `main()` reached the real console and real provider endpoints rather than its
  own fakes.
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
- 45b64df: **`@monthly` is runnable.** The manifest schema's cron regex already admitted
  it, but `scheduleToSeconds` did not — a manifest declaring `@monthly` would
  validate, pass CI, and then throw the first time the runner tried to schedule
  it. It is now 30 days, the same fixed-interval approximation `@weekly`
  already makes (this is an interval scheduler, not a calendar one).
  
  **An unparseable schedule no longer takes the runner down.** The console's
  `loadSchedules` had no error handling at all: one manifest it could not read,
  validate, or schedule threw out of the function and stopped every OTHER
  collector and routine from starting too. It now skips that one component and
  logs why (naming the manifest file to fix), so a single bad manifest —
  shipped or instance-authored — costs one component, not the console.
- 9ec30d5: **One filter vocabulary, one query — and now literally one object.** The
  parser that reads `where: "due <= today or overdue"` and the query it compiles
  into were built in parallel and agreed on almost none of their names:
  `due_from` against `due_on_or_before`, `combine` against `match_any`, a
  comma-separated `flags` string against seven booleans, `sort1` against
  `order_1`. Every one of those is a hard `unknown param` the first time a
  template renders, because the query runner refuses an undeclared parameter
  rather than ignoring it — so the failure would have landed on an evening plan
  rather than in a test.
  
  `seed/queries/vault_tasks_query.yaml` now declares exactly
  `TASK_FILTER_PARAM_SPEC`, and a test asserts the two are equal field for
  field, so neither side can move without the other. There is no longer a
  third copy of the shape anywhere: the manifest is a transcription of the
  parser's own published declaration, and the parser is canonical because it is
  the half three consumers import and typecheck against.
  
  `TaskFilterParams` gains the four **context** params the query needs and a
  `where:` line can never reach — `today` (the day *overdue* and *carried* are
  measured against, resolved where the timezone is known rather than in SQL),
  `me` (your own person page, for *assigned to me*), `path_prefix` (the
  caller's scope) and `offset` — so the contract is one object rather than two
  that can disagree. `path_prefix` and `status` **scope**: `or` widens the
  predicate, never the scope, so no filter anyone writes can reach a ticked
  line or a path outside what the caller was allowed to see.
  
  Three meanings were pinned while the two halves were reconciled, because they
  had been described two ways: *recurring* is an **instance** of a rule, never
  the rule line (a rule is not a task, and no row here can be one); *carried* is
  "it was owed on an earlier day", which is the number the app's chip shows,
  while how long a line has been **sitting** is its own separate column; and
  every nullable field compares under an explicit "no" rather than a NULL, so
  asking for `size l` can never quietly return every task with no size at all.

## 0.10.0

### Minor Changes

- ad73f5a: Metistry can keep your Mac awake while it runs, and asks you first.
  `deployment.yaml` gains `keep_awake`: `never`, `allow_sleep_on_battery`
  (held on wall power, released on battery and on a UPS), `always`, or
  `always_lid_closed`. `metistry init` asks the question once on a terminal,
  printing what each choice costs, and writes your answer; `--keep-awake
  <value>` answers it without one, and an install that was never asked holds
  nothing — a power assertion overrides your own sleep setting, so it is never
  taken on your behalf. Under the `launchd` shape the supervisor holds
  `caffeinate -i -w <its own pid>`: the display still sleeps, your own
  keep-awake app is untouched, and nothing survives the supervisor. `metistry
  doctor` grows one macOS-only `keep-awake` row (`degraded` at worst) that
  cross-checks our pid against `pmset -g assertions`, reads a release on
  battery as success rather than a fault, and reports when the Mac slept
  anyway — with the repair. `always_lid_closed` is accepted and honest: no
  process can keep a Mac awake with the lid shut, so doctor says it needs an
  administrator change you make yourself. Change it later with `metistry
  deployment set-keep-awake <value> --yes`.

## 0.9.1

## 0.9.0

### Minor Changes

- dade46d: **Shadow mode: try a model on your real turns without ever answering with
  it.** The bake-off's stage 2, as configuration. An optional block on the
  default assignment —
  `shadow: { model: llamaserver/qwen3.6-35b-a3b, fraction: 0.1 }` — has the
  engine re-run one turn in ten on a candidate model *after* the real answer has
  been delivered and its session saved, and put both transcripts plus an
  agreement number on that turn's `runs` row. The candidate's answer is never
  returned as the turn's, is never a session, and has no path to the console or
  the phone.
  
  **Its tool calls are stubbed record-only, by construction rather than by
  instruction.** The shadow gets the same tool *list* the real run saw; every
  call is written down and none is performed. A call the real run made
  identically (same name, same arguments, byte for byte) is handed the real run's
  own result, so the candidate's next step is judged against the same facts;
  anything else gets one fixed `(recorded, not executed: …)` string. The stub
  host closes over a list of names and a map of strings — no MCP client, no URL,
  no token — so there is no object in scope it could execute a call against, and
  a shadow of a turn that wrote to the vault cannot write to the vault twice.
  
  **Agreement is deterministic and says what it is:** the mean of "same tool
  calls in the same order" and token Jaccard over the two final answers. No model
  scores it, so it cannot drift and the stored row re-scores to the same number.
  The *rubric* score stays `packages/eval`'s, on the owner's fixtures — the
  engine leaves a typed hook for it instead of inventing a second scorer.
  
  **A shadow is a turn, so it is budgeted like one.** It asks the same pre-call
  gate with the candidate's own provider and `critical: false`, so `stop` and
  `critical_only` skip the experiment while the interactive turn they let through
  keeps its answer; its spend is its own `runs` row of kind `shadow` carrying the
  provider that was actually paid, which is what makes per-provider budgets
  honest with no change to the `spend` query. Nothing it does can cost the turn:
  a candidate that is down, an unset credential or a failed write lands as a note
  on the row, never as a failed reply.
  
  Additive migration `0020` adds `shadow_provider`, `shadow_model`,
  `shadow_transcript`, `shadow_agreement` and `shadow_cost_usd` to `runs`
  (rollback: drop the five columns and `runs_shadow_ts_idx`). New named query
  `seed/queries/shadow_agreement.yaml` reports agreement, tool-sequence match,
  answer similarity, cost and failures per candidate over the last N shadowed
  turns; the weekly review's System section carries one line per candidate and
  omits it when nothing is being shadowed. `compute.yaml`'s schema refuses a
  `shadow:` block with no `fraction`, a fraction outside 0..1, a candidate this
  file does not declare, a candidate that is the assigned model itself, and the
  block on a tier or crew — each naming the field. `docs/ops/compute.md` gains
  "Shadow mode".
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

- c1f512e: **The assistant now uses your `identity.yaml` on the launchd shape, instead
  of the seed identity that ships with the product.** Every `*_FILES` overlay
  default resolved its instance half relative to the process's working
  directory, and every launchd job's working directory is the product
  checkout — so `.metistry/identity.yaml`, `rules.yaml` and `compute.yaml`
  named the product's own directory, found nothing, and the engine ran on the
  seed. `METISTRY_INSTANCE_DIR` was not in the engine's environment allowlist
  either, so it could not have resolved them itself.
  
  Fixed at the root: `metistry up` puts `METISTRY_INSTANCE_DIR` and
  `METISTRY_SEED_DIR` in every child's environment (the plists' env dicts and
  the supervisor's child specs alike), and core's `overlayFiles` resolves every
  default against the instance directory through `resolveInstanceLayout` — so
  it finds the file whether the instance has run `metistry migrate-layout` or
  not. The assistant, the console and the reconciler all read their overlays
  through it, which also means the console's router and the engine can no
  longer disagree about which `rules.yaml` is in force.
  
  The engine **refuses to start** when neither `METISTRY_INSTANCE_DIR` nor
  `METISTRY_IDENTITY_FILES` is set, rather than answering under the seed's
  name. `ops/sandbox/assistant.sb` grants read on the four config files by
  name (never on the directory holding them, which on an unmigrated instance
  is the vault root), so the reads the overlay now performs are permitted and
  nothing else in the instance is.
  
  Also: `metistry update --version <x.y.z>` was ignored — `version` was listed
  as a boolean flag, so the value never arrived and the latest release was
  installed instead. And in git mode `update` wrote the **pre-pull** version
  into `metistry.lock`; the version is now read from the checkout after the
  pull, so a run that fast-forwards onto a new release pins that release.
- 337bc0a: **Automatic prompt caching on the providers that support it** (OPEN-6, ruled
  2026-09-17: ship the automatic form first, measure explicit breakpoints
  later). A new optional `caching: auto | off` on a `compute.yaml` provider says
  whether that provider implements Anthropic-style prompt caching; the engine
  then sends its automatic caching field on every chat completion — for
  OpenRouter, one top-level `cache_control: { type: "ephemeral" }`, the
  automatic placement its caching doc describes ([or-cache], fetched
  2026-09-11). The `openrouter` template ships `auto` and is the only one that
  does: everything else defaults to `off` and gets no extra field, because a
  server that has never heard of the parameter would have to ignore it. The
  schema refuses `caching: auto` on an `on_machine` provider, naming the field,
  rather than accepting a line that does nothing. Explicit breakpoints remain
  the operator's `request:` block, which is merged after the automatic field and
  therefore overrides it.
  
  The cached share of the prompt now lands on the row: `cached_tokens` and
  `cache_write_tokens` (or Anthropic's `cache_creation_input_tokens`) are read
  out of `usage` into `runs.cache_read_tokens` / `cache_write_tokens`, summed
  over the turn's whole loop, with `tokens_in` still the whole prompt as the
  provider billed it. On the `pricing` path the prompt is priced in three parts
  — fresh at `in_per_m`, reads at `in_per_m × cache_read_multiplier`, writes at
  `in_per_m × cache_write_multiplier` — with two new optional `pricing:` fields
  defaulting to 0.1× / 1.25×, Anthropic's rates as OpenRouter passes them
  through. A response reporting no cached tokens prices exactly as before.
  `docs/ops/compute.md` gains "Prompt caching", including the measurement still
  owed under OPEN-6 and the two assumptions it will check against a live
  response.
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

## 0.8.1

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
- 26ffe39: **Instances can name each other, and an agent can be named across them** —
  the five registry ideas worth borrowing from Google's SAM agent mesh
  (`docs/research/2026-09-13-google-sam-review.md`), built as endpoints and a
  config file rather than as a mesh: no Go daemon, no control plane, no second
  credential class, no second policy language.
  
  - **Capability advertisement.** `GET /api/identity` — the one
    unauthenticated read — now carries `capabilities`: coarse tool *group*
    names (`artifacts`, `capture`, `dispatch`, `knowledge`, `queries`,
    `tasks`), derived from what the console actually has wired, so a phone
    switcher or a peer can name what an instance offers before sign-in. Never
    a tool name, never a count, never an origin; the full `tools/list` stays
    behind an agent token at `/mcp`.
  - **Approve-before-enroll.** An agent created with `remote: true` starts
    **pending**: its token is minted (the console shows one exactly once) and
    authenticates nothing — `/mcp` and `/capture` answer the same uniform 401
    an unknown token gets, `last_seen_at` is not even bumped — until the owner
    approves it from the Needs You queue or with
    `POST /api/agents/<id>/approve`. `metistry connect <tool> --remote` sets
    the flag; loopback tools stay immediate. Denying revokes.
  - **Instance-qualified agent identity.** `agent:<name>@<instance_id>` in
    `packages/core` (`qualifyAgentId`), minted at the boundaries an id
    actually crosses. Storage keeps the bare name; nothing is rewritten.
  - **A peer registry.** `instances.yaml` in the instance repo — a §4.7
    protected path — with `metistry instances list|add <origin>|remove|refresh`.
    `add` asks that origin who it is and records what it answers; rows are
    keyed by `instance_id`, because an origin can move. `GET /api/instances`
    serves it to the app and the phone.
  - **A `runs` audit export.** `metistry runs export [--since] [--until]
    [--component]` streams the ledger as NDJSON through
    `GET /api/runs/export`, so two instances' timelines merge. Redacted,
    resumable by the cursor on every line, and never a truncated export that
    looks complete.
  
  New: `docs/ops/instances.md`; `docs/ops/console-api.md` and
  `docs/ops/cli.md` grew the sections. Migration `0017_agent_enrollment.sql`
  is additive and defaults to today's behaviour.
- 70f6580: **Apple Foundation Models is now a compute provider, and `inbox-drain` calls
  it through the same wire as everything else.** The `apple-fm` bridge grows
  `GET /v1/models` and `POST /v1/chat/completions` on its existing loopback
  listener, under the same bearer as every other bridge route — with
  `response_format: json_schema` translated per request into Apple's
  `DynamicGenerationSchema`, real token counts from the model's own tokenizer,
  and a `400` that names the field when a schema or prompt would not fit the
  4096-token window. `metistry compute providers add --from applefm` writes the
  provider; discovery and `metistry doctor` gain a `local:applefm` row.
  
  `inbox-drain` no longer reaches the bridge's private `/classify` route. It
  declares `uses_model: applefm/foundation-model` in its manifest and goes
  through `completeJson()`, which enforces the rule that a collector may only
  call an on-machine, cost-0 provider — CI checks the shipped default, and the
  call itself throws rather than spending. **Upgrading:** run `metistry compute
  providers add --from applefm` (with
  `--base-url http://host.docker.internal:7810/v1` in the container shape) to
  keep the model tier; without it the drain is deterministic, which is a
  supported install and which `metistry doctor` reports.
- e48ea1e: **Three contract checks that hold at the tool rather than the reader.**
  
  `@foldedspacelabs/metistry-core/test-env` is a new subpath export: a test
  harness loads `METISTRY_DB_*` and `METISTRY_TEST_DB_NAME` from a dotenv file
  and deletes every other `METISTRY_*` from the environment, and
  `assertTestEnvIsolated()` fails a run the moment a path resolves outside
  `os.tmpdir()`. A product checkout's `.env` is a RUNNING install's environment
  — instance directory, reconciler URL, reconciler bridge token — so a test that
  loaded the whole file and called a CLI verb was driving the live system, which
  is how a `compute providers add` case committed into a real instance repo.
  `docs/ops/testing.md` states the rule: tests never see the operator's instance.
  
  `ops/scripts/audit-limits.mjs` (CI) fails on a limit-shaped constant under
  `apps/**/src` or `packages/**/src` that is neither read from config nor
  annotated `// limit: fixed — <reason>`. Two of the forty it found on main are
  now operator-facing: `METISTRY_MAX_BODY_BYTES` (the console's request-body
  cap) and `METISTRY_COMPOSE_TIMEOUT_MS` (how long `metistry up` waits on a cold
  `--build`). The rest say why they are fixed.
  
  `core`'s stdio conformance contract spawns a stdio component with a bare
  environment and requires every line it writes to stdout to be a protocol
  frame; logs go to stderr. It covers mcp-apple-fm's Swift helper, whose
  protocol IS stdout, and fails the build if a `transport: stdio` bridge is ever
  declared without a case.
  
  And refusals on the console's owner surfaces now name the field that would
  permit them — the dispatch body's parameters, the grant validator's message
  (which `PUT /api/agents/<id>/grants` used to discard, so `metistry connect
  <tool> --areas knowledge/…` answered a bare 400), the budget validator's, and
  the two "not available" cases that now name the environment variables they
  need. The door is untouched: a 401 takes no detail and an agent's 403 stays
  the canonical "not granted" (invariant 8).
- ae0f9db: **`compute.yaml` — providers, assignments and budgets in one file.** Where
  work runs, what may leave the machine to get there, and what it may cost is
  now configuration in the owner's hand rather than a build-time decision: any
  OpenAI-compatible endpoint (a local server, OpenRouter, anything with a base
  URL) is a provider, each tier and crew is assigned one pinned
  `<provider>/<model>`, and a daily or monthly budget can be recorded per
  provider and for the instance. A provider is configuration, not a component —
  invariant 5 is met by a zod schema in `packages/core` that the CLI, CI and
  the app all validate against, so adding one is a command rather than a
  directory.
  
  New verbs, all `--json` and all `--dry-run`: `metistry compute show`,
  `providers list|add --from <template>|remove|test`, `models list`, `assign`,
  `budget`. The file is a §4.7 protected path, so every write goes through the
  reconciler as the `user` principal, and the RESULT is validated before it is
  written — an edit that would produce a file the engine could not load is
  refused and nothing changes. Comments and hand-written blocks survive every
  edit. `providers add` reads the API key from stdin into the login Keychain
  under the user account and cannot take it as an argument or print it.
  
  Every rule the schema enforces refuses with the field that would permit it: a
  model must be one pinned `<provider>/<id>` whose provider is declared in the
  same file (no `/auto`, no fallback lists — the router is deterministic), an
  off-machine provider must declare a data policy, a budget needs a limit, and
  `auth.secret` is a name a pasted key cannot match. The console and the
  assistant both hot-reload the file; an invalid save keeps the last good
  configuration and writes one `runs` warning row instead of taking a running
  install's assignments away.
  
  Nothing dials a provider, counts a token or enforces a budget yet — the
  engine is the next change. Until an instance writes `assignments:`,
  `rules.yaml`'s `tiers:` is still the live map, and the seed's `compute.yaml`
  ships commented out so no existing install routes differently. New:
  `docs/ops/compute.md`.
- b99d4ad: **The engine dials the provider, and every call costs a number you can see.**
  `compute.yaml`'s assignments now decide what actually answers a turn. One
  `Engine` interface with a factory keyed on the provider's `kind`: an assigned
  tier or crew runs on the in-house OpenAI-compatible loop — any base URL, so a
  local server, OpenRouter, Zen or anything else — and a turn nothing assigns
  keeps running on the Claude Agent SDK exactly as before. Write an
  `assignments.default` and no turn can reach the SDK path at all, which is why
  the assistant then starts with no engine credential set.
  
  The loop is about 300 lines over `fetch`, the pre-approved MCP client and
  zod — no new dependency. It owns the tool loop over the console's `/mcp`
  (the only tools that exist — invariant 9), `max_turns`, backoff on 429/5xx
  honouring `Retry-After`, `response_format: json_schema` *plus* zod validation
  with one repair retry, effort as `reasoning: { effort }` off-machine and
  reasoning-off on-machine, and the provider's `request:` block merged verbatim
  — except `model` and `messages`, which belong to the assignment, because a
  request block that could repoint the call would hand routing back to the file
  the router was told to obey. A **no-progress veto** ends a run that is
  learning nothing: a turn whose every tool call repeats a (name, arguments)
  already made *and* returns byte-identical output is unproductive; three in a
  row buys a nudge, five ends tool use and asks for the answer. Every early
  stop — the turn cap, a crew's per-run cost cap, the veto — still ANSWERS.
  
  **Cost is a first-class row.** `runs` gains `provider`, `cache_read_tokens`
  and `cache_write_tokens` beside the existing model and token columns
  (additive migration `0016`), and `meta.cost_source` records where the number
  came from: the response's own `usage.cost`, the provider's `pricing:` table,
  `local` (0 by definition), or `unknown` — an off-machine call nothing can
  price is recorded at $0 **and says so**, never at a guessed rate. The
  OpenAI-compatible engine keeps its own message history in a new
  `assistant_sessions` table under the same id `sessions` uses, so a task
  boundary rolls both at once and a rolled thread can never be replayed.
  
  **Budgets are enforced before the call**, against a new `spend` named query
  (invariant 3's one read path, `cache_ttl: 0` so a cached number cannot
  overspend). `allow` records, `stop` refuses, `critical_only` passes only an
  assignment marked `critical: true`; 80% of any window writes one warning per
  calendar window. What a refusal looks like depends on who asked: a chat turn
  is offered one more window as a Needs You item naming the exact field, a
  routine that declares `requires.engine` does not start at all (the runner's
  preflight asks the same budget question first), and a crew fails with
  `budget_exceeded` and parks. A budget that cannot be measured refuses rather
  than guessing.
  
  Also: a non-ZDR off-machine assignment writes one warning `runs` row per
  provider per day and still works — informed choice, never a block; and the
  console refuses a *directed* `agents_delegate` to a crew whose engine kind
  differs from the caller's, with the field that would permit it, while
  unassigned work any agent can claim stays open to everyone. `docs/ops/
  compute.md` gains "The engine", "Budgets" and "The collaboration rule".
- 75c7547: **Local models: discovery, install, and a `llama-server` in the box.** Three
  local model servers, one protocol. LM Studio and Ollama are **peers** —
  discovered over `GET /v1/models` wherever they already run, never started by
  Metistry — and llama.cpp's `llama-server` is now **bundled**: built from
  pinned source into the runtime pack with Metal on, signed alongside Postgres
  and git, so a Mac with neither peer installed still has a local model
  provider and nothing to download first.
  
  `metistry compute models list` is live `/v1/models` against every declared
  provider **plus** a scan of the three known local ports, so a server that is
  running but that nothing dials is reported with the one command that would
  wire it up rather than silently omitted. `metistry doctor` carries the same
  finding as `local:lmstudio`, `local:ollama` and `local:llamaserver` rows —
  each `ok` with what it has loaded, or `absent`. **Absent is never a
  failure:** a Mac with no local server is a supported install and these rows
  can only add information.
  
  `metistry compute models install <provider>/<model>` speaks each server's own
  mechanism: `lms get` for LM Studio, streamed `POST /api/pull` for Ollama,
  and for `llama-server` one plain HTTPS GET of a Hugging Face GGUF into
  `<instance>/state/models/`, checked against the sha256 Hugging Face publishes
  before anything is written and then recorded as `serve.model_path`. `load`
  and `unload` act for LM Studio and are an honest message for the other two,
  which have no addressable load. No new dependency: a GGUF is one file behind
  one URL.
  
  `compute.yaml` gains an **additive, optional** `serve: { runtime, model_path,
  port, extra_args }` block. A provider without it is exactly what shipped
  before. A provider with it is one Metistry runs itself, as an optional
  supervisor child called `llamaserver` — `metistry logs llamaserver`,
  `metistry restart llamaserver`, a `child:llamaserver` doctor row. The host is
  hard-coded to loopback, the port must be the one `base_url` already dials,
  and a missing binary or GGUF is a note rather than a failed `up`.
  
  **Embeddings move to `/v1/embeddings`.** Knowledge search used Ollama's
  native `/api/embed`, which made Ollama the only server that could ever embed;
  it now posts the OpenAI-compatible route at `METISTRY_LOCAL_MODEL_URL`,
  defaulting to the first `on_machine` provider's `base_url` in `compute.yaml`.
  `METISTRY_OLLAMA_URL` keeps working as a deprecated alias — a bare host is
  mapped onto its `/v1` root — with one startup warning naming the new
  variable. `METISTRY_EMBED_MODEL` and `METISTRY_EMBED_DIM` are unchanged, so
  no re-embed is required.
  
  Docs: `docs/ops/compute.md` gains "Local models"; `docs/ops/bundled-runtime.md`,
  `docs/ops/cli.md`, `docs/ops/knowledge-search.md` updated.
- d21f953: **The product no longer ships a claude.ai-login path or the Claude Agent SDK;
  compute is configured in `compute.yaml`.** One engine remains — the
  OpenAI-compatible loop — and Claude is reached through OpenRouter like any
  other cloud model (owner's decision, `docs/plan-refresh-2026-09-13.md` C2/C3).
  `@anthropic-ai/claude-agent-sdk` leaves every `package.json` and the lockfile;
  `engine-sdk.ts`, the `anthropic` engine kind and `CLAUDE_CODE_OAUTH_TOKEN` are
  gone from the engine, the CLI's env allowlist and secret table, the plists,
  `docker-compose.yml`, `.env.example` and the docs. Version bumps are `minor`
  across the fixed set rather than `major` because fixed mode moves every package
  together and a major here would say something about packages this does not
  touch; the behaviour change is stated here, in `docs/ops/compute.md` and in
  `docs/ops/assistant-tools.md` ("Running without an engine").
  
  **"Is there an engine" is now one seam over two facts.** `engineStatus(compute,
  env)` in `packages/core/src/compute.ts` replaces `engineCredentialPresent(env)`:
  an engine is an `assignments.default` *and* the key its provider names in
  `providers.<name>.auth.secret`. `metistry up` (whether the assistant is a
  supervisor child), `metistry doctor` (the `assistant` row), the routine
  runner's preflight (`requires.engine`) and — through the supervisor's child
  list — the watchdog all read it, so they cannot disagree; each refusal names
  the missing half and the verb that fixes it. `makeEngine` throws a named
  `NoEngineError` for a turn nothing assigns rather than inventing one, and the
  drain never starts: an install with no assignment behaves exactly as #145 made
  it, with captures, tasks, search and the console running and queued turns
  waiting. **Both deployment shapes now run engine-less** — `docker-compose.yml`
  no longer interpolates a credential as required.
  
  **The engine's credential has no fixed name.** `ASSISTANT_ENV_KEYS` becomes
  `assistantEnvKeys(compute)`: the static keys plus exactly the secrets this
  install's `compute.yaml` declares, so it stays an allowlist while the variable
  it admits is whatever the file names. A provider key in the operator's shell
  that the file does not name still cannot reach the engine. The sandbox
  profile's documented host list is derived the same way (`engineHosts`) instead
  of naming one vendor; what is actually enforced is unchanged and restated —
  the loop's only outbound call is `<base_url>/chat/completions` on the assigned
  provider.
  
  **The Mac app's step 7 becomes Compute.** Pick a template (OpenRouter,
  OpenCode Zen, LM Studio, Ollama, bundled local), name a model, paste the key
  into a secure field, and the app runs `metistry compute providers add --from
  … --json` with the key on the child's **stdin** — the one exception to the
  app's empty-stdin rule, and why `CommandRunner` grew a `standardInput`
  parameter — then `metistry compute assign default <provider/model> --json`.
  The property holding the key is cleared before the process runs, and tests
  assert the key is in no argument of any call. "Skip: no engine yet" is a real
  choice with its consequence on screen. Settings' "Claude Token" row becomes
  **Compute**, rendering `metistry compute show --json`: the default assignment,
  each provider, and whether the key each one *names* is present — never a
  value.
  
  `collectors/claude-usage` is **kept**, unchanged in behaviour: it is a local
  rollup of `runs` needing no credential, so it degrades to nothing on an
  engine-less install; its `claude.*` metric names are data existing installs
  already carry and renaming them would be a migration with no reader benefit.
  Its copy, `seed/queries/claude_usage_daily.yaml`'s description and the weekly
  review's monthly block stop describing a plan's headroom and describe what the
  provider billed.

### Patch Changes

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
- 78d78d1: **Scheduled work that stops failing quietly.** A collector whose token expired
  used to fail every hour forever — one API call each time, one number on a
  tile, and nothing that ever said "fix it or retire it". Four additive
  behaviours, all derived from the `runs` table with no schema change
  (`docs/ops/automation.md`):
  
  - **Failure streak.** Consecutive `ok = false` runs since the last successful
    one. At `METISTRY_RUNNER_MAX_STREAK` (default 5) the runner stops running
    the component: no call, no spend. Each skipped window records exactly one
    `runs` row (`kind: runner`, `tool: skipped_streak`) — one per window, not
    one per 60-second tick. One successful run clears it; there is no state to
    reset by hand.
  - **One alert per error signature.** `sha256(component + error with uuids,
    paths, hex ids and digits normalised out)`, first 12 hex, stored on the
    failing run's `meta.error_signature` and carried in the alert as
    `[sig:…]`. One (component, signature) raises one **Needs You** item per
    `METISTRY_ALERT_DEDUPE_H` (default 24h), and speaks again when the
    signature changes or the streak cleared and came back. Alerts are ordinary
    `outbound_messages` rows of kind `alert` — the path the watchdog already
    uses, so there is no new row kind and nothing new for the PWA to render.
  - **Preflight before spend.** A collector or routine may declare
    `requires: {env: [NAMES], reachable: [URL_ENV_NAMES], engine: true}`. The
    runner checks it *before* opening a run row and, on a miss, records one
    `preflight_failed` row per window and runs nothing — the message names
    every variable and the manifest file that declares it. `engine: true` asks
    core's one `engineCredentialPresent` seam, moved from `packages/cli` to
    `packages/core` so the console can ask it too (the CLI re-exports it, so
    `up` and `doctor` are unchanged). The legacy `requires: [label]` array
    stays valid and checkless; no shipped manifest declares the structured form
    yet, because every shipped collector degrades absent by design.
  - **`metistry doctor` grows a `schedules` section.** One row per schedulable
    manifest: last run and whether it succeeded, open streak, next due,
    `skipped_streak` / `preflight_failed` state. Built from `runs` plus the
    manifests, importing no collector (invariant 5). Actionable states are
    `failed`, so the existing non-zero exit already covers them; `--json`
    carries the shape in `meta`.
  
  Every refusal, skip and remediation names the environment variable or manifest
  field that would change it.
- 26df04d: **The Feed is a timeline, and a capture is on it the instant it lands.** The
  `activity_feed` query gains an `inbox` branch, so a note taken on the phone
  shows up immediately wearing its own status (`new` = still waiting on the
  drain) rather than appearing five minutes later as a proposal — the loop's one
  accidental latency. Every row now carries a coarse `group` (capture, proposal,
  decision, run, work, message) decided in the SQL, which the panel renders as
  filter chips; `since` pulls only what is new, and a decision event says what
  you answered, not just that something was answered. Still read-only.
  
  **Approve as Work.** A `knowledge` or `report` proposal whose payload carries
  `suggested_work` shows one extra answer, and the click inserts the `work` row,
  links it as `proposals.work_id` and allows the proposal. `inbox-drain` sets the
  suggestion deterministically — frontmatter `kind: todo|task`, a leading
  `@task` / `todo:` / `- [ ]`, or the `todo` verdict its rules already reached;
  **no model**, and the Apple FM tier's `has_action` is deliberately not an
  input. Nothing auto-creates: §4.12 holds because a human clicked. The row is
  born owner-less and unclaimed, so any agent may take it, and the insert is
  keyed on the proposal id so a double-tap cannot make two.
  
  **A decision is an answer to the row you were shown.** `POST
  /api/proposals/:id` accepts `if_unchanged: {seen_at}`; if the proposal moved
  after that — payload rewritten, its linked work row touched, a message in that
  row's room — nothing is decided and a `409` comes back carrying
  `reason: "stale"` and the current row, in the same envelope `already decided`
  already used.
  
  **Later and Skip** (migration `0019`, one nullable `snoozed_until`). *Later* is
  a snooze: the row stays pending, leaves Needs You and the morning brief, and
  comes back on its own (`METISTRY_SNOOZE_HOURS`, default 3) — it never ends a
  proposal. *Skip* declines with nothing to say and fires none of Decline's
  per-kind consequences: skipping an enrolment request does **not** revoke the
  agent, and its fixed `skipped` marker is excluded from every path that carries
  a decline's words anywhere. `POST /api/proposals/batch` applies `later`, `skip`
  or `deny` to many rows, all-or-nothing **per row** with a result for each; the
  queue gains multi-select and the keys `l` and `s`.

## 0.7.1

## 0.7.0

### Minor Changes

- f6c0eee: **One background item, and it is called Metistry.** macOS shows one background
  item per launchd agent, named after its program, so the launchd shape used to
  introduce itself in System Settings as "postgres", "node", "node", "node" —
  `sfltool dumpbtm` said `Executable Path: /bin/sh` four times over. Under that
  shape the core is now a single agent, `com.foldedspacelabs.metistry`, whose
  program is a symlink named `Metistry`.
  
  - **The watchdog grew into the supervisor.** It runs Postgres, the console, the
    reconciler, the assistant (still rooted at `sandbox-exec`, same profile, same
    parameters — proved live: a vault read denied, a write outside the state dir
    denied, a write inside allowed, its own console and db allowed, another
    install's console and reconciler denied) and any configured bridge as its
    children, with ordered start behind a readiness probe (Postgres answers →
    console → the rest), per-child exponential backoff, crash-loop detection that
    is *reported* rather than hammered, per-child logs at the same
    `/tmp/metistry-<service>.log` paths, and SIGTERM-then-SIGKILL in reverse
    order. Its probes and presence feed are unchanged and in the same process —
    invariant 3's sole exception did not move.
  - **`metistry restart|stop|start <service>`** reaches those children over a
    0600 unix socket in the instance's state dir, because launchctl cannot
    address a process launchd has never heard of; launchctl stays for the
    supervisor and the TCC helpers. Requests are authenticated with a token
    anyway (invariant 8), and the misuse tests ship with the interface. `doctor`
    asks the supervisor for a row per child.
  - **Everything macOS shows carries the Metistry name.** The EventKit helper's
    agent is `com.foldedspacelabs.metistry.calendar` and its bundle is displayed
    as "Metistry Calendar Access"; the Apple FM helper's is "Metistry Apple
    Intelligence". Their **bundle identifiers and signing identifiers are
    untouched** — TCC keys a grant on bundle id plus certificate chain, so no
    install has to consent again.
  - **A running install migrates in place.** `metistry up` boots out the
    pre-supervisor agents once and deletes their plists before installing the
    supervisor, so nothing runs twice; `migrate-shape launchd` produces the new
    set directly. The compose shape is untouched apart from that one rename.
  - **A bridge is installed only when it is configured** (its `METISTRY_*_URL` is
    set) — the signal `doctor` already read, and the end of "`up` installs every
    plist in `ops/launchd` regardless".
  - **`metistry up --register-via app`** leaves the one agent to the Mac app,
    which registers the copy embedded in its bundle through
    `SMAppService.agent(plistName:)` — what nests it under the app in Login Items
    instead of listing it beside.

## 0.6.0

## 0.5.0

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

## 0.3.1

## 0.3.0

### Minor Changes

- ea541bc: Tiers are (model, effort) pairs, and sessions end at task boundaries. `core`
  gains `tiers.ts` — the schema for a `tiers:` block, the `default`/`routine`
  names, and the one resolver that turns a tier NAME into a pair (an unknown
  name lands on `default`, never on an invented model) — and `session-roll.ts`,
  which marks a thread's active sessions `rolled` so the next turn starts a
  fresh SDK session and logs one `runs` row with the reason and the turn count.
  The `agent` manifest gains an optional `effort` (`low | medium | high`,
  default `low`), so a crew declares the other half of its tier; a manifest
  without it keeps working, cheaply. Rationale and figures:
  `docs/research/2026-09-cost-optimization.md`, decisions 2 and 3.
- 92dd868: Session summaries as a capture source (stash review item 2). `core` gains a
  deterministic Claude Code transcript summariser — turns, duration, files
  touched, tools with counts, models, first prompt and last response, both
  clipped — plus the `kind: session` note it renders and a content-derived
  `idempotency_key`. `cli` gains `metistry import-sessions [--since] [--project]
  [--limit] [--dry-run]`, which posts those summaries to `/capture` from the
  host, skipping anything a ledger at `~/.metistry/imported-sessions.json`
  already sent. No model is called on either side, and a transcript is never
  posted — only its summary.
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
- fc0b525: `parseDecisionBlock` — the question-answer convention (§4.21). A reply whose
  last block is a fenced ```decision block (a `title:` line plus two to eight
  `options:`) is a blocking question; the emitter parses it where the reply is
  stored and turns it into one queue item. Strict by design — a malformed block
  parses to null and is ignored, so the shape is all a model can put in front of
  the user.

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).
