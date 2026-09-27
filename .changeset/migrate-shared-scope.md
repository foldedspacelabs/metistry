---
"@foldedspacelabs/metistry-cli": minor
---

**The shared secrets scope is retired (plan §2.14, T4-3).** Every Keychain
item an instance reads or writes is filed under its own `instance_id`; the
per-user account third-party credentials were shared through
(`SECRET_SCOPES`, deleted with `scopeFor`, `scopeReason`, `DEFAULT_SCOPE`)
is only ever asked about by presence, and read from by the migration alone.

`metistry secrets migrate-scope` copies each shared-scope original
(`METISTRY_*_API_KEY`, `METISTRY_DEVIN_API_KEY`, the AWS keys) into this
instance as an owner-named secret under its lowercase name
(`METISTRY_DEVIN_API_KEY` → `devin_api_key`) and records it in
`secrets.yaml`; an item the instance already holds wins; it rewrites
`auth.secret` and `requires.env` to `{{ secret.name }}` only into a file
that still validates with it; it is idempotent and deletes nothing.
`metistry update` runs it and can never be failed by it.
`metistry secrets purge-shared` removes an original only once every
instance this Mac knows has its copy, preview-then-confirm. Doctor gains a
`shared scope` row (presence only, never `failed`).

`secrets sync --to env` fills a shared-scope variable's line from the
owner-named secret and no longer falls back to, or copies from, the
per-user account; `--to keychain` and `mint` refuse to handle a third-party
credential (it is set with `secrets set`). `secrets list --json` rows drop
`scope` and gain `secret` and `sharedOriginal` for a shared-scope variable.
`accountFor` is the instance's account for every name.
