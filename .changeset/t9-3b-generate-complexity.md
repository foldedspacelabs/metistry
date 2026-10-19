---
"@metistry-apps/eval": minor
---

T9-3b (X-121): `metistry-eval generate-complexity`, a fixture generator for
the router's confirmatory eval (docs/ops/dynamic-router.md §7.2, "Generating
fixtures"). Two non-Claude models from two families — a writer and a blind
relabeller — are called through an OpenAI-compatible endpoint configured from
the environment; a Claude id or a one-family pair is refused, and every prompt
is checked against a frozen list of the rubric's phrases and the live planner
wording before it is sent. Agreement keeps the label; an adjacent
disagreement keeps the writer's with the relabeller's as `accept`; opposite
ones and every D08-class item go to `adjudicate.jsonl` for the owner, capped,
the overflow dropped and counted. The stats report gives the counts, the
agreement, |r| and the recording's sha256. Every row is `source: generated`,
and `metistry-eval complexity` now reads `complexity.jsonl` and
`complexity.generated.jsonl` under `--instance` and holds the two sets to the
bar separately, never blended.
