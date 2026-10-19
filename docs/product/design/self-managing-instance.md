# A self-managing instance — secrets, config and a `metistry doctor` that repairs (2026-10-18)

Design note answering two of the owner's rulings of 2026-10-04. On secrets
and configuration:

> "It's been kind of a pain to manage secrets, keychains, and the .env file.
> It feels like Metistry should self-manage more of those things through the
> UI so the user doesn't need to worry about interacting with the CLI,
> minting, updating, merging, cleaning up, etc. It's too much cognitive load
> for the user."

With it, **M7 ("no mint from the app") is reversed**. And on doctor:

> "I also want auto-fixing for any issues that are identified. That way,
> regardless of the problems found, the user only needs to run `metistry
> doctor` to fix it and get the instance working correctly."

Nothing here is built. This PR adds one document and no product code. Code
and docs are cited at `origin/main` `14509e75`. The evidence in §1 comes from
the owner's 2026-10-04 session, cited as such. Where this note proposes
something the plan says otherwise, §5 names the plan text. The plan itself is
not edited.

## 1. The problem

### 1.1 One feature, three tokens, three ways

Turning on the recorder (live capture, T8-2a/T8-2b) on 2026-10-04 took three
credentials, each set a different way:

1. `metistry secrets mint METISTRY_LIVE_CAPTURE_CONTROL_TOKEN`: the key the
   bar presents to start and stop a recording. X-80 would have `up` mint it;
   X-80 is not built.
2. An `openssl rand` line appended to `.env` by hand for
   `METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE`. The bridge refuses to start without
   both of these and refuses them if equal
   (`packages/mcp-live-capture/src/index.ts:220-230`).
3. A capture owner token for `METISTRY_LIVE_CAPTURE_INBOX_TOKEN`, so that
   transcripts reach the console. The release pack has **no command that
   mints one**. The documented path is `docker compose exec … console node
   scripts/enroll.mjs --owner-token` (`docs/ops/capture-shortcut.md:15-25`),
   a dev-only script with a compose-shaped command. The owner ran an inline
   `node --input-type=module -e` against `apps/console/dist/auth-store.js`
   instead. Its verifier is a hash row in `owner_tokens` (`auth-store.ts:122-124`),
   which is in Postgres, so `docker compose down -v` silently invalidates it.
   That fails invariant 1's rebuild test.

None of the three values means anything outside this install, and nobody
ever needs to paste one anywhere. Each is exactly what `GENERATED_SECRETS`
already describes as "minting one can never be the wrong guess"
(`packages/cli/src/secrets.ts:115-136`), yet the owner minted all three by
hand.

### 1.2 Three stores, and a render that runs the wrong way

- **Values** live in the login Keychain under this instance's account:
  `metistry:<VAR>` for the install's own variables, `metistry:secret:<name>`
  for owner-named secrets (`docs/ops/cli.md:1212-1290`, `:1467-1484`).
- **Policy** lives in `.metistry/secrets.yaml`: hosts, grants and expiry,
  never a value (plan §2.14).
- **`.env`** (`.metistry/state/.env`) holds copies of the values and also
  hand-written configuration: ports, URLs, `METISTRY_ORIGIN`,
  `METISTRY_RECONCILER_SANDBOX=0`, and the URL line that *turns a bridge on*.
  A bridge is installed only when its `METISTRY_<NAME>_URL` is set
  (`packages/cli/src/launchd.ts:46-60`).
- **`up` renders from `.env`.** The CLI loads `.env` into the process
  environment (`packages/cli/src/env.ts:98-124`). `up` renders the
  supervisor's plist and `supervisor.json` from that environment
  (`packages/cli/src/up.ts:1180-1210`; `docs/ops/deployment-shapes.md:1003-1027`).
  The reconciler, the watchdog and the TCC bridges source `.env` themselves
  (`deployment-shapes.md:974-981`).
- So the chain is **Keychain → (`secrets sync --to env`) → `.env` → (`up`) →
  jobs**, with hand edits entering in the middle. Every verb that rewrites
  `.env` has to end with `followEnvFile` because of 0.14.2, where new tokens
  sat in `.env` and old ones in the jobs (`packages/cli/src/env-follow.ts:1-22`).
  `secrets sync --to env` rewrites `.env` in place because "`.env` also
  carries hand-written configuration this command must not own"
  (`secrets.ts:28-30`).

`desktop-app-plan.md:364-368` (first-run step 4) already says the right
thing: "Bridge tokens, the assistant token, VAPID keys: minted by the app
into the Keychain; `.env` is written by the app from the Keychain at service
start … and is never edited by hand". The code reached half of that.

### 1.3 Residue and hangs

- A migration left residue. `migrate-scope` copies the shared-scope
  originals and by design deletes nothing (plan §2.14 step 4), so the owner
  ran `secrets purge-shared --yes` by hand.
- `secrets set` waited forever in a terminal with nothing piped in, until
  #486 (`5aff8be0`). The owner hit it.

### 1.4 A doctor that cries wolf, then hands back incantations

On 2026-10-04 doctor gave **two false alarms by racing a kickstart**:

- **Sixteen schedule rows** said "last ran N minutes ago, over 2× its
  interval". The check is pure wall clock against the last `runs` row
  (`packages/cli/src/doctor.ts:1111-1117`). It has no idea the runner was
  restarted a moment earlier and has not yet had a tick to catch up.
- **The recorder's socket was ENOENT one second after bootstrap.** The
  live-capture bridge's own `check()` fails when its helper does not answer
  (`packages/mcp-live-capture/src/index.ts:199`). `up` runs doctor straight
  after bootstrapping (`up.ts:1148-1154`), and so does `update`
  (`update.ts:829-833`).

It also keeps a **known false reading**: "the reconciler … is NOT confined"
(X-48). `confinementRow` reads `supervisor.json`'s argv, not the running
child (`doctor.ts:1744-1770`).

And its remedies are mostly commands to type:
`launchctl kickstart -k gui/$(id -u)/<label>` (`doctor.ts:1521`); a `sed …
&& launchctl bootstrap` recipe (`:1511`); a two-step `git mv` through a
temporary name (`:640`); `security find-generic-password … -w`
(`secrets.ts:544`). T4-21's `action` turned some of them into buttons
(`docs/ops/cli.md:2103-2126`), but a button that runs `metistry up` for you
is still a fix you have to choose.

### 1.5 Every credential the install holds, and who mints it today

| Credential | Holders | Minted today by | Origin |
| --- | --- | --- | --- |
| `METISTRY_DB_PASSWORD` | db, console, assistant, watchdog, CLI | `up` (into `.env` only, `up.ts:1075-1087`) | install |
| `METISTRY_LOCAL_OWNER_TOKEN` | console; CLI and the Mac app through it | `init`; `secrets sync` (`GENERATED_SECRETS`) | install |
| `METISTRY_BRIDGE_TOKEN_RECONCILER` | reconciler, console, watchdog, CLI | `init` (`init.ts:361`) | install |
| `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` | reconciler, CLI | `init`, `up`, `update`, `sync` | install |
| `METISTRY_BRIDGE_TOKEN_{APPLE_FM,EVENTKIT,LIVE_CAPTURE}` | the bridge and its callers | the wizard's `secrets mint` (`first-run-model.swift:351-355`), or by hand | install |
| `METISTRY_OWNER_DOOR_TOKEN_EVENTKIT` | eventkit bridge, console | `secrets mint`, by hand (`.env.example:168-172`) | install |
| `METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` | live-capture bridge; the Mac app reads it | `secrets mint`, by hand (`docs/ops/mac-app.md:1286`) | install |
| `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` | the bridge presents it; the console holds its hash in Postgres | `enroll.mjs --owner-token`, dev-only | install |
| `METISTRY_ASSISTANT_TOKEN` | assistant; console registers its hash at every start (`apps/console/src/main.ts:94-103`) | `openssl rand`, by hand (`.env.example:55-59`) | install |
| `METISTRY_VAPID_PUBLIC`/`_PRIVATE` | console; every browser's push subscription | `npx web-push generate-vapid-keys`, by hand | install, **with outside holders** |
| supervisor control token | supervisor, CLI | `up` (`mintControlToken`, `up.ts:966`) | install, already managed |
| provider keys, GitHub PATs, Devin, AWS, connection credentials, CalDAV app passwords, tunnel authtokens | the egress door fills them (§2.14) | typed: `secrets set`, `compute providers add`, `connections authorize` | **another service** |
| the vault remote's credential | the supervisor reads it at spawn | `connect-repo` device sign-in | **another service** |

Of the eleven install rows, only two are managed end to end, by `up` and `update` with nobody asked: the
supervisor's control token and the reconciler's owner bearer.

**What is already right, and stays:** the Keychain as the value store, per
instance (Q3); a value only ever on a child's stdin, never in argv, never
printed (`docs/ops/cli.md:1248-1258`); adopt before mint (`:1359-1370`);
`up` as the one renderer (`env-follow.ts:17-21`); preview-then-confirm on
destructive verbs; T4-21's `action`, never parsed from prose
(`doctor.ts:97-107`); and the `StepRunner`, where `--dry-run` is a mode of
the same code path (`packages/cli/src/steps.ts:1-5`).

## 2. Principles

### 2.1 Configured means minted

**Every install-local credential is generated when the feature that needs it
is turned on, by `up` or by the app running the CLI.** "Install-local" means
two things: its value means nothing outside this install, and every holder is
a process `up` renders, or the Mac app reading through the CLI. The only
credentials ever typed are ones **another service issues**: a provider key, a
PAT, an app password. Each is typed **once, into a hidden field**, and the
app sends it on stdin, as New Secret already does
(`apps/macos/sources/kit/secrets-model.swift:11-20`).

- **One table, keyed by feature.** `GENERATED_SECRETS` becomes the install's
  credential table. Each row gives the variable, the feature that needs it,
  its holders, and whether it has outside holders. `up` ensures every row of
  every enabled feature.
- **Adopt, then mint.** The order is: this instance's Keychain item; then a
  value already in `.env` or in the installed jobs, copied **into** the
  Keychain because a running service holds it; then a fresh mint. This is
  `sync`'s rule for two names today (`docs/ops/cli.md:1359-1370`).
  `adoptOrMintSecret` skips the middle source (`secrets.ts:556-572`), so a
  value only `.env` holds would be rotated behind its holder. The general
  version must not do that. The comment that kept other bridge tokens out of
  the table, "because a service was already started with them"
  (`secrets.ts:131-133`), is answered by that middle step.
- **Outside holders change the rule.** VAPID is minted only if absent. Every
  browser's push subscription is bound to the public key, so rotating it is
  never automatic: it is a hand step that names the cost ("every device must
  re-enable notifications").
- **The recorder's transcript credential stops living in Postgres.**
  **Recommended:** the live-capture bridge becomes an *internal agent* with a
  `/capture`-only grant. The console registers it at every start from an
  env-held token, the way it registers the assistant from
  `METISTRY_ASSISTANT_TOKEN` (`apps/console/src/main.ts:94-103`;
  `docs/ops/capture-shortcut.md:26-27`: an agent token "also works on
  `/capture`, and only there"). `up` mints the token, the console
  re-registers it after `down -v`, and no route or table is added.
  *Rejected:* the CLI writing `owner_tokens` itself, because of invariant 3
  and because `packages/cli` "never imports the app"
  (`packages/cli/src/connect.ts:69`). *Alternative:* a `local` mint route
  like `POST /api/agents`. That is open question 4.

### 2.2 `.env` is derived

**Configuration the owner sets lives in `.metistry/*.yaml`**: git-recorded
policy, written by a CLI verb through the protected write. **Values live in
the Keychain.** **`up` renders `.env`, the plists and `supervisor.json` from
those two.** Today `up` renders the plists *from* `.env`. This design inverts
that one step, so `.env` becomes `up`'s output instead of its input.

- **Where configuration goes.** Which features run goes in
  `.metistry/deployment.yaml`, already the file that says what runs where
  (`seed/deployment.yaml`; `packages/core/src/deployment.ts:149-157`). A new
  `features:` block replaces "the URL line is set" as the switch
  (`launchd.ts:46-60`). `vault.push` absorbs `METISTRY_PUSH_SCHEDULE`.
  Ports stay in `state/ports.yaml`. Any remaining owner override goes in a
  strict `env:` block in the same file, whose schema **refuses secret-shaped
  names** (the `isSecretVar` rule, `secrets.ts:95-97`), so no value can reach
  git. *Rejected:* a new `.metistry/environment.yaml`, because it would be a
  second file answering "how does this install run".
- **Invariant 1 improves.** `.env` is gitignored. Today a hand-written
  `METISTRY_ORIGIN` or feature line dies with the Mac. In `deployment.yaml`
  it rebuilds from the repo. With §2.1, a fresh Mac re-mints every install
  credential, and only credentials another service issues need typing again.
- **Invariant 7 holds.** Services still read configuration from their
  environment. Only the source that environment is rendered from changes.
  **On Linux** there is no Keychain, and `secrets` refuses there
  (`docs/ops/cli.md:1270`). The secret half of `.env` stays the store there,
  as today, and only the configuration half is derived.
- **The migration path for existing installs**, run inside `update`
  (principle 2.5) and spread over two releases:
  1. **Release N: adopt and compare (additive).** Copy every secret-shaped
     line missing from the Keychain into it, never minting over a value.
     Move every recognised configuration line to its yaml home through the
     protected write. Move anything unrecognised into `deployment.yaml`'s
     `env:` block, except secret-shaped names, which are adopted into the
     Keychain instead. `up` still renders from `.env`, but also computes the
     rendering from yaml plus Keychain. Doctor shows any difference as an
     informational row.
  2. **Release N+1: invert.** `up` renders `.env` under a `GENERATED by
     metistry up` header and records the rendered file's hash in `state/`.
     Before each render it compares hashes, and a hand edit since the last
     render is **adopted** (into yaml or Keychain) before it is overwritten.
     The previous file is kept as `state/.env.pre-render` (0600) for one
     release. **Rollback is safe by construction**: the rendered `.env`
     carries every value the jobs need, so an older release, which reads
     `.env`, still runs (`update --rollback` is a symlink flip).
  3. `secrets sync --to env` becomes the render itself (one renderer) and is
     deprecated. `followEnvFile` folds into `up`.

### 2.3 One owner surface

The owner manages credentials and features in **Settings**. The app drives
the CLI as its audited door: the CLI prints every step it takes (`✓ $`), and
a configuration change becomes a commit. Invariant 10 applies: **each UI
action is an enumerated product change**, a row in `ManagementRow`
(`apps/macos/sources/kit/stores/management-runner.swift:26-74`) and in
plan §2.2. The full set:

| # | Action, where | Verb (argv) | M-row | New? |
| --- | --- | --- | --- | --- |
| A1 | New Secret, Secrets | `secrets set <name> [--hosts …] [--expires …]`, value on stdin | M7 | exists |
| A2 | Replace, Secrets | `secrets replace <name>`, value on stdin | M7 | exists |
| A3 | Sent Only To, Secrets | `secrets hosts <name> …` | M7 | exists |
| A4 | Who May Use It, Secrets | `secrets grant <name> <grantee> on\|ask\|off` | M7 | exists |
| A5 | Delete, Secrets | `secrets remove <name> --json`, preview, then `--yes` | M7 | exists |
| A6 | **Rotate** an install credential, Secrets ▸ *Managed by Metistry* | `secrets rotate <VAR> --json`, preview (holders, the one restart), then `--yes`; refuses a credential another service issues or one with outside holders | M7 | new verb |
| A7 | **Turn On / Turn Off** a feature: its own pane (Live Capture's switch), the wizard's bridge step, and *Managed by Metistry* when a feature's credential is missing | `deployment set-feature <feature> on\|off --json`, preview (what it mints, starts, and which macOS grants it will ask for; for off, what stops), then `--yes` | **M21** | new row |
| A8 | **Fix All**, Services ▸ Doctor and the Status panel | `doctor --plan --json`, shown; then `doctor --fix --json`; each destructive item confirmed on its own: `doctor --fix --only <id> --yes --json` | M6 | new verbs |
| A9 | **Fix** (one row), same places | `doctor --fix --only <id> --json` | M6 | new |
| A10 | Check Again, same places | `doctor --check --json` | M6 | renamed flag |
| A11 | *Later:* New Capture Token / Revoke for outside holders (the phone Shortcut), Settings ▸ Devices | `tokens add <label> --json` (value shown once, then Copy) / `tokens revoke <label>` | new row, beside M19 | new |

Three rules hold the set closed:

- **The app never writes the Keychain or a protected file itself.** The CLI
  does it on the app's behalf, which keeps T8-5's ruling ("never written by
  the app") true. Reversing M7 means *the app may cause a mint through the
  CLI*, not that Swift gains a Keychain write.
- **The wizard's bypass closes.** First-run step 4 runs `secrets mint`
  through `cli.run`, outside `ManagementCommand`
  (`first-run-model.swift:351-355`, `:446-448`). It becomes A7.
- **M6 is split.** `ManagementCommand` matches verbs by prefix
  (`management-runner.swift:109`), and M6's only verb is `["doctor"]`
  (`:54`). So `doctor --fix` would pass today under a row whose rationale is
  "local probes" (plan §2.2). M6's verbs become `doctor --check`,
  `doctor --plan` and `doctor --fix`, and a bare `doctor` from the app is
  refused.

**One pane or two:** the ruling's "Secrets & Connections" maps onto screen
15's ACCESS group, `Account · Connections · Secrets · Variables`
(`screen-15-settings.md:9-13`). This note keeps the panes separate and makes
*Secrets* the one place every credential is seen (open question 6).

### 2.4 Doctor repairs

See §3.

### 2.5 Migrations finish themselves inside `update`

Nothing a release migrates should leave the owner a cleanup verb to run.

- **Shared-scope originals.** `update` already runs `migrate-scope`. It now
  also **retires** each original that every instance this Mac knows has
  copied: the item is renamed to `metistry:retired:<VAR>`, which nothing
  reads, and the next release's `update` deletes it. A destructive Keychain
  delete thus becomes additive-first, with a one-release rollback. The known
  set is widened beyond LaunchAgents (`docs/ops/cli.md:1662-1665`) to
  include the Mac app's recent instances, so a stopped second instance is
  not stripped. *Rejected:* deleting in the same run, because an instance
  nobody had registered would lose a key it had not copied.
- **`.env` adoption and inversion** (§2.2), the legacy `.env`
  (`retire-legacy-env`, which `update` today only reports, `cli.md:1448-1449`),
  missing templates and vault case all run as steps of `update`, as the last
  three already do.
- `update`'s closing doctor is `--check`, with the grace periods of §3. It
  reports and does not repair. Repair is the owner's `metistry doctor` or
  Fix All.

## 3. The doctor contract

**Classes.** Every finding doctor can produce has one class, held in code as
a closed table and never derived from prose (the T4-21 rule,
`doctor.ts:97-107`):

- **Fixable.** Doctor does it. The fix is idempotent, local and bounded. A
  fix marked **confirm** is destructive or disruptive (it moves files,
  deletes an item, or restarts a running service), so it is
  preview-then-confirm.
- **Your hand.** Doctor names the exact step and, where it can, opens the
  place to do it. Examples: `sudo`, a TCC grant, a password another service
  issues, loading a model, resolving a conflict, or a download.
- **Informational.** A fact, not a fault.

**Modes.**

- **`metistry doctor`** (in a terminal) checks, plans and applies every
  non-destructive fix. It asks once per destructive fix (y/N), then
  re-checks and prints **before → after**: each row's old state, what was
  done (`✓ $ argv`), and its new state. It exits 0 when nothing `failed`
  remains.
- **`--check`** is read-only, exactly today's behaviour. It is used by `up`'s
  and `update`'s closing step, CI, checkpoints and the app's refresh.
- **`--plan`** is the fixes as a dry run of the same `StepRunner` code path.
  It is what the app shows before Fix All.
- **`--fix [--only <id>] [--yes]`** applies the fixes. Destructive ones run
  only with `--yes`. The app passes `--yes` only after its own confirmation,
  item by item. A `run_verb` never carries `--yes` (`docs/ops/cli.md:2115-2118`).
- **`--json`** adds `class` and `fix` (an id) to every row, additively,
  beside `action`. It also adds `fixes[]` (id, argv steps, outcome) and an
  `after` report. `action` stays for hand steps that open a pane.
  `open_secrets` narrows to "type a credential another service issues".
- **Without a terminal**, bare `doctor` behaves as `--check` and ends with
  "N fixable — run `metistry doctor` in Terminal, or `--fix`" (recommended;
  open question 2). Every script and agent that runs `metistry doctor` today
  then stays read-only by construction.

**Evidence rules.** No fixing on thin evidence.

1. **Grace for what just started.** A row whose subject started less than G
   ago is *starting*, not failed. This uses the uptime doctor already reads
   (`ps -o etimes=`, a child's `uptimeMs`, compose's `Status`;
   `docs/ops/cli.md:2128-2138`). Doctor polls it, within one run budget W,
   until it is ready. Proposed: G = 15 s for children, bridges and helpers,
   30 s for the db, 10 s for the supervisor's socket; W = 30 s per run.
   These numbers are to be measured. This rule fixes the recorder's ENOENT.
2. **Schedules after a restart or a wake.** "Overdue" counts only once the
   console's runner has been up for at least `min(interval, 15 min)` plus one
   tick (`METISTRY_RUNNER_TICK_MS`, 60 s, `apps/console/src/main.ts:693`),
   and the Mac has been awake that long. Doctor reads sleep gaps from the
   keep-awake state file (`cutoffIsAFinding`). Before that, the row reads
   "catching up after a restart N s ago". This rule fixes the sixteen rows.
3. **Read what runs, not what was rendered.** Doctor takes the running
   process's argv and state, not `supervisor.json` (X-48). When it cannot
   read them, the row says so and is never classed fixable.
4. **Two readings before an act.** A fix runs only if the failing reading
   holds on a second probe at least G later.
5. **One pass, never a loop.** Each fix runs at most once per invocation.
   The re-check fixes nothing. A fix that did not clear its row reports
   "tried X; still failing", plus the hand step. A restart-class fix is not
   repeated across invocations within 30 minutes; the local fix log is the
   evidence. After that it becomes "your hand: the log". Fix All pressed
   repeatedly cannot restart-storm a crash loop.
6. **Converge onto what the owner declared; never change a declaration.**
   Doctor never turns a feature on or off, never grants or un-grants, and
   never changes `keep_awake`, a sandbox switch or a host list. It never
   starts what the owner stopped (`child: stopped`, `metistry down`). The
   only writes to a protected path are migrations that preserve meaning
   (`METISTRY_PUSH_SCHEDULE` → `vault.push`). This is invariant 2's line
   applied to a repairing tool.
7. **Never interrupt work in flight.** Doctor defers any restart of a
   component that reports activity, for example a recording in progress
   (the live-capture check's `recording`), or an `update` holding the
   advisory lock, and says so.
8. **Fix in dependency order:** db → migrations → credentials and render →
   supervisor → children and jobs → bridges → schedules. A dependent row is
   re-evaluated after its prerequisite's fix, not fixed separately.
9. **Act only on the right product.** Doctor refuses to fix when it cannot
   name the release the instance runs (X-101).

**Audit.** Every fix runs through the `StepRunner`, so the `✓ $ argv` lines
of `up` and `update` and `--plan` are one code path. Each fix is appended to
`.metistry/state/doctor-fixes.jsonl` (derived state, 0600; names, never
values). That log is also what rule 5 reads. A `runs` row would need a
console door this note does not add (open question 8).

**What doctor never fixes.** Anything that costs money or reaches the
internet: an `update`, an app download, a model pull, a sign-in. Anything
another service issues. Anything only an administrator may do (`sudo`, TCC).

**The app.** Services ▸ Doctor (`settings-panes/services-pane.swift`) and the
Status panel (`status-panel.swift`) gain **Fix All** (A8) beside each row's
existing button. The confirmation shows `--plan`'s list first, the
non-destructive fixes run, and each destructive one is then confirmed on its
own. Afterwards the panel shows before → after.

### 3.1 Every doctor check that exists today, classified

There is one row per finding `doctor.ts` can produce at `14509e75`, grouped
as the report groups them. The fix happens only when the evidence rule holds;
otherwise the row is reported as it is today. "Restart once" means rule 5.

**The install.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 1 | `deployment`: shape, namespace (ok) | info | — | — |
| 2 | `instance layout` legacy (degraded) | fix, confirm | `migrate-layout`; the preview is its `--dry-run` | no open vault conflict |
| 3 | `instance layout` not an instance (absent) | hand | choose the instance folder, or `init` one | — |
| 4 | `profile` standup keys ignored (ok, info line) | info | Approve *Tidy* in Needs You | — |
| 5 | `vault case` spelled differently (degraded) | fix | rename to the seed's spelling through the reconciler (`update`'s step) | the reconciler answers as the owner |
| 6 | `inbox` pre-#156 captures directory (degraded) | fix, confirm | `migrate-inbox` | the preview lists the files |
| 7 | `shared scope` not copied (degraded) | fix | `migrate-scope` (copies; deletes nothing) | presence probes answer without a prompt |
| 8 | `shared scope` copied, originals remain (degraded) | fix, confirm | retire the redundant originals (§2.5) | every instance this Mac knows holds its copy |
| 9 | `shared scope` Keychain did not answer (degraded) | hand | unlock the login Keychain or allow its prompt, then Check Again | — |
| 10 | `cli on PATH` no shim (absent) | fix | write the shim (`up`'s step) | — |
| 11 | `cli on PATH` shim not on PATH (absent) | hand | link it: ruled the user's hand (`doctor.ts:715-719`) | — |
| 12 | `app` not installed (absent) | info | — | — |
| 13 | `app` behind the lock (degraded) | hand | Settings ▸ Updates (release) or Check for Updates… (checkout); a download | — |
| 14 | `app` no readable version (degraded) | hand | reinstall from the release's DMG | — |

**Components** (one row per manifest).

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 15 | a manifest does not validate (failed) | hand | the named file: your edit in a checkout, a damaged release otherwise | — |
| 16 | `console` down (failed) | fix | start, or restart, the console | two probes; not stopped by the owner |
| 17 | `console` answers with the wrong status (failed) | hand | `metistry logs console` | doctor does not restart a service that answers |
| 18 | `console` refuses the local owner token (degraded) | fix, confirm | re-render from the Keychain; restart the console only. Today's button runs `secrets sync --to env`, which the code's own comment says "changes nothing" (`doctor.ts:396-402`) | the Keychain's hash differs from the running job's; if equal, it is the compose loopback cause, which is hand |
| 19 | `brain` /mcp, console down (failed) | info | follows row 16 | re-checked after 16 |
| 20 | `brain` /mcp unexpected status (failed) | hand | the console log | — |
| 21 | `assistant` no engine (absent) | hand | Settings ▸ Compute: pick a provider and paste its key once, or load a local model | — |
| 22 | `assistant` no `supervisor.json` or no assistant child (failed) | fix | re-render (`up`), the 0.14.2 case | compute.yaml's default has its key in the store |
| 23 | `assistant` child not running (failed) | fix | restart once | rules 1, 5 |
| 24 | a bridge not configured (absent) | info | the feature is off; Turn On (A7) is the owner's choice. Today's "Add `<TOKEN>` in Secrets" button (`doctor.ts:461`) is retired | — |
| 25 | a bridge unreachable (failed) | fix | start or restart its job or child | rules 1, 4 |
| 26 | a bridge refuses its token, 401/403 (failed) | fix | re-render from the Keychain; restart that bridge only. **Never re-mint** | token hash differs between the store and the job |
| 27 | a bridge answers without a `check()` body (failed) | fix | restart once | rule 5 |
| 28 | bridge's own check: a TCC grant missing (degraded) | hand | System Settings ▸ Privacy & Security ▸ the named pane (doctor opens it) | — |
| 29 | bridge's own check: its helper does not answer (failed); the recorder's ENOENT | fix | bootstrap or kickstart the helper's launchd job | rule 1; launchctl says the helper is not running |
| 30 | `live-capture` own check: no transcript credential (degraded) | fix | mint it (§2.1) and restart the bridge | the feature is on |
| 31 | `live-capture` own check: transcriber unavailable (degraded) | hand | the bridge's words (macOS on-device speech) | — |
| 32 | `live-capture` own check: recordings owed (degraded) | info | the bridge retries; a refused token becomes row 26 | never restart while `recording` (rule 7) |
| 33 | `reconciler` own check: owner bearer missing (degraded) | fix | mint it (in `GENERATED_SECRETS` today); restart the reconciler | — |
| 34 | any other bridge-reported state (degraded) | info | the bridge's remediation, verbatim | — |
| 35 | a component with no network surface (ok) | info | — | — |
| 36 | `registries` a unit skipped (degraded) | hand | the named extension file | — |
| 37 | `registries` overlays (ok, note) | info | — | — |

**Database and schedules.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 38 | `db` password unset (absent) | fix | adopt it from the Keychain; mint only when no cluster exists | a data dir with no password in any store is hand |
| 39 | `db` unreachable (failed) | fix | start or restart the db | rules 1, 4 |
| 40 | `migrations` pending, or no table (degraded) | fix | the migration runner under the advisory lock, `update`'s step alone. Today's button runs all of `update` (`doctor.ts:837-847`) | the db answers |
| 41 | `migrations` the db is ahead of the product (degraded) | hand | update the product; doctor never rolls a schema back | — |
| 42 | `migrations` and `schedules` not checked, no db (absent) | info | follows 38–39 | — |
| 43 | `schedules` runs table unreadable (degraded) | info | follows 40 | — |
| 44 | a schedule stopped by the runner, `skipped_streak` (failed) | hand | the last error; the next good run clears it | if that error is another row's fixable finding, it is fixed there |
| 45 | a schedule blocked on configuration, `preflight_failed` (failed) | fix | mint the missing install credential; **hand** when another service issues it | the manifest's `requires` names it |
| 46 | a schedule never ran (absent) | info | — | — |
| 47 | a schedule not placeable: no working days or timezone (absent) | hand | `Me/profile.md`, or the timezone | — |
| 48 | a schedule overdue by more than 2× (failed) | hand | the console log | **rule 2**; before it holds, info: "catching up" |
| 49 | a schedule's failure streak (degraded) | hand | the error text | — |
| 50 | a schedule skipped: template missing (degraded) | fix | re-seed missing templates only (`update`'s step) | the file is absent, not edited |

**Vault sync.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 51 | no reconciler configured (absent) | fix | mint its bearers and render (`up`) | — |
| 52 | the reconciler did not answer (absent) | info | follows the reconciler row | — |
| 53 | the reconciler predates `/vault/status`, or a schema mismatch (degraded) | fix | restart the reconciler onto the running release | the child's argv names another release (rule 3) |
| 54 | conflict (degraded) | hand | resolve the named paths | — |
| 55 | no remote (absent) | info | Connect a Repository, if wanted | — |
| 56 | push or pull failed, no credential (degraded) | hand | re-authorise the remote (GitHub device sign-in) | — |
| 57 | push or pull failed, another reason (degraded) | hand | the remote's error | — |
| 58 | the `vault:` policy does not validate (degraded) | hand | fix it in Vault settings | — |
| 59 | `METISTRY_PUSH_SCHEDULE` overrides `push` (degraded) | fix | the `.env` migration moves it to `vault.push` (§2.2) | meaning preserved (rule 6) |

**Keeping the Mac awake.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 60 | `never`, chosen (ok) | info | — | — |
| 61 | not configured (absent) | hand | Settings ▸ Services ▸ Keep this Mac Awake. The product may not decide it (`seed/deployment.yaml`) | — |
| 62 | compose shape (absent) | info | — | — |
| 63 | no state file (degraded) | fix | start the supervisor | rule 1; not after the owner's `down` |
| 64 | the Mac slept anyway (degraded) | hand | a stronger setting, if wanted; the owner's call | — |
| 65 | released when the supervisor stopped (degraded) | fix | start the supervisor | not after the owner's `down` or `stop` (rule 6) |
| 66 | the holder's heartbeat is stale (degraded) | info | the Mac may have just woken; after one cycle, the supervisor log | — |
| 67 | should hold but does not, or the recorded pid is not holding (degraded) | hand | the supervisor log | — |
| 68 | lid-closed asked for, not in effect | hand | `sudo pmset -a disablesleep 1`, the owner's administrator act | — |

**Processes: launchd, compose, the supervisor, the sandbox.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 69 | `launchd:<label>` not bootstrapped (absent) | fix | bootstrap (`up`) | the job belongs to this shape and an enabled feature |
| 70 | `launchd:<label>` not running (failed) | fix | kickstart once | rules 1, 5 |
| 71 | launchctl not found (absent) | info | — | — |
| 72 | `compose`: docker not found (absent) | hand | install Docker, or move to the launchd shape | — |
| 73 | `compose ps` failed (failed) | hand | start Docker Desktop | — |
| 74 | `compose ps` unparseable (failed) | info | report it as a bug | — |
| 75 | `compose:<svc>` no container (absent) | fix | `docker compose up -d`, through `up` | — |
| 76 | `compose:<svc>` not running (failed) | fix | `up -d` once | rule 5 |
| 77 | `compose:<svc>` unhealthy (degraded) | hand | the container log | info inside the grace (rule 1) |
| 78 | `supervisor`: no `supervisor.json` (absent) | fix | `up` | — |
| 79 | `supervisor:<label>` does not answer (failed) | fix, confirm | kickstart the supervisor; every child restarts | socket ENOENT within G of bootstrap is *starting*; rule 4 |
| 80 | `child:<name>` not reported (absent) | fix | re-render (`up`) when `supervisor.json` lacks it | — |
| 81 | `child:<name>` stopped (degraded) | info | the owner stopped it; Start is the owner's | rule 6 |
| 82 | `child:<name>` crash-looping or exited (failed) | fix | restart once, then hand: the log | rule 5 |
| 83 | `launchd env` drift (degraded) | fix, confirm | re-render (`up`); it restarts the supervisor | hashes differ on two reads |
| 84 | `launchd env` never rendered (absent) | fix | `up` | — |
| 85 | `sandbox` nothing confined, compose (degraded) | info | the container is the boundary | — |
| 86 | `sandbox` nothing confined, launchd (degraded) | fix | re-render when the render predates confinement | the running argv has no `sandbox-exec` (rule 3) |
| 87 | `sandbox` reconciler unconfined by the owner's switch or an SSH remote (degraded) | info | — | read from the running process (X-48) |
| 88 | `sandbox` reconciler unconfined, no real git (degraded) | hand | `xcode-select --install`, then Fix | read from the running process (X-48) |
| 89 | `sandbox` empty egress allowlist (degraded) | info | correct for a local-only install; a stale render is row 83 | — |

**Models and connections.**

| # | Finding (today's status) | Class | Fix, or the hand step | Evidence rule |
| --- | --- | --- | --- | --- |
| 90 | `local:<server>` not answering (absent) | info | a hand step only when compute.yaml's default runs there: start it, load a model | — |
| 91 | `local:<server>` answering, no provider (ok, hint) | info | — | — |
| 92 | `connection:<name>` check failed (degraded) | hand | someone else's server; an expired key is Replace | — |
| 93 | `connections`: the directory or a file does not read (degraded) | hand | the named file | — |

**Totals: 93 findings. 37 are fixable (31 plain, 6 confirm), 31 are your
hand, and 25 are informational.** In five rows the class depends on what the
evidence shows, and the row says which way: 18, 45, 48, 66 and 90. Counted
by primary class.

**New findings this design adds:** a credential missing for an enabled
feature (fix: mint), a `.env` hand-edited since the last render (fix: adopt
before rendering), and a restart fix that tripped rule 5 (hand: the log).

## 4. What changes where, and what must not

**`packages/cli`.**

- `secrets.ts`: the credential table (§2.1), adopt in three steps, `secrets
  rotate`, retiring shared originals (§2.5), and `sync --to env` becoming
  the render.
- `up.ts`: render from yaml plus Keychain (§2.2, phase N+1), ensure every
  enabled feature's credentials, and a bounded readiness wait before its
  closing `doctor --check`.
- `doctor.ts`: the class table, `--check`, `--plan`, `--fix`, evidence rules
  1–9, before → after, and the fix log. `confinementRow` reads the running
  process (X-48), and the product is resolved correctly (X-101).
- `update.ts`: the adopt step, the retire step, and a `--check` closing
  doctor with grace.
- `launchd.ts`: bridges gated on `deployment.yaml`'s `features:`, not a URL
  line.
- `deployment.ts` (core): the `features:` and `env:` schema, with secret
  names refused.
- A new `deployment set-feature` verb.

**`apps/console`.** The live-capture bridge is registered as an internal
agent from its env-held token, as the assistant is (if open question 4 goes
that way).

**`apps/macos`.**

- `management-runner.swift`: M6 split, M7 gains `rotate`, and an M21 row.
- `secrets-view.swift`/`secrets-model.swift`: *Metistry's Own* becomes
  *Managed by Metistry* with Rotate and Turn On (§5).
- `first-run-model.swift`: step 4 runs A7.
- `services-pane.swift`/`status-panel.swift`: Fix All and before → after.
- `live-capture-pane.swift`: its switch runs A7.

**Docs.**

- A new `docs/ops/secrets.md`. There is none today; the model is spread
  across `cli.md`, `auth.md`, `mac-app.md` and `capture-shortcut.md`.
- `cli.md`'s doctor section, with the contract and the table, held by a test
  that enumerates the classes.
- `deployment-shapes.md` ("The jobs follow `.env`" becomes "`.env` is
  rendered").
- `auth.md` ("Rotating and revoking").
- `mac-app.md` (first run, the recorder key's table).

**What must not change.**

- **The Keychain stays the value store**, per instance, with values on stdin
  only, never in argv, never printed, never in a `--json` result.
- **Secrets never reach git.** The `env:` block refuses secret-shaped names,
  as `secrets.yaml`'s schema refuses a `value:` field (`docs/ops/cli.md:1547-1550`).
- **The CLI stays the door.** No console route mints, fixes or rotates. Doctor
  is reachable from no brain tool and no phone. An agent running `metistry
  doctor` without a terminal gets `--check`. Invariants 9 and 10 and the §2.3
  line, "only the Mac may change the boundary", all hold.
- **Kerckhoffs.** Every fix is an id in a closed table that the code and the
  docs list. Misuse tests ship with `--fix`. Doctor cannot:
  - mint a credential another service issues;
  - rotate one with outside holders;
  - write a value anywhere under `.metistry/` outside `state/`;
  - change a declaration (rule 6);
  - run a step outside the table;
  - be reached from the route table or the tool surface.
- **Invariant 3.** Doctor's database reach stays the probe plus the
  migration runner that already holds the exception (`migrate.ts:8-10`).

## 5. The contradiction resolved

**M7 is reversed: the app may mint, through the CLI.** It returns to
`desktop-app-plan.md:364-368` (first-run step 4), which the W4 reading of
M7 had drifted from. T6-14's rotate-only group becomes **Managed by
Metistry**. Each install credential gets one row with:

- its name;
- what holds it (the services `up` renders it into);
- its state: in the Keychain · rendered · drifted · missing;
- **Rotate** (A6), whose confirmation names the holders and the one restart.
  For a credential with outside holders it says why it is not offered
  ("VAPID: rotating signs every device out of notifications — Settings ▸
  Devices").

A feature whose credential is missing shows **Turn On** (A7). No row has a
value field, because nobody pastes an install credential anywhere.
`SecretsModel.ownNote` (`secrets-model.swift:504-507`), which says rotating
"is not a verb this app runs", is rewritten.

**Plan and doc text this reverses.** These are named here and not edited:

1. `docs/product/decisions-log.md:390`, the T6-14 row: "M7 says the app
   never mints: the pane has no Mint control."
2. `docs/product/design/screen-19-secrets-variables.md:13-14`: *Metistry's
   own* "rotate-only". Also `docs/ops/mac-app.md:843-845`: "rotating one is
   `metistry secrets` in Terminal, because §2.2's M7 lists … not `mint` or
   `sync`".
3. Plan §2.2. The M6 row ("`metistry doctor --json` | local probes",
   `design-build-plan.md:422`) becomes a mutating door. The M7 row (`:423`)
   gains `rotate`. A new M21 is added for features.
4. Plan §2.14 step 4 (`design-build-plan.md:1098-1101`): "Leave the shared
   originals". §2.5 retires them inside `update`.
5. `docs/ops/cli.md:1578-1583`: "`sync|mint|list|purge` are not in M7's list
   … the Mac app's first run drives `sync` and `mint`". Also `secrets.ts:28-30`:
   "`.env` also carries hand-written configuration this command must not
   own". Under §2.2 it carries none.
6. `metistry-build-plan.md:1950-1951`: doctor as "iterate the registry, call
   check, report". It now reports and repairs. The same plan's
   "progressive unlock via the doctor capability checklist (which doubles as
   grant-rot recovery)" (`:693-694`) already pointed this way.
7. Code comments and docs, not plan:
   - `secrets.ts:131-133` (why bridge tokens are not generated);
   - `launchd.ts:46-60` and `deployment-shapes.md:372` ("Bridges are
     installed only when configured" by a URL line);
   - `capture-shortcut.md:20-25`, the live-capture paragraph;
   - `mac-app.md:55-56`, first-run step 4.

**Not reversed:** T8-5's "never written by the app"
(`decisions-log.md:382`). The app still only reads the control key; the CLI
writes it.

**Contradictions found in code**, reported rather than routed around:

- **The app already mints.** The wizard runs `secrets mint
  METISTRY_BRIDGE_TOKEN_<NAME>` through `cli.run`
  (`first-run-model.swift:351-355`, `:446-448`). So "the app never mints"
  never held for first run. The call also bypasses `ManagementCommand`,
  which says "the set is closed at the type"
  (`management-runner.swift:17-21`).
- **Doctor's console-401 button contradicts its own comment.** The action is
  `secrets sync --to env` (`doctor.ts:396`), and the comment six lines
  later says "the fix is a restart … Re-syncing changes nothing" (`:402`).
- **M6 already admits `doctor --fix`** by prefix (§2.3).

## 6. Candidate tickets

Proposed; none is in the plan. They are listed in the recommended order. A
fixer is only as safe as its readings, so the two races and X-48 come first.
The W5 rulings PR is filing doctor tickets in parallel, which are referred to
here by description.

1. **SM-1 · Doctor graces what just started** · S. Evidence rules 1 and 2:
   uptime-aware polling within a run budget, and schedules measured from the
   runner's uptime and the last wake. Used by `up`'s and `update`'s closing
   doctor.
   - *Tests:* a 5-minute schedule last run 11 minutes ago, with the console
     restarted 30 s ago, is not `failed`. The recorder's socket missing 1 s
     after bootstrap reads *starting*, then ok.
   - **This is the W5 rulings PR's grace ticket (newly kickstarted jobs and
     the schedule check). If that is filed, SM-1 is it, not a second
     ticket.**
2. **SM-2 · = X-48** · S. The sandbox row reads the running process. Do it
   as specified: reproduce first.
3. **SM-3 · = X-101** · S. Doctor resolves the release the instance runs. It
   must come before any fix: a fixer reading a checkout's manifests repairs
   toward the wrong product.
4. **SM-4 · Every finding has a class; `--check`** · M · deps SM-1–3.
   - Adds the closed class table, `class` and `fix` in `--json` (additive),
     and `--check`, identical to today.
   - Every in-repo caller moves to `--check`: `up`, `update`, the app's
     refresh, docs, checkpoint briefs.
   - The Mac's M6 row is split.
   - No behaviour changes yet.
   - *Tests:* every finding doctor can emit has a class (the test
     enumerates §3.1); `--check` runs no mutating command through the exec
     seam; `ManagementCommand` refuses a bare `doctor`.
5. **SM-5 · Doctor repairs** · L · deps SM-4.
   - `--plan` / `--fix [--only] [--yes]` over the `StepRunner`, the terminal
     default, evidence rules 3–9, before → after, and the fix log.
   - *Misuse tests:* no fix changes a declaration; a stopped child is not
     started; nothing restarts during a recording; a destructive fix without
     `--yes` and with no terminal is skipped and listed; a second run fixes
     nothing; a fix that fails is not retried in the run; no fix id exists
     outside the table.
6. **SM-6 · Configured means minted** · M · deps SM-4.
   - The credential table by feature, adopt in three steps, and `up`
     ensuring every enabled feature's credentials. Covers the assistant
     token, bridge tokens, the eventkit owner-door token, and VAPID
     (if absent).
   - `secrets rotate` (A6).
   - **Subsumes X-80.**
   - *Tests:* X-80's three tests; a credential only `.env` holds is adopted
     into the Keychain and never re-minted; `rotate` refuses VAPID and a
     credential another service issues.
7. **SM-7 · Features turn on with one verb** · M · deps SM-6.
   - `deployment set-feature` (M21), `features:` in `deployment.yaml`,
     `launchd.ts` gated on it, a bounded readiness wait, and the hand steps
     named (TCC prompts).
   - The wizard and Live Capture pane run it through `ManagementCommand`.
   - *Tests:* turning the recorder on from nothing mints three distinct
     credentials and starts both jobs; turning it off previews what stops.
8. **SM-8 · The recorder's transcript credential survives a rebuild** · M ·
   deps SM-6, open question 4.
   - Internal agent from env, `/capture`-only.
   - `capture-shortcut.md`'s bridge paragraph goes.
   - *Misuse tests:* the token is refused on every route but `/capture`; it
     works after `down -v` and a console restart; it differs from the
     bridge's other two.
9. **SM-9 · Settings: Fix All, Rotate, Turn On** · M · deps SM-5, SM-6,
   SM-7. The Mac side of §2.3 and §5.
   - *Tests:* Fix All shows the plan before it runs; destructive items are
     confirmed one by one; Rotate names the holders; no view holds a value.
10. **SM-10 · Migrations finish themselves** · S. Retire, then delete,
    redundant shared originals, with the widened known-instance set (§2.5).
    - *Tests:* an instance in the app's recents with no copy keeps its
      original; a retired item is restorable for one release.
11. **SM-11 · `.env` adopted and compared** (release N) · M · deps SM-6.
    - `update`'s adopt step and the `env:` block's schema.
    - Doctor's informational difference row.
    - `METISTRY_PUSH_SCHEDULE` → `vault.push`.
12. **SM-12 · `.env` rendered** (release N+1) · M · deps SM-11, one release
    apart.
    - `up` renders `.env`; hand edits are detected by hash and adopted
      first; `.env.pre-render` is kept; `sync --to env` becomes the render.
    - *Tests:* a hand-added feature line survives as yaml; an older release
      runs on the rendered `.env`.
13. **SM-13 · Capture tokens for outside holders** · S · deps X-75.
    `tokens add|revoke` through X-75's door, with Settings ▸ Devices
    show-once and Revoke (A11). Replaces `auth.md`'s `UPDATE owner_tokens
    SET revoked_at` instruction.
14. **SM-14 · `docs/ops/secrets.md`** · S. The managed model, the credential
    table (§1.5) and the class table, written alongside SM-6 and kept
    current by SM-4's enumeration test.

## 7. Open questions for the owner

1. **May doctor restart a service you are using mid-session?** Options: (a)
   never without a confirmation; (b) freely, except where the component
   reports activity (rule 7); (c) restart what is down freely, but treat
   restarting a *running* service to clear drift as confirm (rows 18, 79,
   83). I recommend (c): a service that is down has no session to
   interrupt.
2. **What does a bare `metistry doctor` do without a terminal?** Options: (a)
   it fixes anyway, your words taken literally; (b) it checks and names
   `--fix`; (c) every fix needs `--fix`, even in a terminal. I recommend (b):
   you get repair in Terminal, and every script and agent that runs `doctor`
   today stays read-only without being touched.
3. **Where do hand-written `.env` lines go in the migration?** Options: (a)
   `deployment.yaml`'s `env:` block (git-recorded, secrets refused); (b) a
   gitignored `state/env.local` appended verbatim, which keeps hostnames out
   of git but is not durable; (c) refuse to render until you move each one,
   with doctor naming them. I recommend (a). The instance repo is private,
   and in git the line survives a lost Mac.
4. **The recorder's transcript credential.** Options: (a) an internal agent
   registered from env, `/capture`-only (no route, no table, survives
   `down -v`); (b) an `owner_tokens` row minted through a `local` route and
   re-minted when refused; (c) an owner token minted by a CLI verb through
   X-75's door. I recommend (a).
5. **Should `update` remove shared originals itself?** This reverses plan
   §2.14 step 4. The proposal is retire, then delete a release later, with
   the widened known set (§2.5).
6. **One pane or two?** Your ruling says "Secrets & Connections". Screen 15
   rules `Connections · Secrets · Variables` in ACCESS. I recommend keeping
   the panes and making Secrets the one place every credential is seen.
7. **Should doctor ever take a step that downloads or costs?** Examples: the
   app behind the lock (row 13), a missing local model. I recommend never:
   those stay your hand, named with the button that does them.
8. **Is the fix log enough audit?** The local `doctor-fixes.jsonl` with
   names only, or also a `runs` row, which needs a console door?

## Sources

All at `origin/main` `14509e75`:

- `CLAUDE.md` (invariants 1, 2, 3, 7, 8, 9, 10; "enforce at the tool").
- `docs/product/design-build-plan.md`: §2.2 (M6, M7, M19), §2.3, §2.14,
  §2.22, X-48, X-75, X-80, X-101, and the W4 X candidates X-80–X-102.
- `docs/product/decisions-log.md` (W4 rows, T6-14, T8-5).
- `docs/product/desktop-app-plan.md` (first-run step 4).
- `docs/product/design/screen-15-settings.md`, `screen-19-secrets-variables.md`.
- `metistry-build-plan.md` (D6; doctor in §4).
- `docs/ops/{cli,auth,mac-app,deployment-shapes,reconciler,capture-shortcut}.md`.
- `packages/cli/src/{secrets,up,doctor,update,env,env-follow,launchd,protected-write,init,steps,migrate,connect,connection-check,local-models}.ts`.
- `packages/core/src/deployment.ts`.
- `packages/mcp-live-capture/src/index.ts`.
- `apps/console/src/{main,auth-store}.ts`.
- `apps/macos/sources/kit/{secrets-model,secrets-view,settings-model,status-panel,first-run-model}.swift`,
  `settings-panes/services-pane.swift`, `stores/management-runner.swift`.
- `.env.example`; `seed/deployment.yaml`.

The evidence in §1.1, §1.3 and §1.4 comes from the owner's 2026-10-04
session. The schedule false alarm's cause is read from the code, not
reproduced.
