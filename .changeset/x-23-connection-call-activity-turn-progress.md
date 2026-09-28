---
"@metistry-apps/console": patch
---

**`activity_feed` and `turn_progress` surface `connection_call` rows (Ruling 28, X-23).** A `connections_call` proxied through the connection pool used to vanish from both: `activity_feed` never listed `connection_call` among the `runs` kinds it admits, and `turn_progress` filtered to `kind = 'tool'` only, so the working strip went quiet while a turn waited on a connection. Both now include it — in `activity_feed`'s existing `run` group (nothing new to widen a chip for), and joined into `turn_progress` by the same exact `meta.turn_id` key as any other tool row. The subject and detail `activity_feed` renders for a `connection_call` name only the connection and the upstream tool (`meta.connection` / `meta.connection_tool`, the same fields `connection_calls` already reads) — never `meta.args` or a secret value. No route, column or wire shape changed.
