---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

**Per-instance secrets (plan §2.14).** A secret is an owner-chosen lowercase
name, a value in the login Keychain under service `metistry:secret:<name>`
and account `<instance_id>` — one instance, one account, no shared scope —
and a policy in `.metistry/secrets.yaml`: the hosts it is sent only to, who
may use it (On · Ask · Off per connection and actor), and an expiry. It is
referenced as `{{ secret.name }}`.

`@foldedspacelabs/metistry-core` adds the store and its contract:
`InstanceSecrets` (bound to one `instance_id`; nothing on it takes an
account), the `KeychainBackend` seam and `memoryKeychain()` for tests,
`secretService`/`secretAccount`, the strict `secrets.yaml` schema
(`parseSecretsFile`, `secretGrant`), the resolver (`fillSecretRefs`, all or
nothing; `parseSecretReference`, with `env:NAME` for one release),
`describeSecrets` over a presence-only probe, and `INSTANCE_LAYOUT.secrets`.

`@foldedspacelabs/metistry-cli` adds `metistry secrets set | replace | remove
| hosts | grant` and `list --named`: the value on stdin into this instance's
Keychain account, the policy through the reconciler as the owner.
`sync | mint | list | purge` are unchanged, except that `purge` now also
deletes the instance's named items. `securityKeychain`/`securityPresence`
drive `security` for the new store; `Keychain` delegates to them with the
same argv.

`@metistry-apps/console` serves `GET /api/secrets` (reach owner): names,
hosts, grants, expiry, presence and last used — never a value; the console
holds a presence probe and nothing that can read an item. *Last used* comes
from the new `secret_last_used` named query (`expose: route`) over
`runs.meta.secrets`.
