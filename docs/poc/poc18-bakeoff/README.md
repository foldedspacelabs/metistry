# PoC-18 — the bake-off

One experiment, three numbers: **which model** the seed ships as `default`,
**which local server** Metistry bundles, and **where the bar is** — Sonnet's
score and cost per turn on the same fixtures. The design is
`docs/plan-refresh-2026-09-13.md` §3; this directory is where it runs.

**This is the harness, not a verdict.** Nothing here has been run against a
model. The fixtures are the owner's to write (§3.8) and the result is the
owner's to rule on; what has shipped is the runner, the fixture format, the
scorers, the judge rule and the report.

| where | what |
|---|---|
| `packages/eval` | the runner — a private, unpublished workspace package (`@metistry-apps/eval`). Fixture schema, scorers, judge, report. |
| `fixtures/` | the fixtures. One EXAMPLE per axis ships here; the owner's fifty go beside them. |
| `runs/` | raw JSONL, one row per case per run, plus a `.meta.json` per run. **Committed** — this is the evidence (poc15/16 precedent). |
| `runs/.transcripts/` | full message histories. **Gitignored**: they are large and can carry vault content. |
| `docs/poc/RESULTS.md` §PoC-18 | the write-up, once there is one. |

---

## Authoring fixtures

### The one rule that is not negotiable

**Claude is the bar, never the source.** No Claude output is a fixture, an
expected answer, a rubric, or training data of any kind — Anthropic's usage
policy forbids using Claude outputs to develop competing models, and a
fixture written by the bar would be the bar marking its own homework besides
(decision C11). The fifty fixtures are **the owner's own words**, rewritten
from the Studio's real history. Sonnet is then run *against* them to set the
reference score, which is the only role it has in this PoC.

The example fixtures in `fixtures/` carry `example: true`. They are format
illustrations written by the harness author, not fixtures: the runner
**skips them** unless you pass `--include-examples`, so they can never
quietly become part of a scored run. Delete them or leave them; either is
fine.

### One axis per fixture

A failure has to name the component to fix, so no fixture mixes two axes.
The schema enforces this — a `tool_calls` fixture carrying a rubric is
refused by the validator, not silently half-scored at run time.

| axis | what it measures | scored |
|---|---|---|
| `tool_calls` | a tool loop over the brain bridge's tools, with correct arguments and no hallucinated tool | in code |
| `stopping` | reading a thread and knowing when to stop — no runaway loops | in code |
| `triage` | judgment: what becomes a proposal, what is noise | rubric |
| `voice` | the voice in `identity.yaml`, held over a long session | rubric |
| `writing` | briefs and folds a person actually reads | rubric |

### The shape

One JSON object per line in a `.jsonl` file (a PoC-15-style
`{"fixtures": [ … ]}` JSON file is read too):

```jsonc
{
  "id": "T07",                       // stable, filename-safe, never reused
  "axis": "tool_calls",              // exactly one of the five
  "prompt": "…",                     // the turn, in your words
  "context": { "thread": "…", "brief": "…" },   // optional, both composed into the turn
  "expected": {
    "tool_calls": [                  // tool_calls axis. [] means "calling nothing is the right answer"
      { "name": "knowledge_write", "args_match": { "path": { "contains": "Knowledge/Areas" } } }
    ],
    "stop_after_turns": 2,           // stopping axis — and it must stop ON ITS OWN inside it
    "rubric": "5 = …  1 = …",        // the three judgment axes, in your words
    "must_include": ["Tuesday"],     // hard gates, any axis, checked before any judge call
    "must_not_include": ["as an AI"],
    "one_of": ["proposal", "noise"]  // at least one of these must appear
  },
  "weight": 1,                       // how much this case counts in its axis's pass rate
  "notes": "why this case exists"    // for the human reading a failure; never sent to a model
}
```

**Tool names** may be bare (`capture`) or qualified (`mcp__brain__capture`) —
they mean the same thing. **Argument matchers** are `{"equals": …}`,
`{"regex": "…"}`, `{"contains": "…"}` or `{"any": true}`; a bare value is
shorthand for `equals`. Only the arguments you name are checked, so a call
with extra arguments still matches. Listing a tool twice means calling it
twice.

Write `args_match` against the **live schema**, not from memory —
`metistry-eval tools` prints it. (`capture`'s argument is `note`, not
`text`.)

### Validate before you spend anything

```
pnpm -F @metistry-apps/eval build
node packages/eval/dist/main.js validate docs/poc/poc18-bakeoff/fixtures/*.jsonl
```

Exits non-zero on any issue, reports every bad row rather than the first, and
prints the per-axis counts so an axis with no coverage is visible.

---

## The judge

Axes `triage`, `voice` and `writing` are rubric-scored, pass at **≥ 4 of 5**,
by a model from a **third family** — neither the candidate's nor the bar's.
The rule is enforced, not documented:

- no judge configured and a rubric fixture selected → **the run refuses to
  start** (`judge_not_configured`). An absent judge fails the run; it never
  passes the cases.
- the judge's family matches the candidate's or the bar's → **the run refuses
  to start** (`judge_same_family`). Family is the segment before `/`, or a
  small map over a bare local id (`qwen3.6:35b-a3b-q4_K_M` → `qwen`);
  `METISTRY_EVAL_JUDGE_FAMILY` overrides it for an id the map cannot place.
- a configured judge that cannot be reached mid-run → **that case fails**,
  with the reason on the row.

```
export METISTRY_EVAL_JUDGE_MODEL=…        # a third family
export METISTRY_EVAL_JUDGE_BASE_URL=…     # any OpenAI-compatible root
export METISTRY_EVAL_JUDGE_API_KEY=…      # where the endpoint needs one
```

A deterministic-axes-only run (`--axis tool_calls --axis stopping`) needs no
judge at all.

---

## Running

The engine is **injected**. `--engine <module>` names a file exporting
`createEngine(ctx)`, which returns a factory taking the per-case recording
tool host:

```js
// stage0-engine.mjs
import { makeOpenAiEngine } from "…/apps/assistant/dist/engine-openai.js";

export function createEngine({ candidate }) {
  return (host) => makeOpenAiEngine({ tools: () => host, sessions, /* … */ });
}
```

That seam is why the harness has no dependency on `apps/assistant` (the
dependency arrow points one way) and why it could be finished and tested
before the engine merged.

```
node packages/eval/dist/main.js run docs/poc/poc18-bakeoff/fixtures/*.jsonl \
  --engine ./stage0-engine.mjs \
  --candidate sonnet-bar --provider openrouter \
  --model anthropic/claude-sonnet-5 --server openrouter --effort medium \
  --quant none --host "M4 Max 64GB" --reasoning off
```

- **Parallelism is 1 by default.** The local half measures tokens/s and TTFT
  on one machine with one model resident; two cases at once would measure the
  queue instead. `--concurrency` is for the cloud rows, where it only costs
  money.
- **Resumable.** The run file is the state: a (candidate, fixture) pair
  already in it is skipped, so `--run-file runs/<the file>.jsonl` continues an
  interrupted run rather than restarting it, and re-running the same command
  is safe.
- **Tools are stubbed record-only.** The candidate sees production's tool
  definitions, read live from `mcp-brain`, and executes none of them —
  nothing touches a vault, a task or a row. This is the same contract stage
  2's shadow mode runs under, which is what makes a bake-off score comparable
  with a shadow score.

### The report

```
node packages/eval/dist/main.js report docs/poc/poc18-bakeoff/runs/*.jsonl --bar sonnet-bar
```

A markdown table per candidate: pass rate and mean score per axis, tool-call
agreement with the bar, tokens/s, TTFT p50, cost per turn, the six trace
columns averaged, and the line the PoC exists to produce —
**`≥ bar on all axes: yes/no`**. That is the *fixtures half* of stage 3's
gate; two weeks of shadow agreement is the other half, and the report says so
rather than implying a promotion.

`--bar` names the reference candidate. Without it, pass rates are absolute
and the gate is not evaluated.

---

## The run record

One JSONL row per case, flat, PoC-15/16's shape plus the axis tag and the six
trace columns (Atomic ADOPT 3) — `steps`, `parse_retries`, `tool_errors`,
`batch_count`, `prompt_tokens`, `predicted_tokens`. A scalar says a model
failed; an axis plus churn counts says whether to fix the model or the
harness. **`null` in a trace column means the engine did not report it, never
zero.**

Rows carry `candidate: {provider, model, server, effort}`, `pass`, `score`,
the `judge` verdict (or `null`), tokens, cost, latency, `ttft_ms`, `turns`,
every `tool_calls` entry with its arguments, `reasons` (why the answer missed)
and `error` (why something other than the answer failed). `transcript_ref`
points into `.transcripts/`.

**A note on re-scoring.** §3.2 wants a revised rubric to re-score without a
re-run. The rows are committed and carry the verdict and the reasons; the
answers themselves are in `.transcripts/`, which is gitignored — so a rubric
revision re-scores on the machine that produced the run, not from a fresh
clone. That is the deliberate trade for keeping the committed evidence small
and free of vault content.

---

## Stages, and the gate

Full text at `docs/plan-refresh-2026-09-13.md` §3.7.

0. **The bar** — the fixtures against Sonnet via OpenRouter: reference score,
   cost per turn, tool-call baseline. A PoC, not a PR. *(This directory.)*
1. **Local where it already wins** — embeddings, the scorer, `fast` and
   `routine`, extraction crews. No main-agent risk.
2. **Shadow mode** — a fraction of `default` turns re-run on the candidate
   with tools stubbed record-only; both transcripts on the `runs` row, the
   local answer never shown.
3. **Promote per tier.** Gate: **≥ the bar on the fixtures *and* two weeks of
   shadow agreement.** Then one line in `compute.yaml`, reversible.
4. **`deep` last** — probably never local on 64 GB; that is what the
   two-default seed exists for.

**Who runs what** (§3.8). Owner: the fifty fixtures and the rubric, OPEN-1,
ratifying `packages/eval`, the OpenRouter spend for the bar run. Agents: the
runner, the server matrix and its structured-output check, candidate pull
scripts, trace columns, the write-up.

**Before any quality run** (§3.4): check which structured-output controls each
server exposes — GBNF `grammar`, `response_format: json_schema`, slot control
(`slot_id`/`id_slot`), `cache_prompt`. If the grammar adopt is what closes the
quality gap, that check alone decides the server.

---

## Not here, on purpose

`docs/poc/poc16-local-scorer/*.py` are the previous PoC's analysis scripts.
They predate the no-Python rule (ruled 2026-08-29) and are **flagged, not
touched, and not ported** — this harness is TypeScript from the start
(§3.6, §5).
