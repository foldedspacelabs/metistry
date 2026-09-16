---
"@foldedspacelabs/metistry-mcp-apple-fm": minor
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

**Apple Foundation Models is now a compute provider, and `inbox-drain` calls
it through the same wire as everything else.** The `apple-fm` bridge grows
`GET /v1/models` and `POST /v1/chat/completions` on its existing loopback
listener, under the same bearer as every other bridge route — with
`response_format: json_schema` translated per request into Apple's
`DynamicGenerationSchema`, real token counts from the model's own tokenizer,
and a `400` that names the field when a schema or prompt would not fit the
4096-token window. `metistry compute providers add --from applefm` writes the
provider; discovery and `metistry doctor` gain a `local:applefm` row.

`inbox-drain` no longer reaches the bridge's private `/classify` route. It
declares `uses_model: applefm/foundation-model` in its manifest and goes
through `completeJson()`, which enforces the rule that a collector may only
call an on-machine, cost-0 provider — CI checks the shipped default, and the
call itself throws rather than spending. **Upgrading:** run `metistry compute
providers add --from applefm` (with
`--base-url http://host.docker.internal:7810/v1` in the container shape) to
keep the model tier; without it the drain is deterministic, which is a
supported install and which `metistry doctor` reports.
