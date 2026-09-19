# @metistry-apps/console

## 0.9.1

### Patch Changes

- 05e2e5b: **The vault's page list, through a named query — the third knowledge door,
  and the only one that is not a proxy.** `GET /api/knowledge/pages?area=&prefix=&limit=&offset=`,
  which #197 deferred because `seed/queries/` carried nothing to run. No
  migration: `0009_brain.sql` already added `title`, `description` and `draft`,
  and `0001` has `path`, `mtime`, `status`.
  
  **Which door a thing comes out of is settled by the schema, not by taste.** A
  page's bytes and a search ranking are not derived state — there is no column
  holding a note body — so those go to the reconciler's bridge. A page LIST *is*
  derived: `knowledge_files` is the reconciler's own index, rebuilt from the
  vault by a walk. So invariant 3 sends it through
  `seed/queries/knowledge_pages.yaml`, executed by `packages/queries`, and the
  route holds **no SQL of its own** — one that reached for `pool.query` would be
  a second read path into state.
  
  **Two filters that mean what they mean everywhere else.** There is no area
  column, and there did not need to be: everywhere in the system an "area" is a
  vault prefix (`Areas/Fsl`, which the agent registry validates and `underAreas`
  matches), so `area` is derived — the first two segments under `Areas/` at any
  depth, the top segment elsewhere, and `null` for a vault-root file like
  `now.md`, which is an answer rather than a gap. `prefix` is **segment-wise**,
  the same semantics an area grant has: `Areas/Health` covers `Areas/Health/…`
  and never `Areas/Healthcare/…`, because a substring match is how a prefix
  filter leaks. Ordered by `path`, which is the primary key, so `offset` walks a
  total order and no row ties or jumps between windows.
  
  **What no parameter can turn on.** Drafts are excluded by the same clause
  `mcp-brain` applies at every tier, so the owner's list and an agent's index
  cannot disagree about what a draft is; an unsettled `conflict` row is excluded
  because its title and mtime are not facts yet. And the route's own scope
  filter runs over the query's rows — the same `canSee` the search and page
  routes use — so a row in the index that is not vault CONTENT never reaches a
  client, the owner's included. The query is overlayable per instance (D4); the
  filter is not, which is why both hold the line. A row whose `path` is not a
  string is dropped rather than passed: a list entry whose scope cannot be
  decided is not a list entry.
  
  **There is no `total`, on purpose.** A count over the unscoped filter is
  precisely the "directory listing of what was filtered" the knowledge routes
  refuse to publish — a narrowed principal would learn how many pages it cannot
  see. Callers page until a window comes back shorter than `limit`. For the same
  reason a filter pointing outside the scope answers an empty `200` rather than
  a `400`: refusing `prefix=.metistry` by name would say which prefixes exist.
  Only the filter's shape is validated.
  
  MetistryKit gains the matching `knowledgePages` method, the
  `KnowledgePageList` / `KnowledgePageEntry` shapes and a `pages` store section
  beside `knowledge` — two sections, because browsing the vault and searching it
  are two questions and a search must not blank the list you were reading.
  
  The list is ordered by `path COLLATE "C"` — byte order, explicitly, rather
  than the database's own locale. A glibc locale collation ignores punctuation
  at the primary level, so `Areas/Health/sleep.md` sorts before
  `Areas/Healthcare/…` on one cluster and after it on another: same rows, same
  query, two different windows, and a client paging with `offset` would see a
  page twice or not at all depending on which machine the database was
  initialised on. CI (Linux) and the owner's Mac disagreeing is how it was
  found.
- dc4ce91: **The vault's link graph, through a named query — the fourth knowledge door
  and the last piece §6.1 left open.** `GET
  /api/knowledge/links?path=&limit=&offset=`, over
  `seed/queries/knowledge_page_links.yaml`. No migration: `0001_init.sql` has
  `knowledge_links (from_path, to_path, kind)` with the primary key on all
  three and an index on `to_path`, so both directions are one indexed lookup.
  The graph is derived state — the reconciler parses it out of the notes on
  every walk and re-resolves a note's edges whenever the note or the path set
  moves — so invariant 3 sends it through `packages/queries` and the route
  holds no SQL of its own.
  
  **One list, keyed by the other end.** `direction` is a column (`outgoing` =
  this page links there; `incoming` = that page links here) and `path` is
  always the far side of the edge. That is not a presentation choice: it is
  what lets one predicate decide every row. Two arrays would be two chances to
  filter them unevenly, and the filter is the point — **both ends are scoped**.
  The `path` parameter is checked before anything runs (a path the caller may
  not see gets the `404` a missing page gets: "this page has four backlinks" is
  a fact about a page), and every row goes through the same `canSee`. A page
  inside a grant that links *out* of it, and a page outside a grant that links
  *in*, both come back dropped rather than listed.
  
  **Never in the list:** an edge whose other end is a draft or an unsettled
  `conflict`, at either end and at every tier — the same rule the page list
  applies, so a draft cannot be discovered through the graph after being hidden
  from the list. Dropped rather than blanked, because a row saying "there is
  something here you may not see" is the disclosure the rule exists to prevent.
  **An unresolved wikilink stays**, marked `resolved: false` with a title
  derived from its own path: a note not written yet is how a vault gets
  written, and Obsidian renders it rather than hiding it.
  
  Ordered outgoing first, then by path in byte order (`COLLATE "C"`), then by
  `kind` — the link table's primary key read the other way round, so the order
  is total and `limit`/`offset` cannot repeat or skip an edge. The same target
  reached as a wikilink and as an embed is **two edges**, which is why the
  client's row identity is the triple and not the path. No `total`, for the
  page list's reason. The query is `expose: route`, so `/api/q/knowledge_page_links`
  answers the `404` an unknown name gets.
  
  MetistryKit gains `knowledgeLinks(path:limit:offset:)`, the
  `KnowledgePageLinkList` / `KnowledgePageLink` shapes with `outgoing` and
  `incoming` as views of the one list, and `isLastPage`/`nextOffset` beside the
  page list's.
- 6b3d645: **One endpoint per necessary operation: the generic door closes over
  route-backed queries, and the page list's scope comes from the credential.**
  `GET /api/knowledge/pages` filters every row through `canSee` — and
  `GET /api/q/knowledge_pages` served the same rows with no filter at all, to
  anyone who could reach the generic door. That included the capture owner
  token, which is a `403` on `/api/knowledge/*` and has always been admitted on
  `/api/q/<name>`: a credential that may not use the scoped route could read the
  whole unscoped vault index by name, from any address. A filter with a second
  way in is not a filter.
  
  **The close is a manifest field, not a list in a server** (invariant 5).
  `packages/queries` gains one optional key on a query manifest — `expose:
  generic | route`, defaulting to `generic`, so every query written before this
  means exactly what it meant — and `QueryStore.exposure(name)` reads it back.
  `knowledge_pages.yaml` declares `expose: route`; `GET /api/q/<name>` asks the
  store and refuses anything that is not `generic` with the **unknown-query
  refusal, byte for byte**: same code, same status, same absent message, so the
  door is not an oracle for which route-only queries a build has. An unknown
  value in the field is a load-time `invalid_spec`, never a silent fall back to
  the permissive default. The dedicated route still runs the query through the
  same `QueryStore` — the door closed, not the read path.
  
  **The scope is now derived from the principal.** The `knowledgeRoutes` call
  site passed the constant `OWNER_SCOPE`; it passes `knowledgeScopeOf(auth)` —
  session / local owner to the whole vault, a principal carrying grants to
  `grantedScope`, anything else to nothing. `grantedScope` reproduces
  `mcp-brain`'s `knowledgeScope(principal).canRead` (`tier === "areas" &&
  underAreas(path, areas)`, against that package's own `underAreas`) rather than
  renaming its fields: that shape's `prefixes` is `null` for tiers `none` and
  `index`, meaning "no restriction on the TITLES those tiers browse", and `null`
  here means every vault path's CONTENT — the rename would have handed the two
  tiers that may not read a page the owner's own scope. Agent bearers keep their
  uniform `403` on `/api/knowledge/*` and reach knowledge on `/mcp`, so the
  grant path is exercised by tests today; it is real code so that the filter a
  narrower console principal needs is not invented at a call site later.
- Updated dependencies [1155dd9]
- Updated dependencies [847a5ba]
- Updated dependencies [6b3d645]
  - @foldedspacelabs/metistry-cli@0.9.1
  - @foldedspacelabs/metistry-queries@0.9.1
  - @foldedspacelabs/metistry-mcp-brain@0.9.1
  - @metistry-apps/collectors@0.9.1
  - @foldedspacelabs/metistry-artifacts@0.9.1
  - @foldedspacelabs/metistry-core@0.9.1
  - @foldedspacelabs/metistry-tasks@0.9.1
  - @metistry-apps/routines@0.9.1

## 0.9.0

### Minor Changes

- e9074d2: **The console grows the routes the app plan needs, so compute and knowledge
  stop being Mac-only.** Nine new endpoints on the existing owner auth, the
  existing error envelope and the existing `degrades: absent` rule, each with
  its misuse tests (invariant 8).
  
  `/api/compute*` is five of the `metistry compute` verbs over HTTP: `GET
  /api/compute` (the `compute show --json` report, plus both budget windows
  folded from the `spend` named query and a `writable` flag), `GET
  /api/compute/models`, `POST /api/compute/assign`, `POST /api/compute/budget`,
  `POST /api/compute/providers/test`. They call the **same exported functions
  the CLI verbs call** — the same YAML-document edit so comments and
  hand-written blocks survive, the same re-validation of the result before
  anything is written, the same write through the reconciler as `user`
  (invariant 2) — so a refusal reads identically on both doors because it is the
  same refusal. `providers add` and `providers remove` are deliberately absent:
  they take a key, and a key goes on stdin into the login Keychain, so adding or
  removing a provider stays CLI/app-only and `secret_present` is the only thing
  a secret contributes to a response. These are the owner's **configuration**,
  not invariant-10 "actions" — `user` principal only, no `propose_action` kind,
  no autonomy level that reaches them.
  
  Two guards worth naming. The console refuses to write a `compute.yaml` it is
  not reading: if the `METISTRY_COMPUTE_FILES` overlay ends somewhere other than
  `<instance>/.metistry/compute.yaml`, the write is refused with both paths
  named, because unguarded it would find nothing at the path it opens, start
  from a bare header and deliver a four-line file over the real one. And the
  whole surface degrades absent: the compose shape gives the console no instance
  mount by design, so there every compute route answers 503 naming
  `METISTRY_INSTANCE_DIR` while `metistry compute` keeps working.
  
  `GET /api/knowledge/search` and `GET /api/knowledge/page` are the owner's read
  path into their own vault — a thin proxy onto the reconciler's
  `/vault/search` (three modes, snippets, and `degraded` reaching the client
  rather than being swallowed) and `/vault/read`. The console has held a vault
  reader and searcher since Phase 6 and wired them only into `mcp-brain`, so
  knowledge was reachable by an agent over MCP and by nothing the owner holds.
  The proxy also **narrows what the bridge serves**: `/vault/read` is confined
  to the instance repo and stops there, because the protected-path writes go
  through it, so the route adds core's `isVaultPath` and `.metistry/`,
  `Artifacts/` and the root `CLAUDE.md` are not reachable as knowledge from any
  client. A refusal answers 404, not 403, so "refused" and "absent" are
  indistinguishable from outside. `GET /api/knowledge/pages` is deliberately not
  here: the page list is derived state and belongs in a named query over
  `knowledge_files`, which `seed/queries/` does not carry yet.
  
  `GET /api/commands` is the composer's list, **generated** from the instance's
  own `rules.yaml` and the agent registry — `/note`, the deep alias under
  whatever name that instance gives it, `/model`, and one command per
  `fast_path` rule whose pattern spells one unambiguously. A rule that is a
  sentence rather than a command yields nothing, on purpose. Each entry carries
  the tier it routes to and, for a fast path, the named query whose own
  description is the menu's line. The PWA's static `COMMANDS` array — a
  placeholder marked with an expiry since it was written — is deleted, and an
  integration test routes every command the endpoint offers back through
  `route()` so the menu and the router cannot drift.
  
  `GET /api/runs/:id` is the activity feed's drill-down into a `runs:<id>` ref,
  through a new `run_detail` named query: provider, model, token and cache
  counts, cost, the tool calls the same reply made (joined exactly on
  `meta.turn_id` or `meta.message_id`, never a time window) and the shadow
  agreement measure where the turn was shadowed — the measure, not the two
  transcripts.
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
- Updated dependencies [e9074d2]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
- Updated dependencies [ce521a6]
  - @foldedspacelabs/metistry-cli@0.9.0
  - @foldedspacelabs/metistry-core@0.9.0
  - @metistry-apps/routines@0.9.0
  - @foldedspacelabs/metistry-mcp-brain@0.9.0
  - @metistry-apps/collectors@0.9.0
  - @foldedspacelabs/metistry-artifacts@0.9.0
  - @foldedspacelabs/metistry-tasks@0.9.0
  - @foldedspacelabs/metistry-queries@0.9.0

## 0.8.1

### Patch Changes

- @metistry-apps/collectors@0.8.1
  - @foldedspacelabs/metistry-artifacts@0.8.1
  - @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-mcp-brain@0.8.1
  - @foldedspacelabs/metistry-queries@0.8.1
  - @foldedspacelabs/metistry-tasks@0.8.1
  - @metistry-apps/routines@0.8.1

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
- f27e0af: **The board moves things now** — phase 3 of
  `docs/research/2026-09-12-hermes-agent-review.md`, built on the rule that
  keeps invariant 8 honest: *the board offers no drop the service would refuse.*
  
  - **`packages/tasks` — the three gaps the note found, closed additively.**
    `UpdateInput.status` was `Exclude<TaskStatus, 'open'>`, so **unblock was
    unreachable by anything in the system**; it now accepts `open` from
    `blocked` only, and hands the row back the way `release()` does. `owner`
    can be set and cleared after create (with `title` and `project`, the other
    two fields a card carries but could not change). `heartbeat` takes a
    `note` that lands on `history` — and a renew *without* one appends nothing,
    so a lease ticking every few minutes never buries the row's record.
    `update` now has **two arms, and the fields pick the arm**: the holder arm
    (`in_progress | blocked | closed`, or a bare note) is claim-gated exactly
    as before; the board arm (`owner`, `title`, `project`, the unblock) is not,
    because addressing a card is a gesture on a row nobody need hold and the
    unblock is by definition a row whose holder is stuck. Mixing the two in one
    call is refused naming both fields — the looser gate must never carry the
    stricter arm's write. New refusal reason: `not_blocked`.
  - **The console's task routes** (`apps/console/src/task-routes.ts`):
    `PATCH /api/tasks/:id {status?, owner?, project?, title?}`,
    `POST /api/tasks/:id/{claim,release,renew}`. Until now
    `POST /api/tasks/:id/dispatch` was the *only* task route the console had.
    A thin adapter and nothing more: every refusal comes out of a `WHERE`
    clause in `packages/tasks`, and the route only turns it into a sentence
    that names what would permit it. `user` principal only — an agent token
    and a capture owner token both get the canonical `403` — and one `runs`
    row per request records the door beside the service's own row for the op.
  - **The drags** in the Board tab: HTML5 drag-and-drop, no library, four
    handlers. Each drop maps to exactly one route, `reported` is never a
    target, a closed card is not draggable, and a refused drop snaps back
    carrying the server's message. `m` on a focused card is the keyboard
    alternative. Clicking a card opens its room when one exists — `board.yaml`
    gained `has_thread`, so the panel never asks a second endpoint — and its
    detail popover when it does not.
  
  **Assignment stays the human's alone, by absence rather than by a check:**
  `owner` exists on `PATCH` and on no agent surface, because `tasks_update`'s
  schema has no `owner` key and its status enum has no `open`. That is
  collaboration rule 4 without a rule to run.
  
  `docs/ops/board.md` gained the **Drags** table; `docs/ops/console-api.md`
  gained the routes.
- 6504920: **The Board — one place to see who is working on what.** A read-only Kanban
  over the task list: six columns (Backlog, Assigned, In Progress, Needs You,
  Done, Reported), a project filter, per-column counts, and a red chip on
  anything that stalled. No migration and no fifth status value — every column
  is a `CASE` over columns `work` already carried, so the whole feature is two
  named queries (`board`, `board_projects`) and a panel.
  
  Two things it makes visible that nothing else did. **"Assigned but not
  started"** — a row addressed to an agent that nobody has claimed — was in the
  data all along with no view onto it. And **Done vs Reported**: a closed task
  that produced a finding no longer looks identical to one that produced
  nothing, reconstructed from the run that claimed it.
  
  `board_projects` is one row per project × column, which is the cross-project
  board a per-board isolation model structurally cannot produce; here it is a
  `GROUP BY` on a column the table already had.
  
  Read-only on purpose. Every task mutation is still a tool call (invariant 9),
  so the panel has no drag, no drop target and no mutating control, and a test
  asserts it. Adapted from `docs/research/2026-09-12-hermes-agent-review.md`
  (phases 1 and 2). New: `docs/ops/board.md`.
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
- 5b3e6f2: **`targets/devin-sessions`** — dispatch a brief to a Devin session and get the
  answer back as a report to triage. The first `transport: http` compute target,
  and the first whose *content* returns rather than only its status.
  
  `POST /api/tasks/:id/dispatch` (passkey session only) gains `purpose` and
  `max_acu`. `purpose: "knowledge_research"` is the new brief kind: a question
  the assistant cannot answer goes out with a preamble that forbids touching any
  repository, and the whole output is a structured answer —
  `{answer, sources[], confidence, open_questions[]}`, sent as a Draft-7
  `structured_output_schema` so Devin's own `structured_output_required` will not
  let the session end without filling it in. The session id becomes the work
  row's `external_ref` (`devin:<id>`), and `collectors/devin-sessions` polls
  every five minutes: a finished session becomes a `report` proposal
  (`source_agent devin`, `trust external`) carrying the answer plus provenance —
  session URL, status, confidence, ACUs used against the cap — and closes the
  work row; an errored, suspended, timed-out or contract-breaking session files a
  report saying exactly that and leaves the row `blocked`. Accepting the proposal
  in Needs You is what puts it in the vault, through the existing fold path.
  Ruled a collector rather than an in-process timer: a poll is a scheduled pull
  with a cost, so it should have a manifest, a `runs` row and a `check()`.
  
  Safe to point at a third party: the shipped `data_policy` has an **empty**
  `allow` list, so the product default lets a brief cite nothing from the vault —
  widen it per instance in a `METISTRY_TARGETS_DIRS` overlay — and `deny_sources`
  is `[comms, devin]`, so Devin's own knowledge is not silently re-exported to
  Devin. The budget is Devin's per-session `max_acu_limit` (manifest default 5,
  overridable per dispatch), written to the dispatch `runs` row and reconciled
  with the ACUs Devin reports. Dispatch stays the owner's action: the route is
  the `user` principal only and `agents_delegate` reaches local crews and nothing
  else, so the rule that a non-Claude agent is never pushed to by name holds
  because there is no tool to break it with.
  
  Configure with `METISTRY_DEVIN_API_KEY` (the same key `devin-knowledge` uses)
  plus `METISTRY_DEVIN_ORG_ID`, which is **required** here — a session is a
  spend, and the organization it is charged to is not something to infer.
  Without either, the target's `check()` is `absent` with the remediation and the
  collector degrades absent. `docs/ops/devin.md` ("Dispatch out") has the full
  shape, including one thing now verified negative: Devin's v3 API supports **no**
  `Idempotency-Key` header, so the guard is the work row's unique `external_ref`.
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
- 54a737b: **`collectors/devin-knowledge`** — Devin (Cognition) knowledge and repo wikis
  into the inbox as captures, so the evening fold organises them into the vault.
  Set `METISTRY_DEVIN_API_KEY` (a `cog_` service-user key or personal access
  token) in `<instance>/state/.env`, run `metistry secrets sync --to keychain`,
  and hourly the collector pulls every Knowledge note changed since its last run
  plus — when `METISTRY_DEVIN_REPOS` lists repos — the DeepWiki pages for them.
  One capture per item, `source: devin`, frontmatter carrying `devin_id`, title,
  folder, repo, trigger and the source timestamp, then the text unchanged.
  
  Transports follow what Devin documents: Knowledge notes over REST v3
  (`GET /v3/organizations/{org_id}/knowledge/notes`, cursor pagination) with
  plain `fetch`, and repo wikis over `https://mcp.devin.ai/mcp` because **no
  REST route for wiki content exists** — the v3 `repositories/*` endpoints cover
  indexing status only.
  
  Safe to leave running: every capture is idempotent on
  `(collector:devin-knowledge, <kind>:<devin_id>:<version>)`, so a re-run inserts
  nothing and an edited item lands exactly once more; a `429` is
  backoff-and-stop, not a failed run, with the watermark held so nothing is
  skipped; and with no key the collector degrades **absent** — `run()` returns 0
  and `check()` names the variable and the command rather than failing. It is
  outbound-only, so it needs no inbound exposure. `METISTRY_DEVIN_API_KEY` is
  **user-scoped** in the Keychain, like the AWS credentials: it is the person's
  own key, shared by every instance on the Mac, and `secrets purge` never takes
  it. `docs/ops/devin.md` has the configuration, the verified endpoint details,
  and the two provenance points that need the owner's ruling (`deny_sources`,
  and that captures are stored verbatim because no capture door redacts).
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
- Updated dependencies [6fd4c28]
- Updated dependencies [54a737b]
- Updated dependencies [5b3e6f2]
- Updated dependencies [cde0691]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
- Updated dependencies [367f456]
  - @foldedspacelabs/metistry-mcp-brain@0.8.0
  - @foldedspacelabs/metistry-core@0.8.0
  - @metistry-apps/collectors@0.8.0
  - @foldedspacelabs/metistry-tasks@0.8.0
  - @metistry-apps/routines@0.8.0
  - @foldedspacelabs/metistry-artifacts@0.8.0
  - @foldedspacelabs/metistry-queries@0.8.0

## 0.7.1

### Patch Changes

- @metistry-apps/collectors@0.7.1
  - @foldedspacelabs/metistry-artifacts@0.7.1
  - @foldedspacelabs/metistry-core@0.7.1
  - @foldedspacelabs/metistry-mcp-brain@0.7.1
  - @foldedspacelabs/metistry-queries@0.7.1
  - @foldedspacelabs/metistry-tasks@0.7.1
  - @metistry-apps/routines@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0
  - @metistry-apps/collectors@0.7.0
  - @foldedspacelabs/metistry-artifacts@0.7.0
  - @foldedspacelabs/metistry-mcp-brain@0.7.0
  - @foldedspacelabs/metistry-tasks@0.7.0
  - @metistry-apps/routines@0.7.0
  - @foldedspacelabs/metistry-queries@0.7.0

## 0.6.0

### Minor Changes

- 410dcce: The console's **local owner token** (`docs/ops/auth.md`), so the Mac app and
  the CLI authenticate to a console on this machine without a passkey
  ceremony — they are the same package, on the same filesystem, running as the
  same person.
  
  - `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN` yields the `user` principal,
    the same one a passkey session yields, through the same `isUser()`
    predicate — but **only** when the connection's peer address is loopback.
    The decision comes from the socket; `X-Forwarded-For`, `Forwarded`,
    `X-Real-IP` and `Host` are never read. From anywhere else it is a 401
    byte-identical to an unknown token's, plus a `runs` audit line naming the
    address. Constant-time comparison; misuse tests ship with it.
  - Compose NATs a host-loopback connection to the bridge gateway, so
    `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is told: the compose
    file sets the sentinel `docker-gateway`, resolved at startup from the
    container's own default route. The gateway address only — a sibling
    container is still remote. Unset (launchd) = plain loopback.
  - `GET /api/whoami` → `{principal, via, management, origin, as_of}`.
  - `POST /auth/logout` and `/api/push/*` stay passkey-session-only: they act
    on a device session row. A host-minted `owner_tokens` row (the capture
    Shortcut) is unchanged — capture-only, any address.
  - `METISTRY_ORIGIN` may be a comma-separated list (`expectedOrigin` takes an
    array in @simplewebauthn v13); the first entry stays canonical. An origin
    mismatch, which used to escape as HTTP 500, is a 401 naming expected vs
    presented.
  
  CLI: `METISTRY_LOCAL_OWNER_TOKEN` joins `SECRET_SCOPES` as instance-scoped;
  `metistry init` mints it into the `.env` lines it prints; `secrets sync --to
  env` mints one for an install that predates it (`GENERATED_SECRETS`, the
  same "generated, so minting cannot be the wrong guess" rule as `up`'s DB
  password); `metistry console whoami [--json]` prints the principal — what
  the app calls to show "signed in as owner"; and `metistry doctor`'s console
  row now presents the token, so `api_status` is a real authenticated read
  (a refused token degrades rather than fails).

### Patch Changes

- @metistry-apps/collectors@0.6.0
  - @foldedspacelabs/metistry-artifacts@0.6.0
  - @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-mcp-brain@0.6.0
  - @foldedspacelabs/metistry-queries@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0
  - @metistry-apps/routines@0.6.0

## 0.5.0

### Patch Changes

- @metistry-apps/collectors@0.5.0
  - @foldedspacelabs/metistry-artifacts@0.5.0
  - @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-mcp-brain@0.5.0
  - @foldedspacelabs/metistry-queries@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0
  - @metistry-apps/routines@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-mcp-brain@0.4.0
  - @foldedspacelabs/metistry-core@0.4.0
  - @metistry-apps/collectors@0.4.0
  - @foldedspacelabs/metistry-artifacts@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0
  - @metistry-apps/routines@0.4.0
  - @foldedspacelabs/metistry-queries@0.4.0

## 0.3.1

### Patch Changes

- @metistry-apps/collectors@0.3.1
  - @foldedspacelabs/metistry-artifacts@0.3.1
  - @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-mcp-brain@0.3.1
  - @foldedspacelabs/metistry-queries@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1
  - @metistry-apps/routines@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [c07a12c]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-mcp-brain@0.3.0
  - @metistry-apps/collectors@0.3.0
  - @foldedspacelabs/metistry-artifacts@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0
  - @metistry-apps/routines@0.3.0
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

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-mcp-brain@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0
  - @metistry-apps/collectors@0.2.0
  - @metistry-apps/routines@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-queries@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
  - @foldedspacelabs/metistry-mcp-brain@0.1.0
  - @metistry-apps/collectors@0.1.0
  - @metistry-apps/routines@0.1.0
