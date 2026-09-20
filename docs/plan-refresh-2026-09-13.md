# Plan refresh — configurable compute, the bake-off, and the small adopts (2026-09-13)

Consolidates seven notes written 2026-09-11/12 into one decision record, and
is the traceability trail for the dated edits made the same day to
`metistry-build-plan.md` and the two product plans. Written at the owner's
instruction ("review and refresh the build and technical plans … the new
bake-off and anything else we've decided to adopt today"); the plan is normally
not edited by agents, so every edit is marked `(refresh 2026-09-13)` in the file
it touches and nothing is deleted — superseded text keeps its place with a
pointer, the way the existing "ruled 2026-08-29" annotations do. Format follows
`docs/plan-review-2026-08-29.md`; every claim is attributable to a note in §7.

**Status vocabulary**, used in every table: **decided** — the owner ruled, in a
note's "Owner decisions" section or in the prompt it records verbatim.
**proposal accepted** — a recommendation the owner directed us to run with,
without a per-item ruling; queued, shape may still move. **proposal open** — a
recommendation with no owner ruling: listed for visibility, **not ratified to
build**. **OPEN** — a question for the owner; nothing is built on either side of
it. A queue entry inherits the status of the decision behind it — a PR in §4
containing a "proposal open" item is not, by being listed, authorised.

---

## 1. Decisions log

### Compute — `docs/research/2026-09-11-local-models-openrouter-opencode.md`

| # | Decision | Date | Status |
|---|---|---|---|
| C1 | **One `compute.yaml`** in the instance repo (providers, assignments, budgets), a §4.7 protected path written *as the user*, hot-reloaded by console and assistant; provider = configuration, not a component (invariant 5 met by a schema in `packages/core`) | 09-11 | **done** (#152) |
| C2 | **One engine, `openai-compatible`**; the Claude Agent SDK leaves the product; Claude arrives through OpenRouter with `anthropic/claude-sonnet-5` pinned and `provider: { order: [anthropic], allow_fallbacks: false }`. A native Messages adapter stays a documented, unbuilt option | 09-11 | **done** (#159, #167) |
| C3 | **The subscription path is scrubbed from the product repo** — `CLAUDE_CODE_OAUTH_TOKEN`, the PoC-4 "never `ANTHROPIC_API_KEY`" rule, wizard step 7, the "subscription" copy. An instance re-adds it privately as its own `compute.yaml` provider; the product never names it | 09-11 | **done** (#167) |
| C4 | **No library for the engine loop** — ~300 lines over pre-approved `@modelcontextprotocol/sdk` + `zod`; revisit the Vercel AI SDK past ~600 lines or streaming UI | 09-11 | **done** (#159) |
| C5 | **Budgets `allow \| stop \| critical_only`**, default `stop`, and `stop` **pauses routines** as well as refusing at the engine | 09-11 | **done** (#159) |
| C6 | **Provider secrets are user scope** in the Keychain | 09-11 | **done** (#152) |
| C7 | **Collaboration rule 4** — a Claude turn may create *unassigned* work; a *directed* push to a named non-Claude agent is refused at the console (`invalid_request` + a `runs` row). Enforced by absence of any engine-calling tool | 09-11 | **done** (#159) |
| C8 | **Apple FM becomes an OpenAI-compatible local provider** on its existing Swift bridge (`/v1/models`, `/v1/chat/completions`), **PoC first** on runtime-supplied JSON schemas | 09-11 | **done** (#164 PoC-19, #169 provider) |
| C9 | **Claude Managed Agents is not the main agent's harness** — sandbox tools invariant 9 removes, `/mcp` only via a public endpoint or a preview tunnel, not ZDR-eligible, beta, $0.08/hour session time. Right shape for a later **compute target** | 09-11 | decided (rev 4) |
| C10 | **The seed `default` is non-Claude, chosen by a bake-off** on Metistry's own fixtures; Sonnet is the suggested `deep` | 09-11 | decided (rev 4) |
| C11 | **Never train on Claude outputs** — no distillation, no Claude transcripts as training data (Anthropic usage policy). Plan for zero fine-tuning; harness tuning is the lever | 09-11 | decided |
| C12 | **Cost is a first-class row** — `provider`, `model` beside `tokens_in/out/cost_usd`; a `spend` named query; budgets enforced **before** the call | 09-11 | **done** (#159) |
| C13 | **Non-ZDR off-machine assignments warn, never block** — one `runs` warning row and a badge; informed choice | 09-11 | **done** (#159) — contested, see §2.6 |
| C14 | **The local server is a bake-off axis**, not a given: `llama-server`, LM Studio and Ollama on the same model, measured | 09-12 | decided (addendum; owner reopened the LM Studio default) — harness ready (#158, #160), measurement run pending |
| C15 | **A bundled, signed `llama-server`** is the no-install local provider the app manages, built from pinned source like Postgres/git in the runtime-deps pack; LM Studio and Ollama stay supported peers discovered via `/v1/models` | 09-12 | **done** (#158) — the *default* is the bake-off's to confirm |
| C16 | ~~LM Studio when detected is the local default~~ | 09-11 | **superseded** by C14/C15 |
| C17 | **OpenCode as a dev tool** — `plugins/opencode` mirroring the Claude Code plugin, `metistry connect opencode` writing the `/mcp` entry | 09-11 | **done** (#171) |
| C18 | **Embeddings move to `/v1/embeddings`** on the provider `assignments.embed` names; `METISTRY_OLLAMA_URL` + `METISTRY_EMBED_MODEL` seed it as a transition | 09-11 | **done** (#158) |

### Offline and multi-instance — `docs/research/2026-09-11-multi-instance-and-offline-client.md`

| # | Decision | Status |
|---|---|---|
| O1 | An instance on the phone is `(origin, instance_id)`; everything keyed by `instance_id` | proposal accepted (owner: run with the recommendations) |
| O2 | A per-instance **switcher with an honest presence chip**, never a unified inbox | proposal accepted |
| O3 | **Queue appends, never queue claims or answers** — `capture` and 👍/👎 only; decision controls are **disabled while unreachable** | decided (owner) |
| O4 | **No wake-the-laptop path** is built | proposal accepted |
| O5 | The console's offline contract — `GET /api/identity`, `Idempotency-Key` on `POST /capture`, `since` cursors, `409` carrying the winner | **shipped** (#132, `docs/ops/console-api.md`) |

### Small adopts from the four prior-art reviews (2026-09-12)

| # | Adopt | Source | Status |
|---|---|---|---|
| R1 | ~~Loopback CONNECT proxy~~ → **allowlist enforced inside the engine's own `fetch`** (the one engine is in-process code, so the host check is a function, not an environment variable a subprocess may ignore); hosts from `compute.yaml`; a CI test that every outbound call goes through it | rivet, revised 2026-09-15 after the SAM note (`2026-09-13-google-sam-review.md` argues `HTTPS_PROXY` honouring is unreliable; owner agreed) | **done** (#159); the sandbox profile keeps port filtering as defence in depth |
| S1 | Coarse **capability advertisement** on `GET /api/identity`; `tools/list` stays token-gated | sam | **done** (#162) |
| S2 | **Approve-before-enroll** for remote agents | sam | **done** (#162) |
| S3 | Agent identity `agent:<name>@<instance_id>` | sam | **done** (#162) |
| S4 | `instances.yaml` **peer registry** (the phone's instance list, and an instance's directory of exposable resources: CLI commands, directories, MCP servers, compute, tasks/knowledge, Slack, Linear — discoverable and grantable by cloud and local agents wherever they run) | sam | **done** (#162); scope of "resource" is OPEN-7 |
| S5 | `runs` NDJSON audit export | sam | **done** (#162) |
| S6 | An **internal mesh** (self-contained cross-device service wrapping, no tailnet dependency) | sam | BORROW-LATER — owner: "worth considering in the future"; the registry it waited on (S4) is now shipped (#162), still not scheduled |
| R2 | **Warn at 80 %** of every budget window, deduped, before `stop` fires | rivet | **done** (#159) |
| R3 | **Every refusal names the config field** that would permit it | rivet | **done** (#163) |
| R4 | **CI audit for unwired limits** — fail on a cap-shaped literal absent from a manifest/config schema | rivet | **done** (#163) |
| R5 | **stdout is the protocol** — a `packages/core` conformance test that a stdio bridge emits only framed protocol | rivet | **done** (#163) |
| A1 | A **cross-artifact thread ("room") view** in the console, no schema, with `payload.reason` rendered as a sentence | agent-room | **done** (#161) |
| A2 | **Threads hung off `work` rows** — nullable `work_id` on `artifact_comments` + check constraint, **no `to_agent` field** (collaboration rule 4 holds by absence) | agent-room | **done** (#161) |
| A3 | `autonomy.level: observe \| propose \| act_within_scope` + escalation on `checkBrief` and the budget flip | agent-room | **done** (#170) — OPEN-2 resolved 2026-09-16, the narrowing-only rule overturned by the owner |
| A4 | **Do not auto-close quiet threads** — `commentResolve` releases queued bundles, so a sweep would start work overnight | agent-room | **done** (#161) — decided constraint (owner) |
| H1 | The board as **two named queries** (`board.yaml`, `board_projects.yaml`) — every column derivable today, no migration, no fifth status | hermes-1 | **done** (#155) |
| H2 | A **read-only board panel** in the PWA over `GET /api/q/board`; MetistryKit renders the same query | hermes-1 | **done** (#155) |
| H3 | **The drags** — `reopen()`, `assign()`, a `note` on `tasks_renew`, a thin console adapter; nobody drags into Working; drag out of Working = release, never orphan | hermes-1 | **done** (#166) |
| H4 | **Preflight before spend** — check a component's declared prerequisites before `tick()` starts a run; `error = 'blocked_config: …'`, alert once | hermes-2 | **done** (#153) |
| H5 | **One alert per (component, error signature)** with an ack that silences that signature only | hermes-2 | **done** (#153) |
| H6 | A **`schedules` section in `metistry doctor`** — last run, overdue by >2× interval, non-zero exit when actionable | hermes-2 | **done** (#153) |
| H7 | **`failure_streak`** in the morning brief; at 3, one line offering fix / pause / remove | hermes-2 | **done** (#153) |
| H8 | **Crew descriptions in `agents_delegate`** from the manifest | hermes-2 | **done** (#180) |
| H9 | **`data_collection: "deny"`** in the OpenRouter request body | hermes-2 | **rejected 2026-09-17** — conflicts with C13, see §2.6; C13's warning-only shape stands (#159) |
| T1 | **Tool *names* as grammar terminals** (or a `json_schema` enum from the live `tools/list`); keep parse → zod → one repair retry where a provider only hints | atomic | proposal open (needs the server check in §3.4) |
| T2 | **Lead the candidate list with a ~30–35B A3B-class MoE at Q4**; demote gemma-4 to scorer-only | atomic | folded into the bake-off (§3.3) |
| T3 | **Axis tag + six trace columns** on every bake-off record | atomic | **done** (#160) |
| T4 | **No-progress veto** — warn at 3 identical calls, hard veto at 5, graceful reply after 3 vetoes | atomic | **done** (#159) |
| T5 | **Slot-pinned KV reuse** (`cache_prompt` + session-stable slot id) and a **byte-stable-prefix test** | atomic | proposal open (needs the server check) |
| T6 | **A judge from a third model family** that **fails** when absent, over stored raw JSONL | atomic | **done** (#160) |

---

## 2. Contradictions resolved

**2.1 PoC-4's container-auth rule.** PoC-4 locked "auth is a subscription
`setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`; never `ANTHROPIC_API_KEY`". C2/C3
supersede the *auth* clause only — the product's credential is a provider API
key in the Keychain named by `compute.yaml`; **the networking and
session-survival findings stand**, being what PoC-4 actually measured. Marked
in four places (§2 table, §2 decision 6, §4.17 rule 7, §6 decision 9).

**2.2 "Subscription" language.** Every sentence in the plan and the desktop
plan making a Claude subscription the product's auth path is superseded by C3.
Historical lines in `PRODUCT.md` and `docs/poc/RESULTS.md` are **left alone** —
the scrub is a code-and-copy scrub, not a history edit.

**2.3 Ollama as the named local path.** Plan §4.17's fallback table and the
desktop plan's "optional, offered in-app" paragraph name Ollama; C15 replaces
it with the bundled `llama-server`, the other two as external peers.

**2.4 `CREW_MODELS` and `rules.yaml` tiers.** `haiku|sonnet|opus` as a crew's
`model`, and `tiers:` in `rules.yaml`, are superseded by `compute.yaml`
`assignments` (model **and** effort, `<provider>/<model>` pinned). `rules.yaml`
keeps the routing rules and stops naming models. Noted at §4.18.A′.

**2.5 Autonomy — OPEN-2, the owner's call.** `autonomy.level` is
*narrowing-only by construction*: a per-agent key can never widen past the
project default, so "lower the bar per agent as trust grows" means removing a
narrowing, not raising a ceiling — and making it able to widen would break the
one-way property that makes today's model safe. **Left OPEN**; A3 is blocked.

**2.6 Non-ZDR — OPEN-3.** C13 (warn, never block) is the owner's ruling; the
hermes-2 review calls it "a prompt-shaped control in config's clothing" and
proposes H9, sending `data_collection: "deny"` so training-retaining providers
are never *selected*. Recorded resolution, **a proposal, not a decision**: send
it by default with a per-provider opt-out in `compute.yaml`, keeping the
warning row for anything still off-machine — the constraint becomes the
default, informed choice stays available.

**Ruled 2026-09-17:** keep the warning only (option A); H9 rejected —
informed user choice is the imperative, and a user who wants a non-ZDR
provider may pick it.

**2.7 MLX as a selection criterion.** The compute note lists "MLX build" among
stage-0 criteria; the only controlled local-agent result on this hardware class
is llama.cpp + Metal, no MLX. MLX becomes **measured, not required** — an axis
in the server matrix (§3.4), not a filter.

**2.8 PoC-16 does not transfer.** `gemma4:e4b` passing as a single-shot
*scorer* says nothing about an agent loop (their gemma-4-12b: 45.3 %, ~3 steps,
early bail). PoC-16's own gate — a blind confirmatory eval — is unchanged; the
bake-off is a different question and supersedes the gated amendment as the
route to a *main-agent* default. Cross-referenced in the plan's PoC-16 entry.

**2.9 "Reasoning-off locally".** PoC-16 measured that reasoning mode hurt the
*scorer* task; the per-model reading (probe the style, set it per profile) is
likelier right for a loop. Recorded as a bake-off measurement, not a plan edit.

**2.10 Flagged, not edited — `CLAUDE.md`.** Its Stack section says "Claude
Agent SDK for Metis" and pre-approves `@anthropic-ai/claude-agent-sdk`; C2
removes both. That file is the owner's and out of scope here — it needs his
hand before PR 1 lands. The plan's §7 entry says the same thing and *is* in
scope, so it carries a dated superseded note.

---

## 3. The bake-off (next PoC — PoC-18, the next free number)

### 3.1 Goal

One experiment answering three questions with numbers: **which model** the seed
ships as `default`, **which local server** Metistry bundles, and **where the bar
is** — Sonnet's score and cost per turn on the same fixtures. A PoC in
`docs/poc/`, not a PR; it gates the local-main-agent path (C10, C14, C15).

### 3.2 Fixtures and the judge

- **50 owner-authored turns** from the Studio's real history, rewritten as
  prompts with expected tool calls and a rubric. Only the owner can write them:
  three of the five axes are judgment and voice.
- **Format reuses PoC-15/16** — one JSONL row per case per run (`id`, `input`,
  `axis`, expectation, outcome, latency) and a `.meta.json` per run, now with
  `server`, `quant`, `server_build`, `host` beside `model`.
- **One axis per fixture**, over the five things the main agent's turns
  actually need: (1) a tool loop over ~12 MCP tools with correct arguments and
  no hallucinated tool; (2) reading a thread and knowing when to **stop**;
  (3) triage judgment — proposal vs noise; (4) the voice in `identity.yaml`
  held over a long session; (5) briefs and folds a person actually reads. A
  failure must name the component to fix, so no fixture mixes two axes.
- **Claude is the bar, never the source.** No Claude output is a fixture, an
  expected answer, or training data of any kind (C11): the fixtures are the
  owner's words, and Sonnet is run *against* them to set the reference.
- **Judge rule.** Axes (3)–(5) are rubric-scored, pass at ≥ 4 of 5, by a model
  from a **third family** — neither the candidate's nor the bar's, so nothing
  grades its own homework — and **an absent judge fails the case** rather than
  passing it. Raw JSONL is stored so a revised rubric re-scores without a
  re-run.

### 3.3 Candidates

**Shortlist accepted 2026-09-17 from the survey**
(`docs/research/2026-09-17-bakeoff-candidate-survey.md`), superseding the text
this section held since 2026-09-13.

Criteria in order: native tool calling in the chat template; structured
output (grammar or `json_schema`); **≥128k native** context (YaRN-extended
does not count); fits alongside Postgres, the console and the engine inside
the ~40 GB practical ceiling **including KV cache at the context the run
uses**; tokens/s at 8k. Names and quants verified 2026-09-17 in
`docs/research/2026-09-17-bakeoff-candidate-survey.md`; re-verify if PoC-18
starts more than a month after that date.

Selection rule (owner, 2026-09-17): **quality first**; open weights are a
tiebreaker within a quality band; a somewhat lower-quality open-weight model
is acceptable where day-to-day performance and usability stay reasonable.

- **Quality lead:** **Qwen3.8-27B dense at Q4_K_M** (~17 GB weights, ~25 GB
  with a 128k KV cache), Apache-2.0, 262k native. The strongest agentic
  scores of anything that fits (Terminal-Bench 2.1 73.0, SWE-bench Pro 61.7)
  at a measured ~34 tok/s on this hardware.
- **Usability control:** **Qwen3.6-35B-A3B at Q4_K_M** (21.2 GB), the
  A3B-class MoE the plan previously named as lead — measured **~85 tok/s** on
  M5 Pro, ~2.5× the dense lead, at visibly lower agentic scores. This lane
  answers the ruling's usability clause with a number instead of a guess.
- **Third-family control:** **GLM-4.7-Flash** (30B-A3B, MIT, 128k, ~17.5 GB)
  — τ²-Bench 79.5, the best multi-turn tool-use evidence of any local
  candidate, and a non-Qwen family so the judge rule has somewhere to stand.
  Run it with `--repeat-penalty 1.0`.
- **Optional fourth:** **Nemotron-3.5-Lightning-30B-A3B** (OpenMDW-1.1, 1M
  context, ~19 GB, measured 67.7 tok/s) — include only if its tool-call
  evidence gap is closed by the PoC's own tool-loop axis; it has no published
  agentic benchmark.
- **Scorer-only:** **Gemma 4** — E4B stays the PoC-16 scorer; 26B-A4B or 31B
  may be tried as the rubric judge. **Not a main-agent candidate.**
- **Cloud rows for the seed default:** `qwen/qwen3.6-35b-a3b`
  ($0.05/$0.70, Apache-2.0), `deepseek/deepseek-v4-flash` (MIT, ~$0.14/$0.28),
  `z-ai/glm-5.2` (~$0.447/$3.31 realised) and `minimax/minimax-m3`
  ($0.098/$1.21 realised) — with Sonnet as the bar, not a candidate.
- **OPEN-1 resolved in favour of open weights.** The lead MoE is served on
  OpenRouter at $0.05/$0.70 *and* runs locally from the same weights, so the
  seed default can be cloud today and local later **without changing model**
  — which makes stage-2 shadow agreement a measurement of harness and quant
  rather than of two different models. That is worth more than the price
  delta between the open and closed rows.
- **New OPEN-8:** `z-ai/glm-5.2`'s licence is asserted by secondary sources
  only. Verify before it counts as an open-weight row.

### 3.4 Servers — and the first thing the PoC checks

Every candidate runs on **`llama-server` (the bundled build), LM Studio and
Ollama**, same file and quant. **First check, before any quality run: which
structured-output controls each server exposes** — GBNF `grammar`,
`response_format: json_schema`, slot control (`slot_id`/`id_slot`),
`cache_prompt`. T1 and T5 need grammar and slot control; if the grammar adopt
is what closes the quality gap, that check alone decides the server.

**Ruled 2026-09-17 (survey finding).** "Every candidate runs on all three
servers" is not satisfiable as a precondition: Ollama does not support the
Qwen3.5-class llama.cpp GGUFs at all, and Qwen3.8 needs **`--jinja`** plus a
current (non-stale, non-`--depth 1`) llama.cpp build — without it there is no
reliable turn boundary, and a stale build silently corrupts its DeltaNet path
while still reporting normally. Server coverage is therefore recorded as a
**result** per (model, server), not a gate for entering the bake-off;
`server_build` (already in each run's `.meta.json`) is now load-bearing, not
bookkeeping.

### 3.5 Metrics

Per (fixture, model, server): **pass rate per axis**; **tool-call agreement**
with the bar; **tokens/s at 8k**; **TTFT**; **cost per turn** at OpenRouter list
vs $0 local; **RAM headroom** on 64 GB with the stack resident. Plus six trace
columns separating a wrong answer from planner churn — `steps`,
`parse_retries`, `tool_errors`, `batch_count`, `prompt_tokens`,
`predicted_tokens` — and reasoning style recorded per model, not assumed off.

### 3.6 The harness — where it lives

Fixtures, raw runs and results in **`docs/poc/poc18-bakeoff/`** (PoC
precedent), summarised into `docs/poc/RESULTS.md` §PoC-18. The runner is
**TypeScript** — no Python (ruled 2026-08-29; the two `.py` files under
`docs/poc/poc16-local-scorer/` are flagged, not touched). **Proposal:** a
private, unpublished workspace package `packages/eval` driven by `vitest` with
`zod` fixture validation — both pre-approved, no new dependency — so stage 2's
shadow scoring and any CI regression reuse one scorer. *Rejected:* a throwaway
script in `docs/poc/`, cheaper today and rewritten twice, since shadow mode
needs the same scorer inside the engine's repo. **The new package is the
owner's to ratify.**

**Transcripts — ruled 2026-09-17.** `runs/.transcripts/` (full message
histories) are kept, not discarded, but committed to the *instance* repo,
never the product repo; the product repo's `.gitignore` entry is the
enforcement (see `docs/poc/poc18-bakeoff/README.md`).

### 3.7 Stages, and the gate

0. **The bar.** Fixtures against Sonnet via OpenRouter: reference score, cost
   per turn, tool-call baseline. A PoC, not a PR.
1. **Local where it already wins** (PR 2/3): embeddings, the scorer once its
   blind eval passes, `fast` and `routine`, extraction crews. No main-agent
   risk, and real telemetry on local latency and tool reliability.
2. **Shadow mode** (PR 3): for a configurable fraction of `default` turns the
   engine re-runs the turn on the candidate with tools **stubbed record-only**,
   stores both transcripts on the `runs` row and never shows the local answer;
   the weekly review reports agreement and a sampled rubric score.
3. **Promote per tier. Gate: ≥ the bar on the fixtures *and* two weeks of
   shadow agreement.** Then flip `default` in `compute.yaml` — one line,
   reversible — `deep` staying on the bar model.
4. **`deep` last** — probably never local on 64 GB; that is what the
   two-default seed exists for.

### 3.8 Who runs what

**Owner:** the 50 fixtures and the rubric; OPEN-1; ratifying `packages/eval`;
the OpenRouter spend for the bar run; the Studio's own overlay. **Agents:** the
runner, the server matrix and its structured-output check, candidate pull
scripts, trace columns, the write-up. Fixtures gate stage 0; the bundled
`llama-server` (PR 2) gates its local half.

---

## 4. The refreshed queue

**Status as of 2026-09-17.** Merges since 2026-09-15 (#141–#171) shipped
essentially the whole chain: PRs 1, 1a, 2, 3, 4 and 5 are **done** (49 rows
across §1's decisions log, the small-adopts table, this queue and §4b's
W1–W7 now read `done (#NNN)`), plus every grouped adopt including crew
descriptions (H8, **done**, #180 — see below). The Taskuary
executable-action proposal (ADOPT 6) and the autonomy-widening question
(OPEN-2) were both accepted and shipped the same day, in #170. **Decided but
not yet built:** C9–C11 and C14 (bake-off calls that need the owner's
fixtures to run), O1–O4 and S6 (accepted, unscheduled). OPEN-1 and OPEN-3
through OPEN-7 were all **ruled 2026-09-17** (table below); H9 was
**rejected** the same day. **Genuinely open** — nothing built on either
side, per this doc's status vocabulary above: T1, T2 and T5 (wait on the
bake-off's server check). W2 has since moved past "open" — v0.8.0 is being
cut as of 2026-09-17 (below, and §4b).

**Later the same day (2026-09-17).** #178 recorded the day's rulings in this
document and added invariant 10 to `CLAUDE.md`. #179 is the bake-off
candidate survey (`docs/research/2026-09-17-bakeoff-candidate-survey.md`)
whose accepted shortlist now replaces §3.3, and which raised the new OPEN-8
(§3.3, §4 table). #180 applies the rulings in code: the Zen seed template is
gone (OPEN-7), the default assignment ships marked `critical` (OPEN-4), the
board's Assigned column reads "Addressed to" (OPEN-5), and crew descriptions
ship in `agents_delegate` — **H8 is done.** **O1–O4** (the phone/offline
client) stay **reserved by the owner, not scheduled** — accepted proposals
with no PR against them. **Stage-2 shadow mode** (the one piece PR 3 still
lacks) is **in progress**. **v0.8.0 is being cut** (W2, §4b).

Sequence: **PR 1 → PR 2 → PoC-18 stage 0 → PR 3 → PR 4/5**, grouped adopts
landing independently. Fixture authoring can start now; the Sonnet bar needs
only an OpenRouter key, the local half needs PR 2's binary.

| PR | Contents | Owner needed | Status (2026-09-17) |
|---|---|---|---|
| **1** | `compute.yaml` schema in `packages/core` (zod), `seed/compute.yaml` + templates, `metistry compute providers\|models\|assign\|budget`, hot reload, OpenRouter seed provider with Claude pinned, **the scrub** (engine, CLI env allowlist, secrets, shapes, docs — plus the Agent SDK dependency and `engine.ts`'s `query()` path) | ratify the SDK removal in `CLAUDE.md` first (§2.10) | **done** (#152 schema/verbs, #167 the scrub) |
| **1a** | **App part, split out:** the Compute pane, wizard step 7 → "Choose your compute", Settings. Separated so the schema/CLI PR is reviewable alone and the SwiftUI change lands against a settled verb surface | — | **done** (#167) |
| **2** | `/v1/models` discovery, doctor rows, `compute models list\|install\|load\|unload`, LM Studio + Ollama as peers, embeddings over `/v1/embeddings` (C18) — **and the bundled `llama-server`** built from pinned source into the runtime-deps pack, signed like Postgres and git | — | **done** (#158) |
| **3** | `Engine` interface + the `openai-compatible` loop, `runs` provider/model columns, `spend` query, budgets `allow\|stop\|critical_only` with the routine pause, non-ZDR warning, per-run scoped credential, cross-kind delegation refusal — **plus** R1 in-engine host allowlist, R2 80 % warning, R3 refusals name the field, T4 no-progress veto, T1/T5 where the server exposes them, and **stage-2 shadow mode** | OPEN-3, OPEN-4, OPEN-6 | **done** (#159) except T1/T5 (no server exposes grammar/slot control yet) and stage-2 shadow mode (**in progress**, 2026-09-17) |
| **4** | Apple FM `/v1` surface **after** the `DynamicGenerationSchema` PoC (C8); `inbox-drain` moves to provider `apple-fm`; CI check that no collector names a provider with cost > 0 | — | **done** (#164 PoC-19, #169) |
| **5** | `plugins/opencode`, parity test, `metistry connect opencode`, `docs/ops/opencode.md` | `@opencode-ai/plugin` types — ask before adding | **done** (#171) |

**Grouped adopts** (each independent of the compute chain):

- **G1 — automation hardening**, one PR: H4 preflight before spend, H5
  per-error-signature dedupe with an ack, H7 `failure_streak` in the brief, H6
  `doctor schedules` — the one place a competitor is plainly ahead.
- **G2 — board view**, three PRs: H1 the two named queries → H2 the read-only
  panel → H3 the drags; the read-only panel is the "is this wanted" gate.
- **G3 — threads on work**, three PRs: A1 the room view (no schema) → A2
  `work_id` on `artifact_comments` (additive, no `to_agent`) → A3
  `autonomy.level`, **blocked on OPEN-2**. A4 stands throughout: no auto-close.
- **G4 — contract hygiene**, one PR: R4 CI audit of unwired limits, R5
  stdout-is-the-protocol conformance test, H8 crew descriptions.

**Owner-gated, everything else waits on these:** the 50 fixtures and rubric;
the Studio's overlay; ratifying `packages/eval`; the SDK removal in
`CLAUDE.md`; OPEN-1 … OPEN-7.

**Still open after this refresh**

| # | Question | Source | Status (2026-09-17) |
|---|---|---|---|
| OPEN-1 | Is "open weights" a criterion for the seed `default`, or only price and quality? | compute rev 3 Q0 | **ruled 2026-09-17** — quality first, open weights a tiebreaker within a quality band; not purely score-based (§3.3) |
| OPEN-2 | `autonomy` narrowing-only vs "lower the bar as trust grows" (§2.5) | agent-room | **resolved 2026-09-16** — owner overturned the narrowing-only rule; shipped as A3, autonomy levels the owner can raise (#170) |
| OPEN-3 | Non-ZDR: keep the warning, or send `data_collection: deny` by default with a per-provider opt-out (§2.6) | hermes-2 | **ruled 2026-09-17** — keep the warning only (option A); H9 rejected: informed user choice is the imperative (§2.6) |
| OPEN-4 | What may `critical: true` cover under `action: critical_only`? | compute rev 3 Q1 | **ruled 2026-09-17** — covers the `default` assignment tier only by default; interactive turns keep answering, routines and delegation stop under `critical_only`; the seed marks the default assignment critical |
| OPEN-5 | `work.owner` — "addressed to" or authoritative? An Assigned column makes it look authoritative | hermes-1 | **ruled 2026-09-17** — stays informational ("addressed to"), not authoritative; the board column renamed "Addressed to" |
| OPEN-6 | Prompt caching: one top-level `cache_control` or explicit breakpoints — measure both in PR 3 | compute rev 3 Q3 | **ruled 2026-09-17** — ship automatic top-level `cache_control` first; an agent measures automatic vs explicit breakpoints on ~10 real turns before any further decision, waiting on a configured OpenRouter provider on the Studio |
| OPEN-7 | Seed cloud templates: OpenRouter only, plus Zen, and leave "any base URL" to the form? | compute rev 3 Q2 | **ruled 2026-09-17** — OpenRouter is the only seeded cloud template; Zen removed from the seed, reached through the generic "any OpenAI-compatible base URL" form |
| OPEN-8 | Is `z-ai/glm-5.2` actually open-weight? Its licence is asserted by secondary sources only | 2026-09-17 bake-off survey, §3.3 | open — verify the licence before it counts as an open-weight row |

---

## 4a. Queue additions and status (2026-09-18)

**Shipped since the 09-17 status paragraph:** v0.8.1 and v0.9.0 (release
notes in `CHANGELOG.md`); the flat instance layout (#192–#195, #198, `docs/ops/instance-layout.md`);
the assistant loading the instance identity on the launchd shape (#201 — it
had been running on the seed identity, layout-independent, pre-existing);
stage-2 shadow mode (#187); automatic prompt caching (#196, OPEN-6 first half);
console routes for compute, knowledge search/page, commands and run detail
(#197, #199); the Mac app's console client and store (#200, phase A's
non-visual half); the design brief (#189) and wireframes (#190, #191).

**Owner-hand, in order:** Studio `metistry update` → refused (legacy) →
`migrate-layout --dry-run` → `migrate-layout` → `update`; then
`docs/poc/poc18-bakeoff/SETUP.md`; then fixtures (harvest at
`<instance>/.metistry/eval/fixtures-harvest.jsonl`); then the OPEN-6
measurement.

**New research items (owner, 2026-09-18):**

| # | item | shape to research | status |
|---|---|---|---|
| Q1 | **Keep the Mac awake while Metistry runs, screen may sleep.** A setting (proposed: `deployment.yaml` `keep_awake: true`, surfaced in the app's Settings → Status pane and a doctor row) under which the supervisor holds a power assertion that prevents *idle system sleep only* — `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep)` from the app's background item, or a `caffeinate -i` child of the supervisor (never `-d`, which pins the display). Research: behaviour on battery vs AC (`pmset`), whether the launchd shape's background item can hold the assertion without the app window, how the Studio's current sleep settings interact, and what `doctor` should say when the assertion is refused. Default: on for an always-on instance, off on battery — to confirm | open |
| Q2 | **Rename the metrics section.** "Insights" (spend, run metrics, shadow agreement) was a placeholder name; the owner leans **"System"** and the designer is ideating names in parallel. Apply the final name across `app-ux-plan.md`, `design-system.md` (P6, §3.1, §3.18), `design-brief.md`, and `design/mac-insights.svg` in one PR once settled | open — owner leans System |
| Q3 | **Website at `metistry.ai` / `metistry.app`.** The owner bought both domains on 2026-09-19. Design and build the site — and decide hosting — only **after** the apps are designed and the product's behaviour is settled, so the site describes what exists rather than what was guessed. Not scheduled; loop back after the Mac app's phase A/B views ship | deferred (owner, 2026-09-19) |

**Shipped 2026-09-19:** v0.9.1; the knowledge queries and scoped routes on both doors (#206, #209, #210, #216, #221); `expose: route`; `console call --idempotency-key` (#205); the keep-awake setting with the onboarding question (#218, research #204/#208 — Q1 closed); faster `up` and `down` (#219); the CLI polish pass (#217); the `state/cli/metistry` shim (#220); `turn_id` via `_meta` and the tool-surface CI gate (#222); research on code-mode MCP (#213, not now) and agent virtual filesystems (#214, no projection).

**Unblocked for agents:** a named query over `knowledge_files` plus
`GET /api/knowledge/pages` (skipped in #197); an `Idempotency-Key` path for
`metistry console call` so the app can capture; the PWA renav to the
six-section IA (owner: later); phase A views once the designer's tokens land.

## 4b. Second-instance-first re-phase (2026-09-15)

The owner is standing up a second instance in a separate context: knowledge to organise, project and
long-term planning, the team's repositories to learn, and three agents
that need access — Devin (connected to everything there; debugging and
research), Cursor, and Claude Code (dev tool undecided; stay flexible).
Second Mac: M5 Pro, 64 GB, full admin. **No Claude access on that instance for
~a week.** Ruling: "develop capabilities in the main repo I can use
there." Facts that shape the order: `inbox-drain` is deterministic
(model-free), so captures still become proposals without an engine; only
the evening fold enqueues an assistant turn; the assistant job
hard-requires `CLAUDE_CODE_OAUTH_TOKEN` (`apps/assistant/src/main.ts`)
and would crash-loop under the supervisor without it. Devin/Cursor
surfaces verified in `2026-09-15-devin-cursor-integration.md` (#143).

| # | what | proves / unblocks | who | Status (2026-09-17) |
| --- | --- | --- | --- | --- |
| W1 | **Assistant degrades absent**: no token → the supervisor does not start the assistant child, `doctor` reports `assistant: absent (no engine credential)`, fold turns queue and wait; everything else runs | a second instance runs today with no model | agent (Opus) | **done** (#145) |
| W2 | **Cut v0.8.0** (changesets pending: offline contract #132, signed packs #133) | the second Mac installs signed packs + helpers via the Mac app | owner tags | **in progress (2026-09-17)** — v0.8.0 is being cut, tag not yet pushed |
| W3 | **`metistry connect <tool>`** — one generic verb: mint a per-tool agent token (`POST /api/agents` + grants, principal kind external), write the tool's native config: Cursor `~/.cursor/mcp.json` (`url` + `headers` with `${env:NAME}` so the token never hits disk), Devin (personal-scope custom Streamable-HTTP MCP with `Authorization: Bearer`, printed as instructions — no API to write it), Claude Code (existing plugin), OpenCode later (shrinks compute PR 5). Plus `docs/ops/{cursor,devin}.md` | Cursor and Devin read/search the vault, capture, and take tasks through `/mcp` | agent | **done** (#148) |
| W4 | **Cursor session capture**: `sessionEnd` in `.cursor/hooks.json` (Cursor also loads `~/.claude/settings.json`, mapping `SessionEnd`), same idempotency key as the Claude Code plugin; gated on Cursor's transcript format (unverified) | dev sessions land in the inbox whichever tool is used | agent | **done** (#149) |
| W5 | **Devin knowledge-in**: a collector pulling DeepWiki pages for the org's private repos and `devin_knowledge` items via `mcp.devin.ai/mcp` / REST v3 into the inbox as captures (`source: devin`, provenance), so the fold — or Cursor with a knowledge-write grant, until an engine exists — organises them | "learn the team's repos"; Devin's context reaches the vault | agent; owner's Devin PAT (enterprise PAT policy is off by default — owner to enable) | **done** (#150) |
| W6 | **Devin as a compute target**: `targets/devin-sessions` with a new `transport: http` in `dispatch.ts`, `max_acu_limit` from the budget, `structured_output_schema` for the report, **polling** for completion (no outbound webhook exists), result → report proposal | debugging/research briefs dispatched, answers triaged; the first off-machine target that is not GitHub | agent | **done** (#151) |
| W7 | Compute PRs 1→3 **with the local provider first** (bundled `llama-server`/LM Studio on the M5 Pro), Claude via OpenRouter second — the engine on the second instance is local until Claude access arrives; the bake-off (§3) runs alongside on both machines | Metis thinks on the second instance with zero cloud | agent + owner (fixtures) | **done** (#152, #158, #159, #167, #169) |

**Exposure (2026-09-15 ruling):** the owner's home gateway is not available to the second instance, and no inbound exposure is assumed. The shapes that need none: W6 is *outbound-only* (Metis calls Devin's API and polls; results land in the inbox), and a local Devin CLI on the same Mac reaches `/mcp` on loopback. Cloud Devin as an MCP *client* (W3's Devin half) needs an inbound path — a per-instance tunnel with the console's own auth in front (Tailscale Funnel or Cloudflare Tunnel are the candidates; the S6 internal mesh is the long-term answer) — and is deferred until one is chosen. **Ruled 2026-09-17:** local CLI on loopback plus outbound dispatch (W6) is sufficient for now; revisit the tunnel once the second instance is running. W6 grows a **knowledge-research** brief kind: a question Metis cannot answer is dispatched to Devin, the structured answer returns as a `report` proposal with provenance, and the fold files it — "agent delegation of knowledge research and gathering, collected and organised into the knowledge store."

Dependencies: W1–W6 do **not** depend on the compute pivot; W5/W6 need
the owner's Devin PAT; W6's data policy is that instance's own
areas (a brief citing personal areas never leaves). The collaboration
rule holds: Devin is a non-Claude agent — it claims unassigned work, is
never pushed to by name. Grants today are `{tier, areas, queries}` and
tool access follows principal kind (autonomy levels are A3, OPEN-2), so
W3 needs no new grant shape. Training opt-out on dispatched briefs is a
Teams-admin setting at Devin — owner to check before W6 ships a brief.

## 5. What this refresh did **not** change, and why

- **The invariants** — numbering and text untouched; nothing in seven notes
  asks for a change. Every adopt is enforcement *inside* an existing invariant:
  the loopback proxy makes invariant 8 real, the grammar makes invariant 9's
  "enforce at the tool" real for a class of local-model failure.
- **Invariant 4.** The bake-off chooses a *default*, not a runtime route; no
  model decides which model runs, and `/auto` plus fallback lists stay refused
  by the schema.
- **The phase list (§3) and Phase 6 / Later** — nothing re-sequenced. Phases
  1–5 are built, so the work is PR-shaped; §4 is added to §3 in brief rather
  than re-cutting phases.
- **Decision #15 (Docker-free macOS) and the compose shape** — unchanged; the
  bundled `llama-server` follows the runtime-deps pattern that shape uses.
- **D5 / the reconciler / §4.21's risk table.** The agent-room review looked
  for a human-in-the-loop gap and found the ping-pong cap, bundle caps, the
  project budget flip and the `autonomous | review` toggle already shipped and
  matching the plan.
- **`docs/poc/RESULTS.md` and PRODUCT.md history** — the record of what was
  true then; the scrub touches code and user-facing copy only (§2.2).
- **The skips, recorded so they are not re-reviewed:** agent-room as a
  dependency; Hermes's SQLite board, messaging adapters, installable skills and
  in-process plugins; Atomic's TurboQuant fork, managed model daemon, Fusion,
  `subscription-cli` provider, GAIA corpus, Ink TUI; Rivet's agentOS, RivetKit,
  workflows; Managed Agents as the harness.
- **`ios-app-plan.md`** gains only O1–O5; its phasing and the APNs relay
  question are untouched. **No new dependency** is proposed here — the one
  dependency change is a removal (§2.10).
- **Out of scope, noticed:** the two `.py` files under
  `docs/poc/poc16-local-scorer/` violate the no-Python rule that postdates
  them; `apps/console/src/runner.ts` is the 59-line runner G1 hardens.

---

## 6. Edits applied today

`metistry-build-plan.md`, each marked `(refresh 2026-09-13)`: line 11; §2's
PoC-4 outcomes row and decision 6; the PoC-4 section; the PoC-16 entry; §3's
new "Queue refresh" block; §4.17's Apple FM row and rule 7; §4.18's opening, A,
A′, C, D, E; §6 decision 9 and a pointer under "Still open"; §7's Agent SDK
entry. `desktop-app-plan.md`: "Optional, offered in-app", "the user's own,
unavoidable", wizard step 7. `ios-app-plan.md`: one dated block (O1–O5).
`PRODUCT.md`: one line.

## 6a. Proposed for CLAUDE.md — accepted 2026-09-17

A principle for the console's mutating surface after #170: "The console's
mutating surface is a closed, enumerated set of actions, each a door onto an
existing audited service; a new action is a product change, never a prompt or
a config line." Not applied to `CLAUDE.md` here — that file is the owner's
(§2.10) — recorded as a status-pass finding for him to rule on.

Why: invariant 9 already closes the *engine's* mutating and outbound surface
(`brain-commit` plus allowlisted bridges); #170's executable action proposals
gave the *console* an equivalent surface for the first time (a closed set of
four kinds — dispatch, patch, comment, capture — each running the same
service call the owner's own click makes), and nothing in the invariants
currently says that surface has to stay closed by construction rather than by
convention.

**Accepted 2026-09-17.** Applied to `CLAUDE.md` as invariant 10: "The
console's mutating surface is closed. A closed, enumerated set of actions,
each a door onto an existing audited service; a new action is a product
change, never a prompt or a config line."

## 7. Sources

- `docs/research/2026-09-11-local-models-openrouter-opencode.md` — rev 2–4,
  Owner decisions, Owner questions rev 4, "The path to a local main agent",
  addendum 2026-09-12 (#134, #140)
- `docs/research/2026-09-11-multi-instance-and-offline-client.md` (#131)
- `docs/research/2026-09-12-{rivet-agentos,agent-room,hermes-agent,
  hermes-agent-2,atomic-agent}-review.md` (#135–#139)
- Shipped: `docs/ops/console-api.md` (#132). Format precedent:
  `docs/plan-review-2026-08-29.md`; fixture precedent
  `docs/poc/poc15-complexity/`, `docs/poc/poc16-local-scorer/`,
  `docs/poc/RESULTS.md`.
