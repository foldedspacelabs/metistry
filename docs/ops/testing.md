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
which is how CI passes `METISTRY_DB_PASSWORD` in with no file on disk at all.

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

Integration suites must therefore survive **both** a freshly created database
and a re-run against one they have already written to (`pnpm test:unit`, or
vitest invoked directly). Two ways to get there:

- **Scope by marker** — every row carries an `itest-…` id/project/component and
  the suite deletes its own in `beforeAll` and `afterAll`. This is the default
  and what most suites do.
- **Take the database** — only for a suite whose subject is a whole-database
  aggregate, where a sibling's leftovers do not merely add noise but change the
  answer. `routines/test/weekly-review.integration.test.ts` is the one such
  suite: the review *ranks* agents and projects, so another suite's `runs` rows
  push the fixture off the end of a top-10 list. It truncates the eight tables
  the review reads, and refuses to do it unless `current_database()` really is
  the scratch one.

A suite that truncates must carry that refusal. There is no version of this
where a test decides at runtime that some database is probably fine to empty.

It must also never **wait** to truncate. TRUNCATE takes ACCESS EXCLUSIVE on
every table it names, left to right; a sibling file's `DELETE FROM work …`
takes `work` and then `proposals` (the 0018 foreign key's referential check),
and a sibling's `INSERT INTO proposals …` takes the same two the other way
round. No ordering of the list escapes that: some sibling always holds the
second lock and wants the first, Postgres calls it a deadlock and kills one of
the two — as readily the innocent sibling as the reset. So the reset runs under
`SET LOCAL lock_timeout`, well inside the server's 1s `deadlock_timeout`, and
retries. The cycle is then never around long enough to *be* a deadlock: the
reset lets go, the sibling's statement finishes, the next attempt walks
through.

Assertions follow the same rule as cleanup: **count your own rows**. A
`SELECT count(*) FROM inbox` taken before and after an action is one sibling
insert away from failing, and proves nothing about this suite;
`… WHERE source_agent = <this suite's agent>` says the same thing and cannot
race.

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
