# A fast local intent tier for inputs (2026-09-21)

Research commissioned by the owner the same day: *"I'd like to do some research
on exploring the use of Nimble […], Jev/choice […], or another similar system to
act as a fast and nimble local classification system for inputs to Metistry.
This could help Metis quickly identify user intent, in rich text inputs, for
performing an action from a curated and known list of actions that Metistry
maintains (ie the schema) or, if needed, routing to a more complex model that
can perform complicated or compound actions and better judge complex inputs.
This would be part of a tiered and multi-layer input parsing system, not a
replacement."*

Nothing here is built. Sources are cited with URL and the publisher's date.
**Every latency figure below was measured on this Mac on 2026-09-21** — Mac
Studio, Apple M4 Max, 64 GB, macOS 26.4 (25E246) — against the local model
servers that were already running, over the same
`POST <base_url>/chat/completions` wire `collectors/compute-client.ts` speaks.
Command output is printed verbatim. **The owner's instance was not read** and
nothing was written anywhere; the `apple-fm` bridge on `:7810` answered `401`
to an unauthenticated probe, as designed, and was not pursued further.

**One warning about the accuracy numbers, up front.** The ten test messages and
their "right" answers are *mine*. C11 forbids Claude output as training data or
as an expected answer, and a label I wrote is exactly that. So the accuracy
columns below are **illustrative only, and must never become the fixture set**.
What is measured and trustworthy here is **latency, schema conformance, wire
support and the shape of the confidence signal**. §4.4 says where the real
fixtures come from.

## The short version

1. **This already exists, once, and it works.** `collectors/inbox-drain/run.ts`
   is a two-tier classifier: deterministic rules first, then — only for the
   rows the rules could not place — an on-device model held to a JSON Schema
   over a closed five-value enum, degrading to the deterministic answer when
   the model is absent. The owner is asking for that pattern on the *input*
   path. The precedent is not analogous; it is the same code shape (§1.3).
2. **Nimble is not adoptable, and the blocker is not Python.** The GitHub
   repository carries **no licence at all** (`gh api repos/bespokelabsai/nimble`
   → `"license": null`, checked 2026-09-21), which for a fully-open-source
   product is a hard stop before any technical argument. It is also Python
   3.12 + PyTorch/MLX, a 9B model whose weights alone are ~18 GB unquantised,
   with no JS client and a self-reported 444 ms median on an M5 Pro (§2.1).
3. **TypeSafe's Jev is a hosted API — `locality: off_machine` — and that
   settles it for this tier.** It has a real TypeScript SDK and costs
   $0.042/Mtok input, output free, but ZDR is enterprise-only, and a classifier
   on the input path would see *every message the owner types* before any data
   policy has been applied (§2.2).
4. **The technique both of them are selling is free, and it is already on our
   wire.** Nimble's own description: score the model's logits for the allowed
   answer tokens, "so there is no generated JSON to parse." **Measured today:
   `logprobs: true, top_logprobs: 20, max_tokens: 1, reasoning_effort: "none"`
   works on Ollama's OpenAI-compatible `/v1/chat/completions`, and the same
   fields come back populated from the bundled `llama-server`'s.** Fifteen intents, `gemma4:e4b-it-qat`:
   **p50 155 ms, p95 166 ms** — plus TypeSafe's own published confidence
   statistic, recomputed in our code from the returned distribution (§2.4).
5. **Against the honest control — same server, same model, same intents — the
   JSON-schema route costs p50 336 ms for the same answers.** The
   answer-token trick buys **2.2× latency and a calibrated-looking confidence
   number**, not accuracy. An earlier cross-server comparison suggested it
   bought accuracy too; the control says that was LM Studio's reasoning
   channel, which is PoC-16 finding 2 reproduced (§2.3, §2.4).
6. **Embeddings are 20× cheaper again and not usable yet.** Nearest-centroid
   over the `nomic-embed-text` the vault search already runs: **p50 9 ms**, and
   with no labelled fixtures the only available centroid is the intent's own
   description — margins of 0.005–0.083 cosine, which is noise. This is the
   *phase-3* candidate, unlocked by the fixture harvest, not a starter (§2.5).
7. **Invariant 4 survives, and the repo already contains the precedent for how.**
   A classifier that names an ACTION from the closed enum is not routing. A
   classifier that says "escalate to the big model" **is** a model choosing a
   model, and PoC-15/PoC-16 already tested exactly that and left the invariant
   standing pending a confirmatory eval that has not run. The shape that works:
   the classifier emits `{intent, confidence, compound}` as a **fact** onto the
   message; `rules.yaml` grows a `confidence` clause; **the decision stays in
   the rules file, which is a §4.7 protected path** (§3).
8. **Recommendation: yes, phased, and phase 1 adds no dependency.** PoC-20
   phase 0 measures the rules alone; phase 1 is answer-token scoring through
   the existing compute layer; phase 2 is the JSON-schema fallback for
   compound inputs; phase 3 is embeddings once fixtures exist. **No external
   candidate is recommended at any phase.** Two contradictions with the brief
   and one small gap in the `apple-fm` bridge are reported rather than routed
   around (§6, §1.4).

---

## 1. What exists today

### 1.1 The router is 23 lines of regex, and it decides a tier — not an action

`apps/console/src/router.ts:50-73` is the whole of it. Its own header states
the rule it enforces (`:1-3`):

> The router (invariant 4): deterministic — prefix, regex, explicit commands
> only. No model decides which model to use.

In order, first match wins:

| step | `router.ts` | what it matches | where it goes |
| --- | ---: | --- | --- |
| `/note <text>` | `:54-55` | `/^\/note\s+([\s\S]+)$/` | `{kind:"note"}` — inbox, no model at all |
| `/model <tier> <text>` | `:58-61` | a tier name that exists in `rules.tiers` | `{kind:"model", routed_by:"override"}` |
| `/deep <text>` | `:62-63` | `rules.commands.deep_alias` | the `deep` tier |
| `fast_path` rules | `:65-67` | each `match:` regex from `rules.yaml` | `{kind:"fast_path", query}` — a named query |
| composer tier picker | `:69-71` | a `tier` on `POST /message` | that tier, `routed_by:"override"` |
| everything else | `:72` | — | the `default` tier |

The seeded ruleset is **two** `fast_path` rules (`seed/rules.yaml:4-8`) — `/status`,
`/open`, and one English sentence form — over **four** tiers (`:19-31`). That is
the baseline any classifier has to beat, and §5.2 phase 0 is about measuring
how much of real input it already catches.

`Route` (`:24-27`) is the vocabulary a classifier would have to join: three
kinds, and a `routed_by` of `"rule" | "override"`. Nothing in that union can
express "a model had an opinion", which is not an accident.

The decision is written durably **before** the 202, onto the message itself:
`apps/console/src/server.ts:616-621` puts the whole `Route` object in
`inbound_messages.meta.route`. A `fast_path` also opens a `runs` row carrying
`meta.routed_by` and `meta.tier` (`:671-676`). Both are the hooks §4.3 uses.

The assistant resolves the same tier NAME independently at the point of the
call (`apps/assistant/src/tiers.ts:95-101`, and its header at `:5-9` explains
why both sides resolve rather than one shipping the pair). **One name, one
`tiers:` block, two readers** — so a classifier that changed a tier would have
to change it in the file both readers read, which is precisely the property
§3.2 leans on.

### 1.2 The commands list is derived from the rules, not declared

`GET /api/commands` (`apps/console/src/server.ts:900-907`) answers from
`commandList()` (`apps/console/src/commands.ts:104-169`), which reads *this
instance's* `rules.yaml` plus the query store's descriptions. Its `routes_to`
is `"note" | "fast_path" | "model_override"` (`:29`), and a `fast_path` entry
carries `tier: null, model: null` with the named query in `query:` (`:155-164`)
— the shipped `/status` resolves to the `open_work` query and reaches no model.

The comment at `:94-98` is the one that matters for this research:

> No recency, no popularity, no model — the same discipline invariant 4 applies
> to the router applies to the menu it renders.

So there are already **two** surfaces under the no-model rule: what runs, and
what is offered. A classifier must not reorder the menu either.

`literalCommands()` (`:73-85`) refuses to invent a command from a regex it
cannot read unambiguously. That is worth noting because it is the same
discipline §3.3 asks of the classifier: *a thing you cannot name exactly, you
do not name at all.*

### 1.3 The capture path already has this exact two-tier classifier

The brief describes `POST /capture` and inbox-drain as "deterministic,
model-free". **That is out of date, and the correction is the single most
useful fact in this document.** `collectors/inbox-drain/run.ts` has had an
on-device model tier since the compute refresh:

- **Tier 1, rules.** `classify()` (`:86-103`) — frontmatter `kind:`, a bare
  URL, a leading action verb (`TODO_RE`, `:50`), a mime type — and every
  verdict carries a `reason` field that names *which rule fired*: "auditable,
  not vibes" (`:32`).
- **Tier 2, a model, only on fall-through.** `:249` selects
  `deterministic.get(r.id)!.reason === "default"` — **the model never sees a
  row the rules placed positively.** Capped at 25 items a pass (`:208`) and
  2000 characters an item (`:211`).
- **The schema is a closed enum.** `FM_SCHEMA` (`:186-195`) is three fields:
  a five-value `category` enum, a `has_action` boolean, and a short `action`
  string. Its comment (`:174-179`) records that it *used to be* a compiled
  Swift `@Generable` type and became JSON Schema so that "the shape and the
  wording belong to the collector that needs them".
- **Parse, then validate anyway.** `:229-237` re-checks the enum in code
  because "`strict: true` is the provider's promise, not this collector's
  assumption".
- **The tier's name lands on the row.** `:258` and `:264-266` put the provider
  name in `reason` and a `tier` of either the provider or the literal
  `"deterministic"` — so "which model said this" is answerable from the row.
- **Absent is normal.** `completeJson()` returns a *reason* rather than
  throwing for every failure except the money rule
  (`collectors/compute-client.ts:24-28, 94-115`), and the deterministic answer
  stands.
- **And it still proposes rather than acts.** `suggestedWork()` (`:110-142`)
  deliberately does **not** read the model's `has_action` — its comment says so
  at `:113`. The console renders "Approve as Work"; the row is born of a click.

The manifest pins one model (`collectors/inbox-drain/manifest.yaml`:
`uses_model: applefm/foundation-model`) and two independent checks enforce that
it is free: CI against the seed template, and `completeJson()` against the
`compute.yaml` in force (`docs/ops/compute.md:847-855`).

**Everything §3 proposes is this file, pointed at the input path instead of the
inbox.** That is what makes the effort estimates in §5.2 small.

### 1.4 The compute layer, and which servers can constrain generation

Four local servers, one protocol (`docs/ops/compute.md:610-622`). All four were
answering on this machine when the measurements were taken:

```
$ for p in 1234 11434 7813 7810; do printf "%s: " $p; \
    curl -s -m 2 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$p/v1/models; done
1234: 200      # LM Studio      — google/gemma-4-e4b
11434: 200     # Ollama         — gemma4:e4b-it-qat, nomic-embed-text
7813: 200      # llama-server   — stories15M-q4_0 (a test fixture, not a real model)
7810: 401      # apple-fm       — authenticates every route, as designed
```

What each one can be *held to*, verified today:

| server | JSON Schema | answer-token logprobs | evidence |
| --- | --- | --- | --- |
| **`llama-server`** (bundled) | yes — `json_schema`, and `response_format` on `/v1` | **yes** — `logprobs.content[0].top_logprobs` came back populated from `:7813`. The loaded model was the `stories15M-q4_0` test fixture, so **the field shape is verified and the answer content is meaningless** | README `json_schema`: "Set a JSON schema for grammar-based sampling"; `n_probs`; `/v1` `response_format` supports `{"type":"json_schema", "schema": …}` |
| **Ollama** | yes — `format:` takes a JSON schema | **yes**, incl. on `/v1` with `reasoning_effort:"none"` | API docs: "Structured outputs are supported by providing a JSON schema in the `format` parameter"; measured below |
| **LM Studio** | yes — `response_format: json_schema` | **no** — returned `"logprobs": null` with `logprobs:true, top_logprobs:20` for `google/gemma-4-e4b` | measured below |
| **Apple FM** | yes — per-request `DynamicGenerationSchema` | **no, structurally** | `packages/mcp-apple-fm/helper/afm-helper.swift:91-153`; FoundationModels exposes no per-token logits |

Two things follow. First, **the answer-token technique is available on the two
servers Metistry can actually guarantee** — the bundled one it ships, and the
peer most likely to be present — and not on the one that is free. Second,
**Apple FM can only ever do the JSON-schema half**, which is fine: PoC-19
measured a three-field classification schema there at **p50 497 ms**
(`docs/poc/RESULTS.md:817`), and `docs/ops/compute.md:771-773` already
says what it is for — "good at **reduction** (classify, extract, tag), weak as
a judge".

**A small gap, reported not fixed.** `packages/mcp-apple-fm/src/v1.ts:100-102`
refuses `stream`, `tools` and `n != 1` by name, and `:172-189` never emits a
`logprobs` field — but `logprobs` is **not** in the refusal list, so a caller
that asks for it gets a `200` with the field silently missing. That contradicts
the bridge's own stated posture (`docs/ops/compute.md:792`, "What it refuses,
loudly, rather than degrading"). One line in the refusal list; out of scope
here.

The apple-fm bridge also still carries a **`POST /classify`** route
(`packages/mcp-apple-fm/src/index.ts:113-138`) whose schema is the compiled
Swift `@Generable Classification` — `category` as a five-case enum,
`hasAction`, `action` (`helper/afm-helper.swift:159-172`). It is the *old*
inbox schema, hardcoded in Swift, and inbox-drain no longer uses it
(`docs/ops/compute.md:868-874`). **Nothing in this proposal should touch
`/classify`**: a curated intent enum that lives in Swift would need a rebuild
and a re-sign to change, which is the exact mistake `FM_SCHEMA` was moved out
of Swift to fix.

### 1.5 The closed sets a classifier could ever name

There are three, and they are all already enumerated in code:

| set | where | members |
| --- | --- | --- |
| **actions** | `packages/core/src/actions.ts:34` | `dispatch`, `task_update`, `comment`, `capture` — 4 |
| **triage verbs** | `docs/ops/reply-feedback.md:13-20` | `allow`, `accept_with_changes`, `deny`, `accept_as_work` (`allow` + a work row), `later`, `skip` — 6 |
| **route kinds** | `apps/console/src/router.ts:24-27` | `fast_path` (× the instance's named queries), `note`, `model` |

`actions.ts:16-19` states the property that decides §3.3:

> The enum is CLOSED and it is here. A kind nobody validated is a kind nobody
> reviewed; the console, the bridge, the CLI and the tests all read this list,
> so "what may an action do" has exactly one answer.

Summing an instance's realistic surface — 4 action kinds, 6 triage verbs, a
dozen-ish fast paths, and a handful of "this is a question, not a command"
classes — lands in the **20–50 range the brief names**. §2.9 measures at 15 and
at 40 for exactly that reason.

### 1.6 The eval harness that would score it

`packages/eval` is PoC-18's, and it is close but not free:

- Five axes, `tool_calls`, `stopping`, `triage`, `voice`, `writing`
  (`src/fixtures.ts:25`); two are scored in code (`:29`). **`intent` is not one
  of them** and would be a sixth — a deterministic axis, scored in code against
  a label, which is the cheapest kind to add.
- `Candidate` (`src/record.ts:33-45`) already carries `{name, provider, model,
  server, effort}` and `server` is already free-form over `llamaserver |
  lmstudio | ollama` (`:29`) — the exact axis this bake-off needs.
- `RunRecord` (`:69-104`) already carries `latency_ms`, `ttft_ms`, `score`,
  `pass`, `reasons`, `tokens_in/out`, `cost_usd`. **A confidence column is the
  only genuinely new field**, and `reasons: string[]` would carry the
  distribution honestly until one exists.
- And the rule that governs the whole exercise, `src/fixtures.ts:14-20`:

  > The fixtures themselves are the OWNER'S, never Claude's: Claude is the bar
  > the candidates are measured against and is never the source of an expected
  > answer (C11 […]).

---

## 2. The candidates, measured

### 2.1 Nimble (bespokelabsai/nimble)

Read 2026-09-21. The repository was **created 2026-09-18** and last pushed
2026-09-20 — it is three days old, with 1,218 stars.

**What it is**, in its own words:

> Nimble takes some text and a schema, and makes typed decisions about the
> text. The schema is the list of questions to answer. Each question is either
> a choice from a list that you give or a true or false question. For each
> question, Nimble returns the answer it picked and the probability of each
> allowed answer.

And the mechanism, which is the genuinely valuable part:

> Each allowed answer has a code that is one token long. The scorer reads the
> model's logits for these codes. […] The scorer turns the logits into
> probabilities with the softmax function. Our Python code then builds the
> output from these probabilities, so there is no generated JSON to parse.

It is explicitly derivative: "Nimble is inspired by the System One approach of
TypeSafe's Jev", and "we did not distill from Jev."

**Why it cannot be adopted, in order of severity:**

1. **No licence.** `env -u GH_TOKEN gh api repos/bespokelabsai/nimble`
   returns `"license": null`, and `GET /repos/…/license` returns `404`. The
   repository root has no `LICENSE` file. Under default copyright that is
   all-rights-reserved. *The model weights are differently licensed* — the
   Hugging Face card for `bespokelabs/Bespoke-Nimble-9B` declares
   `license: apache-2.0`, and its base `Qwen/Qwen3.5-9B` is also Apache-2.0 —
   so the **weights** are usable and the **serving code is not**. For a product
   whose strategy is fully open source, that asymmetry is disqualifying for the
   repo and merely interesting for the weights.
2. **Python, everywhere.** "Use Python 3.12", PyTorch 2.8.0 for training and
   CUDA, MLX for Mac. CLAUDE.md's stack section bans Python outright (ruled
   2026-08-29). There is **no TypeScript or JavaScript client** anywhere in the
   repository or the model card.
3. **The weights are too big for this task.** "Without quantization, the 9B
   weights alone take about 18 GB. […] A Mac with 64 GB of memory has more free
   memory for this than a machine with 24 GB." Compare `gemma4:e4b-it-qat`,
   PoC-16's winner: 6.1 GB download, 6.3 GB resident
   (`docs/poc/RESULTS.md:681`).
4. **Its own Mac latency is worse than what we measured today.** Its published
   table: **444.0 ms median, 981.0 ms p95** for Bespoke-Nimble-9B on an
   "M5 Pro 64GB", against 106.0 ms on an H100. The 155 ms p50 measured in §2.4
   on this M4 Max, with a 4B-class model and no new dependency, is **2.9×
   faster than Nimble's own Mac number**.
5. **The training set is tiny and narrow, and it says so.** "We trained
   Bespoke-Nimble-9B on 2,676 examples […] don't expect a lot of
   generalization", and of the 324-example evaluation: "The reference labels
   are synthetic. […] All of them come from only six source families, so this
   is a narrow test."
6. **A 26-option ceiling.** "An enum field can have 1 to 26 string choices"
   — because each answer code is one token. At the top of the brief's 20–50
   range that is a real constraint (§2.4 inherits it; §2.9 says how to get past
   it).
7. **2,048-token prompt ceiling**, schema included.

**What is worth taking:** the technique, and its honest caveat, which is the
best-written paragraph in the README and belongs in our own docs verbatim:

> The probabilities are not a guarantee that an answer is correct. Nimble
> scales them so that they add up to 1 across the answers you supplied. A
> probability of 0.9 does not mean that the answer is right 90% of the time.
> If it is possible that none of your answers fit, add an answer that means
> "no match". Test any probability threshold on your own data before you rely
> on it.

That last sentence is the whole of §4.4's bar, written by someone else.

### 2.2 TypeSafe `choice` / Jev

Read 2026-09-21. **A hosted API with client SDKs**, not a pattern and not a
library.

> A Choice is a System One question type for selecting one option from a
> defined set. The answer includes the selected option, a probability for each
> option, and confidence.

> Jev is TypeSafe's flagship model and the first System One model. […] Like an
> LLM, a System One model understands natural-language input. It returns typed
> decisions and probabilities rather than generated text.

| | Jev 1.13 (`jev-1.13.0`) |
| --- | --- |
| shape | hosted only — `POST /v1/systemone` at `api.typesafe.ai`; no self-host, no weights |
| SDKs | Python **and JavaScript/TypeScript** — `npm install @typesafe-ai/sdk`, Node ≥ 20, ESM + CJS + `.d.ts` |
| price | **\$42 / Btok, \$0.042 / Mtok input; "Output tokens are free"** |
| limits | 250,000 tok/s, 1,200 req/min, "adjusting dynamically […] can change without notice" |
| context | 64k per request; 32k for `state` plus the longest question |
| options | "up to 255 options" per Choice |
| data | "Jev is not trained on customer requests or responses"; **ZDR is "for enterprise customers"** |
| licence | none published — it is a service |

Its own published pattern is, almost word for word, the brief:

> **Intent routing** — Classify incoming requests and route each to the optimal
> handler: deterministic logic, a specialist LLM, or a human. […] Rather than
> sending every message through an expensive LLM to figure out what kind of
> request it is, you classify first and route accordingly.

And its confidence doctrine is the one §3.2 adopts:

> **High confidence:** Act automatically. […] **Medium confidence:** Proceed
> with caution. […] **Low confidence:** Do not act. Route to a human, request
> clarification, or fall back to a different system.

> A confidence threshold is not one number. Different actions within the same
> system should be gated at different levels depending on the consequences of
> getting it wrong. […] Your code encodes the risk tolerance.

**The statistic is published and reimplementable.** The `ConfidenceExplorer`
source embedded in `docs.typesafe.ai/confidence` computes, for a Choice with
`n` options and peak probability `p`:

```js
confidence = max(0, min(1, (n * peak - 1) / (n - 1)))
```

That is one line of TypeScript over a distribution we can obtain locally
(§2.4). It is used unchanged in every measurement below.

**Why it is not the answer for this tier.** It is `locality: off_machine` by
construction, and the thing being classified is *every message the owner types
into the composer*, ahead of any data policy. `compute.yaml`'s own comment is
the rule (`seed/compute.yaml:25-27`): "An off_machine provider MUST declare
data_policy — what may leave this machine is a declaration, not a default." A
`data_policy` that admitted raw composer text would be the widest one in the
file, to buy ~100 ms against a local option measured at 155 ms. And ZDR — which
`seed/compute.yaml:34` treats as a first-class provider property — is
enterprise-only here.

**Where it would be legitimate:** as a *cloud arm in the bake-off*, to find the
ceiling. `packages/eval`'s `Candidate.server` is already free-form (§1.6), a
JS SDK exists, and 324-example runs cost cents. That is a measurement, on
fixtures the owner authored, not a production path — and it is still the
owner's call, because the fixtures are the owner's own messages.

### 2.3 Candidate (a): constrained decoding to an enum, through the compute layer

The near-zero-infrastructure option: `completeJson()` already sends
`response_format: {type:"json_schema", json_schema:{name, strict:true, schema}}`
(`collectors/compute-client.ts:125`). Pointing it at an intent enum is a new
schema constant and a caller.

**Measured, LM Studio, `google/gemma-4-e4b`, 15 intents, 10 messages:**

```
### lmstudio google/gemma-4-e4b — json_schema over 15 intents, 10 cases
   29518 ms  status_open_work   compound=false ← what's my status
     242 ms  schedule_lookup    compound=false ← remind me to call the dentist tomorrow
     234 ms  task_list          compound=false ← show me Jim's tasks for our 1:1
     260 ms  status_open_work   compound=false ← what did we decide about the router last week?
     236 ms  task_list          compound=false ← close #412 and tell Drey to pick up the review
     231 ms  unsure             compound=false ← hey
     233 ms  note_capture       compound=false ← add a note: gemma-4 is faster than I expected
     221 ms  unsure             compound=false ← why is the reconciler behind?
     235 ms  schedule_lookup    compound=false ← book me 30 minutes tomorrow afternoon
     236 ms  task_update        compound=false ← switch the deep tier to opus
{"n":10,"p50_ms":236,"p95_ms":29518,"mean_ms":3165,"off_schema":0}
```

**Zero off-schema in ten**, p50 236 ms warm — and a **29.5-second first
request**, which is the model being loaded. That cold-start number is not a
footnote: it is the difference between a classifier on the composer's hot path
and an unusable one, and it is why §5.3 asks the owner for a resident model.

The answers, though, are poor: `schedule_lookup` for a reminder,
`status_open_work` for a question about a past decision, `task_update` for a
compute change, and `compound=false` on an obviously compound message.

**The control that explains it — same server, same model as §2.4, thinking
off:**

```
### json_schema, 15 intents   (ollama gemma4:e4b-it-qat, think off)
    341 ms  status_open_work   ← what's my status
    333 ms  task_create        ← remind me to call the dentist tomorrow
    331 ms  task_list          ← show me Jim's tasks for our 1:1
    318 ms  task_update        ← close #412 and tell Drey to pick up the review
    334 ms  schedule_lookup    ← book me 30 minutes tomorrow afternoon
{"n":15,"p50":333,"p95":341,"prompt_chars":389}
```

Correct on four of five by my labels, against LM Studio's two. **The gap was
the reasoning channel, not the technique** — LM Studio's `gemma-4-e4b` returned
a `reasoning_content` field and consumed `max_tokens` on it. This reproduces
**PoC-16 finding 2** exactly (`docs/poc/RESULTS.md:696-699`): "Reasoning hurts
this task, measured: identical weights with thinking enabled cost 9× latency,
*lowered* accuracy […] The scorer should run with reasoning suppressed."

Suppression is per-server and is a real integration cost:
`reasoning_effort:"none"` on Ollama's `/v1`, `think:false` on its native route,
`chat_template_kwargs:{"enable_thinking":false}` on `llama-server`. PoC-16's
harness note 4 already recorded that "Ollama `/v1` ignores native `think` but
honors `reasoning_effort: "none"`" — confirmed again today.

**Does the set size hurt?** 15 → 40 intents, same server and model:

```
### json_schema, 40 intents
      409 ms  status_open_work   ← what's my status
      374 ms  task_create        ← remind me to call the dentist tomorrow
      465 ms  task_list          ← show me Jim's tasks for our 1:1
      369 ms  task_close         ← close #412 and tell Drey to pick up the review
      394 ms  schedule_lookup    ← book me 30 minutes tomorrow afternoon
{"n":40,"p50":394,"p95":465,"prompt_chars":760}
```

**+18% p50 for 2.7× the intents**, and at 40 it found the better label
(`task_close`) for "close #412". The brief's 20–50 range is not where this
breaks.

### 2.4 Candidate (a′): the technique Nimble uses, without Nimble

Constrain the answer to **one token** from a closed alphabet, ask for
`top_logprobs`, renormalise over the alphabet in our code, and compute
TypeSafe's confidence statistic. This is Nimble's scorer and Jev's answer
shape, on weights we already have.

**It works on the OpenAI-compatible wire `completeJson()` already speaks:**

```
$ curl -s http://127.0.0.1:11434/v1/chat/completions -d '{"model":"gemma4:e4b-it-qat",
    "temperature":0,"max_tokens":1,"logprobs":true,"top_logprobs":5,
    "reasoning_effort":"none","messages":[…"A = status, B = note, C = task"…]}'
content= 'C'
logprobs present: True
   'C' -0.054
   'B' -3.582
   'A' -4.331
```

`C` = `task` at p ≈ 0.947, and the two rejected codes three logits behind it.
**The same fields come back from the bundled `llama-server` on `:7813`** — its
loaded model was the `stories15M-q4_0` test fixture, so only the shape is
meaningful, but the shape is what was in question:

```
--- llama-server /v1 logprobs (toy model, field shape only) ---
logprobs present: True
   '"' -2.112
   'A' -2.63
   'The' -3.097
```

**LM Studio is the exception.** With `logprobs:true, top_logprobs:20` against
`google/gemma-4-e4b` it answered `"logprobs": null` and `completion_tokens: 0`
with `finish_reason: "length"` — `max_tokens` had been consumed by a
`reasoning_content` channel. Raising `max_tokens` to 8 still returned
`logprobs: null`. So **LM Studio is a JSON-schema-only arm** until that is
re-verified on a later build.

**Measured, Ollama `/v1`, `gemma4:e4b-it-qat`, 15 intents, 10 messages:**

```
  (warm-up 242 ms)
   166 ms  A=status_open_work  p=0.860 conf=0.850 alpha=1.000  ← what's my status
   158 ms  C=task_create       p=0.988 conf=0.987 alpha=1.000  ← remind me to call the dentist tomorrow
   154 ms  E=task_list         p=0.952 conf=0.948 alpha=0.999  ← show me Jim's tasks for our 1:1
   155 ms  F=knowledge_search  p=0.866 conf=0.857 alpha=0.998  ← what did we decide about the router last week?
   155 ms  D=task_update       p=0.779 conf=0.763 alpha=0.999  ← close #412 and tell Drey to pick up the review
   129 ms  N=smalltalk         p=0.543 conf=0.510 alpha=0.999  ← hey
   153 ms  B=note_capture      p=0.999 conf=0.999 alpha=1.000  ← add a note: gemma-4 is faster than I expected
   159 ms  F=knowledge_search  p=0.516 conf=0.482 alpha=0.998  ← why is the reconciler behind?
   154 ms  K=schedule_lookup   p=0.980 conf=0.978 alpha=1.000  ← book me 30 minutes tomorrow afternoon
   155 ms  D=task_update       p=0.860 conf=0.850 alpha=1.000  ← switch the deep tier to opus
{"n":10,"p50_ms":155,"p95_ms":166,"mean_ms":154}
```

Five things in that output matter more than the labels:

1. **p50 155 ms, p95 166 ms — a 11 ms spread.** One token is one token; there
   is no output-length variance to absorb. Against the JSON-schema control on
   the same model, **2.2× faster at p50 and 2.3× at p95**.
2. **`alpha` is 0.998–1.000** — that is the share of the model's own top-20
   probability mass that landed *inside* the closed alphabet. Near 1.0 means
   the constraint is not fighting the model, and a low `alpha` would be an
   honest "this input is not in my vocabulary" signal that JSON-schema
   decoding cannot produce.
3. **The confidence tracks the ambiguity.** The two lowest — `hey` at 0.510
   and "why is the reconciler behind?" at 0.482 — are the two genuinely
   ambiguous inputs. The one-word greeting and the diagnostic question are
   exactly the messages a rule should escalate rather than act on.
4. **It is not magic.** "switch the deep tier to opus" came back `task_update`
   at confidence **0.850** — a *confident* error, and the most important row in
   the table. Confidence measures the shape of a distribution, not correctness;
   Nimble's README says so in as many words (§2.1). §4.4's bar has to be a
   measured threshold on the owner's own data, never an assumed one.
5. **Answers were byte-identical between Ollama's native `/api/chat` with
   `think:false` and `/v1` with `reasoning_effort:"none"`** — so the product
   path needs no second client. `completeJson()` gains a sibling,
   `scoreChoice()`, on the same URL with different fields.

**The 26-intent ceiling, and how to pass it.** Single capital letters give 26
codes. Past that: a second scored token (26² codes, two calls or one two-token
generation), or digit-pair codes, or — simplest — **cascade**: one scored token
over ~10 intent *groups*, then a second over the winning group's members. Two
scored tokens at 155 ms is still 310 ms, under the JSON-schema route's single
336 ms. This is the phase-2 design note, not a blocker.

**Not available on Apple FM**, which means the free-and-resident provider can
only do §2.3. An instance with no Ollama and no bundled model gets the
JSON-schema tier at Apple FM's measured 497 ms (PoC-19), or the rules alone.
Both are supported installs; §5.2 requires that degradation be a tested path.

### 2.5 Candidate (b): embeddings + nearest centroid

pgvector is in the stack, and `nomic-embed-text` at 768 dimensions is already
the vault's embedder (`docs/ops/knowledge-search.md:14-15`, §6 decision 8,
PoC-5). The classifier would be a cosine over stored centroids.

**With no labelled fixtures, the only available centroid is the intent's own
description.** That is the floor of this approach, and it is what was measured:

```
### ollama nomic-embed-text (768d) — zero-shot nearest-centroid over 15 intents
     9 ms  ✓ status_open_work  cos=0.629 margin=0.068  ← what's my status
    11 ms  ✓ task_create       cos=0.553 margin=0.083  ← remind me to call the dentist tomorrow
    14 ms  ✗ task_create       cos=0.620 margin=0.011  ← show me Jim's tasks for our 1:1
     9 ms  ✗ triage_answer     cos=0.476 margin=0.011  ← what did we decide about the router last week?
     9 ms  ✗ artifact_review   cos=0.531 margin=0.005  ← close #412 and tell Drey to pick up the review
     7 ms  ✓ smalltalk         cos=0.522 margin=0.012  ← hey
    10 ms  ✗ triage_answer     cos=0.434 margin=0.009  ← add a note: gemma-4 is faster than I expected
     9 ms  ✗ agent_delegate    cos=0.517 margin=0.035  ← why is the reconciler behind?
     7 ms  ✓ schedule_lookup   cos=0.608 margin=0.078  ← book me 30 minutes tomorrow afternoon
     7 ms  ✗ task_update       cos=0.447 margin=0.027  ← switch the deep tier to opus
{"n":10,"p50_ms":9,"p95_ms":14,"matched_my_labels":"4/10"}
```

**p50 9 ms — 17× faster than §2.4 and 37× faster than §2.3.** And unusable as
it stands: six of the margins are under 0.04 cosine, which is noise, and the
margin is the only confidence signal available, so it cannot even escalate
honestly.

**This is not a rejection; it is a sequencing fact.** A logistic head or
labelled centroids over ~30 owner-labelled examples per intent is the standard
form of this and is likely to be both fast and good — but it needs the fixture
harvest to exist first, and the fixtures are the owner's (C11). It is
**phase 3**, and the run above is its honest baseline: anything trained must
beat 4/10 at 9 ms, on the owner's labels rather than mine.

Two properties it keeps that nothing else here has: it is **trainable on this
machine with no GPU and no new dependency** (a 768-dimension logistic
regression is arithmetic), and it can be **retrained from the audit log** as
the owner corrects verdicts — which is the only candidate that gets better
with use.

### 2.6 Candidate (c): fastText / SetFit — disqualified on maintenance, not merit

- **fastText upstream is archived.** `facebookresearch/fastText`:
  `"archived": true`, last push **2024-03-22**, MIT, 26,530 stars.
- **The Node binding is seven years stale.** `npm view fasttext`: latest
  `1.0.0` published **2019-07-17**, package last modified 2022-06-17,
  dependencies `node-addon-api` + `node-pre-gyp` — a native addon compiled at
  install, on a Mac we promise needs no build tools.
- **SetFit is Python** (sentence-transformers + scikit-learn). Its *inference*
  half is candidate (b) with better centroids; its *training* half has no
  TypeScript equivalent.

CLAUDE.md's rule — "every dependency is a future maintenance obligation" —
answers this without needing an accuracy number.

### 2.7 Candidate (d): GLiClass / NuExtract via ONNX Runtime in Node

Technically real, and the brief's parenthetical ("dependency weight!") is
correct to the gram:

- `onnxruntime-node@1.30.0`, MIT — **`dist.unpackedSize` 301,068,136 bytes
  (301 MB)**, `os: [win32, darwin, linux]`, prebuilt native binaries per
  platform.
- `@huggingface/transformers@4.3.0`, Apache-2.0, is 9.9 MB itself but depends
  on `onnxruntime-node@1.30.0`, `onnxruntime-web`, **and `sharp`** — a second
  native addon, for image decoding we have no use for.
- GLiClass weights are real and permissive — `knowledgator/gliclass-modern-base-v3.0`,
  Apache-2.0, 5,644 downloads, last modified 2025-08-12 — and third-party ONNX
  exports exist (`cnmoro/gliclass-{edge,base,large,modern-large,x}-*-onnx`).
  **Third-party exports of someone else's weights are a supply-chain
  relationship we do not currently have with anyone**, and the first-party
  repository publishes `model.safetensors`, not ONNX.

Weighed against §2.4: 301 MB of native binary and a third-party weight export,
to replace a feature of a server we already ship. The right comparison is not
GLiClass against nothing — it is GLiClass against 155 ms and zero new lines in
`package.json`.

### 2.8 Candidate (e): rules and regex — the tier that exists

Already built (§1.1), p50 well under a millisecond, perfectly auditable, and it
handles the only inputs that genuinely matter to get right: the ones the owner
typed deliberately as a command. **Its ceiling is coverage, and nobody has
measured that.** §5.2 phase 0 exists to.

`docs/ops/reply-feedback.md` and `commands.ts` both suggest the cheapest real
improvement available: more `fast_path` rules, which cost one line of YAML
each, reach a named query with no model, and **appear in `GET /api/commands`
automatically** (`commands.ts:150-166`). If phase 0 says 80% of real input is
already a command or a near-command, several of the later phases get cheaper or
disappear.

### 2.9 The comparison

Latency is measured on this M4 Max unless the cell says otherwise. Accuracy
columns are deliberately absent: see the warning at the top.

| | latency (p50 / p95) | intents | confidence signal | training data | new dependency | offline | cost |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| **(e) rules + regex** | <1 ms | n/a | none — it either matched or did not | none | none | yes | 0 |
| **(b) embeddings, nearest centroid** | **9 / 14 ms** | any | cosine margin — **measured uninformative zero-shot** | ~30 owner labels per intent | none (embedder is running) | yes | 0 |
| **(a′) answer-token scoring** | **155 / 166 ms** | **≤26** per call; cascade past that | **full distribution + TypeSafe's statistic** | none (zero-shot) | none — `logprobs` on the existing wire | yes | 0 |
| **(a) JSON schema over an enum** | **336 / 383 ms** (15) · **394 / 465 ms** (40) | 40 measured; schema grows the prompt 18% | none — a label, no probabilities | none | none — `completeJson()` already sends it | yes | 0 |
| (a) on Apple FM | 497 ms p50 (PoC-19, 3-field schema) | ~40 field ceiling | none | none | none | yes | 0, **and ~0 resident memory** |
| **(d) GLiClass / ONNX in Node** | not measured | any | per-label scores | none (zero-shot) | **301 MB native + `sharp`** + third-party ONNX export | yes | 0 |
| **(c) fastText / SetFit** | not measured | any | per-label scores | needed | archived upstream; 2019 native binding; **Python to train** | yes | 0 |
| **Nimble** | 444 / 981 ms (their M5 Pro) | ≤26 | full distribution | none to use; theirs is 2,676 ex. | **Python + PyTorch/MLX + ~18 GB**, **repo unlicensed** | yes | 0 |
| **TypeSafe Jev** | not measured; "adding questions barely changes the response time" | ≤255 | full distribution + confidence | none | `@typesafe-ai/sdk` (JS, Node ≥ 20) | **no** | \$0.042/Mtok in, output free |

**Cold start is the number that does not appear and should.** 29.5 s for LM
Studio's first request today; PoC-16 measured 5.7 s for `gemma4:e4b` if evicted
and recommended `keep_alive`. Apple FM has none — the model is a resident
system daemon, "Cold start is a non-event (first call 0.33 s)"
(`docs/poc/RESULTS.md:821`). On the composer's hot path, a classifier that is
sometimes 30 s is worse than no classifier, and that is a deployment
requirement rather than a model choice.

---

## 3. The invariant question, answered honestly

### 3.1 This half has been tested before, and the invariant stood

**PoC-15 (2026-08-28) evaluated precisely the forbidden version** —
`docs/poc/RESULTS.md:616-665`, titled "complexity-tier scorer (invariant 4
evaluation)":

> Evaluates the user-proposed amendment to invariant 4: a model scoring input
> complexity to pick among user-configured tiers (cheap/standard/deep).

Apple FM was rejected outright ("its `cheap` class functionally does not exist
(0/16 across two greedy runs)"), Haiku passed at 91.7% with caveats, and the
disposition was:

> **invariant 4 stands for now**; defensible interim is default-standard +
> explicit user escalation. Amendment proceeds only if a confirmatory eval
> passes: bare Messages-API Haiku (no tools), fixtures authored independently
> of the rubric, ≥50 deep items.

**PoC-16 (same day)** found a local model that beat Haiku —
`gemma4:e4b-it-qat` at 97.9%, warm p95 667 ms, $0/verdict — and **did not move
the disposition** (`:711-716`):

> the fixtures are still author-aligned with only 16 deep items — 97.9% here is
> not 97.9% in production. The invariant-4 amendment still waits on the
> independent confirmatory eval.

So: **the confirmatory eval has not run, and the amendment is not granted.**
Anything in this proposal that looks like tier selection inherits that
unfinished decision rather than routing around it.

The good news is that **the owner's ask is not that ask.** PoC-15 asked a model
to decide *how much compute to spend*. The brief asks a model to decide *what
the user meant*, from a list the product maintains. Those are different
questions with different blast radii, and §3.2 is about keeping them different
in the code as well as in the prose.

### 3.2 The shape that keeps invariant 4

The distinction the brief draws is the right one and it survives scrutiny:

- **Naming an action from the closed enum is not routing.** `capture` versus
  `task_update` is a statement about the user's sentence. It selects no model,
  spends nothing, and lands on a surface where the consequence is already
  gated (§3.3).
- **Saying "escalate to the big model" is routing**, whoever says it, and
  whatever it is called.

**The proposal, stated as three properties a reviewer can check:**

> **P1 — The classifier emits a fact, never a destination.** Its entire output
> is `{intent, confidence, compound, alpha}` where `intent ∈` a closed enum
> shipped in `packages/core`. It contains no tier name, no model name, and no
> field that could hold one. `Route` (`router.ts:24-27`) is not extended.
>
> **P2 — The rules consume the fact.** `rules.yaml` grows a clause vocabulary
> alongside `match:` — something like
> `- when: { intent: task_create, confidence: ">= 0.8" }` → `query:` or
> `tier:`; and the catch-all
> `- when: { confidence: "< 0.8" } → tier: default`. The thresholds land in a
> **§4.7 protected path — the owner's own hand**: the instance's file is
> `.metistry/rules.yaml` (`packages/core/src/instance-layout.ts:40`) and
> everything under `.metistry/` except `state/` is protected
> (`apps/reconciler/src/paths.ts:29-36`, "the user's hand only […] it is a
> PLACE"). The file is loaded by a zod schema that fails at load rather than
> per message (`router.ts:29-35`).
>
> **P3 — No classifier verdict can reach a tier the rules did not already
> name.** `route()` returns the same three kinds. A classifier that failed,
> timed out or was never configured produces **no fact at all**, and the rules
> fall through to `default` exactly as today. Absent must be indistinguishable
> from today's behaviour, and a test must say so.

Under P1–P3, **the model supplies a feature and the rules make the decision**,
which is the same relationship `fast_path`'s regexes already have with the
message text: the text is a fact; the rule decides.

**Is this a real distinction or a lawyer's one?** Honestly: it is real, but it
is *thinner* than the one between today's router and PoC-15's scorer, and it
should be ratified rather than assumed. The strongest argument for it is that
an identical structure already ships: `inbox-drain` lets an on-device model
supply `category`, and **deterministic code decides what happens** — including
deliberately ignoring the model's `has_action` (`run.ts:110-142`). The
strongest argument against it is that a threshold is a dial, and a dial that
routes cheap-versus-expensive work is a router however it is spelled.

**Recommended ruling for the owner to give or refuse, in one sentence:**

> *A classifier verdict is a fact on the message, like its text; the router's
> rules may read it as they read the text; a rule, in a file only the owner
> writes, is the only thing that may name a tier — and invariant 4's wording
> should be amended to say "no model decides which model to use; a model may
> supply a feature a rule reads" rather than left to be read that way.*

**This should be ratified explicitly**, for two reasons. The first is
PoC-15/16: the amendment process for invariant 4 has a stated bar and an
unfinished eval, so an implicit second amendment arriving through a different
door would be exactly the drift that process exists to prevent. The second is
that it changes what `rules.yaml` *is*: today a regex file anyone can read
aloud; after this, a file with probability thresholds in it. That is a real
increase in what the owner has to understand to own the routing, and it is
worth agreeing to on purpose.

**If the owner refuses**, the fallback is still worth building: the classifier
runs on the **capture and action** paths only (§4.1), never on the composer's
tier decision, and invariant 4 is untouched because nothing it emits is read by
`route()` at all. That is a smaller product and a clean one.

### 3.3 Invariant 10: the classifier names, and never invents

Invariant 10 says the console's mutating surface is a closed, enumerated set of
actions, and `actions.ts:16-19` already enforces the enum in code. The
classifier's relationship to it, in four rules:

1. **The enum ships in `packages/core` and the classifier is handed it.** It
   cannot be a prompt string, a config line, or anything an instance edits
   loosely — "a new action is a product change, never a prompt or a config
   line".
2. **Its output is re-validated after the model speaks**, exactly as
   `inbox-drain` re-checks `FM_CATEGORIES` despite `strict: true`
   (`run.ts:235`). An intent outside the enum is **not a fact**; it is a
   discarded verdict and a fall-through to the rules.
3. **Naming an action is not performing one.** Everything downstream is
   unchanged: `effectiveActions()` clamps to the autonomy ceiling
   (`actions.ts:175-184`), `dispatch` stays `propose` even at
   `act_within_scope` (`:157-161`), and the proposal still waits for a click.
   The classifier at most **pre-fills a card the owner approves** — which is
   what `suggestedWork()` already does for captures, and §4.12's
   "never auto-creates" governs it.
4. **Compound is a fact, not a decision.** `compound: true` says "this sentence
   asks for more than one thing"; a rule decides that compound goes to the
   default tier. The classifier never decomposes, never emits a list of
   actions, and never picks one of them. Today's 4B model got `compound` wrong
   on the one compound message in the set (§2.3), which is an argument for the
   rule being "compound ⇒ escalate" rather than for trusting the field.

### 3.4 What the audit has to carry for this to be reviewable

Not optional, and cheap (§4.3): every verdict — including the discarded ones —
lands where a human can read it back. If a verdict is not in the log, the
classifier is unreviewable, and an unreviewable component in front of the
composer is a worse trade than the latency it saves.

---

## 4. Where it plugs in

### 4.1 The input path, in order of how much invariant argument each door costs

| door | file | what a classifier would add | invariant cost |
| --- | --- | --- | --- |
| **capture → inbox-drain** | `collectors/inbox-drain/run.ts:249` | a richer enum than the current five; the `intent` fact on the proposal | **none** — the tier exists and is ruled on (2026-09-01) |
| **an `action` proposal's pre-fill** | `packages/core/src/actions.ts:34` | suggest `kind` + `args` for the owner's card | **none** — the click is still the decision (§3.3.3) |
| **the Mac app's quick-add task mode** | `docs/product/daily-flow-spec.md:114`; `packages/core/src/task-line.ts` (P1-1) | "is this a task, and what are its fields" | **low** — a writer, not a router; the `^mt-` id is still minted at creation |
| **the composer → router → tier** | `apps/console/src/router.ts:65-72` | the `{intent, confidence}` fact the rules read | **this is the one §3.2 is about** |

**The obvious sequencing is right to left.** The first two doors need no ruling
at all and can be built while §3.2 is being decided. That is what makes the
phasing in §5.2 low-risk: phase 1 can ship into capture, and only phase 2 needs
the composer.

### 4.2 `where:` is structured generation, not classification — and the brief is right to say so

`packages/core/src/task-filter.ts` compiles `where: "due <= today or overdue"`
into **bind params of one named query** (`:9-13`). Its vocabulary is closed:
twelve fields (`:186-188`), seven flags (`:192-194`), six operators (`:198`),
five statuses (`:202`). It is never escaped, never interpolated, and refuses
anything outside the vocabulary (`:429-433`, plus a 400-character ceiling at
`:217`).

Turning *"show me Jim's tasks for our 1:1"* into
`assigned:[[Jim Fallon]] status:open` is **not a choice from a list** — it is
generating a string in a grammar, with an entity resolution
(`Jim` → a `People/` page) in the middle. That is candidate (a) territory
(JSON Schema over `{field, op, value}[]`), not candidate (a′) territory, and it
is a **different project** with a different failure mode: a wrong intent shows
the owner the wrong card, a wrong `where:` shows the owner the wrong tasks and
looks right.

Three things make it *safer* than it sounds, and worth doing later: the parser
is a closed gate that refuses rather than guesses, the refusal is already a
rendered user-visible line (`docs/ops/automation.md:229-232`), and the
round-trip property ("a view the user builds in the app can be pasted into a
template and back", `task-filter.ts:4-7`) means a generated `where:` is
**editable** — the owner sees the filter, not just its results.

**Recommendation: out of scope for PoC-20.** Name it as the natural phase-4
follow-on, gated on the intent tier working, and on it being generated **into
the chip UI for confirmation**, never executed silently.

### 4.3 The audit trail

Two rows already exist and need only fields:

- **`inbound_messages.meta`** already carries the whole routing decision
  (`server.ts:618-621`). The classifier's verdict belongs beside it as
  `meta.intent = {intent, confidence, compound, alpha, model, provider, ms}`
  — durable **before** the 202, like the route.
- **`runs`** already has `component`, `kind`, `provider`, `model`, `ok`,
  `meta` jsonb and token/cache columns (`packages/core/src/runs.ts:9-35`), and
  the fast path already opens one with `meta.routed_by` (`server.ts:671-676`).
  A classifier verdict is a `kind: "classify"` row with the same shape, which
  makes "what did the classifier say, and what did the rules do about it" one
  named query away — and invariant 3 says it must be a named query.

**Three properties to hold, each learned from something already in the repo:**

1. **Log the discarded verdicts too.** A verdict below threshold is the most
   interesting row in the table — it is the training set for phase 3 and the
   evidence for moving a threshold.
2. **`ok` is "the classifier answered", not "the classifier was right."**
   Conflating them makes the watchdog's error rate meaningless.
3. **A never-firing tier must be visible.** `compute.yaml`'s existing
   `fm-tier-never-fires` watchdog probe (`docs/ops/compute.md:865`) is the
   precedent: "configured but never used" should be a row, not a silence.

**On D6 (the durable set):** a classifier verdict is derived. It is a `runs`
row and a `meta` key on a message; rebuild from the repo and re-run and you
lose the history and nothing else. Noted only because D6 is open.

### 4.4 The eval, and the bar

**The fixtures are the owner's, and nothing else will do.** The harvest path is
`<instance>/.metistry/eval/fixtures-harvest.jsonl`
(`docs/plan-refresh-2026-09-13.md:401-402`; **not read here**). C11 forbids
Claude-authored expected answers (`:40`; `packages/eval/src/fixtures.ts:14-20`),
and that plainly covers labels as well as text — which is why every accuracy
figure in §2 is marked illustrative and why none of them may be reused.

**What to add to `packages/eval`, smallest first:**

1. A sixth axis, `intent`, in `AXES` (`src/fixtures.ts:25`) and in
   `DETERMINISTIC_AXES` (`:29`) — scored in code against a label, so no judge
   is needed and a run costs nothing.
2. `expected.intent` (and optionally `expected.compound`) on the fixture
   schema, with the same one-axis-per-fixture enforcement the validator already
   applies (`:128-143`).
3. A `confidence` column on `RunRecord` (`src/record.ts:69-104`), nullable,
   `null` meaning "this technique produces none" — the same
   `null`-versus-`0` discipline the six trace columns already use (`:66-67`).
4. Nothing else. `Candidate.server` already spans the three local servers
   (`:29`), `latency_ms` and `ttft_ms` already exist, and the matrix is already
   a matrix.

**The bar, pre-registered before any run so the result cannot be read to
taste:**

| | threshold | why this number |
| --- | --- | --- |
| **accuracy on the closed set** | **≥ 95%** of the owner's labelled fixtures, excluding cases whose gold label is `unsure` | the brief's figure; also roughly where PoC-16's 97.9% sat on a task of similar shape |
| **latency** | **p50 < 150 ms, p95 < 400 ms**, warm | §2.4 measured 155/166; the p95 headroom is for a cascade past 26 intents (§2.4) |
| **cold start** | **< 1 s**, or the tier does not run on the composer path at all | 29.5 s was measured today (§2.3); `keep_alive`, or Apple FM's residency, or no tier |
| **escalation is honest** | on cases whose gold label is `unsure`, **≥ 90%** fall below the threshold | the tier's whole purpose is knowing when not to answer |
| **confident errors** | **≤ 2%** of fixtures wrong *above* the threshold | the single worst failure mode; §2.4 produced one in ten at conf 0.850 |
| **absent degrades** | with no local provider, **byte-identical routing to today** | P3 of §3.2, as a test not a promise |

**The threshold itself is an output of the eval, not an input.** Sweep it over
the fixture set and pick the point that satisfies rows 4 and 5 together; a
threshold chosen before seeing the data is the mistake Nimble's README warns
about in as many words (§2.1).

**One more axis worth a column: stability.** PoC-19 measured twenty identical
Apple FM generations producing twenty distinct byte strings and one value
(`docs/poc/RESULTS.md:832-834`), and PoC-16 measured its winner "100%
deterministic across three runs". At `temperature: 0` with one scored token
this should be exactly reproducible; if it is not, that is a finding.

---

## 5. Recommendation

### 5.1 The decision table

| | decision | why | effort |
| --- | --- | --- | --- |
| **Adopt Nimble** | **No** | The GitHub repository has **no licence** (`"license": null`, 2026-09-21) — a hard stop for a fully-open-source product before any technical argument. Then: Python 3.12 + PyTorch/MLX (banned), ~18 GB unquantised weights, no JS client, 2,676 training examples "don't expect a lot of generalization", and its own **444 ms median on an M5 Pro** against 155 ms measured here with no new dependency | — |
| **Adopt its *technique*: answer-token scoring** | **Yes — this is the recommendation** | Measured today on Ollama's `/v1` (and the field shape confirmed on the bundled `llama-server`, which had only a toy model loaded): `max_tokens:1, logprobs:true, top_logprobs:20` gives the full distribution over a closed alphabet at **p50 155 ms / p95 166 ms**, 2.2× faster than the JSON-schema route on identical weights. Zero new dependencies — it is fields on a request `completeJson()` already makes | PoC-20 phase 1, **2–3 days** |
| **Adopt TypeSafe Jev in production** | **No** | Hosted-only ⇒ `locality: off_machine` for a component that would see **every composer message** before any data policy applies; ZDR is enterprise-only. ~100 ms of latency is not worth the widest `data_policy` in the file against a 155 ms local option | — |
| **Use Jev as a *cloud arm in the bake-off*** | **Owner's call — it is his messages** | Finds the accuracy ceiling cheaply (\$0.042/Mtok in, output free); a real TS SDK exists; `Candidate.server` already admits it. But the fixtures are the owner's own text leaving the machine | ~half a day if the answer is yes |
| **Reuse TypeSafe's published confidence statistic** | **Yes, and cite it** | `(n·peak − 1)/(n − 1)` clamped to [0,1] — a statistic over a distribution, published openly in the docs page's own `ConfidenceExplorer` source, not a licensed artefact. One line of TypeScript over a distribution we already get. Used unchanged in every measurement above | ~0 |
| **JSON schema over the intent enum (candidate a)** | **Yes — as the fallback arm, not the first** | Works on **all four** local servers including Apple FM (the free, resident, zero-extra-memory one) and is the only route that can carry `compound`, `args`, or anything that is not a single label. Costs **336 ms** where a′ costs 155 | PoC-20 phase 2, **1–2 days** |
| **Embeddings + a trained head (candidate b)** | **Later — gated on the fixture harvest** | **9 ms p50** on the embedder already running, and the only candidate that improves from the audit log. Zero-shot over descriptions was measured at 4/10 with 0.005–0.083 cosine margins, so it is not a starter | PoC-20 phase 3, **2 days after fixtures exist** |
| **fastText / SetFit (candidate c)** | **No** | Upstream **archived** 2024-03-22; the Node binding last published **2019-07-17** as a `node-pre-gyp` native addon; training is Python | — |
| **GLiClass / NuExtract via ONNX (candidate d)** | **No, and it is the closest call** | **301 MB** of native `onnxruntime-node`, plus `sharp` via transformers.js, plus a dependence on third-party ONNX exports of first-party weights — to replace a feature of a server we already ship and measured at 155 ms | — |
| **More `fast_path` rules (candidate e)** | **Yes, and measure their coverage first** | One line of YAML each, no model, and they appear in `GET /api/commands` automatically. If phase 0 says most real input is already a near-command, the later phases get smaller | PoC-20 phase 0, **half a day** |
| **`where:` generation from natural language** | **Out of scope; name it as phase 4** | Structured generation, not classification, with a failure mode that *looks right* (§4.2). Gated on the intent tier working, and on generating **into the filter chips for confirmation** | — |
| **Amend invariant 4's wording** | **Owner's ruling required before any composer-path work** | §3.2's P1–P3 keep the decision in `rules.yaml`, but PoC-15/16 left an amendment process open with an unfinished bar, and a second amendment should not arrive through a side door | — |
| **Refuse `logprobs` by name in the apple-fm `/v1`** | **Yes — a one-line bug** | `v1.ts:100-102` refuses `stream`/`tools`/`n` by name; `logprobs` is silently ignored, which contradicts `docs/ops/compute.md:792` | ~an hour, its own PR |

### 5.2 PoC-20 — the phased plan

**On the number: the brief proposes PoC-19, and PoC-19 is taken.** It is the
Apple FM `/v1` PoC, passed 2026-09-16, written up at `docs/poc/RESULTS.md:777`
with artifacts in `docs/poc/poc19-apple-fm-v1/`. **The next free number is
PoC-20**, used throughout.

---

**Phase 0 — measure the baseline (half a day). Gates everything.**

How much does today's rules-only router already catch? One named query
(invariant 3) over `inbound_messages.meta.route`: the share of real messages
that took `note`, `fast_path`, an `override`, or fell through to `default`;
and among the fall-throughs, the distribution of length and first word.

*Exit:* a number. **If fall-through is under ~40%, stop and write `fast_path`
rules instead** — an extra regex is free, auditable, and self-documenting in
the command menu. **The owner runs this: it needs the instance's database,
which this research did not touch.**

---

**Phase 1 — answer-token scoring through the existing compute layer (2–3 days).
No new dependency.**

- `scoreChoice()` beside `completeJson()` in `collectors/compute-client.ts` —
  same URL, same provider resolution, same on-machine money rule, different
  request fields (`max_tokens:1, logprobs:true, top_logprobs:N`,
  `reasoning_effort:"none"`), and TypeSafe's confidence statistic over the
  renormalised alphabet. Reuses `scrubLeaves()` for anything textual
  (`:180-187`).
- The intent enum as a `packages/core` constant beside `ACTION_KINDS`, with the
  letter-code mapping generated, never hand-maintained.
- Wire it to **capture first** (`inbox-drain`'s fall-through branch), which
  needs **no invariant ruling at all** (§4.1) and where a wrong verdict costs a
  mislabelled proposal card.
- Per-server reasoning suppression, tested on all three: Ollama `/v1`
  (`reasoning_effort:"none"` — verified), `llama-server`
  (`chat_template_kwargs:{"enable_thinking":false}`), LM Studio (**verify;
  today it returned `"logprobs": null`, so it may be schema-only**).
- Degradation test: **no provider ⇒ byte-identical behaviour to today.**

*Exit:* the §4.4 bar, on the owner's fixtures. **If phase 1 passes, this is the
product** and phases 2–3 are optional.

---

**Phase 2 — the JSON-schema arm, and the composer door (1–2 days). Needs the
§3.2 ruling.**

Only if phase 1 misses the bar, or the owner wants `compound`/`args`, which one
scored token cannot carry.

- `completeJson()` against an intent schema — **no new code at all**, just a
  schema constant and a caller.
- The Apple FM arm, which is the one that works on a Mac with no other server
  and no extra resident memory.
- The `rules.yaml` `when:` clause vocabulary (§3.2 P2), in the same zod schema
  that already fails at load (`router.ts:29-35`), with a misuse test: **a rules
  file whose `when:` names an intent outside the enum must fail at load, not
  per message.**
- Cascade if the enum passes 26: group token, then member token.

---

**Phase 3 — embeddings, once fixtures exist (2 days).**

- Labelled centroids or a logistic head over the 768-dimension
  `nomic-embed-text` vectors the vault already stores. No new dependency; a
  logistic regression is arithmetic.
- **The bar is §2.5's run**: beat 4/10 at 9 ms, on the owner's labels.
- Retrainable from the audit log as the owner corrects verdicts — the property
  no other candidate has.

---

**Phase 4 — `where:` generation (not scoped here).** §4.2.

**Only if all of phases 1–3 miss the bar** does an external candidate get
proposed, and the order would be: **GLiClass via ONNX** (Apache-2.0 weights,
301 MB native dependency, a third-party export to vet), then **Jev as a paid
off-machine tier** (a `data_policy` argument the owner has to win), and **never
Nimble** while its repository is unlicensed. Each would arrive as its own PR
with the dependency stated in the first paragraph, per CLAUDE.md.

### 5.3 What needs the owner

| | what | why it cannot be done here |
| --- | --- | --- |
| **The phase-0 number** | run the fall-through query against the instance | needs the instance's database; this research did not touch it |
| **Fixtures** | ~150–300 of his own messages, labelled with the intent enum, including ~20 deliberately `unsure` | C11: a label I wrote is Claude output and may never be an expected answer. PoC-15's caveat — "fixtures and rubric shared an author" — applies doubly here |
| **The §3.2 ruling** | amend invariant 4's wording, or confine the classifier to capture + actions | an invariant is the owner's; and PoC-15/16 left an amendment process open with a stated bar |
| **A resident local model on the second instance** | `gemma4:e4b-it-qat` (6.3 GB) via Ollama with `keep_alive`, **or** the bundled `llama-server` with a small GGUF, **or** accept Apple FM's 497 ms and the schema-only route | 29.5 s cold start was measured today; the composer's hot path cannot absorb it |
| **The Jev bake-off arm** | yes or no to his own messages reaching a hosted API for a measurement | it is his text |
| **The intent enum itself** | which ~20–40 intents an instance maintains | invariant 10 territory: a new one is a product change, not a config line |

---

## 6. Open questions (the owner's)

1. **Is §3.2's reading of invariant 4 ratified — and if so, is the invariant's
   *wording* amended to say it?** The whole composer-path half turns on this.
   PoC-15/16 left an amendment process open with a stated bar that has not been
   met, so an implicit amendment arriving through a different door is exactly
   what that process exists to prevent. A refusal is a clean answer: the
   classifier lives on capture and actions only, and invariant 4 is untouched
   (§3.2, §4.1).
2. **Does the phase-0 number make most of this unnecessary?** If real input is
   already 60%+ commands and near-commands, more `fast_path` regexes are
   cheaper, faster, perfectly auditable, and self-documenting in the menu. This
   is the only question that could cancel the project, and it is one query
   (§5.2 phase 0).
3. **May the owner's own messages reach TypeSafe for a bake-off arm?** It is
   the cheapest way to learn what the ceiling is — \$0.042/Mtok in, output free
   — and it is his text leaving the machine for a measurement, not a product
   path (§2.2).
4. **Where does the intent enum live, and who may grow it?** `ACTION_KINDS` is
   a product change by design (`actions.ts:16-19`). An *intent* enum is more
   instance-shaped than an *action* enum — different people want different
   verbs — and the two obvious answers (a `core` constant, versus
   `rules.yaml`) have opposite invariant-10 stories (§3.3, §5.3).
5. **Is a 30-second cold start acceptable anywhere on the input path, and if
   not, which of the three fixes?** `keep_alive` on a 6.3 GB resident model;
   the bundled `llama-server` holding a small GGUF; or Apple FM's residency at
   497 ms and schema-only (no logprobs). This is a deployment decision that
   changes which candidate wins (§2.9, §5.3).
6. **Does a classifier verdict join the durable set (D6)?** I read it as
   derived — a `runs` row and a `meta` key, rebuildable by re-running. But
   phase 3 wants the *corrected* verdicts as training data, and a training set
   that dies with `docker compose down -v` is a different proposition from one
   that does not (§4.3).

---

## Contradictions with the brief and the plan

Reported, not routed around (CLAUDE.md).

1. **PoC-19 is taken.** The brief proposes "PoC-19?"; PoC-19 is the Apple FM
   `/v1` PoC, passed 2026-09-16 (`docs/poc/RESULTS.md:777`, artifacts in
   `docs/poc/poc19-apple-fm-v1/`). **The next free number is PoC-20**, used
   throughout.
2. **`POST /capture` and inbox-drain are no longer "deterministic, model-free".**
   The brief says they are. `collectors/inbox-drain/run.ts:249` has sent
   rules-fall-through rows to an on-device model since the compute refresh, and
   the manifest pins `uses_model: applefm/foundation-model`. This is a
   *correction in the project's favour* — the pattern being asked for is
   already shipped and ruled on (2026-09-01) — and it is why the effort
   estimates in §5.2 are days rather than weeks.
3. **A small gap in `packages/mcp-apple-fm/src/v1.ts`, reported not fixed.**
   `logprobs` is silently ignored rather than refused by name like `stream`,
   `tools` and `n` (`:100-102`), which contradicts `docs/ops/compute.md:792`'s
   "What it refuses, loudly, rather than degrading". One line; its own PR.
4. **No contradiction with `metistry-build-plan.md` was found**, and it was not
   edited.

---

## Sources

Fetched 2026-09-21 unless noted; dates are the publishers'.

- [bespokelabsai/nimble README](https://github.com/bespokelabsai/nimble) — repo created 2026-09-18, last push 2026-09-20, 1,218 stars, `"license": null` via `GET /repos/bespokelabsai/nimble` and `404` from `GET /repos/…/license`. Python 3.12 + PyTorch 2.8.0 + MLX; ~18 GB unquantised; 2,048-token prompt limit; enum fields "1 to 26 string choices"; one-token answer codes scored from logits; 2,676 training examples; latency table (Bespoke-Nimble-9B **444.0 ms median / 981.0 p95** on "M5 Pro 64GB", 106.0 ms on H100; Jev 1.13.0 246.7 ms; Gemma 3 270M IT 21.8 ms on H100); agreement table on 324 synthetic held-out examples (Nimble 90.12%, Jev 93.21%, Qwen3.5-9B 66.36%).
- [huggingface.co/bespokelabs/Bespoke-Nimble-9B](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B) — model card, `license: apache-2.0`, LoRA adapter ~165 MiB over `Qwen/Qwen3.5-9B`; the weights are licensed even though the serving repo is not.
- [huggingface.co/Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) — `license: apache-2.0`.
- [TypeSafe — Choice](https://docs.typesafe.ai/primitives/choice), [System One](https://docs.typesafe.ai/concepts/system-one), [Confidence](https://docs.typesafe.ai/confidence), [Intent routing](https://docs.typesafe.ai/patterns/intent-routing), [Models](https://docs.typesafe.ai/models), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) — hosted `POST /v1/systemone`; `npm install @typesafe-ai/sdk` (Node ≥ 20, ESM + CJS + `.d.ts`); Jev 1.13 at **\$42/Btok, \$0.042/Mtok input, output free**; 64k context (32k for `state` + longest question); up to 255 options; 250k tok/s + 1,200 req/min, "can change without notice"; "Jev is not trained on customer requests or responses", ZDR "for enterprise customers"; the three-band confidence doctrine and the `(n·peak − 1)/(n − 1)` statistic in the `ConfidenceExplorer` source.
- [llama.cpp `tools/server/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) — `grammar`, `json_schema` ("Set a JSON schema for grammar-based sampling"), `json_schema_file`, `logit_bias`, `n_probs` ("the response also contains the probabilities of top N tokens"), `completion_probabilities`/`top_logprobs`; `/v1/chat/completions` `response_format` supports `{"type":"json_object"}` and `{"type":"json_schema", "schema": …}`; `chat_template_kwargs` e.g. `{"enable_thinking": false}`.
- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md) — "Structured outputs are supported by providing a JSON schema in the `format` parameter"; `format: "json"` for JSON mode.
- `npm view` on 2026-09-21 — `onnxruntime-node@1.30.0` MIT, `dist.unpackedSize` **301,068,136 bytes**; `@huggingface/transformers@4.3.0` Apache-2.0, depends on `onnxruntime-node`, `onnxruntime-web`, `sharp`; `fasttext@1.0.0` MIT, **published 2019-07-17**, modified 2022-06-17, deps `node-addon-api` + `node-pre-gyp`.
- [facebookresearch/fastText](https://github.com/facebookresearch/fastText) via `gh api` — `"archived": true`, last push **2024-03-22**, MIT, 26,530 stars.
- Hugging Face API, 2026-09-21 — `knowledgator/gliclass-modern-base-v3.0` Apache-2.0, 5,644 downloads, last modified 2025-08-12, ships `model.safetensors` (no first-party ONNX); third-party exports `cnmoro/gliclass-{edge,base,large,modern-large,x}-*-onnx`.

Measurements were taken on this Mac (M4 Max, 64 GB, macOS 26.4/25E246) on
2026-09-21 against LM Studio `:1234` (`google/gemma-4-e4b`), Ollama `:11434`
(`gemma4:e4b-it-qat`, `nomic-embed-text`) and the bundled `llama-server`
`:7813`. Harness scripts were scratch files and are not committed; every
command's output is quoted verbatim above.

Repo facts cite the file and line. Prior art this builds on rather than
repeats: `docs/poc/RESULTS.md` §PoC-15 (the invariant-4 evaluation and its
unfinished amendment), §PoC-16 (local scorers; "reasoning hurts this task,
measured"; the Ollama `/v1` `think` gotcha), §PoC-19 (Apple FM's runtime JSON
schemas, 497 ms for a three-field classification, unstable key order);
`docs/research/2026-09-17-bakeoff-candidate-survey.md` (the local model
shortlist); `docs/research/2026-09-19-daily-flow-and-tasks.md` and
`docs/product/daily-flow-spec.md` (quick-add, the task grammar, the filter
language).
