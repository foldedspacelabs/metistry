---
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-core": patch
"@metistry-apps/assistant": patch
---

**`metistry compute cache-report` — OPEN-6's measurement as one command**
(ruled 2026-09-17: ship automatic top-level `cache_control` first, measure
later). `metistry compute cache-report [--since 7d] [--json]` reads the `runs`
ledger through the new named query `cache_report`
(`GET /api/q/cache_report` — invariant 3's one read path, and no console route
or action of its own, so invariant 10's mutating surface is untouched) and
joins it to `compute.yaml`'s `pricing:` rates, which the ledger cannot know. A
table per provider/model, grouped by tier and by the `caching:` mode that was
in force, with turns, cache reads and writes, hit ratio, recorded cost and a
net dollar saving; one verdict line against an 80 % threshold, under the 89 %
after a task boundary that `docs/research/2026-09-cost-optimization.md`
records, because a real install rolls sessions. The saving is net of the write
premium and may be negative — a prefix rebuilt every turn is the finding, not
a number to floor at zero — and is absent, naming the field that would fill
it, wherever no `pricing:` entry publishes a rate. It calls no model and
writes nothing.

**Usage mapping now covers Anthropic's native shape.** `cache_read_input_tokens`
was not read at all, and `input_tokens` on that wire is the *fresh* remainder
with both cache counts reported beside it rather than inside it.
`usageFromResponse` recognises the shape by its anchor field (`prompt_tokens`
= the OpenAI/OpenRouter form, already a total; `input_tokens` = the native
form, summed back into one), so `runs.tokens_in` means the whole billed prompt
whichever endpoint answered and a ratio over it is comparable across
providers.

**Every engine turn now records the cache, and what caching was asked for.**
Crew runs wrote provider, model, tokens and cost but dropped
`cache_read_tokens`/`cache_write_tokens` and `cost_source`; shadow runs
dropped the same two on their own provider's row. Both carry them now. And a
reported zero is no longer flattened into "nothing reported": the engine keeps
the counter absent until a response carries the field, so NULL means the
provider said nothing (the field name is wrong) and 0 means it said zero (the
prefix is not stable) — two findings with different fixes. `runs.meta.caching`
records the mode in force for that turn, since `compute.yaml` is hot-reloaded
and cannot answer later what was true earlier.

**Fixed:** `main()`'s `compute` case hardcoded `fetchFn: fetch` instead of
honouring the `io.fetchFn` test seam, so a test driving those verbs through
`main()` reached the real console and real provider endpoints rather than its
own fakes.
