- 2026-09-16 — **The bake-off harness: choosing the default model becomes an
  experiment with numbers instead of a preference.** `packages/eval` — private,
  unpublished, TypeScript, no new dependency — turns "is a local model good
  enough to be the assistant?" into five measurable axes (tool calls, knowing
  when to stop, triage judgment, voice, writing), one owner-authored fixture
  per axis, and one JSONL row per case carrying pass, score, tokens, cost,
  latency, TTFT and six churn counters that separate a wrong answer from a
  model thrashing. Three things are enforced at the tool rather than asked for
  in a prompt: a fixture may not mix two axes, so a failure names the component
  to fix; the three judgment axes are scored by a model from a *third* family —
  neither the candidate's nor the reference's — and a judge that is absent or
  same-family **refuses the run** rather than quietly passing the cases it
  cannot score; and the candidate is shown the console's real tool definitions
  while every call is stubbed record-only, so an evaluation can never touch the
  vault. Runs are resumable, parallelism is 1 by default so throughput is
  measured rather than the queue, and the report ends in the line the whole
  exercise exists to produce — `≥ bar on all axes: yes/no` — stated as the
  fixtures half of the promotion gate, with two weeks of shadow agreement named
  as the other half. Reference models are the bar and never the source: no
  model's output is a fixture, an expected answer or training data.
