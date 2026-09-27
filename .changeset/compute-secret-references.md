---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
"@metistry-apps/collectors": patch
"@metistry-apps/macos": patch
---

**Compute (T4-18): provider keys are this instance's secrets, providers gain a
switch and billing, and the catalogue is searched by model.**

- `compute.yaml`'s `auth.secret` is a reference: `{{ secret.<name> }}` (one of
  this instance's secrets), `env:<NAME>` (an install variable), or — so every
  older file loads — the bare `<NAME>`. A pasted key still cannot match any of
  them. Core gains `credentialOf`, `providerCredential`, `credentialEnvNames`,
  `credentialFromEnv` and `providerSecretNames`; the reference spelling moved
  to a leaf module (`secret-ref.ts`, re-exported by `secrets.ts`) so
  `compute.ts` can read it without a load-time cycle.
- A service reads a key from its environment, never the Keychain:
  `{{ secret.x }}` arrives as `METISTRY_SECRET_X` (core's `secretDeliveryVar`),
  which `metistry secrets sync --to env` now writes for every secret the
  providers reference, from this instance's item only; `metistry up`'s engine
  allowlist passes exactly those names. For one release a `*_api_key` secret is
  also read from the `METISTRY_<NAME>` line T4-3 filled, so `migrate-scope`
  rewriting the reference cannot cut a running engine off.
- `metistry compute providers add` stores the key through `secrets set`'s own
  code — this instance's Keychain account, recorded in `secrets.yaml` sent only
  to the provider's host — and writes the reference. The `openrouter` template
  references `{{ secret.openrouter_api_key }}`. Nothing in `metistry compute`
  reads or writes the retired per-user account any more. `--secret` takes a
  secret's name; the old UPPER_SNAKE spelling is refused with the name it
  became.
- Providers gain `enabled` (off = neither searched nor offered; an assignment
  naming a switched-off provider is refused by the schema) and `billing:
  token | subscription` (off this machine only). The report carries `enabled`,
  `billing`, `tag` (`local` · `cloud` · `subscription`), `secret_kind`,
  `secret_name` and presence from this instance's account.
- `seed/model-identities.yaml` and core's `groupCatalogue`: provider model id →
  one model, overlaid by key by the instance's `.metistry/model-identities.yaml`
  (a new `INSTANCE_LAYOUT.modelIdentities`). An id it cannot map stays its own
  row under its provider.
- New verbs: `compute providers set <name> [--enabled on|off] [--billing …]
  [--base-url …] [--secret …]`, `compute models search [<query>]`,
  `compute unassign <tier|crew:name>`. New owner routes:
  `GET /api/compute/catalogue[?q=&provider=&refresh=true]` (listings kept
  15 minutes in memory; `refresh` re-reads them) and
  `POST /api/compute/unassign {tier|crew}`; MetistryKit's `UsageStore` gains
  `computeCatalogue` and `unassignCompute`.
- `migrate-scope` now rewrites `compute.yaml`'s `auth.secret` (its schema reads
  references), and still counts a rewritten reference's original as this
  instance's, so reruns stay idempotent and `purge-shared` can find it.
  `METISTRY_SECRET_*` is never taken for a retired shared-scope original.
- `fetchModels` keeps what a listing says beyond the id (name, context,
  per-million price, tools) as `details`.
