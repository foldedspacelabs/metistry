# @metistry-apps/watchdog

## 0.16.0

### Patch Changes

- a6fce49: `metistry connect-repo` now files the push credential with a background-readable Keychain access list every time: it deletes any existing internet-password item for the host and account, then adds with `-A` (never `-U`, which kept the access list of an item `git-credential-osxkeychain` had created — so the supervisor's headless read was refused and every reconciler push failed with "could not read Username"). The token is stored before anything reaches the remote, and connect-repo's own `ls-remote` and push run with `-c credential.helper=` and `GIT_ASKPASS` instead of the osxkeychain helper. The supervisor now tells "no login Keychain item" apart from "item exists but its access list refuses a background read", and `metistry doctor`'s vault sync row names that cause and the fix (`metistry connect-repo <url> --force`).
- Updated dependencies [5a6ad9e]
- Updated dependencies [822a0c7]
- Updated dependencies [eadd0df]
- Updated dependencies [e6f16eb]
- Updated dependencies [0ff5643]
- Updated dependencies [f6a8e5d]
- Updated dependencies [cbfb1a9]
- Updated dependencies [7b979ef]
  - @foldedspacelabs/metistry-core@0.16.0

## 0.15.1

### Patch Changes

- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0

## 0.14.4

### Patch Changes

- f5b8f24: **A restarted supervisor no longer declares a child crash-looping because the previous one still held its port.** For 30 s after the supervisor starts, a child that exits early having logged `EADDRINUSE`, `listen EPERM` or "Address already in use" is retried every 500 ms and not counted toward the crash-loop threshold; every other exit, and any exit after the window, is counted as before. The supervisor also logs "[assistant] not started — …" when `supervisor.json` has no assistant child.
- @foldedspacelabs/metistry-core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Patch Changes

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

## 0.13.0

### Minor Changes

- c38dc4e: **Registries, not lists (§2.7).** Collectors, routines, targets, provider
  templates and connection types load through `Registry` — built from
  manifests, never from a list in code. Core adds `REGISTRY_KINDS` (the closed
  list of kinds, and what an extension may do with each), `loadKind`,
  `kindSources`, `extensionsDirFor`/`extensionsDirFromEnv`, `describeExtensions`,
  and `unitCode`/`joinCode`: a collector's or routine's code is found in its own
  package **by name**, so an extension may replace a product unit's manifest but
  never supplies code, and one naming no product unit is skipped with the reason.
  A new `provider` manifest kind (`type: provider` and a `provider:` block that is
  `providerSchema` itself) turns `seed/compute-templates/<name>.yaml` into
  `seed/compute-templates/<name>/manifest.yaml`; `COMPUTE_TEMPLATES` and
  `parseTemplate` are gone — `computeTemplates()` is the registry, and
  `readTemplate` takes `{ seedDir, instanceDir }`. `collectors` and `routines`
  arrays are replaced by `loadCollectors`/`loadRoutines` and
  `collectorCode`/`routineCode`; the console's `loadSchedules` takes loaded units,
  `TargetRegistry.load(sources)` skips a bad manifest instead of throwing, and the
  watchdog's `loadScheduled` reads the same registries. Every product manifest
  now carries `schema: 1`. New verb: `metistry extensions list | add | remove`
  (M15) — data-only, owner's hand, refused when its registry would skip the unit.
  Doctor gains a `registries` row. **Upgrade note:** an owner's
  `.metistry/targets/<name>/manifest.yaml` overlay without `schema: 1` is now
  skipped (the product's target is in force) until the line is added.

### Patch Changes

- 06c854e: **The scheduler: routines run once, at their time.** Core implements the
  next-occurrence function F-4 froze (`nextOccurrence`, hand-rolled over `Intl`,
  Temporal's `compatible` rule on both daylight-saving nights) and the runner's
  question `dueOccurrence` — the latest slot owed since the last run, so slots
  missed while the Mac slept coalesce into one run. A time of day is read in the
  schedule's `tz`, then `Me/profile.md`'s `timezone`, then `METISTRY_TZ` — never
  `TZ`, which both deployment shapes default to UTC — and with none is refused
  `no_timezone`. Manifests now validate `schedule:` against §2.5's closed shape
  (cron strings still accepted for one release), and the five routines carry
  §2.5's defaults: Morning Brief working days 07:00, Knowledge Fold 21:00,
  Tomorrow's Plan `eve_of_working_days` 23:00, Reply Review 23:00, Weekly
  Review Sunday 18:00. The console's runner reads each manifest ⊕
  `.metistry/scheduled.yaml` on every tick — schedule and pause by name; an
  entry it cannot apply, or a file that does not validate, HOLDS what it names
  rather than falling back to defaults — reads `timezone` / `working_days` from
  `Me/profile.md` through the vault bridge, stamps each run with the slot it is
  for (`meta.scheduled_for`, `ctx.scheduledFor`, `ctx.timeZone`), and records a
  schedule it cannot place once a day as `skipped:<reason>`. `knowledge-fold`
  and `plan-tomorrow` drop their hourly clock gates (`plan-tomorrow` keeps its
  working-day guard) and date a late run from its slot. `metistry doctor` and
  the watchdog bound a time of day by the widest gap of its week
  (`longestGapSeconds`), and doctor reports a refused schedule as `absent` in
  the runner's own words.
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

## 0.11.0

### Minor Changes

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

### Patch Changes

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

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.9.1

## 0.9.0

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
