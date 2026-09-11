# Local models, OpenRouter and OpenCode in Metistry (2026-09-11)

> Research + design note. Owner wants Metistry to (a) install and use local
> models in setup, (b) route work via OpenRouter / OpenCode Zen, (c) support
> OpenCode as a dev tool like the Claude Code plugin. Nothing here is built.
> Vendor claims verified against official docs on 2026-09-11 (Sources).

## Summary

- **The engine is Claude-only and stays so.** Anthropic "doesn't support
  routing Claude Code to non-Claude models through any gateway", and a
  gateway credential replaces the subscription with per-token billing (the
  PoC-4 prohibition) ([Anthropic][cc-gateway]). A non-Claude tier needs a
  **second engine**, not a base-URL trick.
- **Recommend a small in-house OpenAI-compatible engine** in
  `apps/assistant` (raw `fetch` + the pre-approved MCP client), not OpenCode
  as the engine — OpenCode ships a shell tool by design (invariant 9) and is
  a second runtime to bundle. OpenCode is the right *dev tool*, mirrored
  from `plugins/claude-code`.
- **Providers become directories with manifests** (`providers/<name>/`),
  and a tier's `model` gains an optional `<provider>/` prefix. Pinned
  always; `openrouter/auto` is rejected at parse time because the Auto
  Router is "a fast, lightweight classifier" — a model choosing a model,
  invariant 4's exact prohibition ([OpenRouter][or-auto]).
- **One env var for local servers: `METISTRY_LOCAL_MODEL_URL`** (an
  OpenAI-compatible base URL). LM Studio and Ollama both serve
  `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`
  ([LM Studio][lms-openai], [Ollama][ollama-openai]); `METISTRY_OLLAMA_URL`
  stays as a deprecated alias. Default stays Ollama (open source, already
  ratified); LM Studio is detected and offered as an equal.
- **Off-machine providers are compute targets in all but name**: the same
  `data_policy`, enforced the same way — a per-run `/mcp` credential scoped
  to the provider's `allow`, plus `checkBrief` on crew briefs — with ZDR
  and provider pinning as manifest fields, not prompt text.
- **Where local wins today**: embeddings (already), the PoC-16 scorer once
  the eval passes, inbox reduction where Apple FM collapses, the `routine`
  tier, crews that extract. Not `deep`; not anything a collector bills.

## What the repo already has

- Tiers are `(model, effort)` pairs in `rules.yaml`; `resolveTier` "never
  invents a model" (`packages/core/src/tiers.ts`). Crews carry the same
  pair, `model` limited to `haiku|sonnet|opus` (`manifest.ts:171`).
- One SDK `query()` per turn with `model: spec.model`
  (`apps/assistant/src/engine.ts:66-92`). `main.ts:11-14` throws on
  `ANTHROPIC_API_KEY`, requires `CLAUDE_CODE_OAUTH_TOKEN`.
  `ASSISTANT_ENV_KEYS` (`packages/cli/src/deployment.ts:164`) is an
  allowlist and `sandbox.ts:31` allows only `ANTHROPIC_HOSTS` — a provider
  key or host reaching the engine is a deliberate, reviewable edit.
- Embeddings: Ollama `nomic-embed-text` via `METISTRY_OLLAMA_URL` and
  native `/api/embed`, degrading to keyword (`docs/ops/knowledge-search.md`);
  model + dim per row (plan 2424). `packages/mcp-apple-fm` classifies in
  `collectors/inbox-drain` under the "free on-device tier" rule (plan
  ~2012). PoC-15: FM's cheap class collapsed; PoC-16: `gemma4:e4b` passed
  as scorer at $0, invariant-4 amendment gated on a blind eval.
- Targets: `data_policy` enforced by `checkBrief`
  (`apps/console/src/dispatch.ts:59`); `targets/local-crew` narrows it by
  crew `scope` with a per-run credential.
- Claude Code plugin: `SessionEnd` → `POST /capture`, `kind: session`,
  `idempotency_key = <source>:<sessionId>:<sha256(...)[0:16]>`
  (`packages/core/src/session-summary.ts:226`), dependency-free `.mjs`,
  `test/session-parity.test.ts`.
- Secrets: Keychain `metistry:<VAR>`, `_KEY` suffix = secret, user vs
  instance scope (`docs/ops/cli.md`). Mac app panes are read-through fronts
  for CLI verbs; `rules.yaml` is §4.7-protected (`protected-write.ts`).
- `docs/research/2026-09-agent-proxy-routing.md` already ruled a gateway
  "transport, never routing" and proposed `metistry connect <client>`.

## What the vendors actually offer (verified 2026-09-11)

| | LM Studio | Ollama | OpenRouter | OpenCode Zen |
| --- | --- | --- | --- | --- |
| Chat API | `/v1/chat/completions`, `/v1/responses`, plus Anthropic `/v1/messages` on port 1234 | `/v1/chat/completions` on 11434 | `/api/v1/chat/completions`, Bearer key | `/zen/v1/chat/completions`, `/zen/v1/messages`, `/zen/v1/responses` |
| Embeddings | `/v1/embeddings`; SDK example `nomic-embed-text-v1.5` | `/v1/embeddings` (`model`, `input`, `dimensions`) | n/a | not stated |
| Model mgmt | `lms get/load/unload/ls/ps/server`, bundled with the app; **llmster** = headless core, `curl -fsSL https://lmstudio.ai/install.sh \| bash`, `lms daemon up` | `ollama pull` / HTTP API | n/a | n/a |
| Idle | JIT load; TTL default 60 min; auto-evict keeps 1 JIT model | `keep_alive` | n/a | n/a |
| Apple silicon | MLX + GGUF, mixable; `mlx-engine` MIT; macOS 14+, 16 GB+ recommended | Metal | n/a | n/a |
| Licence | app proprietary, "free to use both at home and at work" (2025-07-08); `@lmstudio/sdk` MIT | MIT | service | service; OpenCode MIT (`anomalyco/opencode`) |
| Routing | — | — | default "load balance … prioritizing price"; pin with `provider.order` + `allow_fallbacks: false`; `openrouter/auto` = classifier | curated list, pay-as-you-go, auto-reload $20 under $5 |
| Data | local | local | ZDR by account scope or per-request `provider.zdr: true`; "OpenRouter itself has a ZDR policy" unless prompt logging is opted in; BYOK 5 % fee; `:free` 20/min, 50 or 1000/day | US-hosted; zero-retention except OpenAI/Anthropic 30-day and free models that may train |

OpenCode (`opencode-ai` on npm, `brew install anomalyco/tap/opencode`):
providers include Zen, Anthropic (API key **or** "Claude Pro/Max" OAuth),
OpenRouter, and any OpenAI-compatible server via `@ai-sdk/openai-compatible`
+ `baseURL` (LM Studio `:1234/v1`, Ollama `:11434/v1`). `opencode.json`
(global `~/.config/opencode/` or project root): `model`, `small_model`,
`provider`, `mcp`, `agent`, `plugin`, `share` (default `manual`),
`permission`, `{env:VAR}`. Plugins: `.js/.ts` in `~/.config/opencode/
plugins/` or `.opencode/plugins/`, signature `({ project, client, $,
directory, worktree })`, hook `event` with verified names
`session.created|updated|idle|status|compacted|deleted|error|diff`,
`message.updated`, `tool.execute.before|after`, `permission.asked|replied`,
`file.edited`, `command.executed`, `server.connected`. `opencode run -m
provider/model --format json --attach http://localhost:4096`; `opencode
serve --port 4096 --hostname 127.0.0.1` (`OPENCODE_SERVER_PASSWORD` basic
auth); `@opencode-ai/sdk` `createOpencodeClient({ baseUrl })`,
`session.prompt({ model: { providerID, modelID }, parts })`.

Anthropic ([cc-gateway], [sdk-overview]): "doesn't support routing Claude
Code to non-Claude models through any gateway"; "While a gateway credential
variable … is active, a developer's claude.ai subscription isn't used …
billed per token"; `ANTHROPIC_BASE_URL` alone keeps the saved login. Also:
"Anthropic does not allow third party developers to offer claude.ai login
or rate limits for their products, including agents built on the Claude
Agent SDK" — outside scope, flagged under Contradictions.

## Q1 — where local models win, and where they do not

| use | today | next | why |
| --- | --- | --- | --- |
| Embeddings | Ollama `nomic-embed-text` | same on either server via `/v1/embeddings` | on-machine, free, per-row model/dim |
| Inbox reduction (stage 2) | Apple FM bridge | local chat model as declared fallback where FM collapses, still through the deterministic redaction pass | plan 1857 already names "Local model via Ollama" as FM's fallback |
| Tier scorer | none (gated) | `local/gemma4:e4b` single-shot JSON after the blind eval | PoC-16: 97.9 %, 667 ms p95, $0 |
| `routine` tier | haiku | `local/<model>` per instance overlay | cheap, latency-tolerant, small tool surface |
| Crews that extract | haiku | `model: local/...` or `openrouter/...` | "absorb a lot of context on a cheap model" (`docs/ops/crews.md`) |
| `default`/`fast` chat | haiku | keep | tool-heavy; local tool-calling is the weak spot |
| `deep` | opus | keep | the point of the tier |
| Anything a collector bills | never | never | collectors "never call *billable* models"; OpenRouter/Zen bill, local does not |

Rule: local for **classification, extraction, one JSON verdict** over
sensitive input; cloud non-Claude where a named vendor model is better for a
crew; Claude where tools, memory and judgement matter.

## Q2 — a provider model for tiers, and the second engine

**Tier syntax.** `model` becomes `[<provider>/]<model-id>`; no prefix means
`anthropic` (existing `haiku|sonnet|opus` keep working). The first segment
is a provider only if `providers/<segment>/manifest.yaml` exists; the rest
is verbatim, so `openrouter/anthropic/claude-haiku-4.5` and
`local/gemma4:e4b` both parse. CI rejects `/auto`, fallback lists, unknown
providers.

```yaml
tiers:
  fast:    { model: haiku, effort: low }
  default: { model: haiku, effort: medium }
  deep:    { model: opus,  effort: high }
  routine: { model: local/gemma4:e4b, effort: low }   # instance overlay
scorer:    { model: local/gemma4:e4b }                  # only after the eval
```

**Routing table (deterministic, config → engine):**

| step | who | input | output |
| --- | --- | --- | --- |
| 1 | router (rules over regex) | text, `/deep`, `meta.tier` | tier **name** |
| 2 | `resolveTier` | name | `(provider, model, effort)` |
| 3 | provider manifest | provider | `api: anthropic-sdk \| openai-chat`, base URL, key ref, locality |
| 4 | drain | `api` | `engine.ts` (SDK) or `engine-openai.ts` |

No model appears in steps 1-4; a scorer, if ever admitted, picks only among
named tiers and cannot touch step 3 (plan ~2010).

- **(A) OpenCode as engine** (`opencode serve` + SDK, console `/mcp`
  mounted). Rejected for this role: its built-ins include bash and edit, so
  invariant 9 would rest on `permission: { bash: "deny" }` in a foreign
  binary's config; it is a second runtime to bundle and supervise.
- **(B) In-house OpenAI-compatible engine**, `apps/assistant/src/
  engine-openai.ts`: `fetch` to `<base>/chat/completions` with `tools`
  built from the console's `tools/list` (client from
  `@modelcontextprotocol/sdk`, pre-approved, StreamableHTTP to
  `METISTRY_BRAIN_URL`), the standard function-calling loop, `max_turns`
  from the tier/crew. Invariant 9 holds **by construction**: the only tools
  that exist are the console's. Zero new dependencies. Effort → `reasoning:
  { effort }` on OpenRouter, reasoning-off on local (PoC-16: reasoning hurt).
- **(C) Gateway behind `ANTHROPIC_BASE_URL`** (LiteLLM, LM Studio's or
  Zen's `/v1/messages`). Rejected: unsupported for non-Claude models, a
  gateway credential flips to API billing (PoC-4), and it is per-process.

**Recommend (B).** Cost: an agent loop we own (~400 lines with tests),
weaker than the SDK's — acceptable for small-tool-surface tiers. First cut
needs no tools (`completeJson()` for scorer and inbox reduction).

## Q3 — installing local models from setup

- **`metistry doctor`**: a `provider` row per manifest — `GET <base>/models`
  → `ok | absent | failed`; for `local`, say which server answered
  (`owned_by: library` is Ollama).
- **`metistry models`** (host CLI, never the engine): `list` (`/v1/models`),
  `pull <id>` (Ollama `POST /api/pull`; LM Studio spawns `lms get`, which
  ships with the app and with llmster), `load <id> [--ttl]` (`lms load`;
  Ollama loads on first call), `check`. Every verb degrades absent.
- **Mac app "Models" pane** (read-through only): provider rows from
  `doctor --json`; install buttons — Ollama one-click as ratified
  (`docs/product/desktop-app-plan.md` ~555), LM Studio via its download or
  llmster's script; a per-tier picker that runs `metistry rules set-tier
  <tier> <provider/model>` through `protected-write.ts` (the user's hand,
  invariant 2). The app never edits `rules.yaml` itself.
- **Default**: keep **Ollama** — MIT, brew, validated by PoC-5/16, named in
  the plan. LM Studio is the better pick for GUI, MLX speed, TTL/JIT and
  `lms`; the pane says so. Flipping the default is an owner call.
- **Env**: `METISTRY_LOCAL_MODEL_URL` (default `http://127.0.0.1:11434/v1`;
  LM Studio is `http://127.0.0.1:1234/v1`); `METISTRY_OLLAMA_URL` accepted,
  mapped to `<url>/v1`, warned by doctor. Embeddings move from `/api/embed`
  to `/v1/embeddings` so one code path serves both; `METISTRY_EMBED_MODEL`
  already covers the differing ids (`nomic-embed-text` vs
  `text-embedding-nomic-embed-text-v1.5`).

## Q4 — secrets and data policy

- **Names**: `METISTRY_OPENROUTER_API_KEY`, `METISTRY_OPENCODE_ZEN_API_KEY`
  (`_KEY` = secret); **user-scoped** Keychain like `CLAUDE_CODE_OAUTH_TOKEN`.
- **Who holds them**: the process that makes the call — under (B) the
  assistant, so both names join `ASSISTANT_ENV_KEYS` and `openrouter.ai` /
  `opencode.ai` join the sandbox host allowlist: two explicit edits, which
  is what an allowlist is for. Local providers carry no key.
- **Data policy = the target's.** Each off-machine provider manifest
  carries a target-shaped `data_policy`, enforced at the tool: (1) a turn
  or crew run on provider P gets a per-run `/mcp` credential scoped to
  `P.data_policy.allow` (the `targets/local-crew` mechanism), so
  `knowledge_*` on that session cannot return paths outside it and
  comms-derived rows are excluded; (2) crew briefs still pass `checkBrief`
  against `P.data_policy` ∩ crew scope; (3) a refusal is a `runs` row with
  `error = 'data_policy: …'`. Pinning and ZDR are manifest fields sent
  verbatim (`provider.order`, `allow_fallbacks: false`, `zdr: true`); an
  OpenRouter tier without `zdr: true` is a CI warning.

## Q5 — OpenCode as a dev tool

1. **`plugins/opencode/metistry.ts`** — one dependency-free file (OpenCode
   runs it in its own Bun; `fetch` and the injected `client` suffice).
   Hook `event`; on `session.idle` (OpenCode has no session-end event; idle
   is "the agent finished a turn") read `client.session.messages({ path:
   { id } })`, build the same deterministic summary (turns, duration, tools
   with counts, files touched, first prompt, last response — never a
   transcript), `POST /capture` with `source: "opencode"`, `kind:
   "session"`, and the existing key formula with `source = "opencode"`.
   Inert unless `METISTRY_CAPTURE_ON_STOP=1`; 8 s cap; never throws into
   the session. Idle fires per turn; a new key per turn is the documented
   "new summary" semantics.
2. **Parity test**: a `fromOpenCode(messages)` normaliser in
   `packages/core/src/session-summary.ts`, one shared fixture, and
   `plugins/opencode/test/session-parity.test.ts` reading it through both —
   the pattern that already guards the Claude Code `.mjs`.

The Tier-0/1 surface needs no plugin: OpenCode mounts the console's `/mcp`
with an agent token, so `knowledge_search`, `capture`, `tasks_*` are tools.
Documented in `docs/ops/opencode.md`, written by `metistry connect opencode`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "mcp": {
    "metistry": {
      "type": "remote",
      "url": "https://<origin>/mcp",
      "headers": { "Authorization": "Bearer {env:METISTRY_AGENT_TOKEN}" },
      "timeout": 15000,
      "enabled": true
    }
  }
}
```

`share: "disabled"` because `manual` still allows a transcript onto someone
else's server. Instance split as today (work profile → work URL + token).

## Q6 — provider manifests (invariant 5)

`providers/<name>/manifest.yaml`, `type: provider`; `providerManifest` in
`packages/core/src/manifest.ts`; validated by `manifests.test.ts`;
`GET /api/providers` with live `check()`; overlay via
`METISTRY_PROVIDERS_DIRS` (D4). Product ships four:

```yaml
name: openrouter
type: provider
description: OpenRouter — one key, many vendors, OpenAI-compatible
runs_on: cloud                         # host | container | cloud
api: openai-chat                       # anthropic-sdk | openai-chat
base_url: https://openrouter.ai/api/v1
auth: env:METISTRY_OPENROUTER_API_KEY  # env reference; user-scoped Keychain
locality: off_machine                  # on_machine providers skip data_policy
routing: { order: [anthropic], allow_fallbacks: false, zdr: true }
cost: { billable: true }               # collectors may never name a billable provider
data_policy:
  allow: [Knowledge/Projects, Knowledge/Resources, Knowledge/Techniques]
  deny_sources: [comms]
  max_brief_bytes: 65536
```

```yaml
name: local
type: provider
description: A local OpenAI-compatible server (Ollama or LM Studio)
runs_on: host
api: openai-chat
base_url: env:METISTRY_LOCAL_MODEL_URL # default http://127.0.0.1:11434/v1
auth: none
locality: on_machine
cost: { billable: false }
check: { list_models: true }           # doctor: GET base_url/models
```

`anthropic` is `api: anthropic-sdk`, `auth: env:CLAUDE_CODE_OAUTH_TOKEN`,
`locality: off_machine`; `opencode-zen` is the `openrouter` shape with
`base_url: https://opencode.ai/zen/v1` and no `routing:` block.

## Q7 — phasing

| PR | what | proves | deps |
| --- | --- | --- | --- |
| 1 | `METISTRY_LOCAL_MODEL_URL` (+ alias), embeddings over `/v1/embeddings`, doctor detects Ollama/LM Studio, `providers/local` + schema, `metistry models list/check` | one env var serves both servers; first `type: provider` passes CI | none |
| 2 | `providers/{anthropic,openrouter,opencode-zen}`, `<provider>/` prefix in tier and crew `model` (parse; CI rejects `/auto`, fallback lists), `metistry models pull/load`, secret names, `GET /api/providers`, docs | the config surface is complete and validated before any call is made | none (`lms` spawned) |
| 3 | `plugins/opencode` + parity test + `docs/ops/opencode.md` + `metistry connect opencode` | an OpenCode session lands in the inbox with the same key shape as Claude Code | `@opencode-ai/plugin` **types only, dev** — ask |
| 4 | `engine-openai.ts`: `completeJson()` first (scorer behind the eval flag; inbox-drain fallback), then the MCP tool loop; `routine` and crews on `local/...`; `ASSISTANT_ENV_KEYS` + sandbox hosts; per-run scoped credential; runs rows with cost | a non-Claude tier runs end-to-end with the console's tools and the same enforcement | none (MCP SDK pre-approved) |

PR 5 (later): the Mac app "Models" pane over those verbs. `@lmstudio/sdk`,
`@opencode-ai/sdk` and `openai` are **not** needed; raw `fetch` suffices.

## Recommendations

1. **Build a second, OpenAI-compatible engine in `apps/assistant`; never
   point the SDK at a gateway** — because Anthropic does not support
   non-Claude models through any gateway, a gateway credential replaces the
   subscription (PoC-4), and a loop over `/mcp` keeps invariant 9 true.
2. **Make providers manifests and tiers `provider/model` strings, with
   `auto` and fallback lists rejected at parse time** — because invariant 4
   survives OpenRouter only if the model is pinned in config and
   `openrouter/auto` is a classifier choosing a model.
3. **One local env var, `METISTRY_LOCAL_MODEL_URL`, embeddings on
   `/v1/embeddings`, Ollama the default and LM Studio a detected equal** —
   because both speak the same three endpoints and Ollama is MIT and
   already ratified.
4. **Treat off-machine providers as targets: same `data_policy`, enforced
   by a scoped per-run `/mcp` credential and `checkBrief`, ZDR and pinning
   as manifest fields** — because "comms never leaves" is enforced at the
   tool today and must not become prompt text for a second party.
5. **Ship `plugins/opencode` as a `session.idle` plugin with the existing
   idempotency-key formula and a documented `/mcp` snippet, in its own PR**
   — because it is independent, dependency-free, and gives OpenCode the
   whole Tier-0/1 surface without a second engine.

## Contradictions with the plan (not edited)

- Plan line 1857 and `desktop-app-plan.md` name **Ollama** as the local
  path; this note keeps it and adds LM Studio as an equal.
- `CREW_MODELS = haiku|sonnet|opus` and `docs/ops/crews.md` limit a crew's
  model to three; recommendation 2 widens it to `provider/model`.
- The SDK overview's "does not allow third party developers to offer
  claude.ai login … including agents built on the Claude Agent SDK" sits
  uneasily with PoC-4's subscription rule for a *distributed* app. Outside
  scope; flagged.

## Open questions

1. Default local server for the Mac app: keep Ollama (plan) or flip to LM
   Studio now that the owner has used it?
2. Should an OpenRouter tier without `zdr: true` be a CI **error** rather
   than a warning, given invariant 8?
3. Is a per-run scoped `/mcp` credential acceptable for *chat* turns on
   non-Anthropic providers, or should those providers be crew-only at first?
4. Does the SDK-overview clause on claude.ai login change anything about
   distributing the Mac app on the subscription path?
5. `@opencode-ai/plugin` as a dev-only types dependency — approve, or type
   the hook by hand?

## Sources

- [lms-openai] <https://lmstudio.ai/docs/developer/openai-compat>;
  [lms-anthropic] <https://lmstudio.ai/docs/developer/anthropic-compat>;
  [lms-cli] <https://lmstudio.ai/docs/cli>; [lms-headless]
  <https://lmstudio.ai/docs/developer/core/headless>; [lms-ttl]
  <https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict>; [lms-mlx]
  <https://lmstudio.ai/mlx> (2024-10-08); [lms-sysreq]
  <https://lmstudio.ai/docs/app/system-requirements>; [lms-work]
  <https://lmstudio.ai/blog/free-for-work> (2025-07-08); [lms-sdk]
  <https://lmstudio.ai/docs/typescript>,
  <https://lmstudio.ai/docs/typescript/embedding>, licence from
  <https://github.com/lmstudio-ai/lmstudio-js> (npm page 403).
- [ollama-openai] <https://docs.ollama.com/api/openai-compatibility>
- [or-api] <https://openrouter.ai/docs/api-reference/overview>;
  [or-routing] <https://openrouter.ai/docs/features/provider-routing>;
  [or-auto] <https://openrouter.ai/docs/features/model-routing>; [or-zdr]
  <https://openrouter.ai/docs/features/zdr>; [or-privacy]
  <https://openrouter.ai/docs/features/privacy-and-logging>; [or-byok]
  <https://openrouter.ai/docs/use-cases/byok>; [or-limits]
  <https://openrouter.ai/docs/api-reference/limits>
- [oc-docs] <https://opencode.ai/docs/> (2026-09-10) and its `providers/`,
  `config/`, `plugins/`, `server/`, `cli/`, `mcp-servers/`, `sdk/`,
  `agents/`, `share/` pages; licence MIT at
  <https://github.com/anomalyco/opencode>; [oc-zen]
  <https://opencode.ai/docs/zen/> (2026-09-10)
- [cc-gateway] <https://code.claude.com/docs/en/llm-gateway>;
  <https://code.claude.com/docs/en/third-party-integrations>;
  [sdk-overview] <https://code.claude.com/docs/en/agent-sdk/overview>
- **Failed fetches:** an OpenRouter Anthropic-Messages-format endpoint
  could not be verified (`/docs/api-reference/messages` and
  `/docs/guides/claude-code-integration` both 404) — treat as unknown;
  `lmstudio.ai/docs/developer/sdk`, `/docs/developer/core/llmster`,
  `/docs/app/advanced/mlx` 404 — content taken from the pages above.
- Repo: `CLAUDE.md`; `metistry-build-plan.md` (11, 133, 372, 552-576,
  1349, 1857, 2010-2016, 2424, 2511); `seed/rules.yaml`; `packages/core/
  src/{tiers,manifest,session-summary}.ts`; `apps/assistant/src/{engine,
  main,tiers,crew,crew-drain}.ts`; `apps/console/src/dispatch.ts`;
  `packages/cli/src/{deployment,sandbox,protected-write}.ts`; `targets/*/
  manifest.yaml`; `plugins/claude-code/`; `docs/ops/*.md`;
  `docs/product/desktop-app-plan.md`; `docs/poc/RESULTS.md`.
