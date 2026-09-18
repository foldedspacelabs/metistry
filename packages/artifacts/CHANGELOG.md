# @foldedspacelabs/metistry-artifacts

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
