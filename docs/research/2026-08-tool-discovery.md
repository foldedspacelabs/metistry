# Tool discovery: lazy vs eager — landscape research (2026-08-30)

Commissioned after PoC-17's surprise: the lazy meta-tool pattern worked
perfectly at the Haiku tier (10/10) but *cost more* than eager on a small
bridge (+1 turn, +34% cumulative prompt tokens, +2.4 s wall). Questions:
what are others doing, what's best practice, and is the cost Haiku-specific?

## 1. The industry converged on the same problem — and on thresholds

Between Nov 2025 and Feb 2026 three major interventions shipped, all
implementing "don't load definitions you aren't using":

- **Anthropic's Tool Search Tool** (API, 2025-11-24): tools marked
  `defer_loading: true` are replaced by a search tool; the model searches,
  loads only matching schemas, then calls. Claimed **~85% token
  reduction**. Claude Code's own MCP Tool Search activates only when tool
  descriptions exceed **~10k tokens** — i.e. the vendor itself gates lazy
  behind a size threshold rather than defaulting to it.
- **Code execution with MCP** (Anthropic pattern, Nov 2025): the agent
  writes code that calls tools instead of emitting tool-use blocks;
  discovers tool files on demand. Claimed **~98% reduction** at the
  extreme (150k → 2k); community replications report 80–98% on large
  surfaces (e.g. 112 GitHub tools).
- **Progressive disclosure / tool retrieval** (Cloudflare Code Mode,
  LangChain-style retrieval, vLLM semantic router): same idea, retrieval
  picks 3–5 relevant tools per query.

Common thread: **every published win is measured on large surfaces**
(dozens-to-hundreds of tools, 60k+ definition tokens). Nobody publishes
the round-trip overhead on *small* surfaces — PoC-17's measurement of the
crossover from below appears to be genuinely missing from the public
conversation, but the vendors' *behavior* (threshold-gated activation)
implies they found the same thing.

## 2. Is the cost Haiku-specific? No — but the *benefit* is model-tiered

Two separate effects, often conflated:

- **The round-trip cost is structural, not model-specific.** An extra
  discovery turn re-sends the whole context and adds a full network+
  inference round trip regardless of model. Prompt caching (now default
  everywhere) further shrinks lazy's savings, since re-ridden definitions
  are mostly cache reads. This is why PoC-17's result generalizes: any
  model pays the +1 turn; a bigger model just pays it slower.
- **The accuracy benefit of fewer tools is real and hits small models
  first.** Published selection benchmarks: Haiku-class drops below 90%
  selection accuracy around **10–15 tools** (Sonnet ~20–30); ~50 tools →
  84–95% for most models; ~200 → 41–83%; ~740 → near-zero. So trimming
  the visible tool surface is an *accuracy* intervention for the cheap
  tier before it is a token intervention. (PoC-17's eager arm went 5/5 at
  40 tools, but with distinctive names and n=5 — the benchmarks say don't
  extrapolate that to messier catalogs.)

## 3. Best practice, synthesized

1. **Threshold-gate, don't default.** Small/always-used surfaces: eager.
   Lazy only when definitions are large relative to their index and most
   tools go unused per turn. Anthropic's own product draws the line
   around ~10k definition tokens; community "safe zone" for visible tools
   is ~10–20.
2. **Curate before you defer.** Fewer, better-described tools beat any
   loading strategy; progressive loading "reduces the cost of badly
   designed surfaces; it does not redeem them." AWS guidance: ≤~8 params
   per tool, split multi-purpose tools.
3. **Retrieval quality is the new failure mode.** Lazy setups fail by
   *missing* the right tool at search time and lose serendipitous
   discovery — a real regression risk PoC-17 didn't hit because its index
   fit in one response.
4. **Code-execution-over-MCP is the endgame for very large surfaces**,
   not a Phase-2 need here — but the assistant-engine contract (§4.18.C)
   should not preclude it.

## 4. Recommendation for Metistry (supersedes plan §4.3's lean — needs D-ratification)

- **Default `discovery: eager`.** Metistry bridges are small by design
  (invariant-8 "keep it small"; EventKit/Apple-FM/brain are each well
  under 20 tools), agents mount only their manifest's `uses`, and the
  scoped-toolset design already caps the visible surface per session —
  the accuracy cliff is avoided by curation, not indirection.
- **Keep `lazy` in the contract with the three frozen meta-tool names**,
  activated per-bridge when definitions exceed a threshold — propose
  **>20 tools or >5k definition tokens**, both statically countable at
  manifest-validation time; CI warns when an eager bridge crosses it.
- **Revisit trigger:** if a real turn's tool definitions ever exceed ~10%
  of context (the industry line), or external-agent scenarios mount many
  third-party servers, adopt threshold-based deferral globally — and
  evaluate code-execution mode rather than scaling meta-tools further.

## Sources

- [Anthropic Tool Search / defer_loading guide](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)
- [Stop eager-loading MCP tools (Focused)](https://focused.io/lab/stop-eager-loading-mcp-tools)
- [AWS: MCP tool design tradeoffs](https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/)
- [Progressive tool loading pattern (Wire)](https://usewire.io/blog/progressive-tool-loading-mcp-context-pattern/)
- [MCP context overload (EclipseSource)](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/)
- [Lazy loading MCP tools: client support](https://ismaelramos.dev/blog/lazy-loading-mcp-tools/)
- [Tool Search lazy-loading pattern](https://www.agentic-patterns.com/patterns/tool-search-lazy-loading/)
- [MCP code execution, 98% reduction discussion](https://github.com/orgs/modelcontextprotocol/discussions/629)
- [Code execution with MCP overview](https://www.theunwindai.com/p/code-execution-with-mcp-by-anthropic)
- [Over-tooled agent problem (tool-count thresholds)](https://tianpan.co/blog/2026-04-19-over-tooled-agent-problem)
- [Semantic tool selection benchmarks (vLLM router)](https://vllm-sr.ai/blog/semantic-tool-selection/)
- [The Bitter Lesson of Tool Calling (arXiv)](https://arxiv.org/html/2608.06370v1)
