---
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/assistant": patch
---

**Automatic prompt caching on the providers that support it** (OPEN-6, ruled
2026-09-17: ship the automatic form first, measure explicit breakpoints
later). A new optional `caching: auto | off` on a `compute.yaml` provider says
whether that provider implements Anthropic-style prompt caching; the engine
then sends its automatic caching field on every chat completion — for
OpenRouter, one top-level `cache_control: { type: "ephemeral" }`, the
automatic placement its caching doc describes ([or-cache], fetched
2026-09-11). The `openrouter` template ships `auto` and is the only one that
does: everything else defaults to `off` and gets no extra field, because a
server that has never heard of the parameter would have to ignore it. The
schema refuses `caching: auto` on an `on_machine` provider, naming the field,
rather than accepting a line that does nothing. Explicit breakpoints remain
the operator's `request:` block, which is merged after the automatic field and
therefore overrides it.

The cached share of the prompt now lands on the row: `cached_tokens` and
`cache_write_tokens` (or Anthropic's `cache_creation_input_tokens`) are read
out of `usage` into `runs.cache_read_tokens` / `cache_write_tokens`, summed
over the turn's whole loop, with `tokens_in` still the whole prompt as the
provider billed it. On the `pricing` path the prompt is priced in three parts
— fresh at `in_per_m`, reads at `in_per_m × cache_read_multiplier`, writes at
`in_per_m × cache_write_multiplier` — with two new optional `pricing:` fields
defaulting to 0.1× / 1.25×, Anthropic's rates as OpenRouter passes them
through. A response reporting no cached tokens prices exactly as before.
`docs/ops/compute.md` gains "Prompt caching", including the measurement still
owed under OPEN-6 and the two assumptions it will check against a live
response.
