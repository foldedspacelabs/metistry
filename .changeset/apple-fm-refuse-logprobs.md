---
"@foldedspacelabs/metistry-mcp-apple-fm": patch
---

**`/v1/chat/completions` refuses `logprobs`/`top_logprobs` by name instead of
silently ignoring them.** `docs/ops/compute.md`'s contract is that an
unsupported request field is refused, loudly, naming the field — `stream`,
`tools`, and `n` already did this, but `logprobs: true` (or a non-zero
`top_logprobs`) fell through and generated as if the caller had not asked,
which would have looked like a confidence signal the response never carried.
Both now return `400 logprobs_unsupported`, saying Apple Foundation Models
exposes no token probabilities. `logprobs: false`/absent is unaffected.
