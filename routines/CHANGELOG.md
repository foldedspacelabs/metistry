# @metistry-apps/routines

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
