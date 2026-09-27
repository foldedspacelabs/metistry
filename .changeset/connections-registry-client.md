---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

**Connections P1: the files, the pooled client, `metistry connections` and the
read routes (plan §2.6, M13, T4-8a).** A new package,
`@foldedspacelabs/metistry-connections`, reads `.metistry/connections/<name>.yaml`
against the connection-type registry — `ok`, `absent` (provider not installed;
nothing deleted) or `failed`, never fatal — and adds four rules to F-3's
schema: no key-shaped literal anywhere a value is typed, no `{{ secret.x }}` in a
URL, on a command line or in a path. Its `ConnectionPool` holds one MCP client
per connection (stdio or Streamable HTTP), and refuses before dialling a tool
the file does not list, one at Never, one at Ask First without an approval, and
a call whose arguments carry the caller's own bearer; a command gets only the
environment its file names, never the host process's; every HTTP request goes
through core's `guardedFetch` with `connection:<name>` as the grantee and is
pinned to the connection's origin (no redirect followed); every answer is
redacted. `checkConnection` is its `check()` (ok · degraded · absent · failed).
The CLI adds `metistry connections list|show|add|set|policy|remove|test`
(protected writes through the reconciler; `add` dials once and applies the
owner's Q15 defaults) and one doctor row per connection, never `failed`. The
console serves `GET /api/connections` and `GET /api/connections/:name` to the
owner — names, never values, and no dial. Core adds
`INSTANCE_LAYOUT.connectionsDir`.
