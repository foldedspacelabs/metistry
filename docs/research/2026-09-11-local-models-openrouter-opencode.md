# Configurable compute: local models, OpenRouter/Zen, OpenCode (2026-09-11, rev 2)

> Revised for the owner's pivot: **all AI compute — the main agent included
> — is user-configurable by provider and model**, the subscription path
> leaves the product repo, and every provider's agents collaborate through
> Metistry's MCP. Nothing here is built. Vendor claims verified 2026-09-11
> (Sources); the plan is not edited, contradictions are listed.

## Summary

- **One file, `compute.yaml`, in the instance repo** (protected path)
  holds providers, model assignments per tier and crew, and budgets. The
  CLI and the app edit it *as the user* through the same protected-write
  path `deployment set-shape` uses; the console and assistant hot-reload
  it. Directories-per-provider are withdrawn: a provider is configuration,
  not a component, so invariant 5 is met by a schema in `packages/core`.
- **Two engines behind one `Engine` interface**: `anthropic` (Claude Agent
  SDK on an **API key** — the SDK docs say to use API-key auth) and
  `openai-compatible` (OpenRouter, Zen, LM Studio, Ollama, Apple FM, any
  base URL). Library evaluation says **none yet**: the in-house loop is
  ~300 lines over pre-approved `@modelcontextprotocol/sdk` + `zod`; the
  Vercel AI SDK is the one to revisit if that grows.
- **The subscription path leaves the product.** `CLAUDE_CODE_OAUTH_TOKEN`,
  the PoC-4 rule that forbids `ANTHROPIC_API_KEY`, wizard step 7 and the
  "subscription" copy are the scrub list below. An instance re-adds it
  privately through a generic mechanism the product never names.
- **Apple FM becomes a local provider**: the existing Swift bridge grows
  `/v1/chat/completions` + `/v1/models`, so the engine speaks one protocol
  and the package stays where macOS requires it (invariant 6).
- **Cost is a first-class row**: provider, model, tokens, cost on every
  `runs` row; per-instance and per-provider budgets enforced before the
  call; non-ZDR assignments warn, never block.
- **Collaboration rule**: Claude never routes to non-Claude models nor
  spawns non-Claude agents; every provider's agents meet through the
  console's `/mcp` rows. Enforced by the absence of any engine-calling tool.
- **Local default is LM Studio when detected, Ollama equal**, both
  discovered via `/v1/models`; `lms get` / `POST /api/pull` install.

## What the repo already has

- Tiers are `(model, effort)` pairs in `rules.yaml` (`packages/core/src/
  tiers.ts`); crews' `model` is `haiku|sonnet|opus` (`manifest.ts:171`).
  One SDK `query()` per turn (`apps/assistant/src/engine.ts`);
  `main.ts:11-14` throws on `ANTHROPIC_API_KEY`, requires
  `CLAUDE_CODE_OAUTH_TOKEN`; `ASSISTANT_ENV_KEYS` (`deployment.ts:164`)
  and `sandbox.ts:31` allowlist the engine's env and hosts.
- `runs` already has `tokens_in`, `tokens_out`, `cost_usd`
  (`db/migrations/0001_init.sql:17-19`).
- Embeddings: Ollama via `METISTRY_OLLAMA_URL` + native `/api/embed`,
  degrading to keyword. `packages/mcp-apple-fm`: Swift helper with a static
  `@Generable` schema and `LanguageModelSession.respond(to:generating:)`
  (`helper/afm-helper.swift:11-51`), HTTP bridge on 7810 (`POST /classify`,
  `GET /check`). PoC-3 passed headless; PoC-15 rejected FM as scorer;
  PoC-16 passed `gemma4:e4b` at $0 (amendment gated on a blind eval).
- Targets: `data_policy` enforced by `checkBrief` (`dispatch.ts:59`);
  `local-crew` narrows by crew `scope` with a per-run credential.
  Protected-path writes go through `protected-write.ts` as the `user`
  principal (`deployment set-shape`). Claude Code plugin: `SessionEnd` →
  `POST /capture`, `idempotency_key = <source>:<sessionId>:<sha256[0:16]>`
  (`session-summary.ts:226`), parity test. Secrets: Keychain, `_KEY` =
  secret, user vs instance scope (`secrets.ts:64-66`).

## What the vendors actually offer (verified 2026-09-11)

| | LM Studio | Ollama | OpenRouter | OpenCode Zen |
| --- | --- | --- | --- | --- |
| Chat API | `/v1/chat/completions`, `/v1/responses`, Anthropic `/v1/messages`; port 1234 | `/v1/chat/completions`; 11434 | `/api/v1/chat/completions`, Bearer | `/zen/v1/chat/completions`, `/zen/v1/messages`, `/zen/v1/responses` |
| Models / embeddings | `/v1/models` (all downloaded when JIT on); `/v1/embeddings`, `nomic-embed-text-v1.5` | `/v1/models`, `/api/tags`; `/v1/embeddings` | `/api/v1/models` | curated list |
| Structured output | `response_format: json_schema` (GGUF grammar, MLX Outlines; "LLMs below 7B" may fail) | `format` (JSON schema) and `response_format` on `/v1` | `response_format: json_schema`; per-provider — some "treat it as a strong hint"; `require_parameters: true` to filter | not stated |
| Install / mgmt | `lms get/load/unload/ls/ps/server`; **llmster** headless (`curl -fsSL https://lmstudio.ai/install.sh \| bash`, `lms daemon up`); JIT, TTL 60 min, auto-evict | `POST /api/pull`; `keep_alive` | n/a | n/a |
| Apple silicon | MLX + GGUF; `mlx-engine` MIT; macOS 14+, 16 GB+ | Metal | n/a | n/a |
| Cost / usage | 0 | 0 | response `usage.cost` always present (`usage.include` deprecated); `/generation` by id | pay-as-you-go, reload $20 under $5; prices on the page |
| Data | local | local | ZDR per account scope or `provider.zdr: true`; OpenRouter itself ZDR unless prompt logging opted in; BYOK 5 % | US-hosted; zero-retention except OpenAI/Anthropic 30-day, free models may train |
| Licence | proprietary, free at home and work (2025-07-08); `@lmstudio/sdk` MIT | MIT | service | service; OpenCode MIT (`anomalyco/opencode`) |

OpenCode (`opencode-ai` on npm, `brew install anomalyco/tap/opencode`):
providers include Zen, Anthropic (API key or Claude Pro/Max OAuth),
OpenRouter, any OpenAI-compatible base URL. `opencode.json`: `model`,
`provider`, `mcp`, `agent`, `plugin`, `share` (default `manual`),
`{env:VAR}`. Plugins in `~/.config/opencode/plugins/` or
`.opencode/plugins/`, signature `({ project, client, $, directory,
worktree })`, `event` hook with verified names `session.created|updated|
idle|status|compacted|deleted|error|diff`, `message.updated`,
`tool.execute.before|after`, `permission.asked|replied`, `file.edited`.

**Anthropic, and the framing that follows.** Claude Code docs: "doesn't
support routing Claude Code to non-Claude models through any gateway";
`ANTHROPIC_API_KEY` "is used instead of your Claude Pro, Max, Team, or
Enterprise subscription even if you are logged in" ([env-vars]). Agent SDK
overview: "Unless previously approved, Anthropic does not allow third party
developers to offer claude.ai login or rate limits for their products,
including agents built on the Claude Agent SDK. Use the API key
authentication methods" ([sdk-overview]). The SDK `Options` has an `env`
record that "replaces the subprocess environment" and no `apiKey` field
([sdk-ts]). So: **the Agent SDK is a legitimate engine for an
`anthropic` provider when the credential is an API key**; what leaves the
product is the subscription path only.

## The compute model — `compute.yaml`, not env vars

**Name.** `compute.yaml`: it holds providers, assignments *and* budgets,
and "configurable compute" is the owner's word; `providers.yaml` would
misname two thirds of it. **Where.** Instance repo root, a §4.7 protected
path (invariant 2: where work runs and where data goes is how the system
behaves); the CLI and app write it *as the user* via `protected-write.ts`,
as `deployment set-shape` does. `seed/compute.yaml` ships the default
(Anthropic API key, Sonnet suggested "because that is what we test
against"), overlaid D4-style (`METISTRY_COMPUTE_FILES`). The `tiers:` block
moves here (model **and** effort); one left in `rules.yaml` still parses.

```yaml
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine                      # cost 0; no data_policy needed
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    auth: { secret: METISTRY_OPENROUTER_API_KEY }          # Keychain, user scope
    locality: off_machine
    zdr: true                                 # false → warning row, never a block
    request: { provider: { order: [anthropic], allow_fallbacks: false } }
    data_policy: { allow: [Knowledge/Projects], deny_sources: [comms], max_brief_bytes: 65536 }
  anthropic:
    kind: anthropic                           # Claude Agent SDK
    auth: { secret: METISTRY_ANTHROPIC_API_KEY, inject_as: ANTHROPIC_API_KEY }
    locality: off_machine
    pricing: { claude-sonnet-5: { in_per_m: 0, out_per_m: 0 } }   # illustrative shape; real rates come from the template
assignments:
  default: { model: anthropic/claude-sonnet-5, effort: medium }
  tiers:
    fast:    { model: lmstudio/google/gemma-3n-e4b, effort: low }
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
    deep:    { model: anthropic/claude-opus-5, effort: high }
  crews: { researcher: { model: openrouter/deepseek/deepseek-v3.2 } }
budgets:
  instance:  { daily_usd: 5, monthly_usd: 60, action: warn }
  providers: { openrouter: { monthly_usd: 20, action: stop } }
```

**Rules the schema enforces** (`packages/core/src/compute.ts`, zod; CI and
the app validate the same schema): `model` is `<provider>/<id>`, first
segment a provider in this file, the rest verbatim (LM Studio ids contain
slashes); no `/auto`, no fallback lists (invariant 4); `auth.secret` is a
Keychain name, never a value; `inject_as` is any `^[A-Z][A-Z0-9_]*$` — the
template says `ANTHROPIC_API_KEY`, nothing else; `off_machine` requires
`data_policy`; a collector naming a provider with cost > 0 fails CI.

**Hot reload.** Console and assistant watch the resolved file with
`chokidar` (pre-approved); a valid parse swaps the in-memory map
atomically; an invalid one keeps the last good map and writes a `runs`
warning row (startup still fails loudly on a bad file, as `tiers.ts` does).

**Verbs** (all `--json` for the app):

```
metistry compute providers list|add --from openrouter|zen|lmstudio|ollama|anthropic|remove <name>|test <name>
metistry compute models list [--provider <name>]        # /v1/models, live
metistry compute assign <tier|crew:<name>|default> <provider/model> [--effort low|medium|high]
metistry compute install <provider/model>               # lms get | POST /api/pull
metistry compute budget <instance|provider:<name>> --daily|--monthly <usd> --action warn|stop
```

`add --from <template>` writes a validated block from `seed/compute-
templates/<name>.yaml`, prompts for the secret via `metistry secrets`
(user-scoped Keychain), then runs `test` (a real `/v1/models` or a
one-token completion). The app's **Compute** pane is those verbs: provider
list with status, model picker per tier/crew fed by `models list`, budgets,
a warning badge on non-ZDR assignments. Wizard step 7 becomes "Choose your
compute".

## The engine layer

One interface in `apps/assistant/src/engine.ts`:

```ts
interface Engine { run(spec: TurnSpec & { provider: Provider }): AsyncIterable<EngineEvent>; }
// TurnSpec adds provider/model/effort; EngineEvent carries text, tool calls, usage.
```

Rev 2 of this note had two kinds — `anthropic` (the SDK on an API key)
and `openai-compatible`. Rev 3 (owner decision, below) drops the SDK:
**one engine, `openai-compatible`**, and Claude arrives through OpenRouter
like every other cloud model. The interface stays so a native Anthropic
Messages adapter can slot in later. Routing stays router → tier name →
`resolveTier` → `(provider, model, effort)` → engine, no model in the loop.

**Libraries for the second engine, honestly:**

| candidate | licence | adds | MCP | structured | verdict |
| --- | --- | --- | --- | --- | --- |
| Vercel AI SDK `ai` + `@ai-sdk/openai-compatible` | Apache-2.0 (LICENSE verified); 26.7k★ | provider abstraction, tool loop, `generateObject`, `createMCPClient` (http/sse/stdio, not experimental) | yes | yes (`supportsStructuredOutputs`) | the only one that removes real code (~180 lines); brings a second MCP client and a large tree (size unverified — npm returned 403); a third agent loop in the repo |
| `openai` | Apache-2.0 | typed client, `baseURL`, `zodResponseFormat` | no | helper only | types over `fetch`; no loop, no MCP — little gain |
| token.js | MIT, 311★ | 200+ providers in OpenAI format | no | not stated | too small to depend on for years |
| in-house | — | `fetch`, loop, cost | via `@modelcontextprotocol/sdk` (pre-approved) | `zod` validate | **recommend** |

**Recommend none, for now** — because OpenAI-compatible base URLs already
give the provider abstraction the AI SDK sells, the two pre-approved
packages cover MCP and validation, and a dependency here is a decade-long
obligation for one person. Revisit the AI SDK (one ask-first dependency,
two packages) if the loop passes ~600 lines or needs streaming UI.

**What the loop must own regardless of library:** the tool loop over the
console's `tools/list`, `max_turns`, backoff on 429/5xx, `usage` → cost,
`response_format: json_schema` **plus a validating fallback** (parse → zod
→ one repair retry) because LM Studio warns sub-7B models may fail and
OpenRouter says some endpoints "treat it as a strong hint"; effort →
`reasoning: { effort }` on OpenRouter, reasoning-off locally (PoC-16); the
provider's `request:` block merged verbatim. ~300 lines with tests.

### Dropping the SDK entirely: one engine, Claude through OpenRouter

The owner's instinct is to skip the Agent SDK and reach Claude only
through OpenRouter, so billing is cut and dry and nothing in the product
brushes the SDK's login and branding notes. What that buys and what it
gives up, verified 2026-09-11:

**Buys.** One engine, one protocol, one session store, one cost path.
OpenRouter passes Anthropic's prices through "without any markup"
([OpenRouter][or-faq]); prompt caching works for Claude via OpenRouter —
one top-level `cache_control` for automatic caching or up to four explicit
breakpoints, cache reads at 0.1× and 5-minute writes at 1.25×, with
`cached_tokens` and `cache_write_tokens` reported per response
([OpenRouter][or-cache]) — so the agent loop keeps the caching economics
the cost research measured. Prompts and completions are "not logged by
default" at OpenRouter ([OpenRouter][or-faq]); Anthropic's own retention
still applies behind it. No SDK subprocess, no `inject_as`, no
`engine_env` — the private-re-add mechanism shrinks to "the Studio's
`compute.yaml` names its own provider", and the Claude subscription
reaches Metistry only as a *collaborator*: Claude Code sessions with the
plugin and `/mcp`, working tasks from the queue. That is the cleanest ToS
posture available.

**Gives up.**

1. **~5%.** OpenRouter's platform fee is 5.5% on card credit purchases and
   5% on BYOK usage above the plan allowance ([OpenRouter][or-faq]).
2. **Anthropic-native features that do not cross the OpenAI wire**: the
   native structured-outputs guarantee (OpenRouter's `response_format` is
   a strong hint on some endpoints), server-side tools (web search, code
   execution), PDFs and citations, and the step-by-step thinking stream.
   Metistry uses none of these today; `json_schema` + the validating
   fallback covers structured output.
3. **The SDK's turnkey machinery** — session persistence and resume,
   automatic compaction, hooks, skills, subagents. But the OpenAI engine
   must own sessions and compaction for every other provider anyway, and
   Metistry disables the SDK's built-in tools by design (invariant 9), so
   this is "build once for everyone", not a lost capability. Claude
   subagents become Claude crews — the same mechanism every provider gets.
4. **Translation risk.** OpenAI-format tool calling through OpenRouter's
   normalisation, not the native Messages API: cache breakpoint placement
   and tool-result images need care and a test. Not a quality gap in
   practice for text + tools, but a thing to measure once.
5. **Anthropic's own OpenAI-compatible endpoint is not a fallback.**
   Anthropic says it "is primarily intended to test and compare model
   capabilities, and is not considered a long-term or production-ready
   solution"; prompt caching is unsupported, `response_format`, `strict`
   and `reasoning_effort` are ignored ([Anthropic][openai-compat]). So
   "direct to Anthropic without the SDK" means a *native Messages adapter*
   (~150 lines behind the same `Engine` interface: no fee, full caching,
   native structured outputs, still plain API-key billing) — a later
   option if the fee or a feature bites, not part of the first build.

**Recommendation:** take the owner's route. One engine; the seed's
Anthropic template becomes an OpenRouter provider with
`anthropic/claude-sonnet-5` pinned and `provider: { order: [anthropic],
allow_fallbacks: false }`; `kind: anthropic` and the SDK dependency leave
the product with the scrub. Keep the native Messages adapter as a
documented, unbuilt option.

### Claude Managed Agents as the main agent's harness?

Verified 2026-09-11 ([Anthropic][ma-overview], [ma-reference], [ma-budgets]).
Managed Agents is Anthropic's hosted harness: "the model, system prompt,
tools, MCP servers, and skills" defined once as an *agent*, run in
*sessions* inside an *environment* — an Anthropic cloud sandbox or a
self-hosted sandbox driven by a worker on your own machine — with
server-side event history, compaction, prompt caching, scheduled
deployments, multiagent threads, and hard dollar budgets per session.

**Terms.** Authentication is a Claude API key; there is no claude.ai login
path at all, so the SDK overview's third-party clause does not arise — this
*is* the product Anthropic offers to third parties who want Claude as an
agent. Its branding guidelines are the SDK's ("Claude Agent", "Powered by
Claude"; never "Claude Code"), and the Commercial Terms apply. Cleaner
than the SDK on that axis, and equal to OpenRouter.

**Pricing.** List cost per session = model tokens at list price + web
searches at $10 per 1,000 + **session running time at $0.08 per hour**
([ma-budgets]). A session that is always on — the shape Metis has — is
~$58/month of running time before a token is billed; a session-per-turn
shape avoids that but pays the sandbox start each time. Budgets are hard
caps enforced between model requests and pause the session at
`budget_reached`; a nice primitive, and one `compute.yaml` budgets would
have to mirror for every other provider anyway.

**Fit.** Poor for the main agent, for three reasons that are not about
terms:

1. **The tools are the wrong tools.** The harness brings bash, file
   operations and web fetch in *its* sandbox — the surface invariant 9
   removes. Metis's tools are the console's `/mcp`; the harness can reach
   it only as a "remote MCP server" with a public HTTP endpoint or through
   an MCP tunnel, which is "a more limited research preview" needing a
   request form ([ma-overview], [ma-reference]). Either way the vault's
   knowledge and the user's comms cross to Anthropic's sandbox per call.
2. **Not ZDR-eligible.** "Managed Agents is not currently eligible for
   Zero Data Retention or HIPAA BAA coverage" because sessions, sandbox
   state and outputs are stored server-side ([ma-overview]) — the
   opposite of an instance whose Postgres and vault are the record.
3. **Beta, Claude-only.** The `managed-agents-2026-04-01` beta header on
   every call; "behaviors may be refined between releases"; and it would
   be a third engine kind for one vendor, which is what rev 3 just removed.

**Where it does fit:** as a *compute target* (`targets/`), the same shape
as `github-issues` — "dispatch this brief to a hosted Claude session with
a $N budget, results back through `/mcp`". Off-machine by construction, so
the data policy already governs it, and a session budget maps onto the
target's cost row. Worth a manifest later; not the main agent.

### A non-Claude main agent: the safest route, and what it costs

The owner's second question: run Metis on a non-Claude model, so nothing
in the product's default path touches Anthropic's harness terms or the
"Claude calling non-Claude" rule at all. With one engine and
`compute.yaml` this is *only a seed default* — the user picks any
`provider/model` for `default` and every tier — so the question is which
default to ship and what it costs.

**What the main agent needs from a model:** reliable tool calling over
~12 MCP tools (verified `tools=true` on OpenRouter for every row below),
JSON-schema output for the router-adjacent work (`response_format`), a
reasoning knob for the `deep` tier, prompt caching for the loop, and a
context window that holds a fold. Every candidate below clears those on
paper; **quality on Metistry's own eval is not measured** — PoC-15/16's
fixtures are the harness to reuse before a default is chosen.

**Live list prices via OpenRouter, 2026-09-11** (`/api/v1/models`;
no markup; caching discounts vary by vendor):

| model | in $/M | out $/M | ctx | note |
| --- | --- | --- | --- | --- |
| anthropic/claude-sonnet-5 | 2.00 | 10.00 | 1M | the reference; cache reads 0.1× |
| anthropic/claude-haiku-4.5 | 1.00 | 5.00 | 200k | today's `default` tier |
| anthropic/claude-opus-5 | 5.00 | 25.00 | 1M | today's `deep` |
| openai/gpt-5 | 1.25 | 10.00 | 400k | automatic caching |
| google/gemini-3.5-flash | 1.50 | 9.00 | 1M | |
| google/gemini-3.5-flash-lite | 0.30 | 2.50 | 1M | |
| moonshotai/kimi-k2.5 | 0.45 | 2.25 | 262k | open weights |
| deepseek/deepseek-v4-pro | 0.85 | 1.70 | 1M | open weights; automatic caching |
| deepseek/deepseek-v4-flash | 0.07 | 0.13 | 1M | open weights |
| minimax/minimax-m2.7 | 0.30 | 1.20 | 205k | open weights |
| lmstudio/… (local) | 0 | 0 | model-dependent | electricity + RAM |

**A monthly estimate for one instance**, stated assumptions so the table
can be re-run: 90 turns/day (60 chat, 30 routine), 8k input tokens per
turn (a ~4.4k tool list + identity prompt + thread), 600 output tokens,
70% of input served from cache where the vendor discounts cache reads at
0.1× (Anthropic, and treated the same for the others' automatic caching —
optimistic for vendors that discount less), 30 days:

| default model | tokens in/mo | est. $/mo | vs Sonnet |
| --- | --- | --- | --- |
| claude-sonnet-5 | 21.6M in (6.5M billed-equivalent), 1.6M out | ≈ $29 | 1.0× |
| claude-haiku-4.5 | same | ≈ $15 | 0.5× |
| gpt-5 | same | ≈ $24 | 0.8× |
| gemini-3.5-flash-lite | same | ≈ $6 | 0.2× |
| kimi-k2.5 | same | ≈ $7 | 0.24× |
| deepseek-v4-pro | same | ≈ $8 | 0.28× |
| deepseek-v4-flash | same | ≈ $0.65 | 0.02× |
| local (LM Studio, gemma-class) | same | $0 + power | — |

Two things the table hides. Effort: the `deep` tier's reasoning tokens
are billed as output and dominate on a hard question, whichever vendor;
the estimate is for the default tier. Quality: a cheaper default that
needs two turns to do one costs more than the dearer one, and the cost
research found "correct routing beats always-standard on quality, never
cost" (PoC-15). So the honest recommendation is a **two-default seed**:
`default` on a strong mid-price non-Claude model and `deep` on the best
model the user will pay for — with the choice made on Metistry's own
fixtures, not on this table.

**Recommendation.** Ship the seed with a non-Claude `default` (candidate:
`deepseek/deepseek-v4-pro` or `moonshotai/kimi-k2.5` via OpenRouter,
decided by a PoC on the PoC-15/16 fixtures plus a 20-turn tool-loop
transcript) and Claude Sonnet as the *suggested* `deep`, both one line in
`compute.yaml`. The product's default path then never has Claude driving
the loop, which removes the harness question entirely; a user who wants
Sonnet everywhere changes one line. This does not change rev 3's
architecture — it is the seed's contents.

### The path to a local main agent (plan, not a decision)

The owner would like Metis itself on a local open-weights model and is
unsure of the steps, the evaluation, and whether the quality is reachable.
Facts first, then a staged path where each stage is useful on its own and
no stage bets the main agent on an unmeasured model.

**The machine.** The Studio is an M4 Max with 64 GB; LM Studio is already
serving `google/gemma-4-e4b` and `nomic-embed-text-v1.5`. With Postgres,
the console and the engine resident, ~40 GB is the practical ceiling for
a loaded model, which means: dense models up to ~32B at 4-bit (~18–20 GB,
comfortable), sparse ~30B-active-3B MoEs (fast, the sweet spot for an
agent loop), and *not* the 100B+ MoEs or 70B dense at any useful speed.
That is the class to evaluate, not the frontier.

**What "quality" means for Metis, concretely** — the main agent's turns
are not general chat: (1) a tool loop over ~12 MCP tools with correct
arguments and no hallucinated tools; (2) reading a thread and the brief
and knowing when to *stop* (no runaway loops); (3) judgment on triage —
what becomes a proposal, what is noise; (4) the voice in `identity.yaml`
held over long sessions; (5) briefs and folds that a person actually
reads. Only (1) and (2) are cheap to score automatically; (3)–(5) need a
rubric and a human, at least at first. The cost research's warning
applies: a model that needs two turns for one is dearer than Sonnet in
both money and trust.

**Fine-tuning is not the lever — and Claude transcripts are not training
data.** Anthropic's usage policy forbids using Claude outputs to develop
competing models, so "distil Sonnet into a local model" is off the table
regardless of how well it would work. What is on the table: harness
tuning (tool descriptions, the system prompt, structured-output shapes,
turn limits) — where most of a local model's gap on an agent loop
actually lives — and, last and only with owner-authored data, a LoRA.
Plan for zero fine-tuning; treat it as a later experiment.

**Stages** (each ships something; each gate is a number on the same
fixtures):

0. **The bar.** Owner-authored fixtures — 50 real turns from the Studio's
   history, rewritten as prompts with expected tool calls and a rubric —
   run against Sonnet via OpenRouter to set the reference score and cost.
   Reuse the PoC-15/16 fixture format. This is a PoC, not a PR.
1. **Local where it already wins** (rev 3, PR 2/3): embeddings, the
   scorer once its eval passes, `fast` and `routine` tiers, extraction
   crews. Zero risk to the main agent; real savings; real telemetry on
   local latency and tool-call reliability from day one.
2. **Shadow mode** (PR 3 adds it cheaply): for a configurable fraction of
   `default` turns the engine also runs the same turn on
   `lmstudio/<candidate>` with the tools *stubbed to record-only*, stores
   both transcripts on the `runs` row, never shows the local answer. A
   weekly-review line reports agreement on tool calls and a sampled
   rubric score. This is the evaluation the owner is asking about, on real
   traffic, at no user-facing risk.
3. **Promote per tier.** When a candidate holds ≥ the bar on fixtures and
   shadow agreement for two weeks, flip `default` to it in `compute.yaml`
   — one line, reversible — with `deep` staying on Sonnet. Metis is now
   local for most turns and Claude for the hard ones.
4. **Then decide about `deep`.** Probably never local on 64 GB; that is
   what the two-default seed is for.

**Candidates to put through stage 0–2** (verify availability and quant in
LM Studio's catalog at PoC time; do not trust this list's names): the
current Qwen 3.x ~30B MoE and ~32B dense, GLM ~30B-A3B "flash" class,
gemma-4 at its largest size that fits, gpt-oss-20b. Criteria in order:
native tool calling in the chat template, JSON-schema output, ≥128k
context, MLX build, tokens/s at 8k prompt on this machine.

**Honest expectation.** On (1)–(2) a good 30B-class model in 2026 is
close to Sonnet with harness tuning; on (3)–(5) the gap is real and shows
up as blander briefs and more "safe" triage. Whether that is acceptable is
a judgment the shadow numbers make cheap to form. The cost side is
already known: ~$29/month on Sonnet for the profile above versus $0 —
meaningful but not decisive for one person; the stronger reasons are
privacy and independence, which the owner has already ranked.

## Apple Foundation Models in the provider model

Answer: **both — same package, but to the engine just another local
provider.** `packages/mcp-apple-fm` stays a Swift-helper bridge because
macOS requires it (invariant 6; PoC-3: no non-Swift SDK). Its wire grows
`GET /v1/models` (one id, `apple-fm/system`) and `POST /v1/chat/completions`
with `response_format: json_schema`; `compute.yaml` lists it as `kind:
openai-compatible`, `base_url: http://127.0.0.1:7810/v1`, cost 0.

- **(a) special `kind: apple-fm`** over the existing `/classify` — rejected:
  a third engine path for one bridge, answering one compiled-in schema.
- **(b) OpenAI-compatible surface on the bridge** — recommended. Cost: Swift
  in the helper mapping messages → `LanguageModelSession` and JSON schema →
  a runtime schema (Apple's `DynamicGenerationSchema`; page unfetchable —
  verify in Xcode first), no tool calling in v1, `/classify` kept until
  `inbox-drain` switches. Limits stay: small on-device model, Apple silicon
  + macOS 26 + Apple Intelligence on, weak as scorer (PoC-15), fine for
  reduction.

The collector rule becomes mechanical: `inbox-drain` may name `apple-fm`
or `lmstudio` (cost 0) and CI refuses `openrouter`.

**PoC first (owner ruling):** before PR 4, a PoC in `docs/poc/` proves the
helper can serve a runtime-supplied JSON schema through Foundation Models'
structured output (or establishes that only compiled `@Generable` schemas
work, which shrinks the surface to a fixed set for `inbox-drain`).

## Cost controls and monitoring

Users now pay per call, so every engine call writes one `runs` row with
additive columns `provider`, `model` beside the existing `tokens_in`,
`tokens_out`, `cost_usd`. Cost source: OpenRouter — the response's
`usage.cost` (verified, always present); Anthropic — the SDK's result cost
or the `pricing:` table; Zen and other clouds — the `pricing:` table (Zen
publishes prices); local and Apple FM — 0. `budgets:` are enforced **in
the engine before the call** against a `spend` named query
(`queries/spend.yaml`: by provider, model, tier, crew, day); `action` is
`allow` (record only), `stop` (the default: refuse the call with
`error = 'budget: …'`, a Needs You item, **and pause routines** — the
runner skips any routine whose tier would bill until the window resets,
since a stopped engine with a running scheduler just fills the queue with
refusals) or `critical_only` (only tiers or routines marked `critical:
true` in `compute.yaml` keep running — the escape hatch for "Metistry must
keep working"; what counts as critical is the owner's next discussion). A non-ZDR off-machine assignment writes one warning row
and shows a badge — informed choice, never a block (owner ruling). The
weekly review's routing report grows a spend section from the same query.

## The collaboration rule (MCP, not gateways) — rules and their enforcement

1. **A Claude turn never runs on a non-Claude model; no cross-kind
   fallback.** Engine is `provider.kind` from config; the `anthropic`
   engine has no base-URL override (that would be option C).
2. **No tool calls an engine.** `anthropic` has SDK subagents (Claude only)
   plus the console's `/mcp`; `openai-compatible` has `/mcp` only. Neither
   has a "run this on provider X" tool — invariant 9 by absence.
3. **Crews are assigned a provider; their engine follows its kind.** Crews
   never call each other: work moves as `work` rows (`agents_delegate` →
   row → drain → engine by the crew's provider), results as
   `report`/`capture`/artifact rows.
4. **Claude may scope work for anyone; it may not push work to a named
   non-Claude agent** (owner ruling, 2026-09-11). A Claude turn can create
   an *unassigned* `work` row — "any agent could do this" — that a Claude
   crew, a non-Claude crew or an OpenCode session claims from the same
   queue with the same lease. What the console refuses is a *directed*
   push: `agents_delegate` from an `anthropic` turn naming a crew (or
   `tasks_claim`-on-behalf) whose provider kind differs — `invalid_request`
   plus a `runs` row. Documenting work is collaboration with Metistry;
   naming the non-Claude worker is triggering it.
5. **Every provider's agents are peers at `/mcp`** — an OpenCode session
   on Zen, a Claude crew and a local crew see the same `tasks_*`, `report`,
   `capture`, `knowledge_*`, each with its own token and scope.

## Local model discovery and install

- **Discovery** is `GET <base>/v1/models` for every `openai-compatible`
  provider — LM Studio (all downloaded models when JIT is on), Ollama, Apple
  FM's one id, OpenRouter's catalogue; `compute models list` and the app's
  picker are that call, live. **Doctor**: one row per provider, naming
  which local server answered (`owned_by: library` is Ollama) and what
  `lms ps` has loaded.
- **Install**: `compute install lmstudio/<id>` spawns `lms get <id>`;
  `ollama/<id>` posts `/api/pull`; `compute models load|unload [--ttl]`
  wraps `lms` (Ollama loads on first call). Embeddings move to
  `/v1/embeddings` on the provider `assignments.embed` names;
  `METISTRY_OLLAMA_URL` + `METISTRY_EMBED_MODEL` seed it as a transition.
- **Default**: LM Studio when detected (owner's preference; MLX on
  M-series), Ollama equally supported; the wizard offers both with their
  install path (LM Studio download or llmster script; Ollama app or brew).

## Where local models win

| use | next | why |
| --- | --- | --- |
| Embeddings | same model on either local server | on-machine, free, per-row model/dim |
| Inbox reduction | `apple-fm` first, `lmstudio/<small>` where FM collapses, always through the redaction pass | plan 1857 names a local model as FM's fallback |
| Tier scorer | `lmstudio/…gemma…` after the blind eval | PoC-16: 97.9 %, 667 ms p95, $0 |
| `fast`, `routine`, crews that extract | local, or a named cloud vendor model | latency-tolerant, small tool surface; "absorb a lot of context on a cheap model" (`docs/ops/crews.md`) |
| `default`, `deep` | Sonnet / Opus suggested, user's choice | tools, memory, judgement — and what is tested |

## OpenCode as a dev tool

`plugins/opencode/metistry.ts`: one dependency-free file; hook `event`, on
`session.idle` (no session-end event exists) read `client.session.messages`,
build the same deterministic summary, `POST /capture` with `source:
"opencode"`, `kind: "session"`, the existing key formula; inert unless
`METISTRY_CAPTURE_ON_STOP=1`; 8 s cap. Parity test: `fromOpenCode()` in
`session-summary.ts`, one fixture through both. Search/tasks/capture need
no plugin — OpenCode mounts `/mcp`, written by `metistry connect opencode`:

```json
{ "$schema": "https://opencode.ai/config.json", "share": "disabled",
  "mcp": { "metistry": { "type": "remote", "url": "https://<origin>/mcp",
    "headers": { "Authorization": "Bearer {env:METISTRY_AGENT_TOKEN}" },
    "timeout": 15000, "enabled": true } } }
```

## The subscription scrub

**Touch points** (grep for `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`PoC-4`, "subscription"; `apps/console/{auth-store,push,server}.ts` and
`web/` matches are *web-push* subscriptions, not in scope):

- Engine: `apps/assistant/src/main.ts:10-14` (throw + `requireEnv`),
  `engine.ts` comments, `apps/assistant/Dockerfile`, `packages/core/src/
  supervisor.ts:68`.
- CLI: `deployment.ts:180,197` (`ASSISTANT_ENV_KEYS`), `secrets.ts:30,66,
  87` (`SECRET_NAMES`, user-scope rule), `main.ts:141,147`, `up.ts:362`,
  `README.md`, tests `deployment`, `secrets`, `up.launchd`.
- Shapes: `docker-compose.yml:112-113`, `.env.example:24-38`, `ops/launchd/
  …assistant.plist`, `apps/watchdog/src/probes.ts` + its supervisor test.
- Mac app: `kit/claude-token.swift` (step 7), `first-run-model.swift:7`,
  `wizard-step-views.swift:299`, `settings-view.swift:261-270` ("Claude
  Token"), `settings-model.swift:258-261`, `app/terminal-opener.swift`,
  tests `claude-token-tests`, `settings-model-tests`.
- Docs: `docs/ops/{cli,deployment-shapes,mac-app,reconciler,auth}.md`,
  `docs/product/{desktop-app-plan,PRODUCT}.md`, `docs/history/START-HERE.md`,
  `targets/local-crew/manifest.yaml` ("on the same subscription").
- Review, do not delete: `collectors/claude-usage`, `seed/queries/
  claude_usage_daily.yaml`, `routines/weekly-review/run.ts` read a
  subscription's quota — instance overlay, or a generic per-provider spend
  view. `docs/poc/RESULTS.md` and the plan are the record and stay.

**The mechanism for a private re-add, never named by the product** (rev
2; superseded by the one-engine decision in rev 3 — with no SDK in the
product there is nothing to inject, and the Studio's subscription reaches
Metistry only as a Claude Code collaborator over `/mcp`; kept for the
record):

1. `compute.yaml` is instance-owned and overlays the seed. A provider of
   `kind: anthropic` carries `auth: { secret: <any Keychain name>,
   inject_as: <any env name> }`. The engine reads the secret and passes it
   to the SDK subprocess through `Options.env` under `inject_as`. The seed
   template injects `ANTHROPIC_API_KEY`; the product validates the name's
   shape only.
2. `engine_env:` in `deployment.yaml` (instance-controlled) lists extra
   variable names the CLI's `assistantEnv()` passes through from
   `state/.env`; the product default is empty. `sandbox.ts` hosts come
   from `compute.yaml` providers' `base_url`s plus Anthropic's.
3. `metistry secrets` treats any `auth.secret` name in `compute.yaml` as a
   secret with the scope the file declares (`scope: user|instance`), so
   the hard-coded exception in `secrets.ts:66` goes.

The Studio keeps its subscription in its own instance repo; the product
says "API key" and nothing else.

## Phasing (revised)

| PR | what | proves | who |
| --- | --- | --- | --- |
| 1 | `compute.yaml` schema in core, seed + templates, `metistry compute providers|assign|budget` verbs, hot reload, OpenRouter seed provider with Claude pinned, **the scrub** (list above, plus the Agent SDK dependency and `engine.ts`'s `query()` path), wizard step 7 → Compute, Settings pane, docs | the repo is clean of the subscription path and the engine starts on an API-key provider read from config | product |
| 2 | `/v1/models` discovery, doctor rows, `compute models list|install|load|unload`, LM Studio + Ollama, embeddings over `/v1/embeddings` with the alias | both local servers discovered, installed and used from one protocol | product |
| 3 | `Engine` interface, `openai-compatible` engine (`completeJson` then the tool loop), `runs` provider/model columns, `spend` query, budgets, non-ZDR warning, per-run scoped credential, cross-kind delegation refusal | a `routine` tier on LM Studio and a crew on OpenRouter run end-to-end with the console's tools, cost on every row, a budget stop observed | product |
| 4 | Apple FM helper `/v1` surface; `inbox-drain` moves to provider `apple-fm`; CI check on collector providers | one protocol; the free tier is a provider | product |
| 5 | `plugins/opencode`, parity test, `metistry connect opencode`, `docs/ops/opencode.md` | an OpenCode session lands in the inbox with the same key shape | product; `@opencode-ai/plugin` types, ask |
| — | the Studio's private `compute.yaml` overlay (subscription provider, LM Studio assignments, budgets), `engine_env`, `metistry compute` runs against the live instance | the owner's own setup works with the product never naming it | owner |

## Recommendations

1. **One instance-owned `compute.yaml` (providers, assignments, budgets),
   protected path, edited by CLI and app as the user, hot-reloaded** —
   because "which compute" is how the system behaves (invariant 2), users
   change it on the fly, and one schema beats a directory per provider.
2. **One in-house OpenAI-compatible engine, Claude via OpenRouter, the
   Agent SDK removed with the scrub, no library yet** — because one
   protocol means one session store and one cost path, OpenRouter passes
   Anthropic prices and prompt caching through, the ~5% fee buys a product
   that never touches the SDK's login/branding terms, and the two
   pre-approved packages cover MCP and validation; a native Messages
   adapter stays a documented later option.
3. **Scrub the subscription path — and the SDK — in PR 1** — because the
   product must not encourage a ToS violation; with one engine the
   Studio's private overlay is just its own `compute.yaml` provider, and
   the subscription reaches Metistry only as a collaborator (Claude Code +
   plugin + `/mcp`).
4. **Make Apple FM an OpenAI-compatible local provider on its existing
   bridge** — because the engine then speaks one protocol, the package
   stays Swift where macOS requires it, and the "free tier" becomes a
   `cost: 0` check CI can run.
5. **Cost on every run row, budgets enforced before the call, non-ZDR as a
   warning** — because per-call billing makes spend the user's first
   question and informed choice is the owner's ruling.
6. **Enforce the collaboration rule by absence of tools and a console
   refusal on cross-kind delegation** — because "no Claude → non-Claude"
   must be something the system cannot do, not something it is told.

## Contradictions with the plan (not edited)

- **PoC-4's rule** ("subscription token, never `ANTHROPIC_API_KEY`") and
  every "subscription" sentence in the plan, `desktop-app-plan.md` and
  `PRODUCT.md` now contradict the pivot: the product path is an API key,
  the subscription is an instance's private overlay.
- Plan line 1857 and `desktop-app-plan.md` name Ollama; the default becomes
  LM Studio when detected.
- `CREW_MODELS = haiku|sonnet|opus` and `rules.yaml`'s `tiers:` are
  superseded by `compute.yaml` assignments (rev 1's `providers/` dirs too).

## Owner decisions (2026-09-11, on rev 2's open questions)

1. Provider secrets are **user scope**.
2. Claude may **scope work for any agent**; it may not **push work to a
   named non-Claude agent** (collaboration rule 4 rewritten above).
3. Budget `action` is **`allow | stop | critical_only`**, default `stop`,
   and `stop` **pauses routines** too; critical vs non-critical work is a
   follow-up discussion.
4. Apple FM runtime schemas: **PoC first**.
5. **Skip the SDK; Claude through OpenRouter** — the trade-off is written
   out under "Dropping the SDK entirely"; recommendation accepted.

## Owner questions (rev 4, 2026-09-11)

- **Managed Agents for the main agent?** No — API-key-only so its terms
  are clean, but it brings the sandbox tools invariant 9 removes, reaches
  `/mcp` only via a public endpoint or a research-preview tunnel, is not
  ZDR-eligible, is beta, and bills $0.08/hour of session time. Right shape
  for a later *compute target*.
- **A non-Claude main agent?** Yes as the seed default, with the model
  chosen by a PoC on Metistry's fixtures; cost table above.

## Open questions (rev 3)

0. Which non-Claude model is the seed `default` — decided by the PoC, but
   is "open weights" a criterion the owner wants (portability to local
   later) or only price and quality?
1. What is `critical: true` allowed to cover — the router's fast paths and
   `/note` cost nothing already; is it the `default` tier, a named
   routine, or nothing by default?
2. Should the seed ship OpenRouter as the *only* cloud template, with Zen
   as a second, and leave "add any OpenAI-compatible URL" to the form?
3. Prompt caching on the engine: one top-level `cache_control` (simple,
   automatic) or explicit breakpoints on the system prompt and tool list
   (cheaper on long loops, more code) — measure both in PR 3?

1. Is a per-provider `scope: instance` secret ever wanted, or is user
   scope the rule for every provider key?
2. Does a `work` row created by a Claude turn for a non-Claude crew count
   as "triggering"? This note refuses it at the console; the alternative
   is to allow rows and forbid only direct calls.
3. Should `action: stop` on a budget also pause routines that would enqueue
   billable turns, or only refuse at the engine?
4. Apple FM via `DynamicGenerationSchema` could not be verified by fetch;
   if runtime schemas are not available, (b) shrinks to a fixed set of
   compiled schemas — acceptable, or fall back to (a)?
5. Ship the `anthropic` template at all (SDK branding note), or seed
   OpenRouter with `anthropic/claude-sonnet-5` pinned?

## Sources

- [or-faq] <https://openrouter.ai/docs/faq> — fees (5.5% card credits, 5% BYOK), pass-through pricing, no logging by default (fetched 2026-09-11).
- [or-cache] <https://openrouter.ai/docs/features/prompt-caching> — Anthropic caching via OpenRouter: automatic top-level `cache_control` or ≤4 breakpoints; 0.1× reads, 1.25×/2× writes; `cached_tokens`/`cache_write_tokens` in usage (fetched 2026-09-11).
- [ma-overview] <https://platform.claude.com/docs/en/managed-agents/overview> — concepts, API-key beta access, built-in tools, "not currently eligible for Zero Data Retention", MCP tunnels as research preview (fetched 2026-09-11).
- [ma-reference] <https://platform.claude.com/docs/en/managed-agents/reference> — supported MCP server types (remote HTTP or tunnels), rate limits, branding guidelines (fetched 2026-09-11).
- [ma-budgets] <https://platform.claude.com/docs/en/managed-agents/budgets> — list cost: tokens at list, $10/1k web searches, $0.08/hour session running time; hard-cap semantics (fetched 2026-09-11).
- [or-models] <https://openrouter.ai/api/v1/models> — live prices and `supported_parameters` for the table (fetched 2026-09-11).
- [openai-compat] <https://platform.claude.com/docs/en/api/openai-sdk> — Anthropic's OpenAI compatibility layer: testing-oriented, no prompt caching, `response_format`/`strict`/`reasoning_effort` ignored (fetched 2026-09-11).

- LM Studio (<https://lmstudio.ai/docs/…>): `developer/openai-compat`,
  `developer/openai-compat/structured-output`, `developer/anthropic-compat`,
  `cli`, `developer/core/headless`, `developer/core/ttl-and-auto-evict`,
  `app/system-requirements`, `typescript`; <https://lmstudio.ai/mlx>
  (2024-10-08); <https://lmstudio.ai/blog/free-for-work> (2025-07-08); SDK
  MIT at <https://github.com/lmstudio-ai/lmstudio-js>.
- Ollama (<https://docs.ollama.com/…>): `api/openai-compatibility`,
  `capabilities/structured-outputs`.
- OpenRouter (<https://openrouter.ai/docs/…>): `api-reference/overview`,
  `features/provider-routing`, `features/model-routing` (Auto Router),
  `features/zdr`, `features/structured-outputs`,
  `use-cases/usage-accounting`, `use-cases/byok`, `api-reference/limits`.
- OpenCode: <https://opencode.ai/docs/> and `providers/`, `config/`,
  `plugins/`, `server/`, `cli/`, `mcp-servers/`, `sdk/`, `share/` (all
  2026-09-10); Zen <https://opencode.ai/docs/zen/>; MIT at
  <https://github.com/anomalyco/opencode>.
- Anthropic: [cc-gateway] <https://code.claude.com/docs/en/llm-gateway>;
  [env-vars] <https://code.claude.com/docs/en/env-vars>; [sdk-overview]
  <https://code.claude.com/docs/en/agent-sdk/overview>; [sdk-ts]
  <https://code.claude.com/docs/en/agent-sdk/typescript>.
- Libraries: Vercel AI SDK <https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools>,
  <https://ai-sdk.dev/providers/openai-compatible-providers>, licence
  <https://raw.githubusercontent.com/vercel/ai/main/LICENSE>;
  `openai` <https://github.com/openai/openai-node>; token.js
  <https://github.com/token-js/token.js>.
- **Failed / unverified:** OpenRouter Anthropic-Messages endpoint (404 on
  two paths); `npmjs.com` for `ai` and `@lmstudio/sdk` (403 — sizes
  unverified); Apple's FoundationModels pages (JS-rendered, empty) —
  `DynamicGenerationSchema` unverified; Apple FM facts come from
  `packages/mcp-apple-fm/helper/afm-helper.swift` and `docs/poc/RESULTS.md`.
- Repo: `CLAUDE.md`; `metistry-build-plan.md` (11, 133, 372, 552-576,
  1349, 1857, 2010-2016, 2424, 2511); `seed/rules.yaml`; `packages/core/
  src/{tiers,manifest,session-summary}.ts`; `apps/assistant/src/*.ts`;
  `apps/console/src/dispatch.ts`; `packages/cli/src/{deployment,sandbox,
  secrets,protected-write}.ts`; `db/migrations/0001_init.sql`;
  `packages/mcp-apple-fm/`; `plugins/claude-code/`; `docs/ops/*.md`;
  `docs/product/desktop-app-plan.md`; `docs/poc/RESULTS.md`.
