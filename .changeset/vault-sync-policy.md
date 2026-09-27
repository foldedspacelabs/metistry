---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/reconciler": minor
"@metistry-apps/console": minor
---

**The vault's sync policy and status (T10-2, plan §2.21).** `deployment.yaml` gains a `vault:` block — `push: after_commit | manual | {every: N}`, `pull: {every: N}` (1m…24h; no pull "never"), default after_commit and 5m — merged per key over the D4 overlay (core's `vault-sync.ts`). The reconciler schedules on it and re-reads the file when it changes: after_commit pushes after a flush that made commits and retries only what is unpushed, every N pushes on the interval when something is unpushed, manual never pushes; pull is a `git fetch` every N until T10-3's integrate lands. Every commit, push, pull with news and conflict is a `runs` row of kind `vault_sync` with `meta.state` (the `vault.sync` event). The bridge serves `GET /vault/status`; the console serves it to the owner as `GET /api/vault/status`, strictly parsed. `metistry vault settings [--push …] [--pull …] [--yes]` shows and writes the policy (M18, a protected write through the reconciler as `user`), and doctor gains a *vault sync* row (ahead, behind, last push, conflict). `METISTRY_PUSH_SCHEDULE` still overrides `push` for this release, and says so everywhere it applies; `.env.example` no longer sets it.
