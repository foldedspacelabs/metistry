# The tool surface — budget, levers, and the trigger (2026-09-19)

Commissioned by the owner the same day, verbatim:

> we're getting real close to the lazy loading (or maybe a subset of code MCP)
> threshold now. Keep it eager for now, but we need a better plan longer term.

This is the longer-term plan. **Keep it eager** is taken as given and nothing
here proposes changing that today. Every Metistry number below was **measured
on this checkout on 2026-09-19** from the bridge's own `toolSurface()` — the
same function CI measures — and the command output is printed verbatim. The
owner's instance was not read and no database was touched.

## The short version

1. **The vendor's own activation guidance is disjunctive, and we already meet
   it.** Anthropic's tool-search page (read 2026-09-19) says use tool search
   when *any* of: "You have 10 or more tools available", "Your tool definitions
   consume more than 10k tokens", "Tool selection accuracy drops as your
   toolset grows", "you aggregate multiple MCP servers", "Your tool library
   grows over time". This repo has been reading the 10k figure as *the* line
   (`docs/research/2026-08-tool-discovery.md` §1,
   `2026-09-19-code-mode-mcp.md` §2.2). It is one of **five**, joined by OR, and
   we are past two of them (§2.1). **This is a correction, not an alarm** — the
   same page's counter-case is "fewer than 10 tools … or definitions under 100
   tokens total", which nobody is.
2. **The cheapest 345 tokens in the repo are a JSON-Schema dialect string.**
   `"$schema":"http://json-schema.org/draft-07/schema#"` is emitted on all 26
   tools by the MCP SDK: **1,378 chars ≈ 345 tokens, 8.2% of the eager
   surface**, for a constant no model reads. That is the `turn_id` finding
   (#222, 944 tokens) again, one order down, and it is larger than any merge
   in §3 (§3.1).
3. **Three trims that remove no capability are worth up to ~991 tokens — 23.5%
   of the surface.** Fully spent they take 4,224 → ~3,234; spent without
   gutting the three descriptions that earn their length, ~695 → ~3,529
   (§3.1–3.3).
4. **The binding constraint is the COUNT, not the tokens.** Headroom is 776
   tokens (~4.8 average tools) but the count ceiling is already
   `COUNT_ACKNOWLEDGED = { brain: 26 }`, so the 27th tool fails CI on the day
   it lands, whatever the trims did. That is by design
   (`ops/scripts/check-tool-surface.mjs:51-52`, `:86`, `:168-197`) and it is the
   right design.
5. **Merging is real but small, and it costs a noun.** The largest honest
   merge — the five `tasks_*` mutators into one — saves **~411 tokens and four
   tools of count**; the lease trio alone saves ~191 and two. Every merge
   trades the glossary rule "one verb set per object" for count headroom
   (§3.4).
6. **Deferral only pays as a GROUP.** `artifacts_*` is 1,124 tokens over six
   tools (26.6%); `tasks_*` is 890 over seven (21.1%). Deferring both, with
   PoC-17's three meta-tools added back, lands at **16 tools / ~2,642 tokens**
   — under both lines with room. Deferring either alone does not get under the
   count line (§3.5).
7. **The PoC-17 rerun is nearly one command already.** `metistry-eval run`
   takes `--tools <file>` — a `tools/list` result JSON — and `tool_calls` is
   already a scored axis (`packages/eval/src/main.ts:194-195`,
   `src/fixtures.ts:25`). What is missing is a lazy surface to feed it and a
   stub that actually answers the meta-tools: **~half a day**, not a harness
   (§4.2). Prepare that now, run it when §4.1's trigger fires.
8. **A `tool_search` meta-tool of our own is still strictly worse than PoC-17's
   mechanism at this size**, and a read-only `compose` is still last (§3.6,
   §3.7) — the code-mode doc's verdicts stand, re-measured against today's
   4,224 rather than the 4,945 it was written against.

---

## 1. Where we are, measured

```
$ node ops/scripts/check-tool-surface.mjs
tool surface (budget: >20 tools / >5000 definition tokens — packages/core/src/manifest.ts)

  bridge    tools         ≈tokens  headroom to the line
  --------  ------------  -------  ------------------------------------------
  apple-fm  2 (declared)  n/a      18 tools
  brain     26            4224     776 tokens, 6 tools OVER (acknowledged 26)
  eventkit  4 (declared)  n/a      16 tools
```

Per tool, by the same method (the real server, a real `tools/list`,
`chars / 4`):

| tool | chars | ~tokens | desc chars | schema chars | of which param prose | params |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| artifacts_publish | 1379 | 345 | 203 | 1076 | 248 | 6 |
| knowledge_write | 1370 | 343 | 575 | 697 | 273 | 4 |
| agents_delegate | 1084 | 271 | 384 | 602 | 177 | 4 |
| artifacts_review | 927 | 232 | 248 | 580 | 0 | 6 |
| artifacts_comment | 920 | 230 | 179 | 641 | 90 | 6 |
| requests_create | 864 | 216 | 247 | 519 | 56 | 5 |
| request_access | 755 | 189 | 293 | 365 | 105 | 2 |
| tasks_create | 681 | 171 | 86 | 500 | 0 | 6 |
| capture | 673 | 169 | 98 | 485 | 164 | 4 |
| knowledge_search | 647 | 162 | 179 | 369 | 74 | 3 |
| knowledge_grep | 600 | 150 | 242 | 261 | 0 | 3 |
| tasks_list | 590 | 148 | 177 | 320 | 65 | 3 |
| tasks_comment | 581 | 146 | 237 | 248 | 0 | 2 |
| knowledge_list | 574 | 144 | 253 | 224 | 0 | 3 |
| queries_run | 547 | 137 | 171 | 282 | 0 | 2 |
| tasks_update | 526 | 132 | 146 | 285 | 0 | 3 |
| artifacts_get | 511 | 128 | 139 | 276 | 0 | 3 |
| tasks_close | 487 | 122 | 177 | 216 | 0 | 2 |
| tasks_thread | 444 | 111 | 165 | 184 | 0 | 1 |
| tasks_claim | 432 | 108 | 101 | 237 | 0 | 2 |
| tasks_release | 432 | 108 | 120 | 216 | 0 | 2 |
| tasks_renew | 412 | 103 | 81 | 237 | 0 | 2 |
| artifacts_resolve | 402 | 101 | 108 | 194 | 0 | 2 |
| knowledge_read | 388 | 97 | 132 | 159 | 0 | 1 |
| artifacts_list | 355 | 89 | 77 | 181 | 0 | 2 |
| queries_list | 288 | 72 | 108 | 85 | 0 | 0 |

```
TOTAL 16,896 chars ≈ 4,224 tokens
  descriptions            4,926 chars (29%)
  schemas                 9,439 chars (56%)
   ├─ per-parameter prose 1,252 chars  (7% of the whole surface)
   └─ schema envelope     2,425 chars (14%) — $schema 1,378 · required 605 · type 442
  name + JSON scaffolding 2,531 chars (15%)
```

Two things the table says that the single number does not:

- **Mean 162 tokens, median 144, and a long head.** The top three tools
  (`artifacts_publish`, `knowledge_write`, `agents_delegate`) are 959 tokens —
  **23% of the surface in three definitions**, and two of the three are
  refused to most principals (`knowledge_write` and `agents_delegate` are
  internal-only: `packages/mcp-brain/src/knowledge-write.ts:305`,
  `crew-tools.ts:112`). An external agent pays 614 tokens every turn for two
  tools it can only be refused by.
- **Schemas are 56% and descriptions 29%.** The `turn_id` removal (#222) took
  schemas from 65% to 56%; the remaining schema weight is real parameters plus
  the envelope in §3.1.

---

## 2. The budget policy

### 2.1 What the vendors actually say, quoted

From Anthropic's tool-search documentation (read in full 2026-09-19), the two
sentences that should govern:

> **Tool selection accuracy:** Claude's ability to pick the right tool
> degrades once you exceed 30–50 available tools.

and, under *When to use tool search* — note the list is joined by **or**:

> Use tool search when any of the following apply:
> * You have 10 or more tools available.
> * Your tool definitions consume more than 10k tokens.
> * Tool selection accuracy drops as your toolset grows.
> * You aggregate multiple MCP servers (200+ tools).
> * Your tool library grows over time.
>
> Standard tool calling, without tool search, is a better fit when you have
> fewer than 10 tools, every tool is used in every request, or your tool
> definitions are small (less than 100 tokens total).

**We meet two of the five and will meet a third.** 26 ≥ 10; the library grows
(25 → 26 in a week); and "accuracy drops as your toolset grows" is the thing
the rerun measures. We meet **none** of the three counter-conditions. This
repo's current reading — "half Anthropic's own 10k activation line"
(`docs/research/2026-09-19-code-mode-mcp.md` §2.2) — treats one item of a
disjunction as the whole test. That reading should be corrected; it does not
change the *recommendation* (the owner has already ruled: eager now, rerun
before switching), but it changes how comfortable 4,224 tokens is allowed to
feel.

Two more sentences from the same page that shape the plan below:

> Keep your 3–5 most frequently used tools non-deferred so Claude can call
> them without searching first.

> the tool definitions that search loads into context count as input tokens
> like any other tool definition.

Deferral does not make a definition free; it makes it **conditional**. The
saving is `(1 − P(used this turn)) × its tokens`, which is why §3.5 is about
groups with low per-turn hit rates rather than about big tools.

### 2.2 Small models: what can be sourced, and what cannot

The honest state of the evidence, because the owner's second instance may run
a local model and the whole budget turns on this.

**What is sourced.** The vLLM semantic-router stress test (already in
`docs/research/2026-08-tool-discovery.md`'s source list; read 2026-09-19)
measured tool-selection accuracy against tool count on four models:

| model | ~50 tools | ~740 tools |
| --- | ---: | ---: |
| Llama-3.1-70B | 95% | 20% |
| Mistral-Large | 94% | 0% |
| BitAgent-8B | 95% | 10% |
| **Granite-3.1-8B** | **84%** | 7% |

and its token figure: 741 tools ≈ 127,315 tokens per request, versus 1,084
with semantic selection.

The reading that matters is not the collapse at 740 — nobody is going there —
it is the **left column**: at ~50 tools an 8B model is already **eleven points
behind** a 70B one. Small models do not have a different cliff; they start
lower on the same curve.

**What is not sourced, and I will not invent.** I could not obtain a
primary measurement at *26* tools, on *a 27–35B model*, for *this* tool
catalog. The Berkeley Function-Calling Leaderboard was checked and its page
does not publish the per-size, per-tool-count breakdown needed. The repo's own
prior figures ("Haiku-class drops below 90% around 10–15 tools; Sonnet
~20–30" — `2026-08-tool-discovery.md` §2) are secondary and the vendor has
since published 30–50 for its own frontier models.

**So the honest position is: the number we need does not exist publicly, and
the only way to get it is to measure it on our own fixtures** — which is
exactly what §4 is for. Any budget stated below is a *policy* chosen under
uncertainty, not a finding.

### 2.3 The proposed caps

Two engine classes, because `compute.yaml` assigns per tier and an install may
be all-local (`docs/ops/compute.md`, `seed/compute.yaml`; the candidate set is
"current Qwen 3.x ~30B MoE and ~32B dense, GLM ~30B-A3B, gemma-4, gpt-oss-20b"
— `docs/research/2026-09-11-local-models-openrouter-opencode.md:455-457`).

| | frontier (cloud, ≥200k window) | local 27–35B |
| --- | --- | --- |
| **hard cap, eager tools** | **26** (today's acknowledged number) | **16** |
| **hard cap, definition tokens** | **5,000** (unchanged) | **3,000** |
| **soft target** | 4,000 | 2,500 |
| rationale for the count | vendor's 30–50 degradation band; stay clear of its floor | the 8B/70B gap at 50 is 11 points, and 16 is where §3.5's group deferral naturally lands |
| rationale for the tokens | unchanged from `packages/core/src/manifest.ts` | a 32k-window local model: 3,000 tokens is 9.4% — at the plan's own "~10% of context" revisit trigger |

Three properties this policy should have, and the first is the one that makes
it enforceable rather than aspirational:

1. **The cap is per *engine class*, and the eager surface is per *principal*.**
   These already compose: `propose_action` is registered only for a credential
   whose autonomy admits an action (`packages/mcp-brain/src/action-tools.ts:71`)
   — SEP-1881's pattern, applied at the tool. The same mechanism can serve a
   *smaller* eager set to a local-model session without a second bridge: the
   principal is known at `tools/list` time (`server.ts:574`), so a
   `surface: "full" | "compact"` on the principal is a filter, not an
   architecture.
2. **The token cap is the budget; the count cap is the decision.**
   `check-tool-surface.mjs` already encodes this
   (`findingsFor`, `:168-197`): crossing tokens is "trim it", crossing the
   acknowledged count is "make the lazy decision, or move the ceiling with a
   reason". Keep both, and add the second column.
3. **A local-model cap is a *ceiling on what is offered*, not a narrower
   product.** Everything trimmed out must remain reachable — via a named query
   (`queries_run`), a merged tool's `op` argument, or discovery — so "runs on a
   local model" never means "can do less".

---

## 3. The levers, cheapest first

Every figure below is measured or estimated from §1's table by a stated
method. "Cheapness" is effort per token, not tokens alone.

### 3.1 `$schema` — 345 tokens (8.2%), a build change

Every tool's `inputSchema` ends with the same 50 characters:

```
queries_list  inputSchema: {"type":"object","properties":{},"$schema":"http://json-schema.org/draft-07/schema#"}
knowledge_read inputSchema: {"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":500}},
                             "required":["path"],"$schema":"http://json-schema.org/draft-07/schema#"}
```

26 of 26 carry it: **1,378 chars ≈ 345 tokens, 8.2% of the eager surface**,
for a dialect declaration the model never reads and which the MCP spec's own
examples omit. It reaches the model: `apps/assistant/src/tools.ts:144` passes
`t.inputSchema` through to the provider's `parameters` unchanged.

**Where it comes from and what removing it costs.** The SDK builds it in its
`tools/list` handler with no option to suppress it
(`@modelcontextprotocol/sdk@1.30.0`,
`dist/cjs/server/mcp.js:77-86` — `toJsonSchemaCompat(obj, {strictUnions: true,
pipeStrategy: 'input'})`). So the bridge would have to own the outbound list:
either register its own `ListToolsRequestSchema` handler, or filter on the way
out. **The in-repo precedent is one line away** — `handle()` already wraps
`transport.onmessage` to rewrite deprecated names and lift a legacy `turn_id`
on the way *in* (`packages/mcp-brain/src/server.ts:591-599`); this is the same
seam in the other direction.

**What I am not certain of, and it is load-bearing:** whether any MCP client
validates `inputSchema` against its declared dialect and would reject a schema
without one. The spec says `inputSchema` is "A JSON Schema object" and its
examples omit `$schema`, and a strict client is free to assume a default
dialect — but this is a wire-visible change to a published package
(`@foldedspacelabs/metistry-mcp-brain`), exactly as `turn_id` was. It is open
question 1.

**Effort:** ~half a day including a conformance test asserting no tool
advertises `$schema`. **Saving: 345 tokens, no capability, no count change.**

### 3.2 Per-parameter prose — up to 313 tokens (7.4%), an editing pass

`.describe()` strings inside schemas total 1,252 chars ≈ 313 tokens,
concentrated in five tools:

| tool | param prose |
| --- | ---: |
| knowledge_write | 273 |
| artifacts_publish | 248 |
| agents_delegate | 177 |
| capture | 164 |
| request_access | 105 |
| artifacts_comment | 90 |
| knowledge_search | 74 |
| tasks_list | 65 |
| requests_create | 56 |

Not all of it should go: `knowledge_write`'s `expected_sha256` description is
the whole compare-and-swap protocol, and deleting it would trade tokens for
tool errors. But note the vendor's line — tool search "searches tool names,
descriptions, **argument names, and argument descriptions**" — so argument
prose is retrieval surface under a lazy scheme and dead weight under an eager
one. **Target ~150 of the 313**, on the four tools where the prose restates
the type (`capture`'s `mime`, `tasks_list`'s `filter` enum, `requests_create`'s
`refs`). **Effort:** an afternoon; the risk is a regression in argument
accuracy, which the `tool_calls` eval axis already measures.

### 3.3 Top-level descriptions — 333 tokens (7.9%) at a 160-char cap

| cap | saved chars | ≈tokens | % of surface |
| ---: | ---: | ---: | ---: |
| 200 | 882 | 221 | 5.2% |
| **160** | **1,330** | **333** | **7.9%** |
| 120 | 1,987 | 497 | 11.8% |

Fifteen tools are over 160 chars; nine are over 200. The outlier is `knowledge_write` at **575** —
three sentences carrying the write protocol, the ownership refusal and the
protected-path rule (`server.ts:503-505`). That one earns its length: it is
the only mutating knowledge tool and its description is load-bearing
documentation for a model that has no other copy of the rule. `request_access`
(293) and `agents_delegate` (384) are similar.

**So the honest target is not a cap but a pass**, worth perhaps 200 of the 333,
and it is the lever I would rank *last* of the three trims: descriptions are
what a model uses to choose, and §2.2's evidence says a smaller model needs
*more* help choosing, not less. **Do 3.1 and 3.2 first.**

**Trims combined, fully spent: ~991 tokens (23.5%), taking 4,224 → ~3,234.**
**Recommended, keeping the descriptions that earn their length: ~695 tokens
(16.5%), taking 4,224 → ~3,529.** No capability removed, no tool removed.
Phase 1 is the first two (§3.1 + §3.2's target) at ~495.

### 3.4 Merging siblings

Method, stated so the numbers can be checked: for a group, `before` is the sum
of the members; `after` is the largest member's non-schema part, plus the
**union** of all members' properties (taking the largest definition of each
shared name), plus a discriminator enum, plus 80 chars of envelope. It never
estimates below the largest member, so it is conservative.

| merge | tools | before | after | **saves** | count |
| --- | ---: | ---: | ---: | ---: | ---: |
| **the five `tasks_*` mutators** (`claim`/`renew`/`release`/`update`/`close`) | 5 | 573 tok | ~162 | **~411 tok (9.7%)** | **−4** |
| lease trio (`claim`/`renew`/`release`) | 3 | 319 | ~129 | ~191 (4.5%) | −2 |
| `requests_create` + `request_access` | 2 | 405 | ~286 | ~120 (2.8%) | −1 |
| `knowledge_search` + `knowledge_grep` | 2 | 312 | ~195 | ~118 (2.8%) | −1 |
| `tasks_update` + `tasks_close` | 2 | 254 | ~140 | ~114 (2.7%) | −1 |
| rooms (`tasks_comment` + `tasks_thread`) | 2 | 257 | ~151 | ~106 (2.5%) | −1 |
| `artifacts_comment` + `artifacts_resolve` | 2 | 331 | ~257 | ~74 (1.7%) | −1 |
| `knowledge_list` + `knowledge_read` | 2 | 241 | ~169 | ~72 (1.7%) | −1 |
| `artifacts_get` + `artifacts_list` | 2 | 217 | ~160 | ~58 (1.4%) | −1 |

Three things to weigh against the numbers:

- **The glossary rule is a real cost.** "One noun per thing, one verb set per
  object" is why `tasks_list_ready` + `tasks_mine` already folded into
  `tasks_list {filter}` (`server.ts:109-112`) — and that fold *paid for*
  `knowledge_list`/`knowledge_grep`. A `tasks_lease {op}` merge is the same
  move and is defensible; `knowledge_list` + `knowledge_read` is not — listing
  and reading are different verbs on the same noun, and the grant tiers treat
  them differently (`canList` vs `canRead`,
  `packages/mcp-brain/src/knowledge.ts:132-133`).
- **Merging hurts retrieval under a lazy scheme.** A `tasks_mutate` whose
  description must cover five operations is a worse search target than five
  precise names — the vendor's own advice is "clear, descriptive tool names"
  and namespacing. So §3.4 and §3.5 partly *compete*; choose one per group.
- **`rooms` is a grant boundary, not just a pair.** `tasks_comment` and
  `tasks_thread` are their own crew group precisely so speaking is a separate
  power (`packages/core/src/manifest.ts:183`, the `rooms` comment). Merging
  them with anything outside the group would break that; merging them with
  each other is safe and saves 106.

**Recommended if a merge is needed: the lease trio only** (~191 tokens, −2
count, one coherent verb set, no grant boundary crossed). The full five-way
`tasks_*` merge is the bigger prize and should wait for the same decision that
picks §3.5, because it is the group most likely to be deferred instead.

### 3.5 Deferral, by group

PoC-17's mechanism is `discovery: lazy` with three frozen meta-tool names —
`tool_index` / `execute` / `batch` (`metistry-build-plan.md:1097-1099`,
`packages/core/src/manifest.ts:46`). What each group costs today:

| group | tools | ≈tokens | share | deferrable? |
| --- | ---: | ---: | ---: | --- |
| artifacts | 6 | 1,124 | 26.6% | **yes** — a crew gains it only via `uses: artifacts`; whole turns never touch it |
| tasks | 7 | 890 | 21.1% | **yes** — but `tasks_list` is a hot path; keep it eager (the vendor's "3–5 most frequently used non-deferred") |
| knowledge (read) | 4 | 553 | 13.1% | **no** — this is the assistant's reason to exist |
| requests | 2 | 405 | 9.6% | no — `requests_create` is how anything reaches the owner |
| knowledge_write | 1 | 343 | 8.1% | **yes for external/crew** — already refused to them (`knowledge-write.ts:305`) |
| crews (`agents_delegate`) | 1 | 271 | 6.4% | **yes for external/crew** — already refused (`crew-tools.ts:112`) |
| rooms | 2 | 257 | 6.1% | yes — gated by `uses: rooms` anyway |
| queries | 2 | 209 | 4.9% | no — 209 tokens front 21 named queries (a ~90% saving; code-mode doc §2.3 measured 20) |
| capture | 1 | 169 | 4.0% | no — tier-0's whole surface |

Arithmetic on the two candidates, meta-tools added back at the median tool
size (~144 tokens each, ~432 for three):

| shape | tools | ≈tokens | under 20/5000? | under 16/3000? |
| --- | ---: | ---: | --- | --- |
| today | 26 | 4,224 | no (count) | no |
| + §3.1–3.3 trims (fully spent) | 26 | ~3,234 | no (count) | no |
| defer artifacts | 26−6+3 = 23 | ~3,532 | no (count) | no |
| defer tasks | 26−7+3 = 22 | ~3,766 | no (count) | no |
| **defer artifacts + tasks** | **16** | **~2,642** | **yes** | **yes on count; tokens close** |
| **trims (fully spent) + defer artifacts + tasks** | **16** | **~2,124** | **yes** | **yes** |

**The last row is the destination**, and it is worth naming now so the phases
have somewhere to go: 16 eager tools at ~2,100 definition tokens is inside
every figure in §2, frontier and local, with headroom for two more tools.

**The two free wins hiding in this table**: `knowledge_write` and
`agents_delegate` are 614 tokens (14.5%) that *no external or crew principal
can ever successfully call*. They are eager today for a stated and good reason
— "a refusal an agent can read once is worth more than a tool it never learns
exists" (`server.ts:161-167`). That reasoning is sound for `request_access`
(which teaches a *remedy*). It is weaker for these two, whose refusal teaches
"use `requests_create` instead" — one sentence that could live in
`requests_create`'s own description for ~20 tokens instead of 614. **Moving
those two behind the principal filter is the single largest capability-neutral
saving available, and it needs no lazy mechanism at all** — just the
conditional registration `propose_action` already uses
(`action-tools.ts:71`). Open question 2.

### 3.6 A `tool_search` meta-tool of our own

Measured: a name + description index of all 26 tools is **6,000 chars ≈ 1,500
tokens** — *more than a third of the entire eager surface, per search*. Names
alone are 425 chars ≈ 107 tokens, but names alone are not a usable index.

So a search that returns the whole index costs more than it saves, and a
search that returns a subset has the retrieval-quality failure mode
`2026-08-tool-discovery.md` §3 already named ("lazy setups fail by *missing*
the right tool at search time"). The code-mode doc's verdict — "strictly worse
than `discovery: lazy` at our size" (§3.6(d)) — **holds, and is now
quantified.** If a search-shaped thing is ever wanted, it should be PoC-17's
`tool_index` with a `group` argument, not a semantic search.

### 3.7 The read-only `compose` subset — still last

Unchanged from `docs/research/2026-09-19-code-mode-mcp.md` §4.1 (**later,
gated on a measurement**), with the owner's rulings recorded there: the reach
reading of invariant 9 stands, and an unaudited sandbox in the console process
is "audited preferred; best-in-class first".

One number to re-state against today's surface: `compose` would carry
TypeScript declarations for the ten read tools of that doc's §3.5, whose
definitions total **1,238 tokens today** (§1's table, summed over
`knowledge_search/read/list/grep`, `queries_list/run`, `tasks_list/thread`,
`artifacts_get/list`) — down from the **1,583** that doc measured for the same
ten, because of the `turn_id` trim. So `compose` remains an **added** eager
cost until a turn uses it, and the thing it would replace got 22% cheaper
while it waited. It does not belong in this plan's phases; it belongs to the
measurement in that doc's §4.4 step 1, which needs the owner's database.

### 3.8 The decision table

| lever | decision | measured saving | count | effort |
| --- | --- | --- | --- | --- |
| **Drop `$schema` from 26 schemas** | **Yes — first** | **345 tok (8.2%)** | 0 | ~half a day |
| **Trim per-parameter prose on 4 tools** | **Yes** | ~150 of 313 tok | 0 | an afternoon |
| **Tighten 9 over-long descriptions** | **Yes, selectively** | ~200 of 333 tok | 0 | an afternoon |
| **Add the second (local) column to `check-tool-surface.mjs`** | **Yes** | 0 — it is the policy | 0 | ~half a day |
| **Prepare the PoC-17 rerun (§4.2)** | **Yes — now, so the trigger is one command** | 0 | 0 | ~half a day |
| **Ship a lazy surface** | **No — not until §4.1 fires** | up to ~2,000 tok | −10 | 2–3 days |
| **Merge the lease trio** | **Only if the 27th tool is coming** | ~191 tok | −2 | 1 day + a changeset |
| **Merge all five `tasks_*` mutators** | **No — it competes with deferring them** | ~411 tok | −4 | 1–2 days |
| **Defer `knowledge_write` + `agents_delegate` per principal** | **Yes if OQ2 says so** | **614 tok (14.5%)** | −2 for most | ~1 day |
| **A `tool_search` meta-tool** | **No** | negative at 26 | — | — |
| **Read-only `compose`** | **No — later, per the code-mode doc** | adds ~1,240 eager | +1 | 3–5 days after a sandbox |

---

## 4. The trigger

### 4.1 The measurement that says "switch now"

Switching is **per engine class**, not global, and it fires when **either**
condition below holds for that class:

**Condition A — the static one, checkable in CI today.**
The eager surface crosses that class's cap in §2.3 and no trim from §3.1–3.3
is left unspent. For frontier: 27 tools or 5,000 tokens. For local: 17 tools
or 3,000 tokens. This is `check-tool-surface.mjs` with a second column; it
needs no model and no fixtures, and it is what makes "we are close" a fact
rather than a feeling.

**Condition B — the behavioural one, which is PoC-17's rerun.**
Run the eager and lazy arms on the owner's own fixtures, on the engine that
class will actually use, and switch only if **all four** hold:

1. lazy does **not** lose pass rate on axis `tool_calls` (the axis already
   exists: `packages/eval/src/fixtures.ts:25`, scored deterministically,
   `:29`);
2. lazy cuts **cumulative** `prompt_tokens` by **>15%** across the case (not
   per turn — PoC-17's original loss was +34% cumulative because of the extra
   round trip, and cumulative is the only honest axis);
3. `steps` rises by **≤1** on the median case;
4. `cache_read_tokens` is recorded for both arms and the saving survives it —
   definitions are the most cacheable part of a request, so a `prompt_tokens`
   win on an uncached run can be a wash on a cached one. Both columns already
   exist (`packages/core/src/runs.ts`) and `engine-openai.ts` populates them.

State the four **before** running, so the result cannot be read to taste. This
is the same discipline the code-mode doc's §4.4 step 3 imposes, with the
threshold set lower (15% vs 25%) because lazy has no sandbox to pay for.

**Where the call-frequency input comes from.** Which tools may be deferred is
an empirical question the owner's database can answer and this research cannot.
The query — a named query, per invariant 3, so it is reusable and reviewable —
is described here and **not run**:

```yaml
# seed/queries/tool_call_frequency.yaml  (proposed; not written)
name: tool_call_frequency
description: >-
  How often each mcp-brain tool was actually called, per caller, over the last
  `days` days — the input to the deferral decision. Counts only; no arguments,
  no paths, no text.
params:
  days: { type: int, default: 30 }
sql: |
  SELECT tool,
         component                                   AS caller,
         count(*)                                    AS calls,
         count(*) FILTER (WHERE ok)                  AS ok,
         count(DISTINCT meta ->> 'turn_id')          AS turns,
         max(ts)                                     AS last_called
  FROM runs
  WHERE kind = 'tool'
    AND ts >= now() - make_interval(days => (:days)::int)
  GROUP BY tool, component
  ORDER BY count(*) DESC, tool COLLATE "C", component COLLATE "C"
```

Why this works without changing anything: every `/mcp` call already writes one
two-phase row with `kind: 'tool'`, `tool: <primary name>`,
`component: principal.id` and `meta.turn_id`
(`packages/mcp-brain/src/server.ts:272-273`), and a call made under a
deprecated spelling is recorded under the **primary** name with the alias in
`meta.alias` (`:271`), so the counts are honest. `component` separates the
assistant from each crew from each foreign agent — which matters, because a
crew's surface is already narrowed client-side and its zeros mean something
different from the assistant's.

**Read it as: a tool with zero calls in 30 days across every caller is a
deferral candidate; a tool in the top five for the assistant stays eager
forever** (the vendor's own "keep your 3–5 most frequently used tools
non-deferred"). The query returns only tools that were called, so the
zero-call set is the difference against `toolSurface()` — computed by the
runner, not by SQL, so the query stays a pure aggregate.

`expose: generic` is right for it: aggregate counts over tool names the
operator already knows, no paths, no text.

### 4.2 What to prepare so the rerun is one command

**Most of it exists, and that is the routing feedback worth having.**
`metistry-eval run` already accepts `--tools <file>` and parses it as a
`tools/list` result (`packages/eval/src/main.ts:194-195`), falling back to
`brainToolDefs()` — which asks the real bridge. `tool_calls` is already a
scored axis. So the A/B is three commands away from existing, not a harness
away.

What is missing, in order:

1. **`toolSurfaceLazy()` in `packages/mcp-brain/src/surface.ts`** — the same
   in-process server, returning the three frozen meta-tools plus the
   non-deferred set. ~40 lines beside the existing `toolSurface()`, and it
   gives `check-tool-surface.mjs` a "what lazy would cost" column for free.
2. **The stub must answer the meta-tools.** `packages/eval/src/tools.ts` is
   record-only by design ("THE EXECUTION IS STUBBED, RECORD-ONLY"), so a lazy
   arm would call `tool_index` and get a stub back — the case could never
   complete. It needs `tool_index` to return the real index and `execute` to
   dispatch to the same stub the eager arm uses. ~30 lines, and it must be
   marked as harness-only in the PR.
3. **`ops/scripts/rerun-poc17.sh`** — the one command:
   ```
   node ops/scripts/check-tool-surface.mjs --json > /tmp/surface.json
   node -e '…toolSurface()…'     > /tmp/eager.json
   node -e '…toolSurfaceLazy()…' > /tmp/lazy.json
   metistry-eval run --candidate <name> --tools /tmp/eager.json --run-file runs/eager.jsonl
   metistry-eval run --candidate <name> --tools /tmp/lazy.json  --run-file runs/lazy.jsonl
   metistry-eval report --bar runs/eager.jsonl runs/lazy.jsonl
   ```
   The candidate is a `{provider, model, server, effort}` row
   (`packages/eval/src/record.ts:33-45`), so "per engine class" is just two
   invocations.
4. **The fixtures.** The owner's fifty, harvested to
   `<instance>/.metistry/eval/fixtures-harvest.jsonl`
   (`docs/plan-refresh-2026-09-13.md` §4a) — **not read here**. The rerun is
   only as good as these, and they are the one input research cannot supply.

**Total preparation: ~half a day**, and it should happen now rather than when
the trigger fires, because the value of a trigger is that nothing has to be
built the day it goes off.

---

## 5. The phased plan

| phase | what | when to revisit |
| --- | --- | --- |
| **P0 — now (~1 day)** | `$schema` out (§3.1); per-parameter prose pass (§3.2); the second column in `check-tool-surface.mjs` (§2.3). **~500 tokens, no capability, no count change.** | At the next tool. The trims are one-time; spending them and *then* adding a tool is the order that keeps CI honest. |
| **P1 — now (~half a day)** | Prepare the rerun: `toolSurfaceLazy()`, the meta-tool stub, `rerun-poc17.sh` (§4.2). Nothing ships to production. | When the owner assigns a local model in `compute.yaml` — that is the day the second column starts binding. |
| **P2 — the next tool** | The 27th tool forces the decision `check-tool-surface.mjs` already promises. Options, in order: spend §3.3's description pass; defer `knowledge_write` + `agents_delegate` per principal (§3.5, **614 tokens**, needs OQ2); merge the lease trio (§3.4, −2 count). | Immediately — this is the decision point, not a phase with a date. |
| **P3 — when §4.1 condition A or B fires** | Run the rerun. If it passes the four bars, ship `discovery: lazy` for the artifacts and tasks groups: **16 tools / ~2,100–2,600 tokens** depending on how much of P0 was spent (§3.5). If it fails, record why and spend P2's levers instead. | Re-run per engine class whenever `compute.yaml`'s default assignment changes family or size. |
| **P4 — deferred indefinitely** | Read-only `compose` (§3.7), gated on the code-mode doc's §4.4 step 1 (does an intermediate-results problem exist at all?) and on a sandbox the owner will accept. | When a Messages-API engine kind lands, at which point programmatic tool calling arrives free and P4 is moot (code-mode doc §1.3). |

One rule across all of them, and it is the one that has actually held the line
so far: **a new READ capability is a named query behind `queries_run`, not a
new tool** (`docs/ops/assistant-tools.md`, ruled 2026-09-19). 21 named queries
(19 servable through `queries_run` — `knowledge_pages` and
`knowledge_page_links` are `expose: route`) cost 209 eager tokens today; a 21st costs ~120 tokens of *deferred* index and
zero eager. No lever in §3 comes close to that ratio, and it is the reason the
surface grew by exactly one tool in the week this was written.

---

## 6. Open questions (the owner's)

1. **Is `$schema` worth a wire change?** (§3.1) 345 tokens against owning the
   `tools/list` handler in a published package, plus one prompt-cache write at
   a release boundary. Same shape as the `turn_id` question, one order smaller
   — and the same answer would be consistent. The uncertainty I cannot resolve
   is whether any client validates against the declared dialect.
2. **Should `knowledge_write` and `agents_delegate` be registered per
   principal?** (§3.5) 614 tokens — 14.5%, the largest capability-neutral
   saving available — for external and crew principals who can only ever be
   refused by them. The counter-argument is in the code today
   (`server.ts:161-167`) and it is a good one: a refusal an agent reads once
   teaches it the rule. My read is that the rule can be taught in
   `requests_create`'s description for ~20 tokens, but it is a
   teach-versus-tokens judgement and it is yours.
3. **Is the local cap 16 tools / 3,000 tokens?** (§2.3) Chosen under
   uncertainty — §2.2 is explicit that the number we want does not exist
   publicly. It is where §3.5's natural grouping lands and where a 32k window
   hits the plan's own 10% line. Ratify it, or set a different one and let CI
   enforce that instead.
4. **Does the eager surface become per-principal-class?** (§2.3 property 1) A
   `surface: "full" | "compact"` on the principal is a small change with a
   large consequence: two instances of the same product would advertise
   different tool sets. That is already true of `propose_action`, so the
   precedent exists — but making it a *class* is a product decision.
5. **When does the rerun run?** (§4.1) Condition A is automatic. Condition B
   needs the owner's fixtures and a decision about which engine to run it
   against. The cheapest version is: run it once against the current frontier
   assignment as a baseline the day P1 lands, so the first local-model run has
   something to be compared to.

---

## Contradictions and corrections

Reported, not routed around (CLAUDE.md), and nothing below is acted on.

- **There are no `board_*` tools.** The brief names "the three `board_*`" as a
  merge candidate. `board` and `board_projects` are **named queries**
  (`seed/queries/board.yaml`, `board_projects.yaml`; `docs/ops/board.md:16`),
  reached through `queries_run` and `GET /api/q/`. They cost **zero** eager
  tokens — which is the named-query rule working exactly as intended, and the
  best argument in this document for it. The nearest real sibling sets are
  costed in §3.4.
- **The "10k activation line" has been read as a threshold; it is one item of
  a disjunction** (§2.1). `docs/research/2026-08-tool-discovery.md` §1 ("Claude
  Code's own MCP Tool Search activates only when tool descriptions exceed ~10k
  tokens — i.e. the vendor itself gates lazy behind a size threshold") and
  `2026-09-19-code-mode-mcp.md` §2.2 ("half Anthropic's own 10k activation
  line") both rest on it. The same page also says "use tool search when … you
  have 10 or more tools available". **Neither doc is edited here.**
- **`metistry-build-plan.md` §4.3 still cites 10–15 tools** as the
  selection-accuracy window, which the owner ruled superseded on 2026-09-19
  (`2026-08-tool-discovery.md` §2's update carries it). The plan is not edited
  here — flagged for the third time, and it is now the only place in the repo
  still citing the old figure.
- **`packages/mcp-brain/src/surface.ts:36`** measures the budget against a
  principal with `{tier: "areas", areas: []}` and `queries: true` — a grant the
  console's own validator would refuse (`apps/console/src/agents.ts:165`).
  Harmless (it is a harness whose purpose is to see every eager tool) and worth
  knowing when reading the number: it is the *widest* eager surface, which is
  the right thing to budget, but it is not a grant any real agent holds.

---

## Sources

Fetched and read in full on 2026-09-19 unless noted.

- [Claude platform docs, "Tool search tool"](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  — the 30–50 degradation figure; the five-item *when to use* disjunction and
  its three-item counter-case; "keep your 3–5 most frequently used tools
  non-deferred"; "the tool definitions that search loads into context count as
  input tokens like any other tool definition"; "the API excludes deferred
  tools from the system-prompt prefix … the prefix is untouched, so prompt
  caching is preserved"; a deferred tool may not carry `cache_control`;
  ~55k typical multiserver definitions, >85% reduction.
- [vLLM semantic router, "Semantic tool selection"](https://vllm-sr.ai/blog/semantic-tool-selection/)
  — the stress-test table in §2.2 (Llama-3.1-70B 95%→20%, Mistral-Large
  94%→0%, BitAgent-8B 95%→10%, Granite-3.1-8B 84%→7% between ~50 and ~740
  tools); 741 tools ≈ 127,315 tokens vs 1,084 with selection.
- [Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
  — **checked and did not yield** the per-size, per-tool-count breakdown §2.2
  needs; recorded so the gap is visible rather than papered over.
- `@modelcontextprotocol/sdk@1.30.0`, `dist/cjs/server/mcp.js:70-101` —
  the `tools/list` handler and `toJsonSchemaCompat`, read on disk.

Repo facts cite `file:line` against this checkout at `47fe7c5`. Prior art this
builds on rather than repeats: `docs/research/2026-08-tool-discovery.md`
(PoC-17, the eager/lazy line, the 2026-09-19 update),
`docs/research/2026-09-19-code-mode-mcp.md` (the compose verdict, the named-query
measurement, the owner's six rulings),
`docs/research/2026-09-cost-optimization.md` (prompt-cache hygiene),
`docs/ops/assistant-tools.md` ("a new read capability is a named query").
