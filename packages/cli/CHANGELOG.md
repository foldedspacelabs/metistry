# @foldedspacelabs/metistry-cli

## 0.2.0

### Minor Changes

- fe1f062: Two install verbs, terminal-first (the Mac app will drive the same ones):
  `metistry connect-repo <url>` sets the instance repo's origin, obtains a
  git credential the reconciler can push with unattended (GitHub device
  flow, a PAT on stdin, or an ssh key) into the macOS login Keychain,
  verifies with `ls-remote`, flushes the reconciler's queue and pushes; and
  `metistry secrets sync|mint|list` makes the login Keychain the canonical
  store (`metistry:<VAR>`) with `.env` generated from it. No secret reaches
  argv, output, or `.git/config`.
- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).
- d381a45: Release pipeline: a `v*` tag now builds the product's versioned artifacts on
  GitHub Releases — a runtime pack per os-arch, npm packages with provenance,
  container images, and `checksums.txt`. `metistry update` gains a release mode
  that resolves a release, verifies its sha256 before unpacking, switches a
  `current` symlink and keeps the previous release for `--rollback`;
  `metistry init --channel release` writes that mode into `metistry.lock`.

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
