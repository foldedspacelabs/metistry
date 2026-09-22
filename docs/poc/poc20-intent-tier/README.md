# PoC-20 phase 1 — an answer-token intent tier at the capture door

The design is `docs/research/2026-09-21-intent-classification-tier.md`
(approved 2026-09-22); this directory is where the measurement runs.

**Phase 1 is built. It has not been measured, because the measurement needs
fixtures only the owner can write.** What has shipped is the scorer, the
enum, the wiring at the capture door, the audit, the thresholds' home in
`rules.yaml`, and the harness that fits the threshold. What has not: a single
accuracy number, because C11 forbids a Claude-authored label as an expected
answer and there is no honest way around that.

| where | what |
|---|---|
| `packages/core/src/choice.ts` | the technique: one scored answer token over a closed letter alphabet, renormalised, with TypeSafe's confidence statistic. Per-server request shapes, each one measured. |
| `packages/core/src/intent.ts` | the closed intent enum with a description each, the prompt, the deterministic out-of-distribution guard, and `rules.yaml`'s `intent:` schema. |
| `collectors/compute-client.ts` | `scoreChoice()`, beside `completeJson()`: the same provider resolution and the same money rule, different request fields. |
| `collectors/inbox-drain/intent-tier.ts` | the RULE code — the intent → proposal-kind table and the threshold check. The only reader of a verdict. |
| `packages/eval` — `metistry-eval intents` | scores the owner's labelled messages, reports accuracy/ECE/latency, and **fits** the threshold. |
| `intents.example.jsonl` | the fixture format. **Empty, deliberately** (see below). |
| `docs/poc/RESULTS.md` §PoC-20 | the write-up, once there is a measurement. |

---

## What it does, in one paragraph

A capture the deterministic rules could not place is sent to a local model as
one question — *which line below describes what this message says?* — with
sixteen lettered descriptions. The model is allowed to produce **one token**.
We read the returned `top_logprobs`, renormalise over the sixteen letters, and
compute a confidence. That is the whole model tier: about 150–300 ms, no JSON
to parse, no generation to validate. What happens next is **not** the model's:
a table in `intent-tier.ts` says which intents justify which proposal kind, and
a threshold in the owner's own `rules.yaml` says how sure the model has to be.
Below it, or for an intent that says nothing about a capture's category, the
verdict is recorded and the drain carries on exactly as it did before.

## Turning it on

Two files have to agree, because they are two different decisions.

**1. `compute.yaml` — which model** (an operator's choice; must be on-machine,
and the schema refuses anything else at load):

```yaml
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
  intent:  { model: ollama/gemma4:e4b-it-qat }
```

**2. `.metistry/rules.yaml` — how sure it has to be** (the owner's own hand; a
§4.7 protected path):

```yaml
intent:
  min_confidence: 0.80
  by_intent:
    task_create: 0.90
```

Either one alone does nothing. With neither, the drain is byte-identical to
the build before this existed — there is a test that asserts exactly that.

## The fixtures are yours, and the example is empty on purpose

`<instance>/.metistry/eval/intents.jsonl`, one JSON object per line:

```json
{"text": "remind me to call the dentist tomorrow", "intent": "task_create"}
{"text": "still not sure what to do about the reconciler", "intent": "unsure", "compound": false}
```

| field | |
| --- | --- |
| `text` | the message, exactly as you wrote it |
| `intent` | one of this build's intents (`metistry-eval intents` lists them in any error) |
| `compound` | optional: does the sentence ask for more than one thing? **Phase 1 cannot predict this** — one scored token carries one answer — so it is collected now and scored by phase 2. Labelling it while the message is in front of you is free; going back for it is not. |
| `id`, `notes` | optional, and only so a report row can be found again |

Lines starting `#` and blank lines are ignored, because you are writing this by
hand.

**Claude may not write these labels.** C11 forbids Claude output as training
data or as an expected answer, and a label is exactly that. Every accuracy
figure in the research note is marked illustrative for the same reason, and
none of them may be reused. So the file that ships here is **empty**, and the
harness refuses an empty file by name rather than reporting 0/0 as a pass.

**How many:** ~150–300, including **~20 deliberately `unsure`** — messages
where you genuinely could not say. Those twenty are not padding: §4.4's fourth
bar row is about them, and without them the fit cannot tell a confident
classifier from a reckless one.

## Measuring it

```sh
pnpm -r build
node packages/eval/dist/main.js intents <instance>/.metistry/eval/intents.jsonl \
  --base-url http://127.0.0.1:11434/v1 --model gemma4:e4b-it-qat --server ollama --fit
```

`--phrasings` runs the same fixtures under all three question wordings and
reports which did best on YOUR messages — the trial §5.2 phase 1 asks for, and
the one the research could not do because its own arms differed on it (the
answer-token run used bare intent names; the embedding and Laya runs used
descriptions). `--server` matters: it decides the request shape, and the three
servers do not agree (below).

## The bar (§4.4, pre-registered before any run)

| | threshold |
| --- | --- |
| accuracy above the threshold | **≥ 95%**, excluding fixtures whose gold label is `unsure` |
| latency | **p50 < 150 ms, p95 < 400 ms**, warm |
| cold start | **< 1 s**, or the tier does not belong on a hot path |
| escalation is honest | on gold-`unsure` fixtures, **≥ 90%** fall below the threshold |
| confident errors | **≤ 2%** of fixtures wrong *above* the threshold |
| absent degrades | with no local provider, **byte-identical** behaviour — shipped, and a test |

`INTENT_BAR` in `packages/eval/src/intents.ts` is that table in code, so a
result cannot be read to taste.

**On the fit, and a gap in the source.** The brief asks for "the threshold that
maximises accuracy at ≥X% coverage". §4.4 states no X. What it states is the
three rows above plus "pick the point that satisfies rows 4 and 5 together", so
the fit takes the thresholds that satisfy **all three** and among them the one
with the **most coverage**. `--min-coverage` exists for an owner who would
rather read it the other way round.

## What was measured on this Mac, 2026-09-22

Read-only probes against the servers already running (M4 Max, 64 GB, macOS
26.4). **Two of these correct the research note, which is why they are here
rather than inherited.**

### 1. LM Studio is NOT schema-only — it needs `max_tokens: 2` and `top_logprobs ≤ 10`

```
lmstudio  top_logprobs=5   max_tokens=1  -> logprobs null, completion_tokens 0
lmstudio  top_logprobs=5   max_tokens=2  -> ('B', -0.375) ('A', -1.125) ('<|channel>', -4.5)
lmstudio  top_logprobs=20  max_tokens=8  -> HTTP 400 "top_logprobs must be less than or equal to 10"
lmstudio  top_logprobs=20  max_tokens=1  -> HTTP 200, logprobs null   ← the 400 is swallowed at max_tokens 1
```

The research measured `logprobs: null` at `max_tokens: 1` and again at
`max_tokens: 8` with `top_logprobs: 20`, and concluded the server could not do
it. Both observations are reproducible; the conclusion is not. At
`max_tokens: 2` with `top_logprobs ≤ 10` the first content token's distribution
comes back exactly as the other two servers give it. **So the answer-token tier
runs on all three local servers that return logprobs at all**, not two, and the
JSON-schema fallback the brief asked for as a contingency is not needed for LM
Studio. Apple FM remains the one that structurally cannot (no per-token
logits), and it is refused by name before a request is built.

### 2. Reasoning suppression on Ollama is load-bearing, not hygiene

```
ollama  (no suppression)          '<|channel>' -0.436   'A' -1.063   'B' -5.559
ollama  reasoning_effort=none     'A' -0.028   'B' -4.139   'D' -5.186
```

Without it the model's most likely next token is the opener of its reasoning
channel, and `alpha` — the share of mass inside the closed alphabet — collapses.
With it, PoC-16 finding 2 is reproduced from the other direction. Sending
`chat_template_kwargs: {enable_thinking: false}` alongside changes Ollama's
answer by nothing (logprobs identical to three decimals), and `llama-server`
accepts both fields too, so the two suppressions are compatible.

### 3. Descriptions cost roughly 1.7× the latency of bare names

Same five messages, same model (`gemma4:e4b-it-qat` on Ollama), same sixteen
intents, three question wordings:

| phrasing | what the model sees | p50 | p95 |
| --- | --- | ---: | ---: |
| `names` | bare intent names — the research's own §2.5 arm | **174 ms** | 181 ms |
| `says` | a description per intent (Laya lesson 1) | **293 ms** | 331 ms |
| `best_fits` | the same descriptions, a different question | **319 ms** | 324 ms |

`names` reproduces the research's 155 ms p50. **The descriptions the research
recommends put the default phrasing over its own p50 < 150 ms bar**, and that
tension is real rather than a measurement artefact: sixteen descriptions are
about twice the prompt of sixteen names. Which one to ship is exactly what
`--phrasings` decides, on fixtures, and it should be decided rather than
assumed. (The accuracy column is deliberately absent here: the labels in that
smoke run were Claude's, so they are not evidence — C11.)

Cold start on Ollama with the model resident but idle: **4.3 s** for the first
call, ~300 ms thereafter. The bar wants < 1 s, so `keep_alive` matters, exactly
as §5.3 says.

## What phase 1 deliberately does NOT do

- **The composer door.** §4.1's fourth row is the one §3.2 is about, and §6
  question 1 is the owner's ruling it waits on. `route()` does not read a
  verdict, `Route` is not extended, and a test greps for both.
- **`compound`.** One scored token carries one answer. The field exists on the
  verdict and in the fixture format so that phase 2's JSON-schema arm can fill
  it without a shape change; phase 1 never sets it.
- **The JSON-schema intent arm** (phase 2) and **embeddings** (phase 3).
- **`where:` generation** — §4.2 is explicit that it is structured generation
  with a failure mode that *looks right*, and it is phase 4 at the earliest.
