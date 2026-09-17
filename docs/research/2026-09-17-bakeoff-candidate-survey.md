# Bake-off candidate survey (2026-09-17)

`docs/plan-refresh-2026-09-13.md` §3.3 names a *class*, not models — "a ~30–35B
A3B-class MoE at Q4 as lead, one ~32B dense control, gemma-4 scorer-only" — and
instructs whoever runs PoC-18 to "verify names and quants in the catalogue at
PoC time — do not trust a list written today". This is that verification. Every
name, size, score and price below was fetched on **2026-09-17**; nothing is from
memory. Sources in §5, keyed `[n]`.

Selection follows the owner's ruling of **2026-09-17**: quality first, open
weights as a tiebreaker inside a quality band, and a somewhat lower-quality
open-weight model is acceptable where day-to-day performance and usability stay
reasonable. Hard constraints from the plan: Apple Silicon (M5 Pro, 64 GB, ~40 GB
practical ceiling with Postgres, console and engine resident; a Mac Studio for
the second instance), native tool calling in the chat template, structured
output (grammar or `json_schema`), ≥128k context, GGUF for llama.cpp with Metal,
tokens/s at 8k.

**The headline: the plan's lead and control lanes should swap.** The A3B-class
MoE the plan names as lead is now the *fast* lane; the highest-quality local
candidate that fits the ceiling is a **27B dense** model released after the plan
was written. Details in §4.

---

## 1. Candidate table — local

Sizes are the Q4 file, not resident RAM; add KV cache (§4, finding D).

| model | total / active | licence | quant + size | context | tool calling in llama.cpp | reasoning toggle | agentic evidence | Apple Silicon tok/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Qwen3.8-27B** (Aug 14 2026) | 27B dense, hybrid Gated DeltaNet + gated attention, 64 layers | Apache-2.0 | Q4_K_M **17.1 GB** (pack-dependent: 16.8 GB lmstudio-community, 19 GB ggml-org); IQ4_XS 15.7 GB | 262,144 native, ~1M RoPE-scaled | yes, `--jinja` **mandatory** — without it there is "no reliable marker for where your turn ends"; needs current master (a stale build corrupts the DeltaNet CUDA/compute path) | thinking on by default, `"enable_thinking": False` | SWE-bench Pro **61.7**, Terminal-Bench 2.1 (Terminus) **73.0**, OSWorld-Verified 84.3, LCB v6 90.3, IFBench 79.5, GPQA-D 89.2 | **33.81** tok/s (`qwen3.8:27b-mlx`, M5 Pro 64 GB); 22.99 tok/s oMLX 4-bit with external spec. decoding; 16.68 GB weights at 4-bit; prefill 368 tok/s at 16k | 
| **Qwen3.6-35B-A3B** (Apr 16 2026) | 35B total / **3B active** MoE | Apache-2.0 | Q4_K_M **21.2 GB** (lmstudio-community, llama.cpp b8814); Q6_K 28.5 GB | 262,144 native, ~1.01M extended | yes; upstream parser `qwen3_coder`; MTP variants ship in the GGUF packs | thinking on by default, `"enable_thinking": False`; also `"preserve_thinking": True` across turns | SWE-bench Verified **73.4**, SWE-bench Pro 49.5, Terminal-Bench 2.0 51.5, **TAU3-Bench (general agent) 67.2**, MCPMark 37.0 | **84.90** tok/s avg, **79.94** at 11k ctx (`qwen3.6:35b-a3b-mtp-q4_K_M`, M5 Pro 64 GB) — the fastest model in that suite |
| **GLM-4.7-Flash** (Jan 20 2026) | 30B total / ~3B active MoE (GGUF arch `deepseek2`) | MIT | Q4_K_XL 17.5 GB (Unsloth Dynamic), Q4_K_M 18.3 GB, Q5_K_M 21.4 GB | **128k** (LM Studio catalogue); card does not state it | yes — "trained for tool use"; parser `glm47`; **known issue: looping unless `--repeat-penalty 1.0`** (fixed guidance Jan 21) | "Preserved Thinking" mode, required for multi-turn agentic work; LM Studio exposes Enable/Clear Thinking | τ²-Bench **79.5** (own card); τ²-Bench Telecom **98.8 %**, 3rd overall as of Aug 16 2026; SWE-bench Verified 59.2; ~94 % tool-call success, 600 graded MCP calls | not measured on M5; 16 GB minimum per LM Studio |
| **Nemotron-3.5-Lightning-30B-A3B** (Aug 2026) | 30B / ~3B active, hybrid Mamba-2 + MoE (`nemotron_h_moe`) | **OpenMDW-1.1** | ggml-org GGUF Q4_0 **18.9 GB**, Q8_0 33.6 GB | up to **1M** | fine-tuned for tool calling and structured outputs; NVIDIA's own serving configs use `--tool-call-parser qwen3_coder`; GGUFs auto-converted by ggml-org (template fidelity unverified) | not documented as a toggle; MTP layers present | no BFCL/τ² figure found on the card — **evidence gap** | **67.69** tok/s avg (`nemotron-3.5-lightning:30b-mlx`, M5 Pro 64 GB) |
| **Gemma 4** (Jul 30 2026) | E4B 4.5B eff.; 12B; **26B-A4B** (25.2B/3.8B active MoE); 31B dense | Apache-2.0 | GGUF across packs; E4B already resident in the Studio | E2B/E4B **128k**; 12B / 26B-A4B / 31B **256k** | "native function-calling support… native support for structured tool use" | not a documented toggle | ~95 % tool-call success at 27B-class, but "conservative on chained calls; asks for approval unnecessarily" | E4B is the PoC-16 scorer at 667 ms p95 |
| **Qwen3.5-9B** (Feb 24 2026) | 9B dense | Apache-2.0 | Q4_K_M ~6 GB class (Unsloth UD- dynamic variants) | 262,144 native | trained for tool use; chat-template fixes improved tool calling; **Ollama does not support its llama.cpp GGUFs** — llama.cpp / LM Studio only | thinking toggle per Qwen3.5 family | none specific found | not measured |

## 2. Candidate table — open-weight cloud (OpenRouter), for the seed default

Prices per million tokens, fetched 2026-09-17. "Weighted avg" is OpenRouter's
own realised figure and is what a bill actually looks like; list is what a cold
request costs.

| model | weights | in / out | context | tools + `json_schema` | why it is on the list |
| --- | --- | --- | --- | --- | --- |
| `qwen/qwen3.6-35b-a3b` | Apache-2.0 — **the same weights as the local MoE lane** | **$0.05 / $0.70** (list; a third-party aggregator shows $0.14/$1.00) | 262,144 (32,768 completion) | yes, both | the cheapest way to answer the seed-default question, and the only row where cloud and local are the same model (§4, finding B) |
| `deepseek/deepseek-v4-flash` | MIT, ~284B / ~13B active | first-party **$0.14 / $0.28**; OpenRouter weighted avg ~$0.054 / $0.242 | 1,048,576 (latest route 1,310,720) | tools yes | "the first open-weight model that teams immediately dropped into real agentic pipelines"; note DeepSeek's first-party API retains data for training — route it through OpenRouter under the ZDR rules already in `compute.yaml` |
| `z-ai/glm-5.2` | described as open-weight in two independent shortlists; **licence not verified — check before ratifying** | weighted avg **$0.447 / $3.31** (routes span $0.95–$3.00 in, $3.00–$10.25 out) | not fetched | not fetched | top of τ²-Bench (99.1 % telecom, Aug 16 2026); "closest open drop-in for Opus-style work"; token-hungry |
| `minimax/minimax-m3` | **MiniMax Community License** — attribution required for commercial use | weighted avg $0.098 / $1.21 (list $0.30 / $1.20) | 1M | not fetched | multimodal agent input; cheapest of the frontier-substitute rows |
| `nvidia/nemotron-3-ultra` | OpenMDW, 550B / 55B active | $0.423 / $2.61, plus a free route | not fetched | not fetched | "designed for long-running agents and orchestration"; the free route makes it a zero-cost third-family **judge** candidate (§3.2's judge rule) |

The 2026-09-11 price table in `docs/research/2026-09-11-local-models-openrouter-opencode.md`
is six days stale in naming: `moonshotai/kimi-k2.5`, `deepseek/deepseek-v4-pro`
and `minimax/minimax-m2.7` have all been superseded (K3, V4 Flash/Pro 0813, M3).
Sonnet as the bar is unchanged.

## 3. Considered and rejected

| rejected | reason |
| --- | --- |
| **Kimi K3** | 2.8T weights under a custom licence; **$3.00 / $15.00** — above Sonnet's input price, so it cannot be a cheaper seed default, and there is no local path on 64 GB. Supersedes `kimi-k2.5` in the 09-11 table, which should be struck. |
| **Qwen3.8-Flash-Next (125B-A6B)**, **Qwen3.8-2.4T-A95B**, **Qwen3.8-Max** | over the ~40 GB ceiling at any quant that preserves quality; Max is hosted-only. |
| **gpt-oss-20b / gpt-oss-120b** | Aug 2025, no 2026 successor found; 120b exceeds the ceiling; 20b is now two model generations old and its **harmony-only response format** ("should only be used with this format; otherwise they will not work correctly") means a second prompt format in the engine for one candidate. Drop it from the plan's implicit list. |
| **Qwen3-32B** | native context is **32,768**, 131,072 only via YaRN — fails the ≥128k-native criterion outright. |
| **Qwen3-Coder-30B-A3B** | superseded by 3.6/3.8; and measured "weaker on non-code servers than general-purpose alternatives" — the main agent's ~12 MCP tools are not code tools. |
| **Llama 3.3 70B** | highest measured tool-call success (~97 %) but ~42 GB at 4-bit, over the ceiling, at ~10–15 tok/s. |
| **Gemma 4 31B / 26B-A4B as main agent** | the plan's scorer-only ruling holds: "conservative on chained calls; asks for approval unnecessarily" is the wrong failure mode for a tool loop. Keep Gemma in the PoC-16 lane only. |
| **GLM-4.7 (full)** | far over the ceiling; the Flash sibling is the local representative of the family. Also note the family's known "occasional argument truncation on very long inputs". |
| **DeepSeek V4 Pro** | listed as proprietary-served on the τ²-bench snapshot and priced $0.435 / $0.87 — strictly worse than V4 Flash for this purpose. |
| **ToolACE-8B, Granite-20B** (BFCL v4 leaders among open licences) | BFCL v4's leaderboard was last updated **2026-04-12** and its top open rows are tool-calling specialists, not general assistants — they cannot hold axes (3)–(5) of §3.2. BFCL is evidence for the tool-loop axis only. |

## 4. Proposed replacement text for plan-refresh §3.3

> ### 3.3 Candidates
>
> Criteria in order: native tool calling in the chat template; structured
> output (grammar or `json_schema`); **≥128k native** context (YaRN-extended
> does not count); fits alongside Postgres, the console and the engine inside
> the ~40 GB practical ceiling **including KV cache at the context the run
> uses**; tokens/s at 8k. Names and quants verified 2026-09-17 in
> `docs/research/2026-09-17-bakeoff-candidate-survey.md`; re-verify if PoC-18
> starts more than a month after that date.
>
> Selection rule (owner, 2026-09-17): **quality first**; open weights are a
> tiebreaker within a quality band; a somewhat lower-quality open-weight model
> is acceptable where day-to-day performance and usability stay reasonable.
>
> - **Quality lead:** **Qwen3.8-27B dense at Q4_K_M** (~17 GB weights, ~25 GB
>   with a 128k KV cache), Apache-2.0, 262k native. The strongest agentic
>   scores of anything that fits (Terminal-Bench 2.1 73.0, SWE-bench Pro 61.7)
>   at a measured ~34 tok/s on this hardware.
> - **Usability control:** **Qwen3.6-35B-A3B at Q4_K_M** (21.2 GB), the
>   A3B-class MoE the plan previously named as lead — measured **~85 tok/s** on
>   M5 Pro, ~2.5× the dense lead, at visibly lower agentic scores. This lane
>   answers the ruling's usability clause with a number instead of a guess.
> - **Third-family control:** **GLM-4.7-Flash** (30B-A3B, MIT, 128k, ~17.5 GB)
>   — τ²-Bench 79.5, the best multi-turn tool-use evidence of any local
>   candidate, and a non-Qwen family so the judge rule has somewhere to stand.
>   Run it with `--repeat-penalty 1.0`.
> - **Optional fourth:** **Nemotron-3.5-Lightning-30B-A3B** (OpenMDW-1.1, 1M
>   context, ~19 GB, measured 67.7 tok/s) — include only if its tool-call
>   evidence gap is closed by the PoC's own tool-loop axis; it has no published
>   agentic benchmark.
> - **Scorer-only:** **Gemma 4** — E4B stays the PoC-16 scorer; 26B-A4B or 31B
>   may be tried as the rubric judge. **Not a main-agent candidate.**
> - **Cloud rows for the seed default:** `qwen/qwen3.6-35b-a3b`
>   ($0.05/$0.70, Apache-2.0), `deepseek/deepseek-v4-flash` (MIT, ~$0.14/$0.28),
>   `z-ai/glm-5.2` (~$0.447/$3.31 realised) and `minimax/minimax-m3`
>   ($0.098/$1.21 realised) — with Sonnet as the bar, not a candidate.
> - **OPEN-1 resolved in favour of open weights.** The lead MoE is served on
>   OpenRouter at $0.05/$0.70 *and* runs locally from the same weights, so the
>   seed default can be cloud today and local later **without changing model**
>   — which makes stage-2 shadow agreement a measurement of harness and quant
>   rather than of two different models. That is worth more than the price
>   delta between the open and closed rows.
> - **New OPEN-2:** `z-ai/glm-5.2`'s licence is asserted by secondary sources
>   only. Verify before it counts as an open-weight row.

Four findings behind that text, in the order they matter:

**A. The lead/control lanes invert.** Qwen3.8-27B (dense, Aug 2026) beats the
A3B-class MoE on every agentic axis both publish — Terminal-Bench 73.0 vs 51.5,
SWE-bench Pro 61.7 vs 49.5 — and is *smaller* on disk at Q4 (17.1 vs 21.2 GB).
It costs ~2.5× in tok/s (33.8 vs 84.9 measured on M5 Pro 64 GB). Under
quality-first, the dense model leads and the MoE becomes the control that proves
whether the quality premium is affordable day to day. The plan's sentence "the
class behind the only controlled result on this hardware" no longer picks out
the best model in the class.

**B. OPEN-1 has a cheap answer.** One model — `qwen3.6-35b-a3b`, Apache-2.0 — is
both a local GGUF candidate and a $0.05/$0.70 OpenRouter row. Shadow mode
(§3.7 stage 2) run against the cloud copy of the *same weights* isolates harness
and quantisation from model choice, which no cloud/local pair of different
models can do. This is the strongest available argument for treating open
weights as a criterion rather than a preference.

**C. Two server-level gates the criteria list does not mention.** `--jinja` is
**mandatory** for Qwen3.8 (without it there is no reliable turn boundary, and
the symptom is rambling or clipped output, not an error); a stale or
`--depth 1`-cloned llama.cpp silently corrupts Qwen3.8's DeltaNet path while
loading and reporting normally; GLM-4.7-Flash loops unless repeat penalty is
disabled. And **Ollama does not support the Qwen3.5-class llama.cpp GGUFs at
all** — so §3.4's "every candidate runs on llama-server, LM Studio and Ollama,
same file and quant" is not satisfiable for every row. Make server coverage a
*recorded result* per (model, server), not a precondition for entering the
bake-off, and record `server_build` as the plan's `.meta.json` already does —
that column is now load-bearing, not bookkeeping.

**D. KV cache, not weights, is the binding constraint.** Qwen3.8-27B's hybrid
attention costs 64 KB/token rather than the usual 256 KB, which still totals
2.0 GB at 32k, **8.0 GB at 128k** and 16.4 GB at 262k — 25.1 GB and 33.5 GB
resident with the Q4_K_M weights. 128k fits the ~40 GB ceiling with the stack
resident; 262k does not. §3.5's "RAM headroom on 64 GB" row should record the
context the run used, or the number means nothing.

Not changed: the bake-off's goal, fixtures, judge rule, metrics, harness
location and gate all survive this survey intact. `docs/poc/poc18-bakeoff/README.md`
has no candidate section to update — its only model id is the illustrative
family-map example `qwen3.6:35b-a3b-q4_K_M`, which is still a real current
model, so it is left alone.

## 5. Sources

All fetched 2026-09-17.

1. https://huggingface.co/Qwen/Qwen3.8-27B — 27B dense, Apache-2.0, 262,144 native / ~1M, Aug 2026, `enable_thinking`, SWE-bench Pro 61.7, Terminal Bench 2.1 73.0, OSWorld-Verified 84.3, LCB v6 90.3, GPQA-D 89.2.
2. https://dev.to/purpledoubled/run-qwen-38-27b-locally-real-gguf-sizes-the-kv-cache-trick-and-the-template-trap-114j — Q4_K_M 17.1 GB, IQ4_XS 15.7 GB; 64 KB/token KV; 2.0/8.0/16.4 GB at 32k/128k/262k; the `--jinja` template trap.
3. https://github.com/ggml-org/llama.cpp/discussions/27164 — stale / `--depth 1` llama.cpp corrupts Qwen3.8's DeltaNet path; `git fetch --unshallow`, rebuild all shared libs; ~42.9 tok/s with MTP spec. decoding on an RTX 3090.
4. https://huggingface.co/Qwen/Qwen3.6-35B-A3B — 35B/3B active, Apache-2.0, 262,144 native / 1,010,000, Apr 2026, `qwen3_coder` parser, `preserve_thinking`, SWE-bench Verified 73.4, SWE-bench Pro 49.5, Terminal-Bench 2.0 51.5, TAU3 67.2, MCPMark 37.0.
5. https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-GGUF — Q4_K_M 21.2 GB, Q6_K 28.5 GB, Q8_0 36.9 GB; llama.cpp release b8814; arch `qwen35moe`.
6. https://github.com/daniel29348679/m5pro-llm-bench — M5 Pro 64 GB: `qwen3.6:35b-a3b-mtp-q4_K_M` 84.90 tok/s avg / 79.94 at 11k; `nemotron-3.5-lightning:30b-mlx` 67.69; `qwen3.8:27b-mlx` 33.81; `Qwen3.8-27B-4bit` 22.99 and ~16.68 GB; mxfp8 slower than Q4_K_M.
7. https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF — MIT, arch `deepseek2`, Q4_K_XL 17.5 GB, Q4_K_M 18.3 GB, Q5_K_M 21.4 GB, BF16 59.9 GB; `--repeat-penalty 1.0` for the looping fix; `glm47` tool parser.
8. https://huggingface.co/zai-org/GLM-4.7-Flash — 30B-A3B, MIT, τ²-Bench 79.5, SWE-bench Verified 59.2, GPQA 75.2, BrowseComp 42.8; Preserved Thinking required for multi-turn agentic tasks.
9. https://lmstudio.ai/models/zai-org/glm-4.7-flash — 128k context, "trained for tool use", GGUF + MLX 6/8-bit, 16 GB minimum, Enable/Clear Thinking options.
10. https://www.marktechpost.com/2026/01/20/zhipu-ai-releases-glm-4-7-flash-a-30b-a3b-moe-model-for-efficient-local-coding-and-agents/ — GLM-4.7-Flash release, 2026-01-20.
11. https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 — OpenMDW-1.1, >20T tokens, up to 1M context, tool-calling and structured-output fine-tuning, MTP layers, `--tool-call-parser qwen3_coder`.
12. https://huggingface.co/ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF — Q4_0 18.9 GB, Q8_0 33.6 GB, BF16 63.2 GB; arch `nemotron_h_moe`; auto-converted.
13. https://ai.google.dev/gemma/docs/core/model_card_4 — Gemma 4 variants E2B/E4B/12B/26B-A4B/31B, Apache-2.0, 2026-07-30, 128k–256k, "native support for structured tool use".
14. https://www.promptquorum.com/power-local-llm/best-local-models-tool-calling-2026 (2026-09-01) — 600 graded MCP calls per model over `filesystem`/`sqlite`/`puppeteer`/`github` in Cline 3.x: Llama 3.3 70B ~97 %, Qwen3-Coder 30B ~96 % code / ~91 % non-code, Gemma 4 27B ~95 %, GLM-4.7 32B ~94 %, Qwen3 32B ~93 %; per-model failure modes.
15. https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md — `--jinja` required; native handlers plus a generic fallback; warning that extreme KV quantisation (`-ctk q4_0`) degrades tool calling.
16. https://openrouter.ai/qwen/qwen3.6-35b-a3b — $0.05/M in, $0.70/M out, 262,144 context, 32,768 completion, `tools`/`tool_choice` and `response_format` JSON schema, Apache-2.0.
17. https://openrouter.ai/blog/insights/the-open-weight-models-that-matter-june-2026/ — DeepSeek V4 Flash ~284B/13B MIT $0.14/$0.28 (weighted ~$0.054/$0.242, first-party API trains on data); GLM 5.2 $0.447/$3.31; MiniMax M3 ~428B/23B Community Licence $0.098/$1.21, 1M ctx; Nemotron 3 Ultra 550B/55B OpenMDW $0.423/$2.61 + free route.
18. https://openrouter.ai/benchmarks/tau2-bench-airline — snapshot Sep 17 2026 00:06 UTC; Qwen3.5-397B-A17B 78.5 % is the top open-weight row, behind Gemini 3.7 Flash 80.6 % and Claude Opus 5 79.6 %.
19. https://llm-stats.com/models/glm-4.7-flash — GLM-4.7-Flash (reasoning) 98.8 % on τ²-Bench Telecom, 3rd overall; GLM-5.2 99.1 % as of 2026-08-16.
20. https://www.morphllm.com/best-open-source-coding-model-2026 — Kimi K3 2.8T open under a custom licence, $3.00/$15.00 with $0.30 cache reads; DeepSeek V4 Pro $0.435/$0.87.
21. https://huggingface.co/Qwen/Qwen3.6-27B — 27B dense, Apache-2.0, Apr 2026, SWE-bench Verified 77.2, Terminal-Bench 2.0 59.3 (the model Qwen3.8-27B replaces).
22. https://unsloth.ai/docs/models/qwen3.5 and https://lmstudio.ai/models/qwen/qwen3.5-9b — Qwen3.5-9B dense, 262,144 native, trained for tool use, chat-template fixes improved tool calling; **Ollama does not support Qwen3.5 llama.cpp GGUFs**.
23. https://github.com/QwenLM/Qwen3.8 and https://codersera.com/blog/qwen-3-8-model-lineup-2026/ — Qwen3.8 lineup: 27B dense (Aug 14 2026), Flash-Next 125B-A6B, 2.4T-A95B (Aug 12 2026), hosted Max; Qwen3.5 family Feb 24 2026; Qwen3.6-27B Apr 22, Qwen3.6-35B-A3B Apr 16.
24. https://openai.com/index/gpt-oss-model-card/ and https://huggingface.co/openai/gpt-oss-20b — 21B/3.6B active and 117B/5.1B active, Apache-2.0, Aug 2025, harmony-format-only.
25. https://gorilla.cs.berkeley.edu/leaderboard.html — BFCL v4, last updated 2026-04-12; top openly licensed rows are tool-calling specialists (ToolACE-8B, Granite-20B).
26. https://huggingface.co/Qwen/Qwen3-32B — native context 32,768, 131,072 only with YaRN.
