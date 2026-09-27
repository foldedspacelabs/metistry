---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": minor
---

The route record, in shadow (T9-1, docs/ops/dynamic-router.md §6). Every
`POST /message` the console routes now writes one `runs` row of kind `route`
AFTER the 202: the served kind, the cheap features (`words`, `attachments`,
`thread_turns`, `recent_failures`, `reask` — never the text), and what a local
policy would have chosen beside what the rules served. No policy ships yet, so
every consultation reads `absent`; the seam (`routePolicy` on the console's
config) is consulted under a 400 ms deadline, and a policy that answers,
throws or never resolves leaves the served route, the 202 body and the reply
byte-identical. New named query `route_features` (`expose: route`) supplies the
thread facts. `route_report` gains the fifth kind `policy` (0 until T9-4) and
the `policy_*` rows; `metistry compute route-report` renders them under the
baseline's verdict and carries them as `policy` in `--json`.
