---
"@metistry-apps/eval": minor
---

T9-3: `metistry-eval complexity`, the router's confirmatory eval
(docs/ops/dynamic-router.md §7.2). It scores the owner's labelled messages
through the planner exactly as the router's policy calls it — core's
`scoreRouteFeatures` on `assignments.intent`, twice for determinism — and
reports against the pre-registered bar (accuracy, deep-miss, the two traps,
determinism, unscored, warm latency against `policy.timeout_ms`), after
checking the fixture set itself against §7.2. `--fit` sweeps
`complexity.min_confidence`; the cost table (reported, never gated) prices
today's router, the policy and always-the-top at the shadow window's real mix
from `route-report --json` and `cache-report --json`. `--record`/`--replay`
run it offline. The shipped example file is empty (C11).
