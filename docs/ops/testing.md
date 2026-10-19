# Testing

**Tests never see the operator's instance.** That is the whole rule; the rest
of this file is how it is enforced, because "be careful" in a prompt is not a
control (CLAUDE.md) and neither is "be careful" in a comment.

## Why the rule exists

A product checkout's `.env` is a **running install's environment**. It carries
`METISTRY_INSTANCE_DIR`, `METISTRY_RECONCILER_URL` and
`METISTRY_BRIDGE_TOKEN_RECONCILER`. A test that loads that file and then calls
a CLI verb is not driving a fixture, it is driving the live system — and
`--instance <temp dir>` does not save it, because `writeProtected` sends the
write to the bridge named in the environment and the reconciler commits into
whatever instance repo *it* serves.

That is not a hypothetical. On 2026-09-15 a `metistry compute providers add`
case in `packages/cli`, whose `--instance` was a `mkdtemp` directory, reached
the running reconciler and had it commit `.metistry/compute.yaml` into the operator's
private instance repo.

## What a test may inherit from the environment

Exactly two things, and both are about reaching the scratch database:

| variable | why |
| --- | --- |
| `METISTRY_DB_*` | host, port, user, password for the local Postgres |
| `METISTRY_TEST_DB_NAME` | which scratch database this checkout owns |

Everything else matching `METISTRY_*` is deleted from `process.env` before the
first test runs. `METISTRY_INSTANCE_DIR` and `METISTRY_PRODUCT_DIR` are
tolerated **only** while they point inside `os.tmpdir()` — the CLI writes the
resolved instance directory back into the environment, so a legitimate
`--instance <temp dir>` shows up there.

## How to load it

`@foldedspacelabs/metistry-core/test-env` — never a hand-rolled dotenv loop:

```ts
import { loadTestEnv } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

describe.skipIf(!hasDb)("… (real db)", () => { /* … */ });
```

`loadTestEnv` scrubs first and loads second, so it is safe to call from a file
that inherited a polluted environment. It never overrides a value already set,
which is how CI passes `METISTRY_DB_PASSWORD` and `METISTRY_TEST_DB_NAME` in
with no file on disk at all.

`hasDb` is true only when **both** `METISTRY_DB_PASSWORD` is set **and**
`METISTRY_TEST_DB_NAME` looks like a scratch name (`metistry_test_` followed
by lowercase letters, digits and underscores) — a password alone, inherited
from a shell whose install has one but which never exported the scratch name,
is not enough. Gating on the password alone would make a bare `vitest` run
skipIf(false) into every DB suite and fail it at `testDb()`'s refusal instead
of skipping; gating on both turns the missing name into a clean skip.

## How to open the database

**A test's only way into Postgres is `testDb()`.** Never `new pg.Pool(…)`,
never `new pg.Client(…)`, never a product opener handed `process.env`:

```ts
import pg from "pg";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));

describe.skipIf(!hasDb)("… (real db)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await testDb(pg.Pool); // or testDb(pg.Pool, { max: 10 })
  });
  afterAll(async () => pool.end());
});
```

Why: until 2026-09-26 every suite built its own pool — most without a port,
all with `METISTRY_TEST_DB_NAME ?? "metistry_test"`. On a Mac whose live
install's Postgres listens on 5432, a shell with `METISTRY_DB_PASSWORD` set and
nothing else sent a suite straight at the install. It failed on
authentication; nothing was touched; that was luck.

`testDb(pg.Pool)` **refuses — throws, before a socket opens —** when:

- `METISTRY_TEST_DB_NAME` is unset. There is no default name any more: falling
  back is how a suite ends up somewhere it did not choose. `pnpm test` sets it
  per checkout; to run vitest directly, export it (and build it first with
  `ops/scripts/test-db.sh`);
- the name is not `metistry_test_` followed by lowercase letters, digits and
  underscores (what `pnpm test` derives and `test-db.sh` creates), or is longer
  than the 63 characters Postgres keeps;
- the name is one an install on this machine is configured with — any
  `METISTRY_DB_NAME` in the checkout's `.env`, in whatever `.env`
  `loadTestEnv` read, or in the install's `.metistry/state/.env` under any
  `METISTRY_INSTANCE_DIR` those name or the environment held before the scrub;
- `METISTRY_DB_PASSWORD` is unset, or `METISTRY_DB_PORT` is not a port.

It always connects with host, port, user and password from `METISTRY_DB_*`
(defaults `127.0.0.1`, `5432`, `metistry`, the same as `test-db.sh`) — never
anything the driver would pick up from `PG*` variables — and **after
connecting it asks `SELECT current_database()`** and ends the pool rather than
hand it over if the answer is not the scratch name. Core does not depend on
`pg`: the caller passes the constructor in.

Two more, for the tests that need them:

- **`testDbEnv()`** — the same connection as `METISTRY_DB_*` variables, for a
  test whose subject is product code that reads them (`openDbFromEnv`,
  `openMigrationSession`). Pass it instead of `process.env`, then
  **`assertScratchDb(opened, name)`** on what that code opened.
- **`recreateScratchDb(pg.Pool, { suffix })` / `dropScratchDb`** — a whole
  database of the suite's own, `<METISTRY_TEST_DB_NAME><suffix>` (the migration
  runner's suite uses `_mig`). The maintenance connection to `postgres` never
  leaves the helper, and a suffix is required, so the shared scratch database
  is never one suite's to drop. `{ suffix, template }` makes the new database
  a `TEMPLATE` copy of `template`, itself held to the same rules — how the
  workspace runner gives each package a migrated copy of the shared one.

`node ops/scripts/check-test-db.mjs` (CI) holds every test file to this: it
fails on a `pg` `Pool`/`Client` constructed under any import name, and on
`openDbFromEnv` / `openMigrationSession` / `makePool` called with anything but
`{}` or `testDbEnv(…)`. The refusals are tested with a fake env and a fake
pool, no database, in `packages/core/test/test-env.test.ts`.

## The guard

`packages/cli` runs `test/setup.ts` for every file (that is the only reason the
package has a `vitest.config.ts`). It scrubs before each test, pins
`METISTRY_PRODUCT_DIR` at an empty temp directory so a `main()` call with no
`--product-dir` cannot resolve the checkout it is running inside, and calls
`assertTestEnvIsolated()` after each test. The assertion fails the run the
moment a verb resolves a path outside `os.tmpdir()` or a non-allowlisted
`METISTRY_*` appears — which is what a test passing the real checkout as
`--product-dir` looks like. `packages/cli/test/isolation.test.ts` keeps the
guard honest.

**Never pass the real checkout as `--product-dir`.** If a test needs a seed
directory, copy `seed/` into a temp dir and point at that.

## The database

`pnpm test` runs `ops/scripts/test-db.sh` first, which **drops and recreates**
`METISTRY_TEST_DB_NAME` and applies every migration. The default is derived
from the checkout's directory name, so parallel worktrees never drop each
other's database.

### One database per package

The suites then run through `ops/scripts/test-workspace.mjs`, not `pnpm -r run
test` — and **each package gets a scratch database of its own**. For every
workspace package with a `test` script the runner creates
`<METISTRY_TEST_DB_NAME>_<package>` (`…_core`, `…_console`, `…_mcp_brain`: the
unscoped name, `metistry-` dropped, lowercase) as a `TEMPLATE` copy of the
migrated shared database — schema and seed rows, no second run of the
migrations, none of a sibling's leftovers — runs the package's `test` script
with `METISTRY_TEST_DB_NAME` pointed at the copy, and drops the copy after.
Databases are made and dropped only through core's `recreateScratchDb` /
`dropScratchDb` (its `template` option is this), so every name is held to the
rules `testDb()` applies, and the base is cut back when a long checkout name
plus a long package name would pass Postgres's 63 characters — a visible cut
rather than the server's silent one. Every scratch database — the shared one
`test-db.sh` makes and each copy — is `ALTER DATABASE … SET timezone = 'UTC'`,
so a suite sees the same clock as CI whatever zone the server runs in: a
"30 days out" is 30 × 24 hours on a Mac in November too.

Why: until 2026-10-18 the root script was `pnpm -r --workspace-concurrency=1
run test` against the one database, and a `--no-file-parallelism` appended to
that line never reached vitest. Every suite owned its rows by marker (below),
and W4 still saw the same cross-suite flakes again — morning-brief, tasks'
`external_ref`, reply-review's FK, linear-order, push-needs-you — because
suites in different packages shared one row space, and a marker protects only
the rows a suite remembers to mark. Per-suite ownership stays worthwhile
(two files in one package still share that package's copy); this removes the
space packages collided in.

Packages run one at a time by default, as `--workspace-concurrency=1` did.
With their databases apart they may run side by side:

```sh
pnpm test                                            # test-db.sh, then every package
pnpm test -- --concurrency 2                         # two packages at once, two databases
pnpm test -- --only tasks --only artifacts           # a subset (name, unscoped name or directory)
```

The runner refuses to start without `METISTRY_TEST_DB_NAME` — there is no
default base to copy — and reads the checkout's `.env` through `loadTestEnv`,
so its children inherit the same two things a test may (above) and nothing
else. A direct `vitest run` in one package is unchanged: it uses the shared
database `test-db.sh` built, so what the next section says about re-runs
still holds for it.

### Which database am I about to touch

`ops/scripts/migrate.sh` and `ops/scripts/test-db.sh` both resolve a target
database from layered `.env` sourcing, and a 2026-09-19 incident showed that
resolution failing quietly: a shell that had `METISTRY_TEST_DB_NAME` set but
not `METISTRY_DB_NAME` fell through to the built-in default, which happened
to be the live `metistry` database, and `migrate.sh` applied a migration
there. Both scripts now refuse rather than guess:

- **`migrate.sh`** refuses (exit 2) when `METISTRY_TEST_DB_NAME` is set in the
  environment and the resolved target is a different name — a shell that has
  a scratch name set is a test shell, and must never touch anything else by
  omission. It also refuses when the target's value came from the **install's
  own** `.metistry/state/.env`, unless run with `--install` — a human operator
  confirming that yes, this really is the machine to run it on (e.g. the
  manual step in `docs/ops/migrate-compose-to-launchd.md`). `metistry update`
  never shells out to this script at all — it re-implements the same runner
  in `packages/cli/src/migrate.ts` against the `pg` driver directly — so
  `--install` has nothing to do with that path.
- **`test-db.sh`** refuses outright, with no override flag, if
  `METISTRY_TEST_DB_NAME` would resolve to the same name the install's own
  `.metistry/state/.env` configures — there is no legitimate reason for a
  script whose entire job is `DROP DATABASE` to be pointed at one.

The test suites themselves resolve their database through `testDb()`, which
applies the same two refusals from inside the process — scratch name set,
never an install's — plus a prefix rule and a `current_database()` check
(see "How to open the database" above).

Either script takes `--print-target`, which resolves the target and prints
which database it is, where that name came from, and whether the run would
be refused — without connecting to Postgres at all. Run it first if you are
ever unsure what a shell would do:

```sh
$ ops/scripts/migrate.sh --print-target
target database: metistry_test_guard
source: environment
would run: yes
```

Integration suites must therefore survive **both** a freshly created database
(what `pnpm test` now hands every package) and a re-run against one they have
already written to (`pnpm test:unit`, or vitest invoked directly — either with
`METISTRY_TEST_DB_NAME` exported, since `testDb()` has no default). Two ways
to get there:

- **Scope by marker** — every row carries an `itest-…` id/project/component and
  the suite deletes its own in `beforeAll` and `afterAll`. This is the default
  and what most suites do.
- **Shadow the table** — for a subject that reads a whole table with no filter
  to put a marker in (`pending_count`, `task_ageing`, Needs You's notifier, the
  weekly review's rankings), where emptying the table would take rows from a
  sibling file and counting it would count the sibling's. The suite checks out
  one connection and gives it `TEMP` copies of the tables (`LIKE …
  INCLUDING ALL`: columns, defaults, checks, indexes — no foreign keys, no
  triggers); an unqualified table name on that connection is the shadow, the
  subject runs on that connection, and the shared tables are never read,
  written or deleted. `apps/console/test/private-tables.ts` is the helper;
  `routines/test/weekly-review.integration.test.ts` shadows the eight tables
  the review reads inline, since the review is a whole-database aggregate
  that *ranks* — a sibling's rows do not add noise, they push the fixture off
  the end of a top-10 list. A bare `DELETE FROM <table>` in a test is a bug
  (X-25).

**Nothing truncates.** Until X-25 the weekly review's suite answered the
ranking problem by `TRUNCATE … RESTART IDENTITY CASCADE` on the eight tables,
behind a `current_database()` check and a `lock_timeout` retry so the reset
never became a deadlock with a sibling's statement. The deadlock was the
smaller problem. Under file parallelism the truncate emptied the tables out
from under every other file in the package mid-test — reply-review's
`reply_feedback` insert found its `outbound_messages` row gone (the
`reply_feedback_outbound_message_id_fkey` violation), recording-retention's
proposals vanished before its pass counted them, morning-brief's and
plan-tomorrow's `runs` rows disappeared between a write and the read that
asserted on them (the "known flakes" this package carried through W3 and W4) —
and while every package still shared one database, the same reset reached the
console's suites too. A shadow has none of those effects, so there is no
longer a suite that empties a shared table, and a new one would be a bug: a
test never decides at runtime that some database is probably fine to empty.

Assertions follow the same rule as cleanup: **count your own rows**. A
`SELECT count(*) FROM inbox` taken before and after an action is one sibling
insert away from failing, and proves nothing about this suite;
`… WHERE source_agent = <this suite's agent>` says the same thing and cannot
race.

### Recording the Mac app's client-API fixtures

`apps/console/scripts/record-client-fixtures.mjs` is not a test, and it keeps
the same rules as one: it opens Postgres only through `testDb(pg.Pool)` after
`loadTestEnv` has scrubbed the environment, its instance is `metistry init`
into an `os.tmpdir()` directory run with an empty environment, and the console
it records from is `makeServer` in-process with every outbound call faked. It
writes one JSON per client-API route into `apps/macos/tests/kit/fixtures/`
(`docs/ops/mac-app.md`, "The store interface"). Run it on a fresh scratch
database, after `pnpm -r build`:

```sh
METISTRY_TEST_DB_NAME=metistry_test_<you> METISTRY_DB_NAME=metistry_test_<you> ops/scripts/test-db.sh
node apps/console/scripts/record-client-fixtures.mjs            # every served route
node apps/console/scripts/record-client-fixtures.mjs --check    # in memory; exit 1 where a shape moved
```

A ticket that serves a route frozen ahead of it adds the route's request to
the script's `REQUESTS` and re-records with `--only "<METHOD> <path>"`; the
script refuses to replace a `contract` fixture whose shape its recording does
not match unless `--accept` is given, and the PR says why.

The script empties every table of the scratch database (all but
`schema_migrations`) and restarts its identities before it seeds, so it gives
the same answer on a database an earlier run used: `--check` straight after a
record works without a second `test-db.sh`. It reaches only the `metistry_test_*`
database `testDb()` accepts.

CI runs `--check` in the `checks` job after the tests, on a fresh scratch
database of its own, so a PR that moves a served shape without re-recording
its fixture fails there (W2 housekeeping).

## Checks that are not tests

Some rules are easier to enforce over the whole tree than to remember in each
package. Those live in `ops/scripts/`, run in CI before (or just after) the
build, and have their own unit tests under `ops/scripts/test/`
(`node --test 'ops/scripts/test/*.test.mjs'`, which CI runs as one step).

`node ops/scripts/check-tool-surface.mjs` is the tool-surface budget. The
manifest schema states the rule — `discovery: lazy` "is for bridges past >20
tools / >5k definition tokens" (`packages/core/src/manifest.ts`) — but it was
enforced only by `packages/mcp-brain`'s own test, on itself. The script checks
every bridge manifest under `apps/` and `packages/`, and prints the numbers on
every run so the headroom is read rather than inferred:

```
tool surface (budget: >20 tools / >5000 definition tokens — packages/core/src/manifest.ts)

  bridge    tools         ≈tokens  headroom to the line
  --------  ------------  -------  ------------------------------------------
  apple-fm  2 (declared)  n/a      18 tools
  brain     26            4224     776 tokens, 6 tools OVER (acknowledged 26)
  eventkit  4 (declared)  n/a      16 tools
```

- **How a bridge is measured.** It exports `toolSurface()` from its package
  entry, the same way every bridge exports `check()` so `metistry doctor` can
  be generic. `packages/mcp-brain/src/surface.ts` is the reference: it stands
  up the real server and reads a real `tools/list`, so the number is
  production's definitions and not a snapshot. A bridge without that export
  (`eventkit` and `apple-fm` are REST surfaces, never listed to a model) is
  reported **declared-only** — the manifest's `exposes:` count is still
  checked, its token cost prints `n/a` rather than a guess.
- **It runs after `pnpm -r build`**, since it imports what each bridge ships.
  An unbuilt bridge is an error naming the command that fixes it, not a pass:
  a check that quietly degrades to "nothing to measure" is not a check.
- **Tokens are the budget; the tool count is a ratchet.** An eager bridge past
  5k definition tokens fails. Past 20 tools it fails too *unless* the number is
  recorded in `COUNT_ACKNOWLEDGED` in the script — `brain` sits at 26 there,
  which is the "noted, not acted on" its manifest has carried. So a bridge may
  stay where it was acknowledged, and the **next** tool fails the check until
  somebody trims the surface, switches the manifest to `discovery: lazy`, or
  moves the ceiling with a reason. That has happened exactly once: 25 → 26 on
  2026-09-19 for `request_access`, with the reasoning written beside the
  number rather than in a commit message. `discovery: lazy` has already made that
  decision, so the budget does not bind on it.
- `--json` prints the rows and the findings instead of the table.
