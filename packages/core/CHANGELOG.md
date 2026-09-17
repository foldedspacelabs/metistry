# @foldedspacelabs/metistry-core

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
