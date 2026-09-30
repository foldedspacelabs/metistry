---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/collectors": minor
---

Targets and syncs as connections (T4-11). **Targets become agent connections**: a connection-type manifest gains a `dispatch:` block for `provides: agent` — the dispatcher (closed `AGENT_DISPATCHERS`: `devin-session`, `github-issue`), the data policy, the purposes with their preambles (Devin's `DEVIN_PURPOSES` move here), the result path — and the product ships `devin` and `github-issues` agent types beside the `github` tracker type. The console's target registry reads the instance's agent connections afresh and presents each as the target `dispatch()` already knows (dispatch unchanged), sending through the connection's own egress door (`openAgentHttp`): the key a `{{ secret.x }}` reference filled for its listed hosts when granted to `connection:<name>`, the response redacted. A brief or title carrying a secret or variable reference is refused before anything is sent. **Collectors become syncs bound to a connection and its secret**: `github-state` reads the `github` connection, `devin-sessions` and `devin-knowledge` the `devin` one (a type may name further syncs in `also_read_by`, and a sync further origins its code reaches); a connection always wins, and the legacy environment keys still work for one release. `metistry connections add|set --config KEY=VALUE` sets a connection type's fields.
