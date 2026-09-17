---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/assistant": minor
"@metistry-apps/routines": minor
---

**Shadow mode: try a model on your real turns without ever answering with
it.** The bake-off's stage 2, as configuration. An optional block on the
default assignment —
`shadow: { model: llamaserver/qwen3.6-35b-a3b, fraction: 0.1 }` — has the
engine re-run one turn in ten on a candidate model *after* the real answer has
been delivered and its session saved, and put both transcripts plus an
agreement number on that turn's `runs` row. The candidate's answer is never
returned as the turn's, is never a session, and has no path to the console or
the phone.

**Its tool calls are stubbed record-only, by construction rather than by
instruction.** The shadow gets the same tool *list* the real run saw; every
call is written down and none is performed. A call the real run made
identically (same name, same arguments, byte for byte) is handed the real run's
own result, so the candidate's next step is judged against the same facts;
anything else gets one fixed `(recorded, not executed: …)` string. The stub
host closes over a list of names and a map of strings — no MCP client, no URL,
no token — so there is no object in scope it could execute a call against, and
a shadow of a turn that wrote to the vault cannot write to the vault twice.

**Agreement is deterministic and says what it is:** the mean of "same tool
calls in the same order" and token Jaccard over the two final answers. No model
scores it, so it cannot drift and the stored row re-scores to the same number.
The *rubric* score stays `packages/eval`'s, on the owner's fixtures — the
engine leaves a typed hook for it instead of inventing a second scorer.

**A shadow is a turn, so it is budgeted like one.** It asks the same pre-call
gate with the candidate's own provider and `critical: false`, so `stop` and
`critical_only` skip the experiment while the interactive turn they let through
keeps its answer; its spend is its own `runs` row of kind `shadow` carrying the
provider that was actually paid, which is what makes per-provider budgets
honest with no change to the `spend` query. Nothing it does can cost the turn:
a candidate that is down, an unset credential or a failed write lands as a note
on the row, never as a failed reply.

Additive migration `0020` adds `shadow_provider`, `shadow_model`,
`shadow_transcript`, `shadow_agreement` and `shadow_cost_usd` to `runs`
(rollback: drop the five columns and `runs_shadow_ts_idx`). New named query
`seed/queries/shadow_agreement.yaml` reports agreement, tool-sequence match,
answer similarity, cost and failures per candidate over the last N shadowed
turns; the weekly review's System section carries one line per candidate and
omits it when nothing is being shadowed. `compute.yaml`'s schema refuses a
`shadow:` block with no `fraction`, a fraction outside 0..1, a candidate this
file does not declare, a candidate that is the assigned model itself, and the
block on a tier or crew — each naming the field. `docs/ops/compute.md` gains
"Shadow mode".
