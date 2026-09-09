# Cost optimisation — what Anthropic's guidance means for Metistry (2026-09-09)

Sources read in full: the Claude Platform blog post on reducing cost,
the platform doc "Optimizing for cost and intelligence — cut spend
without losing quality", and the cost-optimisation cookbook. Figures
below are theirs; the mapping to Metistry is ours.

## The one fact that reorders everything

**Prompt caching is the largest lever by a wide margin** — 2.7–5.3× on
agent loops, 83–88% on a small triage agent; a cache read costs a tenth
of input (and on Fable 5.1, 0.025×), a write 1.25× (2× for the 1-hour
TTL). Every agentic turn resends the whole prefix, so the prefix must be
**byte-stable**: system prompt, tool definitions, prior turns, in that
order, with nothing volatile ahead of them. What breaks it: a timestamp
in the system prompt, editing the system prompt, changing `effort`,
adding/removing/reordering a tool, changing an output format. On Fable
and Mythos 5.1 a break costs 50× the read price per token.

Metistry runs its own assistant on a **subscription** (usage limits, not
per-token billing), so for the owner these techniques buy headroom; for
users on API keys, crews, or a gateway (§4.18 A) they buy money. The
`claude-usage` collector already labels cost "API-equivalent"; that stays.

## Where we already comply, and where we don't

| Guidance | Metistry today | Gap |
| --- | --- | --- |
| Stable prefix: system → tools → messages | `apps/assistant` builds the system prompt once per engine instance; mcp-brain's tool list is fixed per release; aliases are unlisted (#89) | **Volatile text must never enter the system prompt**: today's date, `now.md`, the brief, presence — put them in the first user message of a turn. Audit and lint |
| Don't change effort/tools mid-session | Router is deterministic (invariant 4) | The UI's model/effort picker (ux-direction) must apply at a *turn boundary* and say "re-caches"; never mid-turn |
| Defer rarely used tools (tool search) | PoC-17: eager under 5k definition tokens; we sit at ~4.4k | Caching changes PoC-17's arithmetic: an eager, byte-stable tool list is paid once per cache write, not per turn. Eager stays right; the rule becomes "stable and under 5k", and tool count changes ship only with releases |
| Manage context lifecycle: prune at task boundaries beats mid-task editing (89% cache reads after a boundary) | "The brief is the context transfer" (§4.11); fold and crew runs are separate threads | Make it policy: **fresh session per fold turn and per crew run**; roll the chat session at task boundaries (decision #3 was "no fixed cadence") and record cache hit rate per session |
| Batch API: 50% off anything that can wait 24h, stacks with caching | Routines never call a model; they enqueue turns | Only on API billing (not the subscription path): unattended turns (fold, reply-review drafting, weekly summaries) go through Batch when `deployment.yaml` names an API key or gateway. A per-turn `urgency: interactive | deferred` flag on `inbound_messages` makes it a switch |
| Model tiering + effort: "a stronger model at low effort can be cheaper than a weaker model working hard"; effort low→max = 3.5× cost for 2.7× on Fable 5, negligible gain at max on Fable 5.1 | Tiers are models (fast/deep) | **Tiers become (model, effort) pairs** chosen by the router; defaults: chat = default model at medium; fold/brief = low; deep = high; crews declare `effort` in the manifest (default low) |
| Prompt audit: remove "verify twice", "be maximally thorough", mandatory scratchpads, stale examples — 14–36% per task | New prompts, few habits yet | A deterministic **prompt lint** over `seed/assistant-prompt.md`, crew manifest bodies and skills, flagging the known anti-pattern phrases; runs in CI (enforce at the tool) |
| Subagent on a cheap model absorbs bulk context, returns one line (78%) | Crews with their own model | Extraction/reading crews default to Haiku; the assistant orchestrates |
| Keep data files out of the prompt; query instead (79–91% and *more* correct) | Named queries, 200-row cap (invariant 3) | Already the design; keep row caps and the "no free-form SQL" rule |
| Shape output; stop sequences (56–63%) | Decision blocks; fold summary | Keep replies shaped where a shape exists; no change |
| Measure: cache hit rate, cost per task | `runs` carries tokens/cost | **Add cache read/write tokens to `runs`** from the SDK's usage, a `cache_hit_rate` per day in `claude_usage_daily`, a dashboard tile and a weekly-review line. Optimise after measuring |

## Decisions recorded

1. **Prompt hygiene is an invariant of the engine build**: nothing volatile
   in the system prompt; tool lists change only with releases; effort and
   model change only at turn boundaries. Enforced by a lint in CI, not a
   comment.
2. **Tiers are (model, effort) pairs** in the router and crew manifests.
3. **Fresh sessions for fold and crew turns; chat sessions roll at task
   boundaries** with cache hit rate recorded per session (closes the
   "no fixed cadence" half of decision #3 with a measurable rule).
4. **Batch routing for deferred turns when on API billing**; a no-op on the
   subscription path.
5. **Instrument first**: cache tokens in `runs`, hit rate on the dashboard
   and in the weekly review, before any further tuning.
