# @foldedspacelabs/metistry-cli

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
