# @metistry-apps/console

## 0.6.0

### Minor Changes

- 410dcce: The console's **local owner token** (`docs/ops/auth.md`), so the Mac app and
  the CLI authenticate to a console on this machine without a passkey
  ceremony — they are the same package, on the same filesystem, running as the
  same person.
  
  - `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN` yields the `user` principal,
    the same one a passkey session yields, through the same `isUser()`
    predicate — but **only** when the connection's peer address is loopback.
    The decision comes from the socket; `X-Forwarded-For`, `Forwarded`,
    `X-Real-IP` and `Host` are never read. From anywhere else it is a 401
    byte-identical to an unknown token's, plus a `runs` audit line naming the
    address. Constant-time comparison; misuse tests ship with it.
  - Compose NATs a host-loopback connection to the bridge gateway, so
    `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is told: the compose
    file sets the sentinel `docker-gateway`, resolved at startup from the
    container's own default route. The gateway address only — a sibling
    container is still remote. Unset (launchd) = plain loopback.
  - `GET /api/whoami` → `{principal, via, management, origin, as_of}`.
  - `POST /auth/logout` and `/api/push/*` stay passkey-session-only: they act
    on a device session row. A host-minted `owner_tokens` row (the capture
    Shortcut) is unchanged — capture-only, any address.
  - `METISTRY_ORIGIN` may be a comma-separated list (`expectedOrigin` takes an
    array in @simplewebauthn v13); the first entry stays canonical. An origin
    mismatch, which used to escape as HTTP 500, is a 401 naming expected vs
    presented.
  
  CLI: `METISTRY_LOCAL_OWNER_TOKEN` joins `SECRET_SCOPES` as instance-scoped;
  `metistry init` mints it into the `.env` lines it prints; `secrets sync --to
  env` mints one for an install that predates it (`GENERATED_SECRETS`, the
  same "generated, so minting cannot be the wrong guess" rule as `up`'s DB
  password); `metistry console whoami [--json]` prints the principal — what
  the app calls to show "signed in as owner"; and `metistry doctor`'s console
  row now presents the token, so `api_status` is a real authenticated read
  (a refused token degrades rather than fails).

### Patch Changes

- @metistry-apps/collectors@0.6.0
  - @foldedspacelabs/metistry-artifacts@0.6.0
  - @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-mcp-brain@0.6.0
  - @foldedspacelabs/metistry-queries@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0
  - @metistry-apps/routines@0.6.0

## 0.5.0

### Patch Changes

- @metistry-apps/collectors@0.5.0
  - @foldedspacelabs/metistry-artifacts@0.5.0
  - @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-mcp-brain@0.5.0
  - @foldedspacelabs/metistry-queries@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0
  - @metistry-apps/routines@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-mcp-brain@0.4.0
  - @foldedspacelabs/metistry-core@0.4.0
  - @metistry-apps/collectors@0.4.0
  - @foldedspacelabs/metistry-artifacts@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0
  - @metistry-apps/routines@0.4.0
  - @foldedspacelabs/metistry-queries@0.4.0

## 0.3.1

### Patch Changes

- @metistry-apps/collectors@0.3.1
  - @foldedspacelabs/metistry-artifacts@0.3.1
  - @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-mcp-brain@0.3.1
  - @foldedspacelabs/metistry-queries@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1
  - @metistry-apps/routines@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [c07a12c]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-mcp-brain@0.3.0
  - @metistry-apps/collectors@0.3.0
  - @foldedspacelabs/metistry-artifacts@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0
  - @metistry-apps/routines@0.3.0
  - @foldedspacelabs/metistry-queries@0.3.0

## 0.2.0

### Minor Changes

- 66d5c08: `queries_list` / `queries_run` on mcp-brain — invariant 3's one read path
  (named, parameterized queries, never free-form SQL) out to agents. An
  agent lists what's available (name, description, param types/defaults)
  and runs one, capped at 200 rows with truncation noted. The instance's
  own assistant always has it; an external agent needs an explicit
  `queries: true` grant (`PUT /api/agents/:id/grants`), a separate axis
  from the knowledge tier.
  
  Every mcp-brain tool also now takes an optional `turn_id` (≤ 64 chars,
  `[A-Za-z0-9_-]`), recorded on the tool's `runs` row (`meta.turn_id`); the
  `activity_feed` query surfaces it so one reply's tool calls group
  together. The seed assistant prompt tells it to generate one per reply.
  
  Crews never get `queries_list`/`queries_run` — a named query is not
  filtered by a crew's scope/projects the way every other tool group is.
- 4774e08: Phase 6 — embeddings on reconcile, and semantic search behind the same
  grants.
  
  The reconciler embeds settled notes as it reconciles (local Ollama
  `nomic-embed-text`, model and dim per row) and gains
  `POST /embeddings/rebuild`. `GET /vault/search` and mcp-brain's
  `knowledge_search` take `mode=keyword|semantic|hybrid`, defaulting to
  hybrid once vectors exist and keyword before that. Every mode keeps the
  grant tier and the draft exclusion in SQL. With no embedder running,
  search still answers in keyword and the index is unaffected.
  
  Migration 0012 adds `knowledge_files.embedded_hash` / `embedded_model`
  (additive, derived).

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-mcp-brain@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0
  - @metistry-apps/collectors@0.2.0
  - @metistry-apps/routines@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-queries@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
  - @foldedspacelabs/metistry-mcp-brain@0.1.0
  - @metistry-apps/collectors@0.1.0
  - @metistry-apps/routines@0.1.0
