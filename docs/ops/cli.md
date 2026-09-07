# `metistry` — init, doctor, up, update

`packages/cli` (`@foldedspacelabs/metistry-cli`, plan §4.16: `init | doctor
| up | update`) is the operator's front door. All four are real.

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
doctor (below). Add a private remote to the instance repo
whenever you like (`git -C <dir> remote add origin …`); the reconciler
pushes on `METISTRY_PUSH_SCHEDULE` and never blocks on it. Point Obsidian
at `<dir>/Knowledge` as the vault root.

`init` finds `seed/` in the checkout it runs from (`--product-dir`,
`METISTRY_PRODUCT_DIR`, the workspace it is installed in, or the current
directory's enclosing checkout — in that order) and otherwise uses the copy
bundled in the npm package, so a stranger's `npx … init` works without a
checkout.

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
checkout with a filled-in `.env` to *running*:

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
- **After a reboot, a Docker restart, or a `brew upgrade node`:**
  `metistry up`. It re-renders the launchd jobs (the node path is the
  stable symlink, so a node upgrade usually needs nothing — but `up` is
  the fix when it does), restarts what is not running, and reports.
- **Weekly:** `metistry doctor` alongside the review routine; a `degraded`
  row is a finding even at exit 0 (a bridge lost a TCC grant, a push
  failed, migrations pending because someone ran `git pull` without
  `update`).
- **Quarterly:** the restore test (`ops/scripts/restore-test.sh`) —
  `metistry.lock`'s `migrations_applied` says which schema the dump was
  taken under.
- **On drift:** if `up --dry-run` shows a plist that differs from what
  is installed, or `doctor` shows `absent` for a job you rely on, the
  checkout and the machine have drifted — `up` reconciles them.

## Not yet

`metistry enroll` (§4.2 passkey enrollment from the host) and `metistry
create <bridge|collector|…>` (§5 extension scaffolds) are not started.
Release mode is complete end to end (`docs/ops/releases.md`) but has not
yet consumed a real published release — the first `v*` tag is its first
live run. The CLI ships no `manifest.yaml`: `core`'s schema has no type
for a command-line tool and inventing one is worse than the gap.
