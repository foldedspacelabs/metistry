# @metistry-apps/macos

## 0.9.0

### Minor Changes

- b2e9416: **The Mac app gains a typed client and a store for everything the owner
  surface offers, and the token still never enters the app's own process.**
  Phase A's non-visual half (`docs/product/app-ux-plan.md` §6): `ConsoleAPI`,
  `InstanceStore`, the wire shapes, and the sidebar's pins. No views, so nothing
  on screen changed yet.
  
  **One authenticated surface, and it is still the CLI.** `docs/ops/mac-app.md`
  wrote the condition for this before the code existed — "adding it is a CLI
  change first: a `metistry console call <METHOD> <path>` keeps the token out of
  this process entirely, which a token-printing verb would not" — and
  `docs/ops/cli.md` ruled what to do once that verb shipped: "the app … use[s] it
  rather than a second HTTP client". So every request is one `metistry console
  call`, a request body goes on **stdin** rather than argv, and the local owner
  token stays where the CLI found it. `console-sign-in-tests.swift`'s source scan
  — one file uses `URLSession`, no file sets a credential header, no file names a
  keychain API, no file opens a file — passes unchanged with the whole data layer
  in, which is the point: the guard was not relaxed to make room for this.
  
  **Refusals keep the words of the thing that refused.** `ConsoleError` decodes
  the standard envelope and adds two cases the CLI door has and HTTP does not —
  this install's CLI predating the verb, and no token or a non-loopback console,
  each carrying the CLI's own sentence because it already names the fix. A `401`
  is **unreachable** and a `403` is not: the console answered, and one route
  declined this credential. `namedField(among:)` attributes a refusal to a field
  the caller already sent, because the envelope is `{code, message}` and names
  its field in prose — nothing is inferred from a sentence's shape.
  
  **The store reports; it never infers.** Four states — loading, loaded, failed,
  stale — with the console's own `as_of` beside the value, and a failed refresh
  over data already on screen goes *stale and keeps it* rather than blanking a
  working pane. A background refresh is a flag rather than a fifth state, so
  there is nothing for a view to turn into a spinner (P2). And
  `allowsDecisions` is O3 in one place: while a section is unreachable, every
  decision, drag and dispatch refuses **before sending**, in a sentence.
  
  **Both reconnect cursors, and they are not the same mechanism.** The feed's
  `since` is an inclusive timestamp that de-duplicates on `(ref, ts, kind)`; the
  request queue's is an opaque cursor whose page is *everything that changed*, so
  a row answered on the phone leaves the queue instead of lingering in it.
  
  **Pins are per instance.** Project, board, page, saved search or agent, in the
  order they were dragged, filed in app preferences under
  `pinnedItems.<instance_id>` — so the same app against a second instance never
  shows the first one's sidebar, and an instance with no id yet holds them in
  memory rather than under a shared key. Nothing about pinning reaches the
  instance repo, Postgres or the vault.
  
  Fifty new tests against an in-process stub console — every shape decoded from
  hand-written fixtures, the envelope read back through the CLI's own stderr
  render, `401` vs `403`, both cursor folds, every store transition and the pins'
  round trip — with no network and no subprocess, so they run in `swift test` on
  CI as they stand.
  
  One limitation, named rather than worked around: `console call` puts the
  envelope on stderr for a `>= 400` and does not print the body, so a conflict
  `409`'s `reason`, `decision` and row do not survive. Phase A reads nothing that
  needs them; the queue's `if_unchanged` repaint does, and the fix is one line in
  the CLI rather than a second HTTP client in Swift.

## 0.8.1

## 0.8.0

### Minor Changes

- 342590b: **Settings → Compute, and the local model server in the menu bar.** The Mac app
  gains a seventh Settings pane over `metistry compute …` — providers (add from a
  template with the API key on **stdin**, test, remove, a non-ZDR badge on
  anything off this machine that claims no zero data retention), assignments
  (`default`, each tier, each `crew:<name>` — a model picker fed by `compute
  models list --provider`, effort as a segmented control), budgets (the
  instance's and each provider's: daily, monthly, `allow|stop|critical_only`), and
  a local-models section reading doctor's `local:lmstudio|ollama|llamaserver|applefm`
  rows with install, load/unload and a RAM figure labelled an estimate. Every
  control is one `metistry compute` verb with `--json`; the pane persists nothing
  (`compute.yaml` is the record) and re-reads on open. The add-a-provider sheet is
  the **wizard's own step 7 model**, so the key's single path to a child process's
  stdin is still one function. `assistant: absent` is shown where it can be acted
  on, quoting doctor's remediation, with one button — or none, where nothing one
  click could do would fix it.
  
  Two menu-bar changes come with it: the supervisor's children (`llamaserver`) are
  listed under **Services** with the same Restart · Stop · Start · View Log,
  because `metistry restart llamaserver` is the same four verbs a launchd job
  gets; and the `apple-fm` bridge row reads `serves foundation-model` once
  `compute.yaml` declares a provider that dials it.
  
  No CLI change was needed — every verb already had `--json`. One reader-side
  fact did: these verbs narrate through the same stream the JSON goes to, so the
  app now reads the **trailing** object out of prose-then-JSON stdout, in one
  place with a test. `applefm` joined the app's template list, which the CLI had
  had since the Apple FM provider landed.
- a4e106b: **The one background item is the app's now, and has a switch.** The Mac app
  registers the install's supervisor through `SMAppService.agent(plistName:
  "com.foldedspacelabs.metistry.plist")`, from the plist sealed inside
  `Contents/Library/LaunchAgents` — so System Settings › General › Login Items
  shows **one** row, "Metistry", with the agent nested under the app and
  attributed to Folded Space Labs, instead of a background item listed beside it
  that only a terminal could turn off. Settings → Services gains **"Run Metistry
  in the background"** beside the existing "Start Metistry at login", each with
  prose saying which is which: one opens a window, the other runs Postgres, the
  console, the reconciler, the assistant and any configured bridge.
  `requiresApproval` reads as ON with a button that opens Login Items, the status
  is always re-read from macOS after a write, and a `swift build` executable —
  which has no bundled agent — says so and points at the terminal path. Wizard
  step 5 passes `--register-via app` when the build carries an agent, and
  registers it *after* `up` has written the config and launcher file it reads.
  
  **The two registrars can no longer fight.** A terminal install still bootstraps
  the same-named agent itself. `metistry up` now asks launchd who owns
  `com.foldedspacelabs.metistry` before installing anything — the plist path and
  program `launchctl print` reports, which is live state rather than a marker
  file that goes stale when the app is deleted — and leaves an app-registered one
  alone, in one printed line, while still writing everything else that agent
  depends on. `metistry doctor` reports the owner on the supervisor's row
  (`meta.registrar`, `meta.registered_from`, and the probe text the app renders).
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

## 0.7.1

## 0.7.0

### Minor Changes

- 1ec60dc: The Mac app signs in to the local console without a ceremony, and never holds
  the token.
  
  - **"Signed in as owner (local token)"** in the Status header, Settings →
    Connections and beside the console row in the menu bar, from one
    `metistry console whoami --json` per launch and per instance switch. Five
    states, each with the CLI's own words and, where there is one, the exact
    command: signed in · this CLI has no `console whoami` (update it) · no local
    owner token (`metistry secrets sync --to env`, then restart the console) ·
    the console did not answer · 401, with **which** of the loopback rule and a
    stale value is likelier for this install's deployment shape.
  - **One client, and the authenticated half of it is the CLI.** The app does not
    read the login Keychain, does not open `<instance>/state/.env`, and sends no
    `Authorization` header anywhere — a test walks `apps/macos/sources` and
    asserts each of those rather than trusting a comment. The four HTTP routes it
    speaks are the console's public bootstrap ones and nothing else. It therefore
    cannot yet make any authenticated console call except `whoami`, and the doc
    says so: that is a CLI change first.
  - **Wizard step 6 is optional and reframed** — "your Mac is signed in
    automatically; enrol a passkey only for browsers and your phone" — with the
    enrolment-code path kept intact for those, and the `ASAuthorization` probe
    moved out of the main flow to Settings → Advanced, where a diagnostic
    belongs. A successful whoami satisfies the step; so does an enrolled passkey,
    because it is the same door.

## 0.6.0

### Minor Changes

- f343d67: The Mac app finishes its first run. All seven wizard steps now do something:
  step 1 installs the bundled runtime to a writable product directory, step 5 sets
  the deployment shape after showing you what it would do, step 6 enrols a passkey
  or says precisely why this install's origin cannot host a native one, and step 7
  guides the Claude sign-in in a real terminal and watches for the token to land.
  Settings gains a working "Start at login", and shows the instance id, the
  assistant's name, the versions and the secret list by asking the CLI rather than
  by reading its files.
