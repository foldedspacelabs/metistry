# Contributing to Metistry

Thank you for looking. Metistry is maintained by one person over years, so
the rules below are about keeping every change reviewable a year from now.
`CLAUDE.md` holds the full development conventions — its ten invariants are
decisions, not preferences, and a PR that breaks one is a conversation to
have in an issue first.

## Before you start

- **Open an issue first** for anything beyond a small fix, so the approach is
  agreed before the code is written.
- **No new dependency without an issue first.** Every dependency is a
  maintenance obligation. Pre-approved: `@modelcontextprotocol/sdk`, `pg`,
  `zod`, `yaml`, `chokidar`, `web-push`, `@simplewebauthn/*` and dev tooling
  (`typescript`, `vitest`, `changesets`). Anything else is decided in the
  issue.
- **Enforce at the tool, never by prompting.** If a change adds a rule, the
  code must be incapable of breaking it; a sentence in a prompt is not a
  control.

## The pull request flow

1. Fork, then branch from `main` — one branch and one PR per logical change.
   Small PRs are reviewed quickly; large ones wait.
2. **Small commits with real messages**, one logical change each.
3. **Tests with the change.** A new route, action or CLI verb ships its
   misuse tests — no credential gets 401, the wrong principal gets 403 — and
   a refusal is a code path with a test.
4. **A changeset** for any change to a package (`pnpm changeset`), and one
   fragment under `docs/product/record/` for a change with product
   significance (`docs/product/record/README.md`).
5. **Docs in the same PR**: a changed route or action updates
   `docs/ops/client-api.md`; a changed CLI verb updates `docs/ops/cli.md`.
6. **Migrations are additive-first** — new tables and columns, each with a
   rollback note. A destructive migration needs an explicit decision.
7. Open the PR with the template filled in: what changed, the tests, and the
   commands you ran with their real output.

## Running the checks locally

```sh
pnpm install
pnpm -r build
pnpm typecheck
pnpm test                      # makes a scratch database first (ops/scripts/test-db.sh)
swift test --package-path apps/macos   # when you touch the Mac app
```

`pnpm test` needs a local Postgres 17 with pgvector (`pnpm db:up` starts one in
Docker) and only ever uses a `metistry_test_*` scratch database; a test opens
Postgres only through `testDb()` and never reads a running install's
environment (`docs/ops/testing.md`).

**CI runs on Linux and on a Mac.** The Linux job runs the checks under
`ops/scripts/` (path casing, migration numbers, test-database use, tool
surface, the product record, design tokens), the build, the typecheck,
migrations applied twice, the full test suite and the client-fixture check.
The macOS job builds and tests the Swift app when anything it compiles has
changed. A PR merges green.

## Conventions that CI and review hold you to

- **Casing.** The instance's vault is TitleCase; `.metistry/` and this repo
  are lowercase. macOS forgives a mismatch; Linux does not.
- **The assistant is never named in code.** Its name lives only in an
  instance's `identity.yaml`; code, paths, tables and env vars say
  `assistant`.
- **No absolute paths, no secrets.** Configuration comes from the
  environment; tests and docs use fictional values.

## Licence

Metistry is Apache-2.0. By contributing, you agree that your contribution is
licensed under the same terms (section 5 of `LICENSE`).
