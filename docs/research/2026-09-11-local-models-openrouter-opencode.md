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

`anthropic` → the existing SDK path, credential injected through the
SDK's `env` option under `inject_as`; MCP and SDK subagents as today.
`openai-compatible` → everything else. Engine choice is `provider.kind`,
fixed by config; routing stays router → tier name → `resolveTier` →
`(provider, model, effort)` → engine, no model in the loop.

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

## Cost controls and monitoring

Users now pay per call, so every engine call writes one `runs` row with
additive columns `provider`, `model` beside the existing `tokens_in`,
`tokens_out`, `cost_usd`. Cost source: OpenRouter — the response's
`usage.cost` (verified, always present); Anthropic — the SDK's result cost
or the `pricing:` table; Zen and other clouds — the `pricing:` table (Zen
publishes prices); local and Apple FM — 0. `budgets:` are enforced **in
the engine before the call** against a `spend` named query
(`queries/spend.yaml`: by provider, model, tier, crew, day); `warn` writes
a warning row and continues, `stop` refuses with `error = 'budget: …'` and
a Needs You item. A non-ZDR off-machine assignment writes one warning row
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
4. **Claude delegates only to Claude crews.** The console refuses
   `agents_delegate` from an `anthropic` turn when the target crew's kind
   differs (`invalid_request`, a `runs` row) — "not spawning, triggering,
   or directly collaborating". Non-Claude crews claim work the router,
   routines or the user assign, from the same queue with the same lease.
   Whether a *row* is "triggering" is Open question 2.
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

**The mechanism for a private re-add, never named by the product:**

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
| 1 | `compute.yaml` schema in core, seed + templates, `metistry compute providers|assign|budget` verbs, hot reload, `anthropic` provider on an API key via `inject_as`, **the scrub** (list above), wizard step 7 → Compute, Settings pane, docs | the repo is clean of the subscription path and the engine starts on an API-key provider read from config | product |
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
2. **Two engines behind one interface — SDK on an API key, and an in-house
   OpenAI-compatible loop — with no library yet** — because the SDK docs
   direct API-key auth, base URLs already abstract providers, and the two
   pre-approved packages cover MCP and validation; revisit the AI SDK at
   ~600 lines.
3. **Scrub the subscription path in PR 1 and re-add it privately through
   `inject_as` + `engine_env`** — because the product must not encourage a
   ToS violation and the mechanism is generic enough to name nothing.
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

## Open questions

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
