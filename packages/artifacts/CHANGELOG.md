# @foldedspacelabs/metistry-artifacts

## 0.15.1

### Patch Changes

- 0025a4a: **Releases publish from the public repository again.** Every published package's `package.json` names its source (`repository` with `directory`, plus `homepage` and `bugs`), which npm's provenance check requires — v0.15.0 published nothing to npm for want of it. The release workflow now builds each GitHub release as a draft with every asset and publishes it only then, so immutable releases no longer refuse the assets; a failed Mac app holds the release as a draft instead of freezing it without the DMG; an npm provenance rejection fails the run instead of passing as a skip; and a malformed `APPLE_API_KEY_P8` is refused naming the format it must be (the raw `.p8` file, BEGIN/END lines included). Metadata and release tooling only; no runtime behaviour changes.
- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1
  - @foldedspacelabs/metistry-tasks@0.15.1

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
  - @foldedspacelabs/metistry-tasks@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.4
  - @foldedspacelabs/metistry-tasks@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3
  - @foldedspacelabs/metistry-tasks@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2
  - @foldedspacelabs/metistry-tasks@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1
  - @foldedspacelabs/metistry-tasks@0.14.1

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
  - @foldedspacelabs/metistry-tasks@0.14.0

## 0.13.0

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
  - @foldedspacelabs/metistry-tasks@0.13.0

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
  - @foldedspacelabs/metistry-tasks@0.12.0

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
  - @foldedspacelabs/metistry-tasks@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0
  - @foldedspacelabs/metistry-tasks@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.9.1
  - @foldedspacelabs/metistry-tasks@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0
  - @foldedspacelabs/metistry-tasks@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-tasks@0.8.1

## 0.8.0

### Minor Changes

- 367f456: **Rooms: a conversation can now hang on a task, not only on a deliverable.**
  A comment thread anchors to a `work` row as well as an artifact version
  (migration `0018` — one nullable `work_id`, a check constraint enforcing
  exactly one parent, and one room per row), so agents can negotiate scope
  before anything is published. Two new tools, `tasks_comment {work_id, body}`
  and `tasks_thread {work_id}`, under the same project grant as `tasks_*`.
  
  **A room cannot address anyone** — no `to_agent`, no `@name`, no addressee
  field anywhere on the path — so posting wakes nobody and triggering stays with
  `agents_delegate`. Because it is the same table, the shipped escalation
  applies unchanged: ten consecutive agent messages and the next one is not
  stored; the room becomes an owner item with its transcript, and a human
  message resets the run. **Resolving is the owner's hand alone**: one console
  route, no tool, and nothing on a timer.
  
  Also: a **Rooms** tab listing every conversation across both anchors, with the
  escalation reason rendered as a sentence; the last of a task's room riding
  along in a crew's brief under `METISTRY_BRIEF_THREAD_BYTES` (default 4096);
  and `proposals.work_id`, set server-side, so a proposal can finally say which
  work row it came from.
  
  Crews reach the new tools through a new `rooms` group in `uses` — its own
  group rather than part of `tasks`, so no existing crew gains the ability to
  speak without a manifest edit.

### Patch Changes

- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [f27e0af]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
  - @foldedspacelabs/metistry-core@0.8.0
  - @foldedspacelabs/metistry-tasks@0.8.0

## 0.7.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.7.1
  - @foldedspacelabs/metistry-tasks@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0
  - @foldedspacelabs/metistry-tasks@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0

## 0.2.0

### Minor Changes

- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
