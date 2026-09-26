# @metistry-apps/routines

## 0.12.0

### Patch Changes

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

## 0.11.0

### Minor Changes

- 6b0d6d7: **Tomorrow's plan is written for you, from your own template.** The daily
  flow's `plan-tomorrow` (`docs/product/daily-flow-spec.md` §5.1, §7; ticket
  P1-7): once an evening, the routine renders `Templates/Plan.md` — a markdown
  file in your vault, which you edit in Obsidian like any other note — into
  `Journal/Plan/<tomorrow>.md`, written through the reconciler's bridge as
  `principal: plan-tomorrow`. Tomorrow's events, the tasks the template asked
  for in the order it asked for, what an agent is waiting on you for, what is
  waiting in your queue, and your own prioritisation prose included verbatim.
  
  **No model is in it, at any tier.** The ordering is a field list in the
  template; your prioritisation *rule* is prose the plan includes for you to
  read, not something a model is asked to apply (invariant 4). The manifest
  declares no engine, so the runner never even asks whether one is configured.
  
  **It writes exactly one file, and never a note you own** (§5.1's one writer
  per file). A plan file whose frontmatter `source:` is not this routine's —
  including one with no `source:` at all, which is yours — is left exactly as it
  is and the run says so. A recurring rule is *listed* for tomorrow
  (`- Water the plants — every week, due 2026-09-22`) with no checkbox and no
  `^mt-` anchor: no routine writes a task line into a note you own (D4), which
  the engine enforces from the render's `source` and the routine refuses again
  before writing. Re-running an evening replaces the same file under
  compare-and-swap; nothing is appended, and there is never a second one.
  
  **The gate is `Me/`, and it degrades honestly.** `@hourly` with the decision
  in the routine, for the reason the fold gives — the runner has no time of day.
  It plans after the day end `Me/profile.md` states (`working_hours:`), on the
  eve of a day `working_days:` names, once per target day. No `working_days` and
  **nothing is written at all**: the run records `no_working_days` rather than
  guessing Monday-to-Friday. No `working_hours` and the plan is written from
  19:00 local *and says so*, in one visible line, because a default nobody chose
  should not be invisible. No calendar bridge, no query store, a `where:` the
  filter vocabulary refuses — each renders one `> ⚠️ metistry: …` line naming
  the template and the line number, and the plan still lands: a day with no plan
  because the calendar was down is the worst possible outcome.
  
  One `runs` row per target date carries what happened — `wrote`,
  `no_working_days`, `not_a_working_day`, `template_missing`,
  `template_unreadable` or `user_owned` — so `metistry doctor`, the morning
  brief and `docs/ops/automation.md`'s SQL all read the same ledger, and an
  hourly routine still files one row a night.
  
  The console now hands routines the named-query store and the vault bridge it
  already built for the server, so every row the plan shows arrives through a
  named query and no component grows a second read path into Postgres
  (invariant 3).

### Patch Changes

- 4581845: **The fold has its own file; your daily note is yours.** Ticket P1-9 of
  `docs/product/daily-flow-spec.md` §5.1: the evening fold now writes
  `Journal/Fold/<date>.md`, `source: knowledge-fold`, and never
  `Journal/<date>.md` — that file has always been the user's own daily note,
  and no fold turn touches it again.
  
  When `Templates/Fold.md` reads, the routine renders it itself — every
  directive but `{{ prose }}`, the one legal only there (D14) — and hands the
  skeleton plus the still-open prose slots to the SAME assistant turn it
  already enqueues; the assistant's whole job is filling the numbered slots and
  writing the result back verbatim. When there is no template yet (a missing
  `Templates/Fold.md`, or no vault reader wired into the routine — §6.4's
  `template_missing`), the fold falls back to the pre-template freeform note,
  at the SAME new path, with a visible reason on the turn rather than losing
  the night's fold or writing nothing at all.
  
  `seed/assistant-prompt.md`'s Fold section (shipped by
  `@foldedspacelabs/metistry-cli`, stamped into every instance by `metistry
  init`/`update`) is updated to match: it names the new path, states plainly
  that `Journal/<date>.md` is never a fold write target, and describes both
  shapes the enqueued turn may hand it — a skeleton to fill or a freeform note
  to compose.
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

## 0.10.0

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

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

### Patch Changes

- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1

## 0.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
