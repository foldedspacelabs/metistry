# @foldedspacelabs/metistry-cli

## 0.3.1

### Patch Changes

- 588e69a: Release images are built for `linux/amd64` and `linux/arm64`. v0.3.0's
  `ghcr.io/foldedspacelabs/metistry-*` images were amd64-only, so `metistry
  update --channel release` on an Apple-silicon Mac failed at `docker compose
  pull` with "no matching manifest for linux/arm64/v8". The Dockerfiles' build
  stage now runs natively on the CI host (`--platform=$BUILDPLATFORM`; the
  compiled output is pure JS) and only the runtime stage is per-architecture.
- 9a2a90f: `metistry update --channel release` downloads release assets (the runtime
  pack, the runtime-deps pack, `checksums.txt`) through GitHub's authenticated
  asset API when `METISTRY_GITHUB_TOKEN` is set — the one path that reads a
  private repo's assets with a token; `browser_download_url` 404s there. The
  302 to the signed S3 URL is followed without resending the token. A 404 on
  download falls back to `gh release download`, as an unauthorised resolve
  already did.
- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Minor Changes

- 1e4eaae: The runtime ships with the product. A release now carries
  `metistry-runtime-deps-<version>-darwin-arm64.tar.gz` — Node, a relocatable
  Postgres 17 + pgvector built from source, and a minimal git — built by
  `ops/release/build-runtime-deps.sh` with every version and source sha256
  pinned in one file, and verified from a *moved* copy of the tree before it is
  packed. `metistry update --channel release` installs it alongside the runtime
  pack, and `metistry up` on the launchd shape fetches it when no Postgres
  exists anywhere; both go through the same checksums.txt verification as the
  product pack, and `METISTRY_RUNTIME_DEPS=0` keeps them off the network.
  `METISTRY_PG_BIN` resolution finds `runtime/postgres/bin` as before, and the
  reconciler's launchd job gets `runtime/git/bin` on the front of its PATH — so
  a clean Mac needs neither Homebrew nor Xcode Command Line Tools.
- 92dd868: Session summaries as a capture source (stash review item 2). `core` gains a
  deterministic Claude Code transcript summariser — turns, duration, files
  touched, tools with counts, models, first prompt and last response, both
  clipped — plus the `kind: session` note it renders and a content-derived
  `idempotency_key`. `cli` gains `metistry import-sessions [--since] [--project]
  [--limit] [--dry-run]`, which posts those summaries to `/capture` from the
  host, skipping anything a ledger at `~/.metistry/imported-sessions.json`
  already sent. No model is called on either side, and a transcript is never
  posted — only its summary.
- Knowledge fold (the evening turn that turns accepted items into Journal and entity pages), `import-sessions` and `kind: session` captures, `knowledge_list`/`knowledge_grep` and vault notes as MCP resources under one scope helper, the simplified vocabulary (22 primary tools with call-time aliases; Approve / Revise / Decline; Auto / Supervised), cost discipline ((model, effort) tiers, session roll at task boundaries, cache read/write metrics and a prompt lint), the bundled runtime build (Node, Postgres 17 + pgvector, git — signed), TCC helpers as signed app bundles whose grants survive rebuilds, Sparkle tooling pinned, npm Trusted Publishing, and the GitHub OAuth App shipped as the default for `connect-repo`.

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

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
