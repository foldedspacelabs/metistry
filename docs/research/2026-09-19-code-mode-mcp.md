# Code-mode MCP — fit and recommendation (2026-09-19)

Research commissioned by the owner the same day: *"we should consider 'code
mode MCP' as an improvement … let agents compose their toolset and data shape
based on their needs … Having used GraphQL in the past, vs Rest, it seems like
a similar idea."*

Nothing here is built. The sources were read in full and are cited with dates.
**Every number about Metistry below was measured on this checkout on
2026-09-19** by standing up the real `mcp-brain` server in-process and reading
its `tools/list` — the same thing `packages/eval/src/tools.ts` does, so these
are production's definitions and not a snapshot. Command output is printed
verbatim. The owner's instance was not read.

## The short version

1. **Code Mode is two separable ideas.** *Fewer definition tokens* (one `code`
   tool instead of N tools) and *fewer intermediate-result tokens* (filter and
   join inside the sandbox). The published wins are almost entirely the first,
   measured on surfaces 50–500× larger than ours.
2. **Our definition surface is 4,945 tokens across 25 tools** — 2.5% of a 200k
   window, **half** Anthropic's own 10k activation line for tool search, and a
   quarter of the plan's §4.3 revisit trigger (~10% of context). The problem
   the technique solves is not present yet (§2).
3. **The second idea we already have, twice.** `queries_list` + `queries_run`
   puts 20 named queries behind **284 tokens** of always-on definitions instead
   of **2,936** — a 90% reduction on that slice, with no sandbox. That *is* the
   GraphQL analogy, and invariant 3 is what made it possible (§2.3).
4. **The cheapest real win is not architectural.** The `turn_id` correlation
   handle, merged into all 25 schemas, costs **950 tokens — 19.2% of the entire
   eager surface**. Recovering ~750 of them is a description edit (§2.4). No
   composition scheme on this surface saves more.
5. **Invariant 9 survives a read-only compose tool, and invariant 10 decides
   its shape**: the capability proxy may carry reads only, because a script
   that could mutate would be a new mutating surface arriving by prompt rather
   than by product change (§3.5).
6. **The sandbox is the whole cost, and every candidate is bad for us right
   now.** Cloudflare's is cloud-only; `node:vm` is documented as not a security
   mechanism; `vm2` has ten published advisories, six critical sandbox escapes;
   `isolated-vm` is a native addon requiring Node ≥ 24 against our pinned
   22.23.2, compiled at install on a Mac we promise needs no build tools;
   QuickJS-in-WASM is the only one that fits and is explicitly unaudited (§3.2).
7. **Anthropic ships a first-party version that costs us no sandbox at all** —
   programmatic tool calling — and we cannot reach it, because our engine
   speaks the OpenAI-compatible wire and PTC is Messages-API-only. That is the
   real reason the answer is *later* rather than *no* (§1.3).
8. **Recommendation: not now. Do the four cheap things, keep the door open,
   and re-ask when a measurement says to** (§4). One contradiction with the
   plan is reported rather than routed around (§2.5).

---

## 1. What Code Mode actually is

### 1.1 Cloudflare — the client-side original, then the server-side one

**Post 1, "Code Mode: the better way to use MCP"** (blog.cloudflare.com/code-mode/,
published **2025-09-26**). The argument is about training distribution, stated
plainly:

> LLMs have seen a lot of code. They have not seen a lot of "tool calls". In
> fact, the tool calls they have seen are probably limited to a contrived
> training set constructed by the LLM's own developers […] Whereas they have
> seen real-world code from millions of open source projects.

The mechanism: MCP tool schemas are converted to a documented TypeScript API,
the model writes TypeScript against it, and

> The code is then executed in a secure sandbox. The sandbox is totally
> isolated from the Internet. Its only access to the outside world is through
> the TypeScript APIs representing its connected MCP servers. These APIs are
> backed by RPC invocation which calls back to the agent loop.

The sandbox is a **V8 isolate**, created per snippet through a new **Worker
Loader API** — "An isolate can start in a handful of milliseconds using only a
few megabytes of memory." The guest's `env` receives *bindings* back to the
parent Worker's RPC interfaces, and `globalOutbound` either proxies or (passing
`null`) blocks all network access.

**Post 2, "Code Mode: give agents an entire API in 1,000 tokens"**
(blog.cloudflare.com/code-mode-mcp/, published **2026-02-20**, modified
2026-07-15). This is the server-side shape, and it carries the headline number:

> With just two tools, search() and execute(), the server is able to provide
> access to the entire Cloudflare API over MCP, while consuming only around
> 1,000 tokens. […] For a large API like the Cloudflare API, Code Mode reduces
> the number of input tokens used by 99.9%. An equivalent MCP server without
> Code Mode would consume 1.17 million tokens.

and the sandbox description:

> Both tools run the generated code inside a Dynamic Worker isolate — a
> lightweight V8 sandbox with no file system, no environment variables to leak
> through prompt injection and external fetches disabled by default.

**The docs page** (developers.cloudflare.com/agents/model-context-protocol/codemode/,
last updated **2026-06-24**) names the two patterns — `codeMcpServer()` wraps an
existing MCP server behind one `code` tool whose *description carries generated
TypeScript definitions for every upstream tool*; `openApiMcpServer()` is the
`search`/`execute` pair. Its authorization paragraph is the one that matters
to us, verbatim:

> Model-written code runs in an isolated Worker. Direct outbound network access
> is blocked by default. Generated code reaches external systems only through
> upstream MCP tools or a host-provided request callback.
>
> **Code execution does not replace authorization.** Enforce permissions and
> any required approval inside upstream tool handlers or the host request
> callback before applying side effects.

That is "enforce at the tool, never by prompting" in Cloudflare's own words.
It is the reason a compose tool is *arguable* here at all: the sandbox is not
where the policy lives.

### 1.2 Anthropic — "Code execution with MCP"

anthropic.com/engineering/code-execution-with-mcp, published **2025-11-04**.
Same two problems, named separately: tool definitions occupying context, and
every intermediate result having to traverse the model. Its headline is the
one the industry quotes:

> This reduces the token usage from 150,000 tokens to 2,000 tokens — a time and
> cost saving of 98.7%.

and its caveat is the one the industry does not:

> Running agent-generated code requires a secure execution environment with
> appropriate sandboxing, resource limits, and monitoring. These infrastructure
> requirements add operational overhead and security considerations that direct
> tool calls avoid.

Both headline figures — 98.7% and 99.9% — are *ratios on definition tokens for
very large catalogs*. Neither is a measurement of an agent completing a task.

### 1.3 The honest number, and the version we cannot reach

Anthropic's **programmatic tool calling** (platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
is the same idea shipped as an API feature, and it publishes an end-to-end
number rather than a ratio:

> On agentic search benchmarks like BrowseComp and DeepSearchQA […] adding
> programmatic tool calling on top of basic search tools improved performance
> by an average of 11% while using **24% fewer input tokens**.

24%, not 98.7%. That is the number to plan against.

Three facts about PTC decide our answer more than anything else in this doc:

- **The sandbox is Anthropic's.** Claude writes code in a code-execution
  container; when that code calls one of our tools, the call comes back out to
  the client as an ordinary `tool_use` block carrying a `caller` field. **We
  execute it exactly as today** — same bearer, same `/mcp`, same `runs` row.
  The audit trail is untouched.
- **Its gate is not a boundary, and Anthropic says so**: "`allowed_callers`
  controls how the tool is presented to Claude and is validated against
  `tool_choice`, but it is not a hard API-level block on direct invocation. […]
  **Do not rely on `allowed_callers` as a security boundary.**" Any
  read-only/mutating split must be enforced by us, at `/mcp`.
- **We cannot use it.** PTC is listed for the Claude API, Claude Platform on
  AWS and Microsoft Foundry, requires the `code_execution_20260120` tool, and
  is "not eligible" for ZDR. Our engine is `engine-openai.ts` — one
  OpenAI-compatible loop over `fetch`, ruled 2026-09-11 — and reaches Claude
  *through* a provider like OpenRouter. PTC is not on that wire.

`apps/assistant/src/engine.ts` already says a second engine kind is additive
("a native Messages adapter … is additive"). If one is ever built for other
reasons, code mode arrives as a request field. That is why §4 says *later*.

### 1.4 What the MCP spec itself says

The spec (modelcontextprotocol.io/specification/**2025-11-25**/server/tools) has
no notion of code execution and **no tool-result size limit**. What it does have
is the set of answers it reached instead:

- `tools/list` **is paginated** (`cursor` / `nextCursor`) and
  `notifications/tools/list_changed` exists — so a server may already vary what
  it lists, per client, over time.
- `resource_link` content: "A tool **MAY** return links to Resources […] the
  tool will return a URI that can be subscribed to or fetched by the client."
  This is the spec's answer to a large tool result — hand back a handle, not
  the bytes.
- `outputSchema` + `structuredContent` for typed results.

Two SEPs went at the problem directly and **both are closed**, because SEPs
moved from issues to pull requests (maintainer comment, 2026-06-24):

- **SEP-1881, Scope-Filtered Tool Discovery** (opened 2025-11-23, closed
  2026-06-24): "`tools/list` returns **only** tools for which the current
  access token satisfies the tool's authorization requirements." *This is
  already what mcp-brain does* — `propose_action` is registered only for a
  principal whose autonomy table admits an action, and a crew sees only its
  `uses` groups. We implement the pattern the spec declined to standardise.
- **SEP-1888, Progressive Disclosure for Typed Library Discovery** (opened
  2025-11-24, closed 2025-12-04): one `<library>.searchTools` meta-tool with
  `mode: "operations" | "types"`. Explicitly motivated by Anthropic's code-
  execution post.

**Conclusion for §1:** there is no standards-track path to adopt. Code mode is
a *server implementation choice*, which is good news — it means we could do a
narrow version without waiting for anyone, and bad news — it means no one else
maintains the sandbox for us.

---

## 2. Our problem, measured

### 2.1 The whole surface is one bridge

The assistant's entire MCP surface is `mcp-brain`, mounted at the console's
`POST /mcp` (`apps/console/src/server.ts:488`), and nothing else:
`apps/assistant/src/brain.ts` builds `allowedTools` from `BRAIN_TOOLS`,
built-in tools are disabled, `strictMcpConfig` refuses any other server
(`docs/ops/assistant-tools.md`). **EventKit and Apple-FM are not tools at all**
— they are HTTP bridges with REST routes (`GET /check`, …), reached by the
router and collectors, never listed to a model. So the surface is exactly what
`tools/list` returns from `mcp-brain`.

Measured live, 2026-09-19, against the real server with a fake `Db`:

```
### external/internal agent (no autonomy record): 25 tools, 19777 chars, ~4945 tokens (chars/4)
| tool | chars | ~tokens | desc chars | schema chars | params |
| --- | ---: | ---: | ---: | ---: | ---: |
| artifacts_publish | 1530 | 383 | 205 | 1227 | 7 |
| knowledge_write   | 1521 | 381 | 577 |  848 | 5 |
| agents_delegate   | 1235 | 309 | 386 |  753 | 5 |
| artifacts_review  | 1078 | 270 | 250 |  731 | 7 |
| artifacts_comment | 1071 | 268 | 181 |  792 | 7 |
| requests_create   | 1015 | 254 | 249 |  670 | 6 |
| tasks_create      |  832 | 208 |  88 |  651 | 7 |
| capture           |  824 | 206 | 100 |  636 | 5 |
| knowledge_search  |  798 | 200 | 181 |  520 | 4 |
| knowledge_grep    |  751 | 188 | 244 |  412 | 4 |
| tasks_list        |  741 | 186 | 179 |  471 | 4 |
| tasks_comment     |  732 | 183 | 239 |  399 | 3 |
| queries_run       |  698 | 175 | 173 |  433 | 3 |
| tasks_update      |  677 | 170 | 148 |  436 | 4 |
| artifacts_get     |  662 | 166 | 141 |  427 | 4 |
| tasks_close       |  638 | 160 | 179 |  367 | 3 |
| tasks_thread      |  595 | 149 | 167 |  335 | 2 |
| knowledge_list    |  588 | 147 | 164 |  329 | 3 |
| tasks_claim       |  583 | 146 | 103 |  388 | 3 |
| tasks_release     |  583 | 146 | 122 |  367 | 3 |
| tasks_renew       |  563 | 141 |  83 |  388 | 3 |
| artifacts_resolve |  553 | 139 | 110 |  345 | 3 |
| knowledge_read    |  539 | 135 | 134 |  310 | 2 |
| artifacts_list    |  506 | 127 |  79 |  332 | 3 |
| queries_list      |  438 | 110 | 110 |  235 | 1 |
TOTAL: 19777 chars | descriptions 4592 (23%) | schemas 12802 (65%)

### principal with an autonomy level: 26 tools, 20835 chars, ~5209 tokens (chars/4)
(identical, plus propose_action 1057 chars / 265 tokens)
```

`chars/4` is the industry's rule of thumb and the one `packages/mcp-brain/test/brain.test.ts`
already asserts against. The manifest's own note and that test both hold: 25
eager tools, under the >5k line; the 26th rides on a credential the owner gave
room, which is SEP-1881's pattern applied at the tool.

### 2.2 How big is that, really

| | tokens | as a share of a 200k window | of a 128k window |
| --- | ---: | ---: | ---: |
| tool definitions (25) | 4,945 | 2.5% | 3.9% |
| `seed/assistant-prompt.md` | ~1,650 (6,597 bytes) | 0.8% | 1.3% |
| Anthropic's stated activation line for tool search | 10,000 | 5% | 7.8% |
| plan §4.3's revisit trigger | ~10% of context | 20,000 | 12,800 |
| Cloudflare's "before" case | 1,170,000 | 585% | 914% |

*Assumption, load-bearing:* the window is the assigned model's, which
`compute.yaml` decides per install and which this checkout does not fix. Both
columns are given so the conclusion does not depend on the choice. **On either,
the definition surface is under half the line at which the vendors themselves
switch strategy, and a quarter of the trigger the plan wrote down.**

### 2.3 We already run the composition half — and the measurement is good

Invariant 3 ("one read path into state — named queries, executed only by
`packages/queries`") is the same trade GraphQL makes against REST, and the
owner's analogy lands exactly on it. `seed/queries/` holds **20** named
queries, each with typed params, defaults, a TTL and an `expose:
generic | route` field deciding which door reaches it. Two tools front all of
them. Measured on this checkout:

```
named queries: 20
queries_list payload: 9628 chars ≈ 2407 tokens      ← the index, paid only when asked for
same 20 as individual tools: 11742 chars ≈ 2936 tokens
queries_list + queries_run definitions: 1136 chars ≈ 284 tokens   ← what we actually pay, every turn
```

**284 tokens of always-on definitions in place of 2,936 — a 90% reduction on
that slice, and the index is deferred behind a call.** That is structurally
Cloudflare's `search`/`execute` pair with SQL where they have JavaScript, and
it was built for a different reason (one read path) two months before this
question was asked. Adding a 21st query costs **~120 tokens of deferred index
and zero eager tokens**; adding a 21st tool costs ~180 eager tokens forever.

The result-size half is already controlled too, and by mechanism rather than
instruction: `queries_run` caps at 200 rows and reports `truncated: true`
(`packages/mcp-brain/src/queries-tools.ts`, annotated `// limit: fixed`);
`knowledge_grep` caps at 50 files / 200 hits; `activity_feed`'s own SQL
projects with `left(detail, 200)`. Results reaching the model are already
filtered server-side — which is the thing code mode is *for*.

### 2.4 The cheapest 950 tokens in the repo

`server.ts:276` merges a `turn_id` correlation handle into every tool's schema.
Measured:

```
turn_id fragment repeated across 25 tools: 3800 chars ≈ 950 tokens (19.2% of the eager surface)
one copy: {"description":"Optional: reuse per reply to group calls in the activity feed.",
           "type":"string","maxLength":64,"pattern":"^[A-Za-z0-9_-]+$"}
```

**Nineteen percent of the tool surface is one sentence, printed 25 times, about
a field that is not a parameter** — it is, in the code's own words, "a
caller-supplied correlation handle … never trusted for anything else". A
shorter description recovers ~750 tokens; moving it to the call's `_meta` (the
spec's carrier for exactly this) recovers ~900. Either is **more than any
compose tool would plausibly save on a 25-tool surface**, at no architectural
cost.

What it costs: one prompt-cache write at a release boundary — already the
policy (`docs/research/2026-09-cost-optimization.md` decision 1, shipped as
#196) — and a wire-visible schema edit to a published package. Not free, and
not a research decision. Flagged, not acted on.

### 2.5 At the plan's full tool count — and a contradiction to report

The plan's repo structure (§4.16) names one further bridge, `mcp-health`. If it
landed and, unlike EventKit, were mounted as MCP tools at the assistant's
surface, the arithmetic from §2.1's per-tool average (~198 tokens) is:

| surface | tools | ~definition tokens | share of 200k |
| --- | ---: | ---: | ---: |
| today | 25 | 4,945 | 2.5% |
| + `propose_action` (owner opts in) | 26 | 5,209 | 2.6% |
| + eventkit's 4, if ever mounted | 30 | ~5,700 | 2.9% |
| + a health bridge at ~6 tools | 36 | ~6,900 | 3.5% |
| + apple-fm's 2 | 38 | ~7,300 | 3.7% |

**Everything the plan currently names still lands under Anthropic's 10k line.**
The surface would have to roughly triple — or third-party servers would have to
be mounted, which is the external-agent scenario `2026-08-tool-discovery.md` §4
already flagged — before the definition problem is real.

**The contradiction.** `docs/research/2026-08-tool-discovery.md` §2 and plan
§4.3 both rest on "the cheap tier's tool-selection reliability falls off past
~10–15 visible tools". Anthropic's current tool-search documentation says:
"Claude's ability to pick the right tool degrades once you exceed **30–50**
available tools." Our 25 sits *outside* the figure the plan used and *inside*
the figure the vendor now publishes. Two readings — the older number was
Haiku-class-specific and the newer one is a frontier-model average, or the
guidance simply moved — and I cannot distinguish them from the sources. Either
way the plan's stated rationale for curation is weaker than it reads, while
curation itself remains right for other reasons. **Owner's to rule on; the plan
is not edited here.**

A second, friendlier update to PoC-17's arithmetic: Anthropic's server-side
tool search **does not break the cache** — "the API excludes deferred tools
from the system-prompt prefix. […] The prefix is untouched, so prompt caching
is preserved." PoC-17's second objection (lazy loses because caching neutralises
the definition ride) does not apply to the server-side mechanism, though its
first (+1 round trip) still does. This is not reachable from our wire either.

---

## 3. The fit against the invariants

This is the crux, and it deserves to be argued rather than asserted.

### 3.1 Invariant 9, read two ways

> **The engine has no shell and no raw git.** `brain-commit` plus allowlisted
> bridges are the assistant's entire mutating/outbound surface.

Two readings, and they give opposite answers:

- **Literal-substrate reading:** no interpreter we host may execute text the
  model produced. Under this, code mode is closed permanently, and the
  recommendation is simply *no* — stop reading at §4.
- **Reach reading** (and the one the invariant's own second clause supports,
  since it enumerates a *surface*, not a *mechanism*): what the invariant
  forbids is the engine causing effects outside the audited tool set. A
  sandbox that can reach nothing but the same audited functions, under the same
  principal, with the same `runs` rows, adds no reach.

The repo has already taken the reach reading once, in a smaller case:
`knowledge_grep` accepts an **agent-supplied regular expression** and evaluates
it in a `node:worker_threads` worker with a hard 1,500 ms kill
(`packages/mcp-brain/src/knowledge-fs.ts:252`, `grepWithTimeout`) "since V8's
regex engine cannot be interrupted mid-`exec` from the same thread". A regex is
a program; we already run the model's programs, budgeted, and refuse rather
than hang. A compose tool is the same shape one level up. That is a precedent,
not a permission — the difference between a regex engine and a JS engine is
several orders of magnitude of attack surface — but it means the question is
"which interpreter, under what budget", not "may the model supply code at all".

*I flag this as the single assumption the recommendation rests on. If the
owner's reading is the literal-substrate one, say so and §4 collapses to "no".*

### 3.2 What sandbox would be acceptable

| candidate | what it is | is it a boundary? | runs where we run | maintenance weight |
| --- | --- | --- | --- | --- |
| `node:vm` | V8 context, same isolate | **No.** Node v26 docs, verbatim: "The `node:vm` module is not a security mechanism. Do not use it to run untrusted code." | anywhere | none — but disqualified |
| `vm2` | hardened wrapper over `node:vm` | **No.** Ten GitHub advisories, **six critical**, most published 2026: "Sandbox Breakout Using Dangerous Host Proto Mutators" (GHSA-cfcw-xp6x-25gj), "Missing `Error.cause` Sanitization that Enables Sandbox Escape to RCE" (GHSA-m283-3h24-438v), builtin-denylist bypasses, a CVE-2023-37903 patch bypass | anywhere | disqualified |
| `isolated-vm` | true separate V8 isolates, C++ addon | **Closest thing in Node** — but the maintainer's own README: "Running untrusted code is an extraordinarily difficult problem […] Use of `isolated-vm` to run untrusted code does not automatically make your application safe", and leaking its objects to guest code "will yield complete control over a process" | anywhere Node runs — **but see below** | **high** (see §4.3) |
| QuickJS-in-WASM (`quickjs-emscripten`) | a separate interpreter inside the WASM sandbox, `setMemoryLimit` + `setInterruptHandler` + `newFunction` for host bindings | **Structurally yes** — the guest has no host globals at all unless granted — but the README says: "This project makes every effort to be secure, but has not been audited." | anywhere Node runs, no native build | **low–moderate** |
| subprocess + seccomp | kernel-enforced | yes | **Linux only** — breaks invariant 7's spirit and the Mac is the primary shape | n/a |
| `sandbox-exec` | SBPL profile | yes, and **already in use** — `ops/sandbox/assistant.sb` confines the engine to deny-default with three network destinations and `node` as the only executable | **macOS only**, and Apple-deprecated (the profile says so, and names App Sandbox as the successor) | already carried |
| Workers / Dynamic Worker Loader | Cloudflare's | yes | **cloud only** | n/a for a local-first install |

Two things this table makes concrete:

**We are not starting from zero.** The engine already runs inside a deny-default
`sandbox-exec` profile: no filesystem but four named config files and a state
directory, `node` as the only executable, outbound TCP limited to the console,
Postgres and `*:443`. A compose tool would execute **inside the console**, not
the engine — a different process with a wider profile — so that confinement
does not transfer. Worth stating plainly so nobody assumes it does.

**`isolated-vm` is worse for us than its reputation suggests.** From npm today:
`isolated-vm@7.0.1` declares `engines.node >= 24.0.0`; the product pins
`NODE_VERSION=22.23.2` (`ops/release/runtime-versions.env`), so we would be on
an older major line from day one. Its install script is
`node-gyp-build … || node-gyp rebuild` — prebuild where one exists, **compile
from source otherwise**, against a promise the bundled-runtime doc makes in
bold: "**Not required, ever: Docker, Homebrew, pnpm, Xcode, build tools.**" And
the resulting `.node` is a Mach-O that would join the signed, notarized,
sha256-pinned set in `runtime/` (`docs/ops/apple-signing.md`). A WASM module is
a file; a native addon is a release-pipeline commitment renewed at every Node
major. **If a sandbox is ever added here, it should be the WASM one.**

### 3.3 Can "enforce at the tool" survive capability passing? Yes — if this holds

The design that preserves it, stated as three properties a misuse test can
check (invariant 8: "misuse tests ship with the interface"):

1. **The guest's global object is empty but for one frozen proxy.** In the
   QuickJS shape this is the default, not a subtraction: nothing crosses the
   WASM boundary except functions handed over with `newFunction`. No `fetch`,
   no `require`, no `process`, no `globalThis.env`, no timers, no `Date.now`
   beyond a frozen value if determinism is wanted.
2. **The proxy is bound to the principal at construction**, and every method on
   it is *the same function `tools/call` dispatches to* — not a parallel
   implementation. If `knowledge_read` refuses a path outside the grant for a
   direct call, it refuses it for a script, because it is the same line of
   code. This is the only construction under which "enforce at the tool" is
   still literally true; a proxy that re-implements a check is a second policy
   and must be refused at review.
3. **The output crosses back through the same sanitizer.** `sanitizeDeep` +
   `redactSecrets` run on every tool result today (`server.ts:510`); a script's
   return value is a tool result and must not skip them. Plus a byte cap, since
   the whole point is that the script returns *less* than the calls it made.

Cloudflare's own docs make property 2 the load-bearing one ("Enforce
permissions … inside upstream tool handlers"), and Anthropic's PTC doc makes
the negative case explicit ("Do not rely on `allowed_callers` as a security
boundary"). Both vendors arrived where invariant 9 already is.

### 3.4 Audit still works, and is arguably better

Every tool call inside a script goes through `wrap()` (`server.ts:247`), so it
writes its own two-phase `runs` row with `component = principal.id`, `kind =
'tool'`, sanitized args, and lands in `activity_feed` grouped by `turn_id`
exactly as today. **A compose tool improves the audit trail in one respect**:
the script text is a *plan*, recorded before any of its calls run, where today
a five-call turn's intent is only reconstructable from the calls themselves.

Two things need deciding and are open questions (§5): where the script text
lives (proposal: `runs.meta.script`, clipped by the existing `summarizeArgs`
convention which already renders long values as `<N chars>`, plus a full
sha256), and whether a script that fails partway leaves a legible trail — it
does, because each call is its own row, but there is no row saying "the script
then threw".

### 3.5 Invariant 10 decides the shape: read-only, and not negotiable

> **The console's mutating surface is closed.** A closed, enumerated set of
> actions, each a door onto an existing audited service; **a new action is a
> product change, never a prompt or a config line.**

A script that could call `knowledge_write`, `capture`, `propose_action` or
`agents_delegate` would be a *composition of mutations authored at run time by
a model* — which is precisely a new action arriving as a prompt. The
enumeration in `packages/core/src/actions.ts` would still hold per call, but
the *sequence* would not be enumerated anywhere, and sequences are where
mutations get interesting.

So the capability proxy carries reads only, as a schema-level fact:

| in the proxy | not in the proxy |
| --- | --- |
| `knowledge_search`, `knowledge_read`, `knowledge_list`, `knowledge_grep` | `knowledge_write` |
| `queries_list`, `queries_run` | `capture`, `requests_create` |
| `tasks_list`, `tasks_thread` | every `tasks_*` mutator, `tasks_comment` |
| `artifacts_get`, `artifacts_list` | `artifacts_publish/comment/resolve/review` |
| — | `agents_delegate`, `propose_action` |

That is **10 of the 26 tools**, and — usefully — the ten whose results are
biggest and whose composition is most obviously wanted (search → read → grep →
summarise; run a query, join it against a page list, return three rows).

### 3.6 The cheaper alternatives, honestly compared

| | what it is | what it buys here, measured or estimated | what it costs | verdict |
| --- | --- | --- | --- | --- |
| **(a) lazy / deferred schemas** | `core`'s `discovery: lazy` (three frozen meta-tool names) past >20 tools / >5k tokens; or the vendor's `defer_loading` | up to ~4,600 of 4,945 definition tokens (≈2.3% of a 200k window) | PoC-17 measured the client-side version *losing*: +1 turn, +34% cumulative prompt tokens, +2.4 s. The server-side version preserves the cache but is not on our wire | **keep as the contract's escape hatch; do not activate** |
| **(b) a `query` tool over named queries** | already built | **measured: 2,936 → 284 eager tokens, 90%**, plus row caps and SQL-side projection | nothing — it exists | **already done; make it the default answer to "add a read capability"** |
| **(c) result pagination / projection params** | `fields:`/`offset:` on the fat readers | attacks the half code mode is actually for, with no sandbox; cost is a few tokens of schema on 4 tools | small schema growth; a cache-write at a release boundary | **the right next step if measurement shows intermediate results are the problem** |
| **(d) a "tool search" meta-tool** | our own index tool | same ceiling as (a), same +1 turn, plus a retrieval-quality failure mode `2026-08-tool-discovery.md` §3 already named ("lazy setups fail by *missing* the right tool at search time") | a new component to maintain and evaluate | **no — strictly worse than (a) at our size** |
| **(e) a read-only `compose` tool** | §4.2 | definition tokens ~unchanged (it *adds* one tool); saves intermediate results on multi-read turns, unquantified here | a sandbox dependency, a capability proxy, a misuse suite, a CPU/output budget | **not now; §4** |
| **(f) trim `turn_id`** | a description edit | **measured: ~750–900 tokens, 15–18% of the surface** | one cache write; a wire-visible schema change to a published package | **do this first** |

---

## 4. Recommendation

### 4.1 The decision table

| | decision | why | effort |
| --- | --- | --- | --- |
| **Adopt Cloudflare-shaped server-side code mode (`search`/`execute` over a generated API)** | **No** | The win is a ratio on catalogs 50–500× ours. Their sandbox is free to them and cloud-only to us. Our equivalent already exists as named queries at a measured 90% | — |
| **Adopt a read-only `compose` tool with a capability proxy** | **Later — gated on a measurement, not a date** | No invariant forbids it if §3.3's three properties hold, but the surface it would shrink is 2.5% of a window and the composition it would add is largely bought already. It buys a sandbox dependency now against a problem that is not present | 3–5 days *after* a sandbox is ratified: proxy, budgets, misuse suite, `runs` shape |
| **Adopt Anthropic programmatic tool calling** | **Later, free, if a Messages engine ever lands** | Costs us no sandbox — their container, our tools, our audit rows unchanged. Blocked purely by `engine-openai.ts` being the only engine kind | ~0 for this question; the engine kind is its own decision |
| **Trim `turn_id` out of 25 schemas** | **Yes — do it first** | Measured 950 tokens, 19.2% of the surface, for a correlation handle. Larger than anything above | ~half a day incl. tests + a changeset |
| **Add the definition-token check to CI generically** | **Yes** | `core`'s manifest schema states the >20 tools / >5k tokens rule; only `mcp-brain`'s own test enforces it. A second bridge could cross it silently | ~half a day |
| **Answer "we need a new read capability" with a named query, not a tool** | **Yes — make it the written default** | Measured ~120 deferred tokens vs ~180 eager, and invariant 3 already requires the query to exist | a paragraph in `docs/ops/` + review habit |
| **Add projection/pagination params to the fat readers** | **Only if §4.4 says intermediate results are the problem** | Gets most of code mode's *other* half with no sandbox | 1–2 days |
| **Activate `discovery: lazy`** | **No** | PoC-17 measured it losing at this size; the vendor mechanism that fixes half the objection is not on our wire | — |

### 4.2 If the answer ever becomes yes, this is the shape

One tool, `compose`, and it does not replace anything:

- **Input:** `{ script: string, turn_id?: string }` — one `async () => { … }`
  arrow, like Cloudflare's. Its description carries generated TypeScript
  declarations for the ten read tools of §3.5. Their JSON Schemas total
  **1,583 tokens today** (§2.1's table, summed), and a TypeScript declaration
  of the same surface is comparable — so `compose` is **an added eager cost
  until a turn uses it**, which is the honest framing.
- **Runtime:** QuickJS-in-WASM. One fresh runtime per call, `setMemoryLimit`
  (proposal: 64 MB), `setInterruptHandler` on a **1,000 ms** deadline — the
  same "refuse, never hang" behaviour `grepWithTimeout` already implements at
  1,500 ms, which is the in-repo precedent.
- **Capability:** a frozen `metistry` object, its methods bound to the
  principal, each one *the same function* `tools/call` dispatches to. Nothing
  else in scope.
- **Output:** the return value, through `sanitizeDeep` + `redactSecrets`, capped
  (proposal: 32 KB, `truncated: true` past it, matching `queries_run`'s
  convention), annotated `// limit: fixed` per R4.
- **Mutations:** none, ever. Not a flag, not a grant — the proxy has no mutating
  method to reach.
- **Grant:** its own group, like `rooms` and `actions` — a crew gains it when
  its manifest is edited, never because a release widened `knowledge`.
- **Audit:** script text (clipped) + sha256 in `runs.meta`; each inner call its
  own `runs` row exactly as today.
- **Misuse tests that ship with it** (invariant 8): guest cannot reach `fetch`,
  `require`, `process`, `globalThis`, a timer, or the host's realm; a script
  reading a path outside the grant is refused by the *same* code path a direct
  `knowledge_read` is; an infinite loop is killed at the deadline; an
  allocation bomb is killed at the memory limit; a script returning 10 MB is
  truncated; a secret-shaped value in the return is redacted.

### 4.3 The dependency, and its weight

CLAUDE.md requires asking before adding one. **The candidate is
`quickjs-emscripten`** (MIT, v0.32.0, last published 2026-02-16,
justjake/quickjs-emscripten).

| | `quickjs-emscripten` | `isolated-vm` (rejected) |
| --- | --- | --- |
| artifact | WebAssembly + JS glue | C++ node-gyp addon → Mach-O |
| install on a Mac with no Xcode | works | `node-gyp rebuild` fallback → fails; contradicts the bundled-runtime promise |
| our Node | fine on 22.23.2 | v7 needs Node ≥ 24; we pin 22.23.2, so an older major line |
| release pipeline | none — a file in `node_modules` | a signed, notarized, sha256-pinned binary in `runtime/`, renewed per Node major |
| isolation | separate interpreter inside the WASM sandbox; guest globals empty by default | real V8 isolates; stronger in principle, but its own README warns that leaking a handle "will yield complete control over a process" |
| audited | **no** — "has not been audited. Please use with care in production settings" | no |
| perf | interpreter; slower than V8 — irrelevant for a 1-second budget over ≤20 RPC calls | fast |
| maintenance | one WASM pin to bump | a native addon on the critical path of every release |

**Neither is audited.** That is the true cost of this feature and the reason
§4.1 says *later*: the sandbox would sit in the console — the process that holds
the Postgres pool, the reconciler token and every agent's bearer — and it would
be the first component in the tree whose correctness we could not test, only
trust. Invariant 8 says security must survive full code visibility; an
unaudited interpreter is the one place that stops being a statement about our
code.

### 4.4 What to measure first — and the method

**No new harness is needed.** PoC-18's runner already does this, which is
routing feedback worth having: `packages/eval/src/tools.ts` builds tool
definitions by asking `mcp-brain` for a real `tools/list` ("THE DEFINITIONS ARE
PRODUCTION'S"), stubs execution record-only, and `RunRecord` already carries
`steps`, `parse_retries`, `tool_errors`, `batch_count`, `prompt_tokens`,
`predicted_tokens` per case, with `null` distinguished from `0`.

**Method, in order:**

1. **Establish that there is an intermediate-results problem at all** — the
   half a compose tool would address, which §2 does *not* answer. Add a named
   query (invariant 3, so it is reusable and reviewable) over `runs`: turns
   grouped by `meta.turn_id`, with call count, and result sizes where
   `meta` carries them. The question is concrete: *what fraction of real turns
   make ≥3 tool calls where an earlier result is only used to shape a later
   one?* Under ~10%, the composition win is theoretical and the answer stays no
   regardless of any token count. **The owner runs this; it needs the instance's
   database, which this research did not touch.**
2. **A/B the surfaces on the owner's own fixtures.** Add `surface: "tools" |
   "compose"` to `Candidate` in `packages/eval/src/record.ts` — a second arm on
   the existing matrix, not a second harness. The fixtures are the owner's
   fifty, harvested at `<instance>/.metistry/eval/fixtures-harvest.jsonl` (path
   per `docs/plan-refresh-2026-09-13.md` §4a; **not read here**). The `compose`
   arm's stub can be a plain Node-side evaluator *for measurement only* — what
   is being measured is token flow and task success, not isolation — provided
   it never ships and the PR says so in one line.
3. **Compare, on the median fixture:** cumulative `prompt_tokens`, `steps`,
   `tool_errors`, and pass rate per axis. **State the adoption rule before
   running, so the result cannot be read to taste:** adopt only if `compose`
   cuts cumulative `prompt_tokens` by **>25%** (Anthropic's own end-to-end
   figure for PTC is 24%, so anything less is not evidence) **and** does not
   lose pass rate on axis 1 (tool choice / no hallucinated tool).
4. **Control for the cache.** `prompt_tokens` alone overstates the saving on a
   cached prefix, and definitions are the most cacheable thing in the request.
   Record `cache_read_tokens` / `cache_write_tokens` too — `packages/core/src/runs.ts`
   already has both as columns, and `engine-openai.ts` already populates them
   from the provider's usage block.
5. **Re-run the trim first.** Do §4.1's `turn_id` change before the A/B, so the
   baseline is the improved surface rather than one carrying 950 tokens of
   avoidable text — otherwise `compose` gets credit for a description edit.

---

## 5. Open questions (the owner's)

1. **Which reading of invariant 9?** §3.1. Literal-substrate ⇒ this is closed
   permanently and the answer is simply "no". Reach ⇒ §4's *later* stands. The
   whole recommendation turns on this and nothing else in the doc resolves it.
2. **Is `turn_id` worth a wire change?** 950 tokens against a schema edit to a
   published package (`@foldedspacelabs/metistry-mcp-brain`) and one cache
   write. If yes, `_meta` or a short description — those are different
   compatibility stories.
3. **The 10–15 vs 30–50 contradiction** (§2.5): does the plan's curation
   rationale get restated, or does the newer vendor figure get recorded as
   superseding it? Either way `2026-08-tool-discovery.md` §2 and plan §4.3 are
   currently citing a number the vendor has moved off.
4. **Would a native Messages engine kind be built for other reasons?** If yes,
   programmatic tool calling arrives free and questions 1 and 5 become moot.
   If no, code mode here is permanently a build-it-ourselves proposition.
5. **If a sandbox is ever ratified, is an unaudited dependency acceptable in
   the console process?** §4.3. This is the real question, and it is a security
   posture decision, not a dependency-count one.
6. **D6 (the durable set):** a compose script's text in `runs.meta` — derived,
   like everything else in `runs`, or does a plan that produced a knowledge
   commit want to survive `docker compose down -v`? I read it as derived, and
   note it only because D6 is open.

---

## Sources

Read in full on 2026-09-19 unless noted; dates are the publishers'.

- [Cloudflare, "Code Mode: the better way to use MCP"](https://blog.cloudflare.com/code-mode/) — 2025-09-26. Client-side Code Mode, V8 isolates, the Worker Loader API, `globalOutbound`.
- [Cloudflare, "Code Mode: give agents an entire API in 1,000 tokens"](https://blog.cloudflare.com/code-mode-mcp/) — published 2026-02-20, modified 2026-07-15. Server-side `search`/`execute`, 1.17M → ~1,000 tokens (99.9%), Dynamic Worker isolate, the comparison against dynamic tool search and CLI-based disclosure.
- [Cloudflare Agents docs, "Code Mode MCP server patterns"](https://developers.cloudflare.com/agents/model-context-protocol/codemode/) — last updated 2026-06-24. `codeMcpServer()`, `openApiMcpServer()`, the sandbox-and-authorization boundary.
- [Anthropic Engineering, "Code execution with MCP"](https://www.anthropic.com/engineering/code-execution-with-mcp) — 2025-11-04. 150,000 → 2,000 tokens (98.7%); the sandboxing caveat.
- [Claude platform docs, "Programmatic tool calling"](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) — +11% / −24% input tokens on BrowseComp & DeepSearchQA; `allowed_callers` is "not a security boundary"; Messages-API platforms only; ZDR-ineligible.
- [Claude platform docs, "Tool search tool"](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) — ~55k typical multiserver definitions, >85% reduction, the 30–50-tool accuracy figure, the 10k-token activation guidance, and "the prefix is untouched, so prompt caching is preserved".
- [MCP specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — `tools/list` pagination, `listChanged`, `resource_link`, `outputSchema`; no tool-result size limit.
- [SEP-1881, Scope-Filtered Tool Discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1881) — opened 2025-11-23, closed 2026-06-24 (SEPs moved to pull requests).
- [SEP-1888, Progressive Disclosure for Typed Library Discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1888) — opened 2025-11-24, closed 2025-12-04.
- [Node.js `node:vm` documentation](https://nodejs.org/api/vm.html) (v26.9.0) — "The `node:vm` module is not a security mechanism. Do not use it to run untrusted code."
- [isolated-vm README](https://github.com/laverdet/isolated-vm) + `npm view isolated-vm` on 2026-09-19 — v7.0.1, `engines.node >= 24.0.0`, `install: node-gyp-build … || node-gyp rebuild`; the maintainer's untrusted-code caution.
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) — v0.32.0, 2026-02-16; `setMemoryLimit`, `setInterruptHandler`, `newFunction`; "has not been audited".
- GitHub Security Advisories for `vm2`, queried 2026-09-19 — ten advisories, six critical, incl. GHSA-cfcw-xp6x-25gj, GHSA-m283-3h24-438v, GHSA-rp36-8xq3-r6c4, GHSA-m4wx-m65x-ghrr.

Repo facts cite the file. Prior art this builds on rather than repeats:
`docs/research/2026-08-tool-discovery.md` (PoC-17, the eager/lazy line),
`docs/research/2026-09-cost-optimization.md` (prompt-cache hygiene),
`metistry-build-plan.md` §4.3 (the bridge contract's three defaults) and §4.5
(the named query contract).
