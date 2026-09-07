# `metistry` — init and doctor

`packages/cli` (`@foldedspacelabs/metistry-cli`, plan §4.16: `init | doctor
| up | update`) is the operator's front door. Two commands are real today;
`up` and `update` print what they will do and exit 0.

```sh
# from anywhere, no checkout needed for init
npx @foldedspacelabs/metistry-cli init ~/metistry-instance --name "Athena"

# inside a checkout after `pnpm -r build`
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js doctor --json
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
  metistry.lock             version + created date; `metistry update` moves it
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

Then, as before: `pnpm -r build`, install the reconciler launchd job
(`docs/ops/reconciler.md`), `docker compose up -d console`, and
`metistry doctor` to confirm. Add a private remote to the instance repo
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

## Not yet

`metistry up` and `metistry update` (plan §4.16: pull the pinned release,
migrate idempotently under an advisory lock, start compose + launchd; move
the pin) are stubs. `metistry enroll` (§4.2 passkey enrollment from the
host) and `metistry create <bridge|collector|…>` (§5 extension scaffolds)
are not started. The CLI ships no `manifest.yaml`: `core`'s schema has no
type for a command-line tool and inventing one is worse than the gap.
