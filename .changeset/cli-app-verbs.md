---
"@foldedspacelabs/metistry-cli": minor
---

Four small verbs so the Mac app can stop parsing files itself and front the
CLI instead (docs/ops/cli.md, docs/product/desktop-app-plan.md):

- `metistry identity [--json]` — identity.yaml as the CLI understands it
  (name, mention, voice, icon, instance_id), resolving `--instance`/
  `METISTRY_INSTANCE_DIR` like every other instance verb. Read-only.
- `metistry --version` / `metistry version [--json]` — this binary's own
  package version (always); the resolved product dir's own package.json
  version; the instance's `metistry.lock` pin + channel; and, for a release
  install, `metistry-runtime.json`'s version, commit and build time. Each
  field is reported only as far as it resolves.
- `metistry secrets list --json` — the same rows the table shows (name,
  scope, keychain account found under, set/unset), values never.
- `metistry deployment [--json]` — the effective shape (deployment.yaml's D4
  overlay) and the services it implies, each tagged with its running state
  via the same cheap `launchctl print`/`docker compose ps` checks `doctor`
  itself uses (never the full `doctor`, which also probes bridges over
  HTTP).
- `metistry deployment set-shape <compose|launchd> [--yes] [--force]` —
  writes the instance's deployment.yaml through the reconciler as the `user`
  principal, exactly like `metistry.lock`/`identity.yaml` (a §4.7 protected
  path). Preview-then-confirm: without `--yes` nothing is written; refuses
  while `db`/`console`/`assistant` are still running under the current
  shape unless `--force` (the data does not move between shapes on its
  own) — `reconciler`/`watchdog` running is never a reason to refuse, since
  they are host jobs under either shape.
