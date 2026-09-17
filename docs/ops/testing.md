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
