---
"@foldedspacelabs/metistry-mcp-brain": patch
---

**`scope_required`: the refusal names the area, once existence is already visible.**
Ruled 2026-09-19 (PR #216 judgement call B): tier `index` — or `links_for` on
a page whose title a grant does not cover — could already see a settled
page's title through `knowledge_search`/`knowledge_list`, but `knowledge_read`
and `knowledge_list { links_for }` answered the bare "not granted" anyway,
leaving an agent to guess which area to ask you to widen. That refusal is now
structured for a page it could already see (never for a path merely shaped
like one, never a draft — existence still does not leak either way):
`isError: true`, the ordinary `error.code: "forbidden"` underneath
(invariant 8's envelope is unchanged), plus `reason: "scope_required"` and
`grantedScope` — the page's own parent directory — alongside it.
`error.message` spells out the same thing in a sentence naming
`requests_create` as the door (there is no `request_access` tool today) and
that you approve it from Needs You.

Tier `none` and a path that fails the vault-path rule are untouched — still
the uniform "not granted", nothing new to distinguish. `Outcome` gains an
`expose` field (`packages/mcp-brain/src/outcome.ts`) alongside the existing
audit-only `meta`, so a refusal can opt into carrying structured, wire-visible
detail without changing what every other `fail(...)` call in this package
sends: `meta` still never reaches the caller. No tool description grew — the
eager `tools/list` stays under the 5k-token line — the extra detail lives in
the response body a refusal already produces.
