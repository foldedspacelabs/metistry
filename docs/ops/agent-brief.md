# Agent brief — the rules for every ticket

You are implementing **one ticket** of the approved spec
(`docs/product/design-build-plan.md`). Your ticket is a file under
`docs/product/tickets/<track>/<id>.md`. Read, in this order: **this brief, your
ticket, and the §2 sections your ticket names** — not the whole plan.

## Where you work

- **A worktree and a branch per ticket**, from `origin/main`:
  `git worktree add ../metistry-<id> -b claude/<id>-<slug> origin/main` (use your
  ticket id in lowercase, e.g. `t2-4`). One ticket, one branch, one PR. **Never
  commit to `main`.**
- **Never the live instance.** Do not run a `metistry` verb against the owner's
  instance, do not read its `.metistry/state/.env`, do not connect to its
  console, reconciler or database, and do not use its ports. If a step seems to
  need it, stop and say so.
- **Tests use the scratch database only**: `ops/scripts/test-db.sh` makes it, and a
  test may inherit exactly two things from the environment — `METISTRY_DB_*` and
  `METISTRY_TEST_DB_NAME` — through `loadTestEnv` (`docs/ops/testing.md`). A
  temporary instance lives under `os.tmpdir()`.
  A test opens Postgres **only** with `await testDb(pg.Pool)` from
  `@foldedspacelabs/metistry-core/test-env` — never `new pg.Pool(…)`; CI's
  `check-test-db.mjs` fails the PR otherwise.
- **A scratch instance** for anything end to end: `metistry init <tmp dir>` with
  `--namespace`, never a real one.
- **GitHub CLI** as `env -u GH_TOKEN gh …`.

## What you build to

`CLAUDE.md`'s ten invariants hold everywhere; the one over all of them is
**enforce at the tool, never by prompting**. The plan's universal acceptance:

- **U1** CI green, including the job that applies migrations twice.
- **U2** Every new door ships its misuse tests: 401 with no credential, 403 for an
  agent bearer, 403 for the capture owner token, the local owner token reaches
  it — plus the ticket's own (bold in its Tests line).
- **U3** A refusal is a code path with a test, never a sentence in a prompt.
- **U4** Migrations additive, numbered from the reserved table (plan §2.9), each
  with a durability comment and a rollback note.
- **U5** No new dependency. Pre-approved: `@modelcontextprotocol/sdk`, `pg`,
  `zod`, `yaml`, `chokidar`, `web-push`, `@simplewebauthn/*`, dev tooling.
  Anything else: stop and ask.
- **U6** Casing: the vault is TitleCase; `.metistry/` and the repo are lowercase.
- **U7** A route, action or CLI verb that changes updates `docs/ops/client-api.md`
  or `docs/ops/cli.md` in the same PR.
- **U8** A package change carries a changeset; a change with product significance
  carries one fragment under `docs/product/record/`.
- **U9** A view meets plan §2.18 (keyboard, VoiceOver, Reduce Motion, the largest
  text size) and its screen's state row, built first against the recorded
  fixtures.
- **U10** If the spec is wrong, stop and report the contradiction — do not route
  around it.

**Words.** The assistant's name lives only in `identity.yaml`; code says
`assistant` and labels template the configured name — a hardcoded name is a bug.
Public text never describes the owner's employment; say *second instance*.

## How you finish

- **Small commits with real messages**, each ending
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **The PR body** says what changed, the tests (misuse tests named), the
  acceptance evidence (commands and their real output), and anything you noticed
  outside the ticket — then ends with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Your ticket's status**: in your PR, set `status: in-review` and `pr: <number>`
  in your ticket file (those two lines are the only ones you edit there). If you
  cannot finish, set `status: blocked` and say why in the PR.
- **Do not merge.** The coordinator merges after CI and a review agent.
- **Scope ceiling:** your ticket's files. Report anything important outside it;
  do not act on it.
