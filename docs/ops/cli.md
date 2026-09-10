# `metistry` — init, connect-repo, secrets, doctor, up, update

`packages/cli` (`@foldedspacelabs/metistry-cli`, plan §4.16: `init | doctor
| up | update`, plus the two install verbs the Mac app drives —
`connect-repo` and `secrets`, `docs/product/desktop-app-plan.md`) is the
operator's front door. All of them are real.

```sh
# from anywhere, no checkout needed for init
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"

# inside a checkout after `pnpm -r build`
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js doctor --json
node packages/cli/dist/main.js up --dry-run        # what it would do, runs nothing
node packages/cli/dist/main.js up                  # containers + host jobs, then doctor
node packages/cli/dist/main.js update --dry-run
node packages/cli/dist/main.js update              # pull, build, migrate, restart, pin

# the instance repo's remote and the machine's secrets
node packages/cli/dist/main.js connect-repo https://github.com/you/metistry-instance.git
node packages/cli/dist/main.js secrets sync --to keychain
node packages/cli/dist/main.js secrets list
```

Package-level detail (flags, resolution order, probe table) lives in
`packages/cli/README.md`; this page is the operator's runbook.

## Creating an instance repo

`metistry init <dir>` replaces the by-hand bootstrap of 2026-09-06 and
produces the same tree — its own git repo on `main`, one commit `Instance
created` authored `Metistry <metistry@localhost>`:

```
<dir>/
  Knowledge/now.md          from seed/Knowledge — the vault; brain-commit writes here
  identity.yaml             the ONLY place the assistant is named (--name)
  rules.yaml                router rules, seeded default
  inbox/                    gitignored
  queries/ agents/ routines/ extensions/ instance-migrations/
                            tracked, empty (.gitkeep) — the D4 overlay reads
                            seed defaults until a same-named file lands here
  metistry.lock             product { version, commit, source } + updated_at +
                            migrations_applied; `metistry update` moves it
  README.md  .gitignore     (inbox/, .obsidian/workspace*)
```

It refuses a non-empty directory unless `--force`, never prompts, and
**never writes a secret**. What it prints at the end is the next step —
three lines for the *product* checkout's `.env`:

```
METISTRY_INSTANCE_DIR=<dir>
METISTRY_BRIDGE_TOKEN_RECONCILER=<minted once; shown only here>
METISTRY_RECONCILER_URL=http://host.docker.internal:7812
```

Then `pnpm -r build && metistry up` — containers, every launchd job,
doctor (below). Add a private remote to the instance repo whenever you
like — `metistry connect-repo <url>`, the next section; the reconciler
pushes on `METISTRY_PUSH_SCHEDULE` and never blocks on it. Point Obsidian
at `<dir>/Knowledge` as the vault root.

`init` finds `seed/` in the checkout it runs from (`--product-dir`,
`METISTRY_PRODUCT_DIR`, the workspace it is installed in, or the current
directory's enclosing checkout — in that order) and otherwise uses the copy
bundled in the npm package, so a stranger's `npx … init` works without a
checkout.

## Connecting the instance repo to a remote

`metistry connect-repo <url>` points the instance repo at your private
remote and leaves credentials the **reconciler** can push with
unattended — which is the whole difficulty. A push that runs from
launchd at 03:00 cannot answer a password prompt, so the token has to be
somewhere git finds by itself, and nowhere else.

```sh
metistry connect-repo https://github.com/you/metistry-instance.git                 # --auth device (default)
metistry connect-repo https://github.com/you/metistry-instance.git --auth token   # PAT on stdin
metistry connect-repo git@github.com:you/metistry-instance.git --auth ssh         # your key is the credential
metistry connect-repo <url> --instance ~/metistry-instance --force                # repoint an existing origin
```

The instance repo comes from `--instance`, else `METISTRY_INSTANCE_DIR`
(read from the checkout's `.env` like every other variable). In order:

1. **`origin`.** Refuses to repoint an existing `origin` without
   `--force` — silently moving an instance to a different repository is
   how a vault goes missing.
2. **Credentials**, before the reachability check (a private repo answers
   nothing without them). For an `https` remote on macOS:
   `credential.helper=osxkeychain` is set **at the repo level**, and the
   token is written into the login Keychain as an internet password for
   the host (`security add-internet-password -r htps`) — exactly the item
   `git-credential-osxkeychain` looks for.
   - `--auth device` runs GitHub's **device-authorization flow**: it
     prints a user code and `https://github.com/login/device`, then polls
     (honouring `authorization_pending` and `slow_down`) until you
     approve in any browser, on any machine. Needs
     `METISTRY_GITHUB_OAUTH_CLIENT_ID` — see below.
   - `--auth token` reads a PAT (scope `repo`) from **stdin**, so it is
     never in argv, never in shell history:
     `pbpaste | metistry connect-repo <url> --auth token`.
   - `--auth ssh` writes no credential; `ls-remote` in step 3 is the
     check that your key or agent works.
3. **`ls-remote origin`** — reachability, proven rather than assumed.
4. **`POST /flush`** to the reconciler when `METISTRY_RECONCILER_URL` +
   `METISTRY_BRIDGE_TOKEN_RECONCILER` are set, so the sole committer
   lands its queue before anyone else touches the tree (D5). A reconciler
   that is not running is not an error.
5. **`push -u origin <branch>`** — one push, so the remote is proven end
   to end and the branch tracks. From here the reconciler pushes on
   `METISTRY_PUSH_SCHEDULE` (`docs/ops/reconciler.md`).

Every git and `security` call is an argument array through `execFile` —
no shell anywhere, so no part of a URL is ever interpreted.

**The token is never printed, never written to `.env`, never put in the
remote URL or `.git/config`.** The tests assert that negatively: they
scan every line of output and every argument of every subprocess for the
token.

### The OAuth App you must register (one-time, by the owner)

`--auth device` uses a GitHub **OAuth App** with device flow enabled. The
product ships Folded Space Labs' app as the default (client id
`Ov23lid9DItZlts5e5GV`), so nothing needs registering: the id is public by
design — a device-flow app has no client secret — and it grants the app
nothing; you approve the `repo` scope on your own account, and the token
lands only in your Keychain. To use your own app instead, register one
(GitHub → Settings → Developer settings → OAuth Apps, tick **Enable Device
Flow**) and set `METISTRY_GITHUB_OAUTH_CLIENT_ID` in `.env`. `--auth token`
and `--auth ssh` work unchanged.

### The Keychain trade-off, on the record

The credential item is written with `security -A` (any application on
this login may read it). The alternative — trusting one binary by path —
is invalidated by every Xcode or Homebrew git update, which would turn
the reconciler's 03:00 push into a silent failure behind a GUI prompt
nobody is there to click. The item is still gated by the login keychain
being unlocked, and anyone running as this user already holds `.env`.

### Linux

There is no Keychain. `connect-repo` skips it and prints the equivalent:
point `credential.helper` at `store --file ~/.git-credentials` and put
the token in that file, `chmod 600`. Everything else (origin,
`ls-remote`, flush, push) is identical.

## Secrets: the Keychain is the store, `.env` is generated

`metistry secrets` makes the macOS login Keychain the canonical home of
every secret this install holds, under the service name
`metistry:<VAR>`; `.env` becomes a file generated from it rather than one
edited by hand (`docs/product/desktop-app-plan.md`, first-run step 4).

```sh
metistry secrets sync --to keychain               # import .env's secret lines into the Keychain
metistry secrets sync --to env                    # regenerate .env's secret lines from the Keychain
metistry secrets mint METISTRY_ASSISTANT_TOKEN    # a new random token, into both
metistry secrets list                             # names and where each lives — never a value
```

`--from` says the same thing from the other end (`--from env` ==
`--to keychain`); one of them is required, because guessing the direction
of a secret copy is how a Keychain gets overwritten with placeholders.

**What counts as a secret** is the name: anything ending `_TOKEN`,
`_PASSWORD`, `_PRIVATE`, `_SECRET` or `_KEY`; anything carrying `_TOKEN_`,
`_PASSWORD_` or `_SECRET_` mid-name (the per-bridge variables are
`METISTRY_BRIDGE_TOKEN_<NAME>`); plus
`CLAUDE_CODE_OAUTH_TOKEN` by name. So `METISTRY_VAPID_PRIVATE` is one and
`METISTRY_VAPID_PUBLIC` is not; `METISTRY_AWS_SECRET_ACCESS_KEY` is one
and `METISTRY_AWS_ACCESS_KEY_ID` is not. The names themselves come from
your `.env` plus `.env.example`, including the commented-out
declarations — that is where a not-yet-set variable is documented.

**`--to env` rewrites in place.** Only the lines that assign a secret
variable change; every comment, blank line, ordering and non-secret
assignment survives byte-for-byte (a test asserts exactly that), because
`.env` also carries hand-written configuration this command must not own.
A commented declaration (`# METISTRY_GITHUB_TOKEN=`) is uncommented in
place; a secret the file never named is appended under one marker
comment. The file is written `0600`.

**Values never travel in argv.** `security ... -w` given as the last
option prompts, and the prompt reads stdin when there is no tty, so the
value goes down the child's stdin and never appears in `ps`. `secrets
list` checks presence *without* `-w`, so there is no code path in it that
can read a value, let alone print one.

`--env-file <path>` targets a `.env` other than the checkout's, and
`METISTRY_KEYCHAIN_ACCOUNT` separates two instances on one Mac (default
account: `metistry`). On Linux `secrets` refuses and points at
`chmod 600` on `.env` or your own secret manager.

## Importing Claude Code sessions

```
metistry import-sessions [--since <date>] [--project <path>] [--limit N] [--dry-run]
```

Summarises this machine's Claude Code sessions and posts each one to
`POST /capture` as `kind: session`, where `inbox-drain` classifies it and
Needs You lists it (stash review 2026-09-09, item 2). Opt-in — nothing
runs it for you — and **summaries only, never transcripts**: full-transcript
capture is the thing that review declined.

**Host only.** It reads `~/.claude/projects/`, which the console container
has no access to; there is no containerised path for this verb.

**Deterministic.** No model is called. The summary is measured from the
transcript: session id, project path and repo, branch, start/end and
duration, user- and assistant-turn counts, first prompt (clipped to 300
chars), last assistant message (500), files touched (paths out of
`Read`/`Edit`/`Write`/notebook tool inputs, deduped, capped at 40), tool
names with call counts, models, token totals, and cost *if* the transcript
carries one. Thinking blocks and tool output never travel.

**The layout it relies on** (confirmed on this Mac against Claude Code
2.1.251, 2026-09-09):

```
~/.claude/projects/<cwd with every "/" and "." replaced by "-">/<session uuid>.jsonl
```

one JSON object per line, appended live. Fields read — all optional, all
guarded: `type` (`user` / `assistant`; everything else ignored),
`timestamp`, `cwd`, `gitBranch`, `version`, `sessionId`, `isSidechain`
(subagent turns are not the owner's turns), `isMeta`, and `message` with
`role` / `model` / `usage` / `content` blocks (`text`, `tool_use`). A
half-written last line is skipped, not fatal. These files carry **no cost
field** on this machine, so `cost` is usually absent. The directory name is
a lossy encoding (`-` for both `/` and `.`), so the cwd comes from the
records and the decoded name is only a fallback.

**Idempotency, twice over.** A ledger at
`~/.metistry/imported-sessions.json` (0600) keyed by session id + transcript
mtime makes a second run a no-op; a session that has since grown is
re-imported as a new summary. Every note also carries an
`idempotency_key` in its frontmatter — derived from the transcript's state,
not the clock — so the server can dedupe across this verb and the Claude
Code plugin's `SessionEnd` hook, which computes the same key for the same
session (`docs/ops/claude-code-plugin.md`).

**The frontmatter both doors emit:**

```yaml
kind: "session"
source: "claude-code"
title: "Claude Code session — <repo> — <YYYY-MM-DD>"
session_id: "…"
project: "/Users/…/demo"
repo: "demo"
branch: "claude/…"
started: "2026-09-08T10:00:00.000Z"
ended: "2026-09-08T10:37:00.000Z"
turns: 2
host: "studio"
captured_at: "2026-09-09T00:00:00.000Z"
idempotency_key: "claude-code:<session id>:<16 hex>"
```

**Credentials.** `METISTRY_URL` and `METISTRY_OWNER_TOKEN` come from the
environment (the checkout's `.env` is loaded first), else from the login
Keychain (`metistry:METISTRY_URL`, `metistry:METISTRY_OWNER_TOKEN`).
Neither is printed, and every error line is redacted before it is written.
`--dry-run` needs no credentials at all and reaches no network: it prints
each note it would post, then a count.

Posts run two at a time. The command exits non-zero only on a hard
failure — nothing got through when something should have, or the ledger
could not be written — so a single unreachable capture among many does not
fail the run.

## Reading a doctor report

```
name                                              kind       status  ms   remediation
------------------------------------------------  ---------  ------  ---  -----------
apple-fm                                          bridge     ok      920
eventkit                                          bridge     failed  4    eventkit rejected the token (HTTP 401) — the METISTRY_BRIDGE_TOKEN_* in .env differs …
reconciler                                        service    ok      53
console                                           service    ok      6
db                                                db         ok      16
migrations                                        db         ok      3
launchd:com.foldedspacelabs.metistry.reconciler   launchd    ok      4
compose:console                                   container  ok      0
…
24 checks: 23 ok, 0 degraded, 1 failed, 0 absent — FAILED (/Users/you/src/metistry)
```

One row per thing that can be wrong; every row is a `core` `CheckResult`
(`name`, `status`, `latency_ms`, `probe`, `remediation`, `meta`) plus a
`kind`. Statuses mean what they mean everywhere else in the product:

| status | meaning | exit code |
| --- | --- | --- |
| `ok` | validated / answered / running | |
| `degraded` | runs, but needs a hand — the remediation says what (a bridge lost a TCC grant, migrations pending, a container still starting) | still 0 |
| `absent` | not configured or not installed: a bridge with no URL in `.env`, a launchd job never bootstrapped, no docker on this machine | still 0 |
| `failed` | down, wrong token, exited, invalid manifest | **1** |

`degraded` and `absent` do not fail the run because "degrades absent" is
how optional bridges are designed to behave (a Linux box has no apple-fm).
Something you rely on that shows `absent` is still a finding — read the
column, not just the exit code.

**What is probed, generically.** Doctor knows no component by name. It
walks every `manifest.yaml` under `collectors/ routines/ packages/ apps/
targets/`, validates it with `core`'s schema, and for anything that
declares an http surface calls `GET /check` with the bearer from the same
`METISTRY_*_URL` / `METISTRY_BRIDGE_TOKEN_*` pairs the console container
and the watchdog use (`host.docker.internal` rewritten to loopback because
doctor runs on the host). The bridge's own `check()` — a *behavioral* probe
(apple-fm classifies a sentence; eventkit reads a calendar; the reconciler
reads `HEAD` and lists `Knowledge/`) — is what decides `ok` vs `degraded`,
and its remediation string is what you see. The console's `/health` and
`/api/status` are hit directly (`401` on `/api/status` is correct — a
passkey session is required — anything else non-200 is not). Then the db
(`SELECT 1`, and `schema_migrations` vs `db/migrations/*.sql`), the launchd
jobs behind every plist in `ops/launchd` (macOS), and `docker compose ps`
against the services in `docker-compose.yml`.

Add a component by adding a directory with a manifest; doctor covers it.
A new http bridge named `foo` on port 7820 is probed the moment
`METISTRY_FOO_URL` (and `METISTRY_BRIDGE_TOKEN_FOO`) exist in `.env`.

`.env` is read from the checkout for variables that are unset — the
`ops/scripts` convention — so `METISTRY_EK_URL=… metistry doctor` overrides
a line in the file for one run (handy for checking a token before writing
it down).

## Bringing an install up

`metistry up [--no-compose] [--no-launchd] [--dry-run]` takes a product
checkout with a filled-in `.env` to *running*.

**What it starts is the same in every deployment shape; where depends on
`deployment.yaml`** (`docs/ops/deployment-shapes.md`). The default is
`compose` and the steps below describe it. Under `shape: launchd` there
is no docker at all: `up` prepares a user-space Postgres (step 0), then
installs `console`, `assistant` and `db` as launchd jobs alongside the
host jobs (step 2), then creates the database, then doctor. `doctor`
reports the shape as its first row and writes every remediation for it.

0. **Postgres (launchd shape only).** Find the binaries
   (`METISTRY_PG_BIN`, a bundled `runtime/postgres/bin`, Homebrew
   `postgresql@17`), `initdb` into `<instance>/state/pg` once, write the
   managed block in `postgresql.conf`. A missing toolchain prints a
   `brew install` line and stops — `up` installs nothing itself.
1. **Containers.** `docker compose up -d --build` in the checkout — or,
   when the instance's `metistry.lock` says `source: release`,
   `docker compose pull` then `up -d --no-build` (a release install never
   builds; plan §4.16).
2. **Host jobs (macOS).** Every `ops/launchd/*.plist` is a template with
   two placeholders. `up` renders `__REPO__` → the checkout and `__NODE__`
   → the first `node` on `PATH` (the `$(which node)` symlink, deliberately
   not the realpath under `Cellar/…` that a `brew upgrade` deletes — the
   Phase 0 versioned-path lesson) into `~/Library/LaunchAgents/`, then per
   job: `launchctl bootout` (tolerated when not loaded), `bootstrap`,
   `kickstart -k`. This is exactly the by-hand recipe in each plist's
   comment, so a job installed by hand is simply re-rendered in place.
   Under the launchd shape three more plists join them: `console` and
   `assistant` carry their whole environment in an `EnvironmentVariables`
   dict rendered from `.env` (no shell, nothing interpolated) and are
   written `0600` because that dict holds secrets, and the `assistant`
   job's root process is `sandbox-exec` running
   `ops/sandbox/assistant.sb`.
3. **Doctor.** Its verdict is `up`'s exit code — `0` when nothing is
   `failed`. A step that fails stops the plan (nothing after it runs),
   doctor still runs for the diagnosis, and the failing command's exit
   code is kept.

Every subprocess is an argument array through the CLI's one exec seam —
no shell, nothing interpolated from `.env`. `--dry-run` prints each
command (and each file it would write) and runs **nothing**, doctor
included; it is the same code path with execution turned off, so what it
prints is what a real run does.

```
[dry-run] == compose
[dry-run] (cd /srv/metistry && docker compose up -d --build)
[dry-run] == launchd
[dry-run] write ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist  (from ops/launchd/…, __REPO__=/srv/metistry, __NODE__=/opt/homebrew/bin/node)
[dry-run] launchctl bootout gui/501/com.foldedspacelabs.metistry.watchdog   # ok if not loaded
[dry-run] launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.foldedspacelabs.metistry.watchdog.plist
[dry-run] launchctl kickstart -k gui/501/com.foldedspacelabs.metistry.watchdog
…
[dry-run] == doctor
[dry-run] metistry doctor
```

### Linux hosts

There is no launchd, and this has not been run on a Linux host yet, so
`up` **prints** the equivalent systemd user units — one per plist,
`EnvironmentFile=<checkout>/.env`, `ExecStart=<node> <checkout>/…/dist/main.js`,
`Restart=always` — and writes nothing. Save each to
`~/.config/systemd/user/`, then `systemctl --user daemon-reload &&
systemctl --user enable --now <unit>`. Turning that into an installed
step is a follow-up once a Linux install exists to test it against; the
TCC-bound jobs (eventkit, apple-fm) have no Linux counterpart at all
(§4.17: absent, not broken). `update` on Linux likewise tells you which
units to restart rather than restarting them.

## Updating

`metistry update [--skip-build] [--skip-migrate] [--dry-run]` moves an
install forward, in this order:

| step | git mode (the product is a checkout) | release mode (`metistry.lock`: `source: release`, or `--channel release`) |
| --- | --- | --- |
| product | `git fetch` + `git pull --ff-only` — a diverged checkout stops the update (exit code git's) | resolve the release, download its runtime pack + `checksums.txt`, **verify the sha256**, unpack to `releases/<version>/`, point `current` at it (`docs/ops/releases.md`) |
| build | `pnpm install --frozen-lockfile` + `pnpm -r build` (`--skip-build` to reuse `dist/`) | no build — the pack is compiled output |
| migrations | `db/migrations/*.sql` not yet in `schema_migrations`, in filename order, one transaction each, under `pg_advisory_lock` (below); `--skip-migrate` leaves them to doctor to report | same, read from `current` |
| restart | `docker compose up -d --build`; `launchctl kickstart -k` for each host job whose code changed | `docker compose pull` + `up -d --no-build` in `current`, with the versioned ghcr images; same kickstart rule |
| lock | write `metistry.lock` into the instance repo | same, pinned to the release actually installed |
| doctor | the verdict, as for `up` | same, against `current` |

Release-mode flags: `--version 0.2.0` installs a specific release instead
of the latest; `--rollback` flips `current` back to the previous release
without downloading anything (migrations are additive-first and are **not**
reverted); `--channel git|release` overrides the lock's `product.source`
for one run. `metistry init --channel release` writes `source: release` in
the first place. A checksum mismatch aborts before anything restarts and
leaves `current` and the lock untouched. Full runbook, layout and secrets:
**`docs/ops/releases.md`**.

Resolving a release needs to read GitHub's Releases API; on a **private**
repo, `METISTRY_GITHUB_TOKEN` must be a fine-grained PAT with **Contents:
read** on that repo — Issues/Pull requests/Metadata (what the github-state
collector needs) is not enough, and a token missing it gets a 403 that
looks like rate limiting but isn't (the error message says which one it
is, using `x-ratelimit-remaining`). Without that scope, `metistry update`
falls back to the `gh` CLI automatically when it is on PATH and logged in
(`gh auth login`) — `gh`'s own credential is independent of
`METISTRY_GITHUB_TOKEN`, so it can resolve and download the release even
when the PAT cannot.

Downloading an asset is a separate call from resolving the release, and on
a private repo it needs a separate fix: a release's `browser_download_url`
only works with a browser session, so it 404s for a token even when
resolving the release worked fine. With `METISTRY_GITHUB_TOKEN` configured,
`metistry update` downloads every asset (the runtime pack, the runtime-deps
pack, and their shared `checksums.txt`) through the authenticated API
instead — `GET /repos/<repo>/releases/assets/<id>` with
`Accept: application/octet-stream` — following the redirect to GitHub's
signed, short-lived S3 URL without resending the token. With no token
configured (a public repo), `browser_download_url` is used directly. Either
path falls back to `gh release download` on a 404, the same way an
unauthorised *resolve* already does.

**What "changed" means.** Before the build, `update` hashes the code each
launchd job executes — read from the plist itself (`__REPO__/<path>` in
`ProgramArguments`): `apps/watchdog/dist` for the watchdog,
`apps/reconciler/dist` for the reconciler, `packages/mcp-*/dist` for the
node bridges, the bare binary for the EventKit helper. After the build it
hashes again and kickstarts only the jobs whose digest moved. A change to
a `src/` file that produced no `dist/` change restarts nothing; a rebuilt
helper binary restarts the helper. Containers are always `up -d --build`
— compose's own cache decides whether anything rebuilds.

**Migrations under the advisory lock.** The runner is
`ops/scripts/migrate.sh` ported to the CLI, and the two share one
constant: `pg_advisory_lock(1296389203)` (`MIGRATION_LOCK_KEY` in
`packages/cli/src/migrate.ts`, `LOCK_KEY` in the script; a test greps
both). Whoever holds the lock creates `schema_migrations` if needed,
applies what is pending — each file plus its `INSERT` in one
transaction — and unlocks; a concurrent runner (a second `update`, or
`pnpm db:migrate` at the same moment) blocks on the lock, then finds every
file recorded and applies nothing. A failing file is rolled back whole,
records no row, stops the run (nothing after it is applied, `update`
exits 1 before touching the containers), and the lock is released with
the session. `migrate.sh` stays the zero-dependency path and now runs the
whole sequence in **one** psql session (advisory locks are
session-scoped) — `\gset`/`\if` per file, `ON_ERROR_STOP` ending the
session on error.

**Writing the lock.** `metistry.lock` lives in the *instance* repo, and
the reconciler is that repo's sole committer (`docs/ops/reconciler.md`,
D5) — so `update` writes it as a bridge call, never as a file:
`POST $METISTRY_RECONCILER_URL/vault/write` with
`intent: { principal: "user", message: "metistry update → <version>" }`.
`metistry.lock` is a §4.7 protected path; `user` is the one principal
allowed to write it, and the commit lands on the reconciler's next flush.
A bridge that is configured but not answering, or that refuses, fails
the update (exit 1) with the reason — the lock is then simply not moved;
rerun after fixing. Only when **no** bridge is configured
(`METISTRY_RECONCILER_URL` unset) *and* `METISTRY_INSTANCE_DIR` is a
local directory does `update` write the file directly — and even then it
first checks that no reconciler launchd job is running, because a
running reconciler with no URL in `.env` is a misconfiguration to fix,
not to write around. (A reconciler installed later sweeps that direct
write into a `user` commit like any other out-of-band edit.) No instance
dir at all → nothing is written, and `update` says so.

`--dry-run` prints the whole plan — including the migration step as one
line and the kickstarts annotated with the path each one depends on —
and opens no db session, calls no bridge, runs no doctor.

## `metistry.lock`

One shape, written by `init` and moved by `update`; YAML, in the instance
repo's root:

```yaml
# metistry.lock — the product release this instance runs (plan §4.16).
# `metistry update` moves the pin; edit by hand only to roll back.
product:
  version: "0.0.1"          # the cli package's version — the release this instance runs
  commit: "83eea07…"        # product commit at the time of writing ("unknown" without a checkout)
  source: git               # git = a checkout `update` fast-forwards; release = pinned published artifacts
updated_at: "2026-09-07T15:00:00.000Z"
migrations_applied:         # every db/migrations file in schema_migrations when this was written
  - "0001_init.sql"
  - "0002_review_decisions.sql"
```

`init` writes `migrations_applied: []` (there is no database yet) and the
checkout's `HEAD` when run from inside one. `product.source` is what
switches `up`/`update` between building from the checkout and pulling a
release; it is `git` until releases exist. The parser is strict — a
malformed lock is an error, not a guess — with one exception: the shape
an earlier `metistry init` wrote (`version:` + `created:`) is read as a
`git` pin and rewritten in the current shape on the next `update`.

## Maintenance

The cadence is plan §5 "Maintenance cadence"; the CLI is how the
operator-facing parts of it happen:

- **On every product change:** `metistry update` (or `update --dry-run`
  first). Pull, build, migrate, restart what changed, pin, doctor — one
  command, idempotent, safe to rerun.
- **After changing `deployment.yaml`:** `metistry up`, having stopped
  what the old shape was running and taken a dump — the data does not
  move between shapes (`docs/ops/deployment-shapes.md`).
- **After a reboot, a Docker restart, or a `brew upgrade node`:**
  `metistry up`. It re-renders the launchd jobs (the node path is the
  stable symlink, so a node upgrade usually needs nothing — but `up` is
  the fix when it does), restarts what is not running, and reports.
- **Weekly:** `metistry doctor` alongside the review routine; a `degraded`
  row is a finding even at exit 0 (a bridge lost a TCC grant, a push
  failed, migrations pending because someone ran `git pull` without
  `update`). The two deliberately use different silence thresholds: the
  watchdog's `silent-collector` probe pages at `METISTRY_WATCHDOG_SILENCE_FACTOR`
  (default 3×) a component's own manifest interval so it catches a stall
  fast, while the weekly review's System section flags anything quiet for
  a flat 7 days, matching its own weekly cadence.
- **Quarterly:** the restore test (`ops/scripts/restore-test.sh`) —
  `metistry.lock`'s `migrations_applied` says which schema the dump was
  taken under.
- **On drift:** if `up --dry-run` shows a plist that differs from what
  is installed, or `doctor` shows `absent` for a job you rely on, the
  checkout and the machine have drifted — `up` reconciles them.

## Not yet

`metistry enroll` (§4.2 passkey enrollment from the host) and `metistry
create <bridge|collector|…>` (§5 extension scaffolds) are not started.
`connect-repo --auth device` has been exercised only against an injected
fetch: the live GitHub round trip waits on the OAuth App being
registered.
Release mode is complete end to end (`docs/ops/releases.md`) but has not
yet consumed a real published release — the first `v*` tag is its first
live run. The CLI ships no `manifest.yaml`: `core`'s schema has no type
for a command-line tool and inventing one is worse than the gap.
