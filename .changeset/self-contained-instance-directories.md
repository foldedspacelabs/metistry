---
"@foldedspacelabs/metistry-cli": minor
---

An instance directory is self-contained: `.env` moves to
`<instance>/state/.env`, `identity.yaml` carries a minted `instance_id`, and
Keychain items are scoped per instance.

- `--instance <dir>` and `--env-file <path>` on every verb. The environment is
  read from `<instance>/state/.env` first, then the product checkout's `.env` —
  deprecated, still read (with a notice on stderr), and still where a terminal
  install may declare `METISTRY_INSTANCE_DIR`.
- `metistry secrets sync --to env` performs the move: every line of the old
  file is carried over and the old file is left in place.
- `SECRET_SCOPES` (secrets.ts) is the one table saying whether a secret is
  filed under the instance's `instance_id` or the per-user account.
  Instance-scoped values found only under the user account are copied across,
  never deleted. `secrets list` gains a scope column.
- New `metistry secrets purge --instance <dir> [--yes]`: preview-then-confirm
  deletion of one instance's Keychain items, incapable of touching user-scoped
  ones.
- The `sh -c` launchd plists gain an `__ENV_FILE__` placeholder and
  `docker compose` is invoked with `--env-file`, so both read the instance's
  file rather than the checkout's.
