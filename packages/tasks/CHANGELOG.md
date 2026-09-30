# @foldedspacelabs/metistry-tasks

## 0.16.0

### Patch Changes

- Updated dependencies [5a6ad9e]
- Updated dependencies [822a0c7]
- Updated dependencies [eadd0df]
- Updated dependencies [e6f16eb]
- Updated dependencies [0ff5643]
- Updated dependencies [f6a8e5d]
- Updated dependencies [cbfb1a9]
- Updated dependencies [7b979ef]
  - @foldedspacelabs/metistry-core@0.16.0

## 0.15.1

### Patch Changes

- 0025a4a: **Releases publish from the public repository again.** Every published package's `package.json` names its source (`repository` with `directory`, plus `homepage` and `bugs`), which npm's provenance check requires — v0.15.0 published nothing to npm for want of it. The release workflow now builds each GitHub release as a draft with every asset and publishes it only then, so immutable releases no longer refuse the assets; a failed Mac app holds the release as a draft instead of freezing it without the DMG; an npm provenance rejection fails the run instead of passing as a skip; and a malformed `APPLE_API_KEY_P8` is refused naming the format it must be (the raw `.p8` file, BEGIN/END lines included). Metadata and release tooling only; no runtime behaviour changes.
- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0

## 0.13.0

### Minor Changes

- 5e8f8d1: A work row says what it is about (T1-1, C85). Migration `0026_work_description.sql` adds `work.description` (nullable text, durable). `TasksService.create` takes `description` and `update` takes it on the board arm, capped at `DESCRIPTION_MAX` (2,000 characters); blank is stored as none, and `Task.description` is `null` when nobody wrote one. `tasks_create` accepts it. `tasks_update` has no `description` key, so an agent sets a description at create and never edits it. The owner edits it with `PATCH /api/tasks/:id {"description": …}`, without a claim; `null` or blank clears it, and it cannot ride with a holder status. Every task route's `task`, the `board` query's rows and MetistryKit's `BoardCard` carry it; `TaskPatch` gains `description` and `TaskPatch.describing(_:)`.

### Patch Changes

- Updated dependencies [152022a]
- Updated dependencies [942372e]
- Updated dependencies [95fb504]
- Updated dependencies [df37d39]
- Updated dependencies [3d2e818]
- Updated dependencies [4451f77]
- Updated dependencies [3a1ff8c]
- Updated dependencies [6592f91]
- Updated dependencies [bf33ee1]
- Updated dependencies [bd29463]
- Updated dependencies [9ac7949]
- Updated dependencies [3f9d719]
- Updated dependencies [4cba65a]
- Updated dependencies [be25ade]
- Updated dependencies [c38dc4e]
- Updated dependencies [a927e61]
- Updated dependencies [06c854e]
- Updated dependencies [ec21783]
- Updated dependencies [a1f1113]
- Updated dependencies [24a9ddb]
- Updated dependencies [8c9dde6]
- Updated dependencies [8217e01]
- Updated dependencies [37f0ed2]
- Updated dependencies [5e8f8d1]
  - @foldedspacelabs/metistry-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [c69abc3]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0

## 0.11.0

### Patch Changes

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

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1

## 0.8.0

### Minor Changes

- f27e0af: **The board moves things now** — phase 3 of
  `docs/research/2026-09-12-hermes-agent-review.md`, built on the rule that
  keeps invariant 8 honest: *the board offers no drop the service would refuse.*
  
  - **`packages/tasks` — the three gaps the note found, closed additively.**
    `UpdateInput.status` was `Exclude<TaskStatus, 'open'>`, so **unblock was
    unreachable by anything in the system**; it now accepts `open` from
    `blocked` only, and hands the row back the way `release()` does. `owner`
    can be set and cleared after create (with `title` and `project`, the other
    two fields a card carries but could not change). `heartbeat` takes a
    `note` that lands on `history` — and a renew *without* one appends nothing,
    so a lease ticking every few minutes never buries the row's record.
    `update` now has **two arms, and the fields pick the arm**: the holder arm
    (`in_progress | blocked | closed`, or a bare note) is claim-gated exactly
    as before; the board arm (`owner`, `title`, `project`, the unblock) is not,
    because addressing a card is a gesture on a row nobody need hold and the
    unblock is by definition a row whose holder is stuck. Mixing the two in one
    call is refused naming both fields — the looser gate must never carry the
    stricter arm's write. New refusal reason: `not_blocked`.
  - **The console's task routes** (`apps/console/src/task-routes.ts`):
    `PATCH /api/tasks/:id {status?, owner?, project?, title?}`,
    `POST /api/tasks/:id/{claim,release,renew}`. Until now
    `POST /api/tasks/:id/dispatch` was the *only* task route the console had.
    A thin adapter and nothing more: every refusal comes out of a `WHERE`
    clause in `packages/tasks`, and the route only turns it into a sentence
    that names what would permit it. `user` principal only — an agent token
    and a capture owner token both get the canonical `403` — and one `runs`
    row per request records the door beside the service's own row for the op.
  - **The drags** in the Board tab: HTML5 drag-and-drop, no library, four
    handlers. Each drop maps to exactly one route, `reported` is never a
    target, a closed card is not draggable, and a refused drop snaps back
    carrying the server's message. `m` on a focused card is the keyboard
    alternative. Clicking a card opens its room when one exists — `board.yaml`
    gained `has_thread`, so the panel never asks a second endpoint — and its
    detail popover when it does not.
  
  **Assignment stays the human's alone, by absence rather than by a check:**
  `owner` exists on `PATCH` and on no agent surface, because `tasks_update`'s
  schema has no `owner` key and its status enum has no `open`. That is
  collaboration rule 4 without a rule to run.
  
  `docs/ops/board.md` gained the **Drags** table; `docs/ops/console-api.md`
  gained the routes.

### Patch Changes

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

- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

## 0.2.0

### Minor Changes

- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
