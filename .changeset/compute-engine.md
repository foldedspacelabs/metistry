---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/assistant": minor
"@metistry-apps/console": minor
---

**The engine dials the provider, and every call costs a number you can see.**
`compute.yaml`'s assignments now decide what actually answers a turn. One
`Engine` interface with a factory keyed on the provider's `kind`: an assigned
tier or crew runs on the in-house OpenAI-compatible loop — any base URL, so a
local server, OpenRouter, Zen or anything else — and a turn nothing assigns
keeps running on the Claude Agent SDK exactly as before. Write an
`assignments.default` and no turn can reach the SDK path at all, which is why
the assistant then starts with no engine credential set.

The loop is about 300 lines over `fetch`, the pre-approved MCP client and
zod — no new dependency. It owns the tool loop over the console's `/mcp`
(the only tools that exist — invariant 9), `max_turns`, backoff on 429/5xx
honouring `Retry-After`, `response_format: json_schema` *plus* zod validation
with one repair retry, effort as `reasoning: { effort }` off-machine and
reasoning-off on-machine, and the provider's `request:` block merged verbatim
— except `model` and `messages`, which belong to the assignment, because a
request block that could repoint the call would hand routing back to the file
the router was told to obey. A **no-progress veto** ends a run that is
learning nothing: a turn whose every tool call repeats a (name, arguments)
already made *and* returns byte-identical output is unproductive; three in a
row buys a nudge, five ends tool use and asks for the answer. Every early
stop — the turn cap, a crew's per-run cost cap, the veto — still ANSWERS.

**Cost is a first-class row.** `runs` gains `provider`, `cache_read_tokens`
and `cache_write_tokens` beside the existing model and token columns
(additive migration `0016`), and `meta.cost_source` records where the number
came from: the response's own `usage.cost`, the provider's `pricing:` table,
`local` (0 by definition), or `unknown` — an off-machine call nothing can
price is recorded at $0 **and says so**, never at a guessed rate. The
OpenAI-compatible engine keeps its own message history in a new
`assistant_sessions` table under the same id `sessions` uses, so a task
boundary rolls both at once and a rolled thread can never be replayed.

**Budgets are enforced before the call**, against a new `spend` named query
(invariant 3's one read path, `cache_ttl: 0` so a cached number cannot
overspend). `allow` records, `stop` refuses, `critical_only` passes only an
assignment marked `critical: true`; 80% of any window writes one warning per
calendar window. What a refusal looks like depends on who asked: a chat turn
is offered one more window as a Needs You item naming the exact field, a
routine that declares `requires.engine` does not start at all (the runner's
preflight asks the same budget question first), and a crew fails with
`budget_exceeded` and parks. A budget that cannot be measured refuses rather
than guessing.

Also: a non-ZDR off-machine assignment writes one warning `runs` row per
provider per day and still works — informed choice, never a block; and the
console refuses a *directed* `agents_delegate` to a crew whose engine kind
differs from the caller's, with the field that would permit it, while
unassigned work any agent can claim stays open to everyone. `docs/ops/
compute.md` gains "The engine", "Budgets" and "The collaboration rule".
