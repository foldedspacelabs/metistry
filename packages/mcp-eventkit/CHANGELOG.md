# @foldedspacelabs/metistry-mcp-eventkit

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- c6eb8ff: The helper build scripts pick a Developer ID identity by its SHA-1 hash
  instead of its display name, so a keychain holding two certs with the same
  name (a renewal, a second import) no longer fails `codesign` with
  "ambiguous". Duplicates of one team are tolerated; certs for different teams
  stop the build and ask for `METISTRY_SIGN_IDENTITY`. The chosen hash and
  name are printed.
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
