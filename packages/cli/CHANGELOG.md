# @foldedspacelabs/metistry-cli

## 0.11.0

### Minor Changes

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
- baf33c2: The vault bridge takes the principal from the credential, never from the
  request body.
  
  **The hole.** Every mutation through the reconciler's bridge carries
  `intent: { principal, … }`, and `principal` was the whole of the §4.7 check:
  `writeAllowed` admitted `.metistry/**`, `CLAUDE.md` and `README.md` for
  `principal: user` and refused everyone else. But `intent` is a field in a
  **request body**, and one shared bearer — `METISTRY_BRIDGE_TOKEN_RECONCILER` —
  reached that check. Any holder of it (the console, which terminates the
  network and multiplexes every agent on the install; anything that ever read
  the console's environment) could write `"principal": "user"` and rewrite
  `rules.yaml`, an agent definition, a named query, `metistry.lock` or the
  assistant's own instructions. Nothing did. Invariant 2 is worth only the
  stronger sentence (owner's ruling, 2026-09-20).
  
  **The wire change.** The bridge now derives a caller CLASS from the bearer and
  reads the body's `principal` as attribution inside what that class may claim
  (`CALLER_AUTHORITY`, `apps/reconciler/src/paths.ts`):
  
  | Bearer | Class | May claim | Protected paths |
  | --- | --- | --- | --- |
  | `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` (new) | `owner` | `user` only | all |
  | `METISTRY_BRIDGE_TOKEN_RECONCILER` | `console` | any principal | `.metistry/assistant-prompt.md` and `.metistry/compute.yaml` only |
  
  A body that exceeds its bearer is `403 forbidden` in the uniform envelope —
  never silently downgraded — and every refused mutation is a `runs` row
  (`component=reconciler, kind=auth`) carrying the caller class, the claimed
  principal and the path. Reads are unchanged: which bearer you hold decides
  what you may write, not what you may see. `check()` gains
  `meta.principal_from_credential` and `meta.owner_bearer`.
  
  The two protected paths left to the console are the two owner-authenticated
  doors it already ships: §4.10's self-modification overlay, which the owner
  allows in triage (`prompt-overlay.ts`), and `compute.yaml`, which the Compute
  pane's `assign`/`budget` write through the same function `metistry compute`
  calls (`compute-routes.ts`). Both are enumerated at the bridge rather than
  left to the console's restraint, so `identity.yaml`, `rules.yaml`,
  `deployment.yaml`, `metistry.lock`, `queries/`, `agents/`, `routines/`,
  `targets/`, `extensions/`, `CLAUDE.md` and `README.md` are refused whatever
  it asks for.
  
  **The new bearer.** `metistry init` mints it; `metistry up` and `metistry
  update` mint it for an install that has none — before they restart the
  reconciler, and `update` kickstarts the reconciler itself if nothing else in
  the run did — and `metistry secrets sync --to env` mints it as a
  `GENERATED_SECRETS` name. It is kept out of the console's environment by name
  (`CONSOLE_ENV_DENY` in the otherwise wholesale `METISTRY_*` passthrough
  `consoleEnv` builds), and `docker-compose.yml` never listed it. `writeProtected` presents whichever
  bearer its process holds and lets the bridge decide — the CLI's is the owner's,
  the console's is not — so a caller cannot widen itself by choosing a variable
  name. With no owner bearer configured anywhere, no caller may write a
  protected path at all, `metistry doctor`'s `reconciler` row is `degraded` with
  the command that mints one, and a 403 from the CLI names that cause.
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
- a0c1d02: `metistry init` now stamps the daily-flow journal tree — `Journal/` and its
  `Plan/`, `Fold/`, `Standup/` and `Meetings/` subfolders, `Templates/` with
  the six seeded templates (Daily, Meeting, Plan, Standup, Fold, Weekly), `Me/`
  with a `profile.md` and `Working Style.md` carrying honest placeholders, and
  empty `People/` and `Projects/` — into every new instance
  (`docs/product/daily-flow-spec.md` P1-8). All six templates ship
  `source: user`, so the assistant can never overwrite them, and a re-stamp
  (`--force` onto an existing instance) never clobbers a template or a `Me/`
  page you have since edited: only what is genuinely missing gets filled in.
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

- afc2679: The command line has a presentation layer. `packages/cli/src/ui.ts` —
  hand-rolled, no dependency — decides once whether to colour (a TTY,
  `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, `--no-color`, and never under
  `--json`), whether the terminal can draw `✓` or wants `[ok]`, and how wide a
  paragraph may be; and it holds the pieces every verb was re-inventing: an
  aligned key/value block, a table with a header rule, a closed status
  vocabulary with one colour each, and a spinner that animates on a terminal
  and prints one line everywhere else.
  
  Applied to the verbs an operator sees most. `doctor` groups its rows by kind
  and puts the remediation — the reason a red row is read at all — wrapped
  underneath that row instead of in a ragged fifth column; `version` and
  `deployment` and `connect --list` are aligned tables; `compute providers
  test` shows the listing and the completion as sub-rows; `update` narrates its
  steps and ends with one line saying whether it landed and what moved;
  `migrate-layout` shows each section's moves as a `from → to` table; `--help`
  opens with the verbs grouped by what you are in the middle of doing, with the
  full reference still underneath. `<checkout>/.env is still being read as a
  fallback and is deprecated` was the first thing printed by almost every verb;
  it is now one dimmed line at the end.
  
  `down` and `restart|stop|start` are the same table, with what `launchctl
  print` and `docker compose ps` answered after the stop under a heading of its
  own; `deployment` names this install's keep-awake policy beside its shape;
  and `init`'s one question wraps to the terminal instead of to 90 columns.
  
  No `--json` document and no exit code changes: colour is off at the source
  whenever a verb is printing for a machine. `--no-color` is new.
- 975221b: **`metistry up` (and `update`) now writes a `metistry` shim, so there is
  finally something to run `metistry` BY NAME against.** A release install has
  no Homebrew formula and no npm global, so nothing ever put `metistry` on
  `PATH` — the only way to run one was the owner's own hand-written wrapper.
  `up`/`update` write a small, idempotent POSIX script to
  `<instance>/.metistry/state/cli/metistry` (mode `0755`) that already knows
  this install's product dir and instance dir, and re-resolves which of
  `current/` (a release) or the bare product dir holds the CLI, and which
  `node` to run it with, on every invocation — so a release flip or a freshly
  bundled runtime needs no re-write. `state/cli/` rather than `state/bin/`:
  the launchd shape's `state/bin/Metistry` is already the supervisor's own
  program-identity symlink, and macOS's default case-insensitive volume would
  make that the same directory entry as `state/bin/metistry` — a sibling
  directory avoids the collision outright. `writeCliShim` also leaves alone
  anything already sitting at the path that is not a symlink-free plain file
  recognisably its own — a foreign file is noted, never overwritten.
  
  `up` never puts it on `PATH` itself (invariant 2 — that is the operator's
  own hand): it prints the one `ln -s … ~/.local/bin/metistry` line that
  would, and `metistry doctor` gains an informational `cli on PATH` row
  (`ok`/`absent`, never a finding that fails the exit code) carrying the same
  line as its remediation.
  
  The Mac app's `RuntimeLocator` now also searches `~/.local/bin` and the
  active instance's own `.metistry/state/cli` when looking for a `metistry`
  on `PATH`, so it finds an install even before anyone has linked anything.
- fe6669c: `metistry up` is faster, says where its time went, and has a counterpart.
  
  Four steps were costing wall-clock seconds nobody benefited from. The retire
  step ran a `launchctl bootout` and an `rm` for each of eight pre-supervisor
  labels, in series, on every run — one `launchctl list` now answers for all
  eight, with the old unconditional sweep kept as the fallback for a dry run or
  a probe that fails. Postgres readiness is polled every 250ms rather than
  every second, keeping the same 15s ceiling. Doctor's probes are independent
  and now run concurrently, so the closing table costs the slowest probe rather
  than the sum of all of them (no timeout was shortened: a slow-but-healthy
  bridge reported as down would be a worse table). `up` ends with a figure per
  `==` section plus the total, and one line naming who owns the processes it
  started — launchd or compose, never the CLI.
  
  New verb: `metistry down [--json] [--dry-run]` stops every host job and every
  container this instance runs and then confirms it by looking — `launchctl
  print` finding nothing, `docker compose ps` listing nothing. It is `docker
  compose stop`, never `down` and never `-v`: no container is removed and no
  volume is touched. `stop [<service>…]` remains the per-service verb. When the
  Mac app registered the background item, `down` stops it for this login
  session and says the app will start it again at the next one — it does not
  reach into another application's `SMAppService` registration.
- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- 1155dd9: `metistry compute providers test <name> --complete` no longer probes the
  alphabetically-first model in a provider's listing — for OpenRouter's 400+
  models that was some obscure, unroutable one, which 404s and reads as the
  key having failed when the listing had already proven it works. The
  completion probe now prefers a model already assigned to that provider in
  `compute.yaml`, then a model this project's own docs point an operator at
  first for it, then OpenRouter's own `openrouter/auto`, and only then falls
  back to the first listed model as before. `--model <id>` overrides the
  choice outright. A failed completion is now reported separately from the
  listing (`listing ok` / `completion: FAILED (model …, chosen: …) …
  override with --model <id>`) rather than marking the whole provider row
  FAILED.
- 847a5ba: `metistry console call` grows `--idempotency-key <key>`, so a caller — the
  Mac app or a script — can retry a `POST /capture` without minting a second
  note. The key is checked to the server's own shape (trimmed, non-empty, at
  most 200 characters) before the request ever goes out, and a replay (the
  console's `idempotency-replayed` response header, which this verb otherwise
  prints no trace of) folds `"replayed": true` into `--json` output or a
  one-line stderr note in plain mode.
- @foldedspacelabs/metistry-core@0.9.1

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
- ce521a6: **`metistry migrate-layout` moves an existing instance onto the flat layout.**
  The 2026-09-17 ruling shipped for new instances; this is the verb that carries
  an old one across. `git mv` for what git tracks and a plain move for what it
  does not: the config half into `.metistry/`, the gitignored `state/` with it,
  every entry of `Knowledge/` up to the instance root (`Knowledge/CLAUDE.md`
  becomes the root `CLAUDE.md`, a `Knowledge/.obsidian/` comes up too), a
  pre-#156 root `inbox/` normalised and merged into `Inbox/`, the `.gitignore`
  rewritten with your own lines kept, and one commit at the end. It restarts
  nothing.
  
  The whole plan is read off the filesystem *before* anything moves, so a name
  collision between `Knowledge/` and the instance root is refused with both
  sides named and the tree exactly as it was. A dirty git tree is refused too
  (`--allow-dirty` overrides), and a running reconciler is named in a warning —
  it is the instance repo's sole committer, and it would otherwise sweep the
  migration into commits of its own halfway through.
  
  Crew `scope:` and target `data_policy.allow:` entries are rewritten in the
  manifest files in the same run — the console re-syncs the crew registry from
  `.metistry/agents/**` on an interval, so a grant migrated in the database and
  left stale in the manifest behind it would be undone by the next sync, which
  is a migration that silently fails. That edit is a byte-range splice rather
  than a re-serialisation: aligned comments, flow-vs-block style and the
  operating prompt below the frontmatter come back byte-identical.
  
  A pre-2026-09-17 `<instance>/eval/` moves under `.metistry/` with the rest —
  bake-off fixtures and transcripts are instance-repo content, not knowledge —
  and preflight now lists any lowercase entry that will sit at the vault root
  after the move, since the vault root becomes the instance root and vault
  content is TitleCase.
  
  Stored paths follow in ONE transaction: `Knowledge/` drops out of
  `knowledge_files`, `knowledge_links`, `embeddings`, `inbox` and
  `projects.area`, a pre-2026-09-16 bare capture filename becomes
  `Inbox/<file>`, and a read grant covering the whole vault becomes `/`. With no
  database configured the rewrites are named and skipped rather than failing, so
  the files still move. `--dry-run` prints every move and every row count and
  touches nothing; `--json` reports the result.
  
  The Mac app reads both layouts now — a legacy folder is adopted, not refused,
  and Status and the first-run wizard both say "Legacy layout — run `metistry
  migrate-layout`". `metistry connect`'s editor configs were already free of
  instance paths; a test now holds them that way.

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
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0

## 0.8.1

### Patch Changes

- 19f2167: **The darwin runtime pack builds again.** The release job that builds the signed TCC helpers moves to the `macos-26` image: the Apple FM helper imports FoundationModels and guards on macOS 26.4, so it needs the 26.4 SDK, which no older image carries. Both helpers now pin their own deployment floor (`arm64-apple-macos26.0` for Apple FM, `arm64-apple-macos14.0` for EventKit) so a helper built on a newer runner still launches on the Mac it ships to. 0.8.0's darwin pack never built; this is the fix that lets 0.8.1 ship it.
- @foldedspacelabs/metistry-core@0.8.1

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
- 2eb6d45: **`metistry connect <tool>`** — one verb that gives an external dev tool its
  own way into an instance. `connect cursor` registers Cursor as an external
  agent, keeps the bearer in the login Keychain, and merges one entry into
  `~/.cursor/mcp.json` (0600, every other server preserved) that names the
  token as `Bearer ${env:METISTRY_AGENT_TOKEN_CURSOR}` — so it never reaches
  disk. `connect claude-code` mints the token
  `docs/ops/claude-code-plugin.md` had you mint by hand and prints the
  plugin's own `export` lines. `connect devin` prints the name, URL and
  `Authorization` value to paste at Customize → MCPs, because Devin has no API
  to write its config, plus the plain warning that a loopback URL is reachable
  from a Devin CLI session on this Mac and not from Devin's cloud.
  
  Idempotent — the agent id *is* the tool name, so a re-run finds the row the
  last one made — and it never shows a secret it did not just mint: the console
  returns a bearer only at mint or rotate, so an already-connected tool is told
  its token is unchanged and `--rotate` is the only way to a new one. Grants
  start default-deny (`{tier: "none", areas: []}`); `--areas` widens the read
  tier, `--project` adds membership, and nothing here can grant
  `knowledge_write` because an external principal cannot reach it at the bridge
  at all. `connect --list [--json]` reports each tool's row, bearer and config.
  New: `docs/ops/cursor.md`, `docs/ops/devin.md`.
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
- ba96165: **`--json` is now pure.** The Mac app's Compute pane (#174) found several
  `metistry compute`/`instances`/`restart|stop|start` verbs writing their own
  progress notes — a stored-secret notice, a download's byte count, a step
  runner's `== title`/`$ command` lines — onto the same stdout stream as the
  `--json` result, so the app had to parse a trailing object out of a run of
  prose (`JSONValue.parseTrailing`). Under `--json`, every verb across
  `compute`, `local-models` (through `compute models …`), `connect`,
  `instances`, `runs export`, `restart`/`stop`/`start`, `doctor`, `identity`
  and `secrets` now writes exactly one JSON document to stdout; every human
  line goes to stderr instead. Non-`--json` output is unchanged.
  
  **`metistry console call <METHOD> <path> [--body @file|-] [--json]`** — a
  thin scripting seam behind `console whoami`: one authenticated request
  against the instance's console, as the same `user` principal (the local
  owner token, loopback-only by design — a non-loopback
  `METISTRY_CONSOLE_URL`/`METISTRY_URL` is refused before the token ever
  leaves this process). Prints the response body, pretty unless `--json`
  (which prints the console's own bytes verbatim), and exits non-zero on a
  `>=400` answer naming the error envelope's `code`/`message` (and `field`,
  when present) on stderr. `docs/ops/second-instance.md`'s first Devin
  dispatch uses it in place of a pasted session cookie.
- ca9f424: **OpenCode joins the instance: `metistry connect opencode` for reading,
  `plugins/opencode` for writing.** The verb registers OpenCode as an external
  agent, files its bearer in the login Keychain, and merges one entry into
  `~/.config/opencode/opencode.json` — `mcp.metistry`, `type: "remote"`, 0600,
  every other server and setting preserved. The bearer is **not** in the file:
  OpenCode substitutes `{env:METISTRY_AGENT_TOKEN_OPENCODE}` inside the header,
  verified against a running OpenCode 1.18.30 by pointing the entry at a server
  that logged what arrived. Global config rather than project, because OpenCode's
  own docs call a project `opencode.json` "safe to be checked into Git"; an
  existing `opencode.jsonc` is the file written instead, since OpenCode loads it
  last. `--list` gains the row.
  
  `plugins/opencode` is the capture half: a `session.idle` hook, inert unless
  `METISTRY_CAPTURE_ON_STOP=1`, that POSTs one `kind: "session"` note per finished
  session with the same frontmatter and the same `idempotency_key` formula as the
  Claude Code and Cursor plugins, so the console dedupes across all four doors and
  `inbox-drain` needed no change. Because OpenCode hands a plugin its SDK client,
  the note is a full summary — turns, duration, models, cost, tokens, tools with
  counts, files touched, first prompt, last response — not the thin one Cursor's
  payload allows. `install.mjs` links it into `~/.config/opencode/plugins/`
  idempotently and `--remove` takes it back out.
  
  Two things said plainly rather than guessed at. OpenCode has no session-end
  event — `session.idle` fires after every assistant turn — so an idle arms a
  quiet window (`METISTRY_OPENCODE_IDLE_MS`, default 90 s) and a further idle
  re-arms it; one note per finished session, not one per turn. And a one-shot
  `opencode run "…"` is **not** captured: measured on 1.18.30, the process exits
  17 ms after `session.idle` (100 ms on the error path), `beforeExit` never fires,
  and an event hook's promise is not awaited — a plugin that slept 4 s in the hook
  was cut off mid-sleep. TUI, desktop app and `opencode serve` sessions are
  captured; the docs say so instead of leaving anyone to debug it.
  
  `@opencode-ai/plugin` was **not** added: the hook shapes are hand-typed from the
  docs in a JSDoc block, and the types package stays a decision for later.
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

### Patch Changes

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
- 0f17227: `metistry doctor` gained an `inbox` row: it flags an instance still carrying
  the pre-#156 layout — a non-empty `<instance>/inbox/` or a `.gitignore` that
  still lists `inbox/` — with the remediation `metistry migrate-inbox
  --dry-run` (`docs/ops/inbox.md`). Degraded, never failed: the fallback path
  still works, it just is not the vault.
- 9a4400f: `metistry init` now prints `METISTRY_ORIGIN` — the console refuses to start
  without it in either shape — and shapes `METISTRY_RECONCILER_URL` for the
  install it targets (launchd by default on macOS, `--shape compose` for a
  container install), on `127.0.0.1` with this instance's own ports once it
  is namespaced (`state/ports.yaml`). Fixes `docs/ops/deployment-shapes.md`'s
  "What is still missing" #4, surfaced by the second-instance guide.
  
  The `--help` text for `metistry compute providers add --from` now lists
  every template from `COMPUTE_TEMPLATES` instead of a hand-copied, and
  stale, subset (`llamaserver` and `applefm` were missing).
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
- 12c65b2: The release's darwin packs are signed under the Developer ID when the
  signing secrets are set: `metistry-runtime-deps` carries Node, Postgres
  and git under Folded Space Labs (Node keeps its JIT entitlements minus
  `get-task-allow`, and the build proves the signed node starts), so the
  supervisor's Login Item on a `metistry update` install is attributed to
  Metistry rather than to the Node.js Foundation; and the darwin
  `metistry-runtime` pack now includes the Swift TCC helper bundles
  (calendar, apple-fm), built and signed in CI, so a release install has
  helpers for `metistry up` to pin its bridges at — under the same
  certificate and identifiers, so a grant earned by a checkout's build
  survives the switch. One composite action (`.github/actions/apple-keychain`)
  does the keychain import for all three darwin jobs. Without the secrets
  (a fork) nothing changes.
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

- 8679831: The Mac app DMG builds again: the bundled supervisor launcher lives in
  `Contents/Resources/` rather than `Contents/MacOS/`, where codesign demands
  a nested signature a shell script cannot carry (v0.7.0's DMG job failed
  sealing the app on it).
- b2b272a: `metistry up` now pins the calendar and apple-fm TCC bridge jobs at their
  signed helper bundles on every run, not only `migrate-shape`. A release
  carries no built helper `.app` (`pack-runtime.sh` ships the sources, not
  the gitignored build output), so a release install's `up` used to
  re-render the calendar plist and rewrite `supervisor.json` pointing at a
  bundle the release does not have — silently un-pinning both bridges the
  next time `up` ran after `migrate-shape launchd` had pinned them. The pin
  (`TCC_HELPERS`, `pinTccHelpers`, `pinSupervisorChild`) moved to its own
  module, `packages/cli/src/tcc-pin.ts`, so `up` can call it right after
  writing the calendar plist and `supervisor.json` and before bootstrapping
  either — no extra kickstart. `migrate-shape` keeps calling it too, after
  its own restore, idempotently.
- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Minor Changes

- cf3aa96: Move a LIVE install between the two deployment shapes, with its data, in one
  reversible verb — `docs/ops/migrate-compose-to-launchd.md` is the runbook.
  
  - **`metistry migrate-shape launchd`** quiesces the console and the assistant,
    `pg_dump`s the live database through the running `db` container to
    `<instance>/state/migrate/<ts>.dump` and **verifies it with `pg_restore
    --list` before stopping anything**, `docker compose stop`s (never `down -v`
    — the containers and the volume are the rollback), writes `deployment.yaml`
    through the reconciler as the `user` principal, runs `up`, `pg_restore`s
    **before any migration runs** (the dump carries `schema_migrations`, so the
    next `metistry update` applies none), compares every table's exact row count
    and fails by name if one lost rows, and ends with `doctor` — after waiting
    for the console and the reconciler to answer, so the verdict is not a race.
    `--dry-run` prints the whole plan and runs nothing.
  - **`metistry migrate-shape compose`** is the documented rollback. The compose
    volume still holds the database as it was at the cutover; anything written
    under `launchd` since is not copied back, and the verb prints the `pg_dump`
    command for it.
  - **Four refusals, all while the old shape is still running and nothing has
    changed**: no bundled `runtime/`; no `ops/sandbox/assistant.sb` in the
    product tree (any pack before v0.6.0 — the assistant's launchd job could not
    start at all); no `pg_dump`/`pg_restore`/pgvector; and a namespaced instance
    whose docker compose project is not namespaced, which would have stopped
    ANOTHER install's containers.
  - **The TCC bridges keep their grant.** A runtime pack ships no built
    `ek-helper.app`/`afm-helper.app`, so the migration pins those two jobs at the
    Developer-ID-signed bundles that already hold the Calendars/Reminders grant —
    same bundle id and certificate chain, so the same TCC designated requirement
    and no re-grant. Shipping prebuilt signed helpers in the pack is the recorded
    follow-up.
  - **Five defects the rehearsal found**, each of which passed a green test suite
    first: a row-count query using `query_to_xml`, which the bundled Postgres
    (built without libxml) cannot execute; rows written into the gap between the
    dump and the stop; a bridge plist re-render that dropped a namespaced
    instance's ports and sent it looking for the default install's; a hand-rolled
    `bootout`/`bootstrap` that hit the same asynchronous-teardown race PR #117
    fixed for `up`; and a closing `doctor` that raced the jobs it had just
    kickstarted.
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

- fc55edc: Fix a `migrate-shape` defect that took production down on 2026-09-10: the
  rollback (`metistry migrate-shape compose`) did not wait for the `launchctl
  bootout` of `db`/`console`/`assistant` to actually finish, nor for the
  bundled Postgres to let go of its port, before calling `docker compose up` —
  which lost that race with `ports are not available … address already in
  use` and exited 1 with the install completely down (no launchd jobs, no
  compose containers).
  
  - Both directions now wait properly: the rollback reuses `up`'s
    wait-for-label-gone helper after each `bootout`, then polls `pg_isready`
    until the bundled Postgres stops answering, before touching compose.
  - Both directions now compensate a failed `up`: the rollback restores the
    launchd jobs it just booted out (bootstrap + kickstart the plists still on
    disk) and flips `deployment.yaml` back to `launchd`; the forward migration
    brings the compose stack back up and flips `deployment.yaml` back to
    `compose`. Either failing now leaves the install exactly as it was, never
    with nothing running.
  - A second forward run after a rollback now works: a leftover
    `<instance>/state/pg` (from the earlier restore) is moved aside to
    `state/pg.<ts>.stale` — never deleted — before `up`, so `initdb` runs fresh
    and `pg_restore --exit-on-error` lands in an empty schema.
  - `docs/ops/migrate-compose-to-launchd.md` documents the `.stale` directory
    and adds a "what a failed rollback looks like and how to recover" section
    with the exact by-hand recovery command.
- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Minor Changes

- 4afd5eb: Four small verbs so the Mac app can stop parsing files itself and front the
  CLI instead (docs/ops/cli.md, docs/product/desktop-app-plan.md):
  
  - `metistry identity [--json]` — identity.yaml as the CLI understands it
    (name, mention, voice, icon, instance_id), resolving `--instance`/
    `METISTRY_INSTANCE_DIR` like every other instance verb. Read-only.
  - `metistry --version` / `metistry version [--json]` — this binary's own
    package version (always); the resolved product dir's own package.json
    version; the instance's `metistry.lock` pin + channel; and, for a release
    install, `metistry-runtime.json`'s version, commit and build time. Each
    field is reported only as far as it resolves.
  - `metistry secrets list --json` — the same rows the table shows (name,
    scope, keychain account found under, set/unset), values never.
  - `metistry deployment [--json]` — the effective shape (deployment.yaml's D4
    overlay) and the services it implies, each tagged with its running state
    via the same cheap `launchctl print`/`docker compose ps` checks `doctor`
    itself uses (never the full `doctor`, which also probes bridges over
    HTTP).
  - `metistry deployment set-shape <compose|launchd> [--yes] [--force]` —
    writes the instance's deployment.yaml through the reconciler as the `user`
    principal, exactly like `metistry.lock`/`identity.yaml` (a §4.7 protected
    path). Preview-then-confirm: without `--yes` nothing is written; refuses
    while `db`/`console`/`assistant` are still running under the current
    shape unless `--force` (the data does not move between shapes on its
    own) — `reconciler`/`watchdog` running is never a reason to refuse, since
    they are host jobs under either shape.
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
- 0281c41: Prove the Docker-free macOS shape (decision 15), and settle where a bundled
  install's writable product dir lives.
  
  - **`metistry runtime install --from <Metistry.app> [--to <dir>]`** — a signed
    bundle's `Contents/Resources/metistry/` is a SEED; the product dir is a
    writable copy of it at `~/Library/Application Support/Metistry/product/`, so
    `metistry update --channel release` works on an app install exactly as it
    does on a checkout. Idempotent, verified against the pack's own
    `metistry-runtime.json` and `runtime/manifest.json`, whose sha256s land in
    `.metistry-install.json`.
  - **`metistry up --namespace`** — a second instance can run on one Mac. One
    file, `<instance>/state/ports.yaml`, allocated once, carries this instance's
    launchd label suffix and an 8-port block; `up`, `doctor`,
    `restart|stop|start`, `logs` and `update` all read it.
  - **The launchd jobs exec the bundled Node** when the install has one, rather
    than whatever `$(which node)` found.
  - **Five fixes the live trial found**: a space in the install path broke every
    `sh -c` job (the app's default location has one); `up` now refuses a
    `state/.env` whose values `sh` would misread; the assistant's sandbox gained
    a rule for Postgres, without which the engine could never start under this
    shape; `up` waits out `launchctl bootout`'s asynchronous teardown instead of
    racing it; and a namespaced instance's ports now reach the dotenv-sourcing
    jobs and `metistry update`'s migration runner — which would otherwise have
    migrated the default install's database.
  - The release runtime pack now ships `ops/sandbox/`, without which the launchd
    shape's assistant job cannot start at all.

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Minor Changes

- 1ca8337: An instance directory is self-contained: `.env` moves to
  `<instance>/state/.env`, `identity.yaml` carries a minted `instance_id`, and
  Keychain items are scoped per instance.
  
  - `--instance <dir>` and `--env-file <path>` on every verb. The environment is
    read from `<instance>/state/.env` first, then the product checkout's `.env` —
    deprecated, still read (with a notice on stderr), and still where a terminal
    install may declare `METISTRY_INSTANCE_DIR`.
  - `metistry secrets sync --to env` performs the move: every line of the old
    file is carried over and the old file is left in place.
  - `SECRET_SCOPES` (secrets.ts) is the one table saying whether a secret is
    filed under the instance's `instance_id` or the per-user account.
    Instance-scoped values found only under the user account are copied across,
    never deleted. `secrets list` gains a scope column.
  - New `metistry secrets purge --instance <dir> [--yes]`: preview-then-confirm
    deletion of one instance's Keychain items, incapable of touching user-scoped
    ones.
  - The `sh -c` launchd plists gain an `__ENV_FILE__` placeholder and
    `docker compose` is invoked with `--env-file`, so both read the instance's
    file rather than the checkout's.
- 99473d3: `metistry restart|stop|start [<service>…]` and `metistry logs <service>
  [--lines N] [--follow]` — the CLI can now act on individual services in
  either deployment shape (launchctl kickstart/bootout/bootstrap on the
  launchd shape, `docker compose restart|stop|start|logs` on the compose
  shape), reusing `up`'s own knowledge of which services are host jobs vs.
  containers rather than a second table. No args = every service the current
  shape runs; `--json` on `restart`/`stop`/`start` prints
  `[{service, action, ok, detail}, …]` for the Mac app's menu bar, which now
  calls these verbs instead of shelling out to launchctl/docker itself. An
  unknown service name fails with the list of known ones.

### Patch Changes

- e23df1b: The Mac app gets Settings, a first-launch wizard, and a menu bar worth
  opening. Settings lives in the `Settings` scene (⌘, and the app menu) with
  six panes, and every value on them is a front for a file the CLI owns — the
  app persists three pointers (active instance, recents, a developer runtime
  override) and no configuration, asserted by a test over its whole defaults
  domain. The product-directory preference is gone: a shipped app's product is
  the runtime inside its own bundle. The wizard replaces the "First run" tab
  group with a sheet over the same seven steps, Back/Continue/Skip, every
  choice stating what it gets you and what it costs. The menu bar groups
  components by doctor's own `kind` with Restart/Stop/Start/View Log per
  component and Restart All/Stop All above them, refreshing on open and every
  30s while open. The lifecycle verbs (`restart`, `stop`, `start`, `logs`) land
  separately; until they do the app says "this CLI has no `restart` verb yet —
  update it" rather than reporting a failed restart.
- a6b82f1: The Mac app DMG notarizes: `build-app.sh` re-signs every Mach-O it embeds
  from the runtime packs under the Developer ID (hardened runtime, timestamp,
  `get-task-allow` stripped from Node's entitlements) and audits the bundle
  before packaging; `notarize.sh` reads Apple's status instead of trusting
  `notarytool`'s exit code, and prints the submission log when it is not
  Accepted. Signing retries through Apple's timestamp-server flakes.
- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- 6b8b214: `metistry update --channel release` now pins `metistry.lock`'s
  `product.commit` to the commit the installed runtime pack was actually
  built from, read from that pack's own `metistry-runtime.json` — release
  mode never does a git pull, so there was no HEAD to read, and the lock
  previously kept whatever commit the prior release had pinned even after a
  version bump. A pack built before this field shipped (0.3.0, 0.3.1) falls
  back to the prior lock's commit rather than fabricating one.
- 3d36953: The Mac app ships as a release asset. A signed, notarized `Metistry-<version>.dmg`
  and an EdDSA-signed `appcast.xml` now come with every release, so the app can be
  downloaded from GitHub Releases and update itself from there. Inside it: a Status
  panel that is `metistry doctor` at a glance with a menu-bar glyph for the worst
  fault, and a first-run flow that walks the install — locate the runtime, create
  the instance, connect a GitHub repo by device flow, sync secrets to the Keychain,
  bring the services up — showing the exact `metistry` command before it runs each
  one. Nothing in the app talks to Postgres or git: it runs the same CLI the
  terminal does.
- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- 588e69a: Release images are built for `linux/amd64` and `linux/arm64`. v0.3.0's
  `ghcr.io/foldedspacelabs/metistry-*` images were amd64-only, so `metistry
  update --channel release` on an Apple-silicon Mac failed at `docker compose
  pull` with "no matching manifest for linux/arm64/v8". The Dockerfiles' build
  stage now runs natively on the CI host (`--platform=$BUILDPLATFORM`; the
  compiled output is pure JS) and only the runtime stage is per-architecture.
- 9a2a90f: `metistry update --channel release` downloads release assets (the runtime
  pack, the runtime-deps pack, `checksums.txt`) through GitHub's authenticated
  asset API when `METISTRY_GITHUB_TOKEN` is set — the one path that reads a
  private repo's assets with a token; `browser_download_url` 404s there. The
  302 to the signed S3 URL is followed without resending the token. A 404 on
  download falls back to `gh release download`, as an unauthorised resolve
  already did.
- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Minor Changes

- 1e4eaae: The runtime ships with the product. A release now carries
  `metistry-runtime-deps-<version>-darwin-arm64.tar.gz` — Node, a relocatable
  Postgres 17 + pgvector built from source, and a minimal git — built by
  `ops/release/build-runtime-deps.sh` with every version and source sha256
  pinned in one file, and verified from a *moved* copy of the tree before it is
  packed. `metistry update --channel release` installs it alongside the runtime
  pack, and `metistry up` on the launchd shape fetches it when no Postgres
  exists anywhere; both go through the same checksums.txt verification as the
  product pack, and `METISTRY_RUNTIME_DEPS=0` keeps them off the network.
  `METISTRY_PG_BIN` resolution finds `runtime/postgres/bin` as before, and the
  reconciler's launchd job gets `runtime/git/bin` on the front of its PATH — so
  a clean Mac needs neither Homebrew nor Xcode Command Line Tools.
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

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

## 0.2.0

### Minor Changes

- fe1f062: Two install verbs, terminal-first (the Mac app will drive the same ones):
  `metistry connect-repo <url>` sets the instance repo's origin, obtains a
  git credential the reconciler can push with unattended (GitHub device
  flow, a PAT on stdin, or an ssh key) into the macOS login Keychain,
  verifies with `ls-remote`, flushes the reconciler's queue and pushes; and
  `metistry secrets sync|mint|list` makes the login Keychain the canonical
  store (`metistry:<VAR>`) with `.env` generated from it. No secret reaches
  argv, output, or `.git/config`.
- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).
- d381a45: Release pipeline: a `v*` tag now builds the product's versioned artifacts on
  GitHub Releases — a runtime pack per os-arch, npm packages with provenance,
  container images, and `checksums.txt`. `metistry update` gains a release mode
  that resolves a release, verifies its sha256 before unpacking, switches a
  `current` symlink and keeps the previous release for `--rollback`;
  `metistry init --channel release` writes that mode into `metistry.lock`.

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
