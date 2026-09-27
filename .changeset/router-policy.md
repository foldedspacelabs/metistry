---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/collectors": patch
---

The router's policy, in shadow (T9-2, docs/ops/dynamic-router.md §2–§5). An
optional `rules.yaml` `policy:` block — the owner's table over the features,
first match wins — picks an operation from a closed vocabulary
(`ROUTE_OPERATIONS`: `answer`, `fast_path:<query>`, `retrieve:knowledge`,
`retrieve:queries`, `delegate:<crew>`, `tools`) and a tier from the owner's
allow-list, inside the owner's caps. Core gains `router-policy.ts`:
`validateRoutePolicy` (every load-time refusal names its field; `mode: serve`
is refused until T9-4), the pure `decide()`, `boundDecision()` (the session
rule and the registries, at run time), the planner's closed `COMPLEXITY`
classes, and `scoreRouteFeatures` — `intent` and `complexity` on the one
on-machine scorer (`assignments.intent`), only when a row reads them,
concurrently, each inside the consultation's deadline. `scoreChoice` moves
from the collectors into core (`score-choice.ts`) with its off-machine refusal
intact, and `completeJson` resolves through the same `resolveOnMachineCall`.
The console wires the table as `routePolicy`: every fall-through and override
is consulted after the 202 and recorded on the `route` row with the features
it read; the served route is unchanged. Fixes T9-1's answer check, which
refused every `fast_path:<query>` choice as garbage.
