# Atomic Agent — review (2026-09-12)

Reviewed at the owner's request: "similar to Hermes, but picking up steam.
Focus on local models. Uses Ollama." The last clause is wrong, and the
correction is the most useful thing here: **Atomic Agent is `llama.cpp`-first,
not Ollama.** Ollama and LM Studio are two optional provider presets with a
documented reliability caveat; the product runs a managed `llama-server` it
downloads and pins itself, built from its own fork.

It is also the first project in this series to publish a **controlled
local-model agent benchmark with raw artifacts**, on the Studio's hardware
class. That and its eval harness are why this note is long.

## What it is

A **product first, framework second**: one TypeScript codebase shipping an
Ink/React TUI, a CLI, an OpenAI-compatible HTTP server (`atomic-agent serve`),
and a Tauri sidecar over NDJSON/stdio. Not a library you import — a binary you
install (`curl … | sh`, Node SEA, self-updating from GitHub Releases).

Surface is wide: browser (Playwright/CDP, ARIA snapshots), filesystem, shell,
git, documents, memory, cron tasks, "skills", MCP, Telegram, vision.

- **Language / licence:** TypeScript, Node ≥ 25.7, `better-sqlite3`. MIT.
- **Layout:** `src/` 2 108 files — `tui` 772, `tools` 317, `llm` 211, `memory`
  121, `local-llm` 70, `agent` 42 — plus `eval/`, `eval-agents/`, `eval-memory/`.
- **Maturity:** created 2026-04-21; 2 529 stars, 247 forks; v0.6.0 on
  2026-09-11 with ~30 tags since 2026-08-20; 100 commits in 30 days;
  15 contributors of whom two (`plombeer31` 532, `Ooooze` 287) are most of it;
  self-labelled "developer preview". A funded-looking single-vendor project:
  faster than Hermes, same low-bus-factor risk.

## The model stack

Default and first-class: a managed `llama-server` from **their own
`llama.cpp` fork**, `atomic-llama-cpp-turboquant-nightly` (MIT, 1 star).
Launch flags (`src/local-llm/daemon-lifecycle.ts`):

```
--no-webui --jinja -ngl -1 --flash-attn auto
--cache-type-k turbo3 --cache-type-v turbo3 --parallel <n> -kvu --ctx-size <n>
```

`turbo3` is a fork-only KV type: stock llama.cpp cannot serve their default.

The catalogue (`models-catalog.ts`, 13 chat models) is curated Unsloth GGUF
links carrying `fileSizeGb`, `minRamGb`, `recommendedRamGb`, `maxContextLength`
and a vision projector — `gemma-4-e4b` (4.2 GB) through `gemma-4-31b`,
`qwen-3.5-4b/9b/35b`, **`qwen-3.6-35b-a3b` (22.4 GB, min 24 / rec 36 GB, 256K
ctx)**, `nemotron-3.5-30b-a3b`; embeddings `bge-m3`, `nomic-embed-text-v1.5`.

Everything else is fallback: OpenAI-compatible, OpenRouter, Gemini, AI/ML API,
**Ollama (`:11434`) and LM Studio (`:1234`) as wizard presets**, and a
`subscription-cli` provider spawning a signed-in `claude` or `codex`. Sampling
defaults `temp 0.2 / top_p 0.95 / top_k 40`. **No MLX anywhere** — on Apple
silicon this is llama.cpp + Metal.

## The performance claims, examined

**Claimed.** (1) GAIA validation L1, 53 tasks: **69.8 % vs Hermes 58.5 %**,
both driving the *same* local `Qwen3.6-35B-A3B-UD-Q4_K_XL` on the *same*
`llama-server`; avg wall 217 s vs 351 s. (2) Scaling: `qwen-3.5-9b` 52.8 %
@152 s, `gemma-4-12b` 45.3 % @423 s. (3) **"+30-50 % throughput"** from
TurboQuant speculative decoding. (4) **"~6.4× KV compression vs F16."**

**Measured.** (1) and (2) are, and unusually well.
`eval-agents/docs/GAIA-L1-EXPERIMENT.md` publishes an `environment.json`
snapshot (agent `0.1.36`, git sha, **Apple M4 Max 40-core GPU**, model file,
`n_ctx` 262 144, llama-server build `b1-9ee9a1c`), dataset provenance and
loader, `singleFork: true` + `maxConcurrency: 1` so one task hits the shared
daemon at a time, per-task temp workspace and state dir, `max-steps 40` and a
900 s timeout, **deterministic grading with no LLM judge in the scoring path**
(a TypeScript port of the official GAIA scorer over a `FINAL ANSWER:` line),
exact reproduction commands, a per-task head-to-head **with every winning task
ID listed**, and a `gaia-l1-eval-2026-06-11` release of matrices, NDJSON
traces and logs.

The caveats are volunteered: Hermes's temperature is not configurable and is
the one uncontrolled variable; GAIA L1 leans on live web access; single run
per configuration, random seed, no multi-seed averaging; 4-bit, so absolute
numbers are not leaderboard-comparable. The scaling table flags itself as
spanning versions `0.1.36`–`0.1.47`, "indicative … not a controlled sweep".

**Not measured:** (3) and (4). The fork has one star and no published
benchmark, and both agents shared one daemon, so TurboQuant is controlled
*out* of the only rigorous result. **The benchmark that is measured says
nothing about TurboQuant, and the claim about TurboQuant is not measured.**

### What plausibly produces the 11.3 pp gap

Real engineering, and all of it portable:

- **GBNF with the tool names baked in** (`grammars/tool-call.gbnf`). The root
  is an array of `{"tool":…, "args":…}` and every legal tool name is a grammar
  terminal — *a hallucinated tool name is unsamplable*. Three hard-won
  details: array-only root "so the model cannot fall into the single-object
  form via first-token bias even when it only needs one call"; a permissive
  `mcp.<a>.<b>` branch replaced at runtime by `buildGrammar` with real MCP
  names; and `ws ::= ( [ \t\n\r] ){0,64}` — bounded, because GBNF masks
  end-of-generation until the root is satisfied and unbounded whitespace gives
  a stuck sampler "an infinite legal move … a silent multi-minute hang".
- **One inference → N tool calls**, executed as a batch, independent reads in
  parallel. This is the wall-time lever: fewer round trips, fewer prefills.
- **Stable prefix + slot-pinned KV reuse.** Persona, rules, tools and skills
  are byte-stable within a session; the client sends `cache_prompt: true` plus
  both `slot_id` and `id_slot`; external servers are documented with
  `--cache-reuse 256`; `trace replay` re-hashes the prefix to catch drift.
- **Compression as a loop stage.** Results summarised not pasted; clipped ARIA
  trees (24k chars) instead of screenshots; history capped in **tasks**
  (default 20) rather than tokens.
- **Tool tiering.** `frequent` tools carry full args in the prefix, `rare`
  ones a one-line manifest materialised by `tool.view` — but they stay in the
  *grammar* either way.
- **A no-progress guard.** Repeated identical calls warn at 3, hard-veto at 5;
  after 3 vetoes the agent is forced into a graceful reply.
- **Per-model profiles** probed from `/props`: reasoning style (`none` /
  `think-tags` / `channel-tags`), turn framing, real context window, vision.
  Plus empty-completion, truncation and parse-failure recovery paths.

Stock, not theirs: `cache_prompt` already defaults true in llama.cpp;
`--flash-attn auto`, `-ngl -1`, `--parallel`; the quants are Unsloth's.
Marketing until numbers appear: TurboQuant's +30-50 % and 6.4×, the
"purpose-built Gemma 4 MTP and Qwen 3.6 NextN heads", and a `GAIA L1 · 69.8 %`
badge that reads as absolute when it is a 4-bit relative comparison.

**Verdict:** the gap is best explained by grammar-constrained tool calls,
batched parallel reads, aggressive compression and the loop veto — harness
design, all free, none of it needing their fork.

## The rest, briefly

**Loop.** Prompt → Decide (one grammar-checked JSON array) → Run (parallel
reads, approval-gated writes) → Compress → repeat until reply, finish, cancel
or max-steps. "The model chooses actions. Atomic Agent owns the loop, the
state, the approvals, the traces, the stop conditions."

**Memory.** SQLite + FTS5 with optional embeddings for hybrid recall: profile
facts, notes, links, lessons, procedures, voting, dedup, usefulness-based (not
age-based) eviction, and reflection running after the turn on a separate slot.
The prompt carries pointers; bodies come back by tool call — the same instinct
as `docs/ops/knowledge-search.md`, with a vote/evict layer we lack.

**Safety.** An approval ladder over shell, fs writes, patches, process kill,
HTTP, skill scripts and untrusted MCP; four session modes
(`default`/`plan`/`auto`/`bypass`) **never persisted** — "a `bypass` that
survived a restart would be a standing grant nobody remembers making". SSRF
guards; append-only NDJSON traces. A `git.remoteSync` flag, off by default,
refuses push/fetch/clone through both the git tools *and* the shell, and hands
`GITHUB_TOKEN` to git only via child-process env, never argv or `.git/config`.
They are honest about the limit: "skills and shell commands inherit the agent
process environment, including `.env` secrets".

**Multi-agent.** v0.6.0 "Fusion": a cloud orchestrator with a
`fusion.delegate` tool fanning out to N local workers, which cannot delegate
further, cannot reach the user, and cannot get an approval — anything needing
a person returns to the orchestrator.

## The eval harness — the part worth stealing

Two suites, TypeScript over vitest, MIT, both reusable.

**`eval/` — behaviour evals.** Each case spawns a real `atomic-agent run` in
an isolated temp `--cwd` and state dir, feeds one prompt on stdin, and asserts
on the reply (regex), the filesystem, and the trace (which tools ran, with
what status). ~70 cases, deliberately outside `npm test`: "unit tests must
stay fast and hermetic; evals talk to an external `llama-server`". Env loading
is `process.loadEnvFile` — no `dotenv`. Three things beat a pass-rate:

1. **Capability axes.** `harness/case-schema.ts` defines ten —
   `tool_selection`, `args_shaping`, `min_steps`, `parallel_batching`,
   `tool_error_recovery`, `instruction_adherence`, `self_termination`,
   `grammar_adherence`, `context_retention`, `refusal_of_impossible` — and
   each axis case "MUST isolate a single axis so a fail directly points at the
   component to fix", with an axis→fix map in the source (`args_shaping ->
   grammar, argsSchema`; `context_retention -> conversation packer`).
2. **Trace-derived columns** per row: `steps`, `parse_retries`, `tool_errors`,
   `batch_count`, `max_batch_size`, `prompt_tokens`, `predicted_tokens`.
   "They separate 'wrong final answer' from planner churn, tool-call
   brittleness, and missed batching."
3. **An honest judge.** Open-ended cases use `kind: "judge"` with a per-case
   rubric, pass at ≥ 4 of 5. The default judge is `openai/gpt-4o-mini` —
   deliberately a different family from the agent, "this removes the 'same
   model grades its own homework' bias". With no key every judge expectation
   **fails** as `judge unavailable` rather than silently passing, and
   `npm run eval:judge` re-scores a stored JSONL without re-running the agent.

Stated limits: no Pass@k, no browser cases, single-judge bias.

**`eval-agents/`** wraps that shape around GAIA with adapters for
atomic-agent, Hermes and OpenClaw behind one `spawn-cli` interface, plus
`environment-lock.ts`, `reproducibility.test.ts` and `preserve-traces.ts`;
`eval-memory/` does the same against mem0, Zep and LangMem.

## Verdicts for Metistry

Cross-references, not repeats: lazy tool discovery is already ours (PoC-17);
delegation is in the Hermes note; egress and budgets in the Rivet note.

### ADOPT — ranked, each ≤ 3 lines, no new dependency

1. **Constrain the tool *name*, not just the JSON shape.** Where the provider
   supports a grammar or `response_format: json_schema`, emit the tool-name
   enum from the live `tools/list`; keep parse → zod → one repair retry for
   providers that only hint.
   *Serves invariant 3/9 and "enforce at the tool": a tool the sampler cannot
   spell is a class of local-model failure deleted rather than caught.*
2. **Change the stage-0 candidate list — lead with a ~30-35B A3B-class MoE at
   Q4, demote gemma-4 to scorer-only.** Their controlled data:
   `qwen-3.6-35b-a3b` 69.8 %, `gemma-4-12b` 45.3 % at twice the wall time and
   ~3 steps/task (it bails early).
   *Serves "The path to a local main agent", stage 0; 22.4 GB fits the ~40 GB
   ceiling alongside Postgres and the console.*
3. **Give the bake-off record an axis tag and six trace columns.** One `axis`
   per fixture plus `steps`, `parse_retries`, `tool_errors`, `batch_count`,
   `prompt_tokens`, `predicted_tokens` per run.
   *Serves stage 0: a scalar says a model failed; an axis plus churn counts
   says whether to fix the model or the harness — the whole stage-2 question.*
4. **A no-progress veto in the engine loop.** Warn at 3 identical tool calls,
   hard-veto at 5, force a graceful reply after 3 vetoes.
   *Serves invariant 9. Runaway looping is how small models fail, and it
   bounds wall time and spend on every tier — so it earns its place now.*
5. **Pin one inference slot per session and assert a byte-stable prefix.**
   Send `cache_prompt: true` + a session-stable `slot_id`/`id_slot` to
   llama.cpp-backed providers; add a test hashing the rendered system prefix
   across two turns.
   *Serves "The engine layer" — the largest free local latency lever, and the
   test is what stops it silently regressing.*
6. **Judge from a third family, and never let an absent judge pass.** The bar
   is Sonnet, so a Sonnet judge marks its own homework; and store the raw
   JSONL so a rubric revision re-scores without re-running the agent.
   *Serves stage 0's honesty.*

### BORROW-LATER

- **Strict schemas and parallel tool calls do not compose** — OpenAI's own
  guidance is that a parallel call "may not match supplied schemas", so their
  `strictTools` also forces `parallel_tool_calls: false`. Relevant the day the
  engine gains `json_schema`.
- **Tagged tool calls in prose.** Some OpenAI-compatible endpoints emit
  `<tool_call><function=…>` inside `content`/`reasoning_content` and are
  silently never executed; their fail-closed coercion is the right response.
- **Task-count as the context unit** for the console readout: "tokens are the
  wrong unit to steer with — nobody thinks in them", with `· 3 tasks lost`.
- **A health probe distinguishing 503-while-loading from dead** — one row per
  provider in `doctor`; **prompt-drift replay**; **usefulness-based eviction**.

### SKIP

- **TurboQuant / their llama.cpp fork** — unmeasured, and we do not ship an
  inference engine (invariants 6, 7).
- **Managed model daemon** (download, pin, CUDA/Vulkan variants, tensor-split)
  — `lms` and `/api/pull` already do it; `compute install` is the right size.
- **Fusion** — a second delegation model competing with `agents_delegate`;
  revisit only after `compute.yaml` exists.
- **`subscription-cli` provider** — spawning a signed-in vendor CLI as a
  completion backend is what invariant 9 forbids. (Their load-bearing flags —
  `--tools ""`, `--strict-mcp-config`, `--system-prompt`,
  `--no-session-persistence` — are worth remembering anyway.)
- **The GAIA corpus** — HF token plus licence, and it measures web research,
  not Metis's job shape. Steal the harness, not the dataset.
- **Telegram channel** — a second single-user remote door with its own
  lockfile, against invariant 8.
- **ClawHub skill install** — remote unvetted code behind a prompt is
  prompting, not enforcement (invariant 2).
- **Analytics on by default**, and the **Ink TUI** — wrong posture, wrong
  surface.

## Contradictions with the plan and earlier notes

1. **"Uses Ollama" is wrong**, and the correction cuts against an assumption:
   the strongest published local-agent result on an M4 Max comes from
   llama.cpp + Metal with a custom KV quant, **not MLX**. The plan's stage-0
   criterion "MLX build" as a selection axis is unsupported by the only
   controlled evidence I found. Flagging, not acting.
2. **PoC-16's gemma4:e4b pass does not transfer to a main agent.** PoC-16
   scored a single-shot classification; an agent loop is a different task, and
   their gemma-4-12b run (45.3 %, ~3 steps, high empty-answer rate) is the
   caution. The plan's "gemma-4 at its largest size that fits" should be
   demoted — ADOPT 2.
3. **Reasoning-off may be too blunt.** The note says "reasoning-off locally
   (PoC-16)"; they treat reasoning as a per-model harness parameter probed
   from `/props`. PoC-16's finding is consistent with either reading; the
   per-model version is likelier right for a loop.
4. **Out of scope, noticed:** `docs/poc/poc16-local-scorer/poc16_score.py` and
   `poc16_analyze.py` are Python, against CLAUDE.md's "no Python anywhere
   (ruled 2026-08-29)", which PoC-16 postdates. Not touched.

## Could not verify

- The `gaia-l1-eval-2026-06-11` tarball — I read the write-up and checked its
  internal consistency but did not download the matrices or re-score the
  traces. The result rests on their honesty about files I did not open.
- The +30-50 % and 6.4× TurboQuant numbers — no method, benchmark or
  reproduction in either repo.
- `https://atomicagent.io/docs/` returned HTTP 200 but is a JS-rendered shell;
  I got the `<title>` and nothing else, so every quote here is from raw repo
  files, not the docs site.
- Whether slot pinning persists across turns in practice — I read
  `llama-server-client.ts`, not `session-registry.ts`.
- Star and contributor counts are a snapshot; treat the trend, not the number.

## Sources

Fetched **2026-09-12** via `gh api` and `curl` on `raw.githubusercontent.com`
(branch `main`).

- `gh api repos/AtomicBot-ai/atomic-agent{,/releases,/contributors,/commits}`
  and `…/atomic-llama-cpp-turboquant-nightly` (MIT, 1 star, pushed 2026-08-14)
- `README.md` (754 lines) — https://github.com/AtomicBot-ai/atomic-agent
- `eval/README.md`; `eval/harness/case-schema.ts` (axes and axis→fix map);
  `eval-agents/docs/GAIA-L1-EXPERIMENT.md` (248 lines); `grammars/tool-call.gbnf`
- `src/llm/llama-server-client.ts`, `src/prompt/stable-prefix.ts`,
  `src/local-llm/daemon-lifecycle.ts`, `src/local-llm/models-catalog.ts`,
  `src/llm/model-profile.ts`
- https://github.com/AtomicBot-ai/atomic-agent/releases/tag/gaia-l1-eval-2026-06-11
  (referenced, not downloaded); https://atomicagent.io/docs/ (HTTP 200, JS
  shell, no extractable content)
- Compared against `docs/research/2026-09-11-local-models-openrouter-opencode.md`,
  `metistry-build-plan.md` §PoC-14/15/16, `docs/ops/knowledge-search.md`,
  `docs/research/2026-09-12-{hermes-agent,rivet-agentos}-review.md`
