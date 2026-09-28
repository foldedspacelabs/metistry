# @foldedspacelabs/metistry-connections

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Minor Changes

- 851e08a: **Connections P1: the files, the pooled client, `metistry connections` and the
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
- 50a455d: **Linear: the connection and its sync (plan §2.6, §4 Q22, T4-24).** The
  product ships its first `tracker` connection type, `seed/connection-types/linear/`
  — a personal API key, sent as `Authorization: <API_KEY>` to
  `https://api.linear.app` and nowhere else, capability `read`.
  `@foldedspacelabs/metistry-connections` adds what a sync opens to read a
  builtin provider's connection (`openSyncHttp`, `instanceSyncOpener`): the
  connection `scheduled.yaml` names, else the one its provider's sync reads; a
  `fetch` pinned to the provider's origin that follows no redirect; every
  request through core's `guardedFetch` as `connection:<name>`, the key filled
  only for a host on its *Sent only to* list; and the `linear` provider's
  read-only GraphQL client (a document that is not a `query` is refused before
  it leaves). *Used by* now names the sync a provider declares. The new `linear`
  collector reconciles the issues assigned to the owner into `work`
  (`external_ref linear:<KEY>`, state, priority and url in `meta`), closes the
  ones that leave with why, and raises one `task` mirror per assigned issue that
  clears at source; `addIssueToToday` captures `- [ ] <title> do <today>
  linear:<KEY>` through the capture service, idempotent per issue. The console
  hands collectors the opener; `metistry secrets sync --to env` delivers a
  sync-read connection's secrets as `METISTRY_SECRET_<NAME>`.

### Patch Changes

- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0
