# @metistry-apps/assistant

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1
  - @foldedspacelabs/metistry-queries@0.14.1

## 0.14.0

### Minor Changes

- 2fc0ef0: **Compute (T4-18): provider keys are this instance's secrets, providers gain a
  switch and billing, and the catalogue is searched by model.**
  
  - `compute.yaml`'s `auth.secret` is a reference: `{{ secret.<name> }}` (one of
    this instance's secrets), `env:<NAME>` (an install variable), or — so every
    older file loads — the bare `<NAME>`. A pasted key still cannot match any of
    them. Core gains `credentialOf`, `providerCredential`, `credentialEnvNames`,
    `credentialFromEnv` and `providerSecretNames`; the reference spelling moved
    to a leaf module (`secret-ref.ts`, re-exported by `secrets.ts`) so
    `compute.ts` can read it without a load-time cycle.
  - A service reads a key from its environment, never the Keychain:
    `{{ secret.x }}` arrives as `METISTRY_SECRET_X` (core's `secretDeliveryVar`),
    which `metistry secrets sync --to env` now writes for every secret the
    providers reference, from this instance's item only; `metistry up`'s engine
    allowlist passes exactly those names. For one release a `*_api_key` secret is
    also read from the `METISTRY_<NAME>` line T4-3 filled, so `migrate-scope`
    rewriting the reference cannot cut a running engine off.
  - `metistry compute providers add` stores the key through `secrets set`'s own
    code — this instance's Keychain account, recorded in `secrets.yaml` sent only
    to the provider's host — and writes the reference. The `openrouter` template
    references `{{ secret.openrouter_api_key }}`. Nothing in `metistry compute`
    reads or writes the retired per-user account any more. `--secret` takes a
    secret's name; the old UPPER_SNAKE spelling is refused with the name it
    became.
  - Providers gain `enabled` (off = neither searched nor offered; an assignment
    naming a switched-off provider is refused by the schema) and `billing:
    token | subscription` (off this machine only). The report carries `enabled`,
    `billing`, `tag` (`local` · `cloud` · `subscription`), `secret_kind`,
    `secret_name` and presence from this instance's account.
  - `seed/model-identities.yaml` and core's `groupCatalogue`: provider model id →
    one model, overlaid by key by the instance's `.metistry/model-identities.yaml`
    (a new `INSTANCE_LAYOUT.modelIdentities`). An id it cannot map stays its own
    row under its provider.
  - New verbs: `compute providers set <name> [--enabled on|off] [--billing …]
    [--base-url …] [--secret …]`, `compute models search [<query>]`,
    `compute unassign <tier|crew:name>`. New owner routes:
    `GET /api/compute/catalogue[?q=&provider=&refresh=true]` (listings kept
    15 minutes in memory; `refresh` re-reads them) and
    `POST /api/compute/unassign {tier|crew}`; MetistryKit's `UsageStore` gains
    `computeCatalogue` and `unassignCompute`.
  - `migrate-scope` now rewrites `compute.yaml`'s `auth.secret` (its schema reads
    references), and still counts a rewritten reference's original as this
    instance's, so reruns stay idempotent and `purge-shared` can find it.
    `METISTRY_SECRET_*` is never taken for a retired shared-scope original.
  - `fetchModels` keeps what a listing says beyond the id (name, context,
    per-million price, tools) as `details`.
- fce1f33: Questions v2 and both report names (T2-3). **A request can ask several
  questions** (1–5, each pick one or pick any, 2–8 options, and — unless it says
  `other: no` — ending in *Something else…*): the assistant's ```` ```decision ````
  block grows a `question:` / `pick:` / `other:` grammar beside v1's (core's
  `parseDecisionBlock`, still hand-rolled and bounded), and every agent asks the
  same way through `requests_create` kind `question` with `questions` — no new
  tool; the brain's eager surface grows 64 tokens (4,267 → 4,331) and stays at 26
  tools. **Answers are stored per question**: `POST /api/proposals/:id
  {decision: "answers", answers: [{choices, other?}, …]}` is checked against the
  questions as stored (`checkAnswers`) and settles the row `answered`, with
  `payload.answers` and the answers' words in `feedback`; free text is `other`
  and never executes. Revise on a question is `accept_with_changes`. v1's wire —
  the option itself as `decision` — still answers a one-question request.
  **`decideProposal` reads F-5's table** (`describeRequest(kind, payload).decisions`)
  instead of building its own list: a report is Dismissed (`skip`) and can no
  longer be approved, revised or declined; Skip on one row is only a type's own
  Decline (Dismiss, Not Mine) — elsewhere it is the batch's (K2). `GET
  /api/proposals` serves a question's `request.questions`. **`decided`** is the
  report kind for a decision made (C104); `decision` is accepted and stored as
  `decided`. The PWA draws each type's own answers from the table, and a
  question's questions as its body. MetistryKit sends Send Answers
  (`RequestAnswer.answers`).

### Patch Changes

- 211b408: **Connections through the proxy: the lazy pair (T4-8b).** `/mcp` gains `connections_list` and `connections_call` — the one way an agent reaches the owner's connections (plan §2.6, C115). `connections_list` names the connections lent to the caller and the tools it may call without dialling anything; `connections_list { connection }` fetches those tools' own definitions on demand, so no upstream tool is ever on the eager surface. `connections_call` runs one through an injected `ConnectionsProxy` (the host's pooled client): secrets filled only at egress, the caller's bearer handed over solely so a call carrying it is refused, the answer redacted and sanitized. This release runs a connection's Reads set to Allow; Never and unlisted tools are "no such tool", Ask First and Changes things are refused with the reason. Every call — refusals included — is one `runs` row of kind `connection_call`, read back by the new route-only `connection_calls` named query.
  
  Core: `Resource` gains `{kind: "connection", door, name, offered}` and `may()` decides it (`mayConnection`): the assistant reaches every connection; an agent needs the connection offered to agents **and** named in `scope.connections`; a crew needs that **and** the new `connections` tool group in `uses`. A miss hides as "no such connection" (new reason `connection_required`). `RULED_TOOLS` and `TOOL_PERMISSION_CELLS` carry the two tools. The eager count moves 26 → 28 with its reason beside `COUNT_ACKNOWLEDGED` in `ops/scripts/check-tool-surface.mjs`; the assistant's `BRAIN_TOOLS` follows the manifest.
- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0
  - @foldedspacelabs/metistry-queries@0.14.0

## 0.13.0

### Minor Changes

- 152022a: **Actors, resolved (T4-6).** Core implements the actor model F-2 froze: `resolveActor` composes the assistant, a crew or an external agent from its registry row, manifest, `identity.yaml` and `compute.yaml`; `describePermissions()` (beside `describeScope`) draws the permissions table — Resource × Read × Write, provenance per entry — by asking `may()` for every tool, so a line is a door that says yes; and `TOOL_PERMISSION_CELLS` encodes docs/ops/actors.md's tool→cell table beside `RULED_TOOLS`, with an enumeration test that parses the document. A crew's `model:` is now a compute reference (`<provider>/<model-id>`) or `same_as_assistant`; the legacy `haiku | sonnet | opus` resolve through `assignments.crews` for one release, and the crew runner resolves all three with the rule the actor states (`resolveCrewAssignment`). The console carries `permissions` on every `GET /api/agents` row, serves `GET /api/agents/:id/definition` (definition, compute, limits — read-only), and `POST /api/agents` refuses `kind: internal` before anything is written. `metistry agents list` prints the table and `metistry agents define <id>` (M12) edits a crew's prompt, model, effort and description, validated the way the console reads the file and refused when stale (`--if-sha256`). MetistryKit decodes the rows into the shared `PermissionRow` wire types and prints them with `PermissionRowText` — the CLI, the console and the Mac print one table.
- a1f1113: The session archive is written (T3-9). The engine appends every finished turn — chat and machine-enqueued alike — to `session_archive`: the system prompt as sent, the messages that turn added, and each tool call with its arguments and result, all through `core/redact.ts` inside the store itself (`apps/assistant/src/archive.ts`), with `expires_at` 30 days out and `folded_at` NULL (the session fold's queue). The turn handle is minted by the drain before the call, so the in-flight `runs` row, every tool call's `_meta` and the archived row share one `turn_id`; the turn row also carries `meta.session_id`. A failed archive write never fails a turn — it lands in the run's notes. The new `session-purge` routine (daily) deletes what has expired and anything older than its `retention_days` (Scheduled config, 1–30, default 30; anything else is refused with the field named). `POST /api/sessions/purge` (reach `local`, served) is Purge Now: without `confirm: true` it deletes nothing and names the sessions not yet folded; with it, it deletes every archived turn up to the preview's `as_of`, audited.

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
  - @foldedspacelabs/metistry-queries@0.13.0

## 0.12.0

### Patch Changes

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
  - @foldedspacelabs/metistry-queries@0.12.0

## 0.11.0

### Patch Changes

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
  - @foldedspacelabs/metistry-queries@0.11.0

## 0.10.0

### Patch Changes

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
- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0
  - @foldedspacelabs/metistry-queries@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [6b3d645]
  - @foldedspacelabs/metistry-queries@0.9.1
  - @foldedspacelabs/metistry-core@0.9.1

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
- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0
  - @foldedspacelabs/metistry-queries@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-queries@0.8.1

## 0.8.0

### Minor Changes

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

- 96662a0: An instance with **no engine credential** now runs everything except the
  assistant, cleanly. Under the launchd shape `metistry up` leaves the
  assistant out of the supervisor's children instead of starting a process
  that can only crash-loop, and prints one line saying so; `metistry doctor`
  reports `assistant  absent` with the remediation and stays exit 0; the
  watchdog's `assistant-drain` reports `absent` rather than alerting about a
  queue nobody is draining. Captures, `inbox-drain`, tasks, search, the
  console and the reconciler are unaffected — what waits is the engine's
  queue, so the evening fold's turn sits in the inbox until a credential
  exists. Add one and re-run `metistry up`: the child is back, with nothing
  to hand-edit. The check lives in one function
  (`engineCredentialPresent`), so the compute pivot's rename is a one-line
  move. The compose shape is unchanged and still requires the variable.
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
- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
  - @foldedspacelabs/metistry-core@0.8.0
  - @foldedspacelabs/metistry-queries@0.8.0

## 0.7.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

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

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
