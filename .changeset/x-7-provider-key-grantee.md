---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/assistant": minor
"@metistry-apps/console": patch
"@metistry-apps/collectors": patch
---

Ruling 2 (X-7): a provider key has a grantee, and every compute call goes
through the egress door.

- `secrets.yaml` takes `provider:<name>` beside `connection:<name>` and
  `agent:<id>`.
- core's new `computeFetch` is the one `fetch` for a compute call: it refuses
  any host but the provider's `base_url` destination (`not_provider_host`),
  attaches the credential itself, and attaches a `{{ secret.x }}` key only
  while `secrets.yaml` grants it to `provider:<name>` and lists the provider's
  host. The engine, `completeJson`, `scoreChoice` and the embedder all call
  through it. **Breaking for importers of core:** `resolveOnMachineCall`
  returns `fetchFn` (the door) instead of `bearer`, and `makeChatClient` takes
  `env`/`secretsPolicy` instead of `apiKey`.
- The engine's sandbox now reads `secrets.yaml` by name (`CONFIG_SECRETS`),
  per call, so a revoked grant stops the next request.
- `metistry compute providers add|set` write `provider:<name>: on` for the
  key; `metistry update` and `metistry secrets migrate-scope` backfill it,
  idempotently, for every provider key `compute.yaml` already uses.
