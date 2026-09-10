# @foldedspacelabs/metistry-mcp-brain

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.6.0
  - @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-queries@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.5.0
  - @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-queries@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0

## 0.4.0

### Minor Changes

- c32b27d: Add `tasks_close` — the vocabulary fix deferred from the 2026-09-09 rename
  (`docs/product/glossary.md` lists tasks' own verbs as `claim · renew ·
  release · close`, but closing went through `tasks_update {status:
  "closed"}`). `tasks_close` is a thin wrapper over the same `tasks.update`
  host handler (`id`, optional `note`) — no new DB path. `tasks_update`
  keeps `status: closed` working for compatibility; its description now
  points callers at `tasks_close` for finishing a task in one call.
  `tasks_close` joins the `tasks` crew tool group (`CREW_TOOL_GROUPS` in
  core) alongside the other holder verbs, and the assistant's `BRAIN_TOOLS`
  allowlist. The eager surface is now 23 tools, 18,369 chars ≈ 4.6k
  definition tokens — still well under PoC-17's 5k-token lazy-discovery
  line.

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0
  - @foldedspacelabs/metistry-artifacts@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0
  - @foldedspacelabs/metistry-queries@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-artifacts@0.3.1
  - @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-queries@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1

## 0.3.0

### Minor Changes

- c07a12c: `knowledge_write` now enforces ownership as well as authorship: an update to
  an existing markdown note whose frontmatter `source` is neither the caller's
  own id nor `knowledge-fold` is refused (`forbidden: owned by <source>; propose
  instead`). New notes are unaffected, and `source` is still stamped from the
  credential rather than the argument, so "notes I wrote" stays a fact rather
  than a claim. Hosts pass their vault reader as the new optional fifth argument
  to `writeKnowledge` (the brain server wires `cfg.readKnowledge` through
  automatically); when a read fails the write is refused rather than waved
  through. `ownershipRefusal` and `frontmatterSource` are exported.
- Knowledge fold (the evening turn that turns accepted items into Journal and entity pages), `import-sessions` and `kind: session` captures, `knowledge_list`/`knowledge_grep` and vault notes as MCP resources under one scope helper, the simplified vocabulary (22 primary tools with call-time aliases; Approve / Revise / Decline; Auto / Supervised), cost discipline ((model, effort) tiers, session roll at task boundaries, cache read/write metrics and a prompt lint), the bundled runtime build (Node, Postgres 17 + pgvector, git — signed), TCC helpers as signed app bundles whose grants survive rebuilds, Sparkle tooling pinned, npm Trusted Publishing, and the GitHub OAuth App shipped as the default for `connect-repo`.
- ad185f2: One vocabulary everywhere. Eight nouns (knowledge, capture, request, task,
  artifact, project, agent, activity) and one verb set per object, in the UI, the
  notifications, the briefs and the tool names. Eleven brain tools were renamed —
  `report` → `requests_create`, `tasks_list_ready` + `tasks_mine` → `tasks_list
  {filter}`, `tasks_heartbeat` → `tasks_renew`, `artifact_*` → `artifacts_*`,
  `crew_dispatch` → `agents_delegate` — and the old spellings keep working for one
  release (resolved at call time, recorded in `runs.meta.alias`, not listed by
  `tools/list`). In the console, Needs You now reads Approve / Revise / Decline
  and project mode reads Auto / Supervised. `docs/product/glossary.md` is the one
  page that holds the vocabulary.

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-artifacts@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0
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
- Phase 5 complete and the desktop direction: crews (manifest-defined sub-agents with per-run scoped tokens and a local target), projects with the `mode: autonomous | review` kill switch, bundle caps, daily budgets and narrowing, the activity feed and agent presence in the PWA, the design system (tokens, components, wireframes) and the PWA restyle (iMessage-style composer with a collapsed actions menu, autocomplete for `@agents` and `/commands`, scroll preservation, reply-text density), reply tapbacks with a daily reply-review that proposes prompt improvements, Needs You as the single actionable list including the assistant's blocking questions, `queries_list`/`queries_run` over named queries with a `turn_id` join key, Phase 6 embeddings and hybrid search, `metistry connect-repo` and `secrets`, the launchd deployment shape with a sandboxed assistant, release notes from the CHANGELOG, and Developer ID signing of the Swift helpers.

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
