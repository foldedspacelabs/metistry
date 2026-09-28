# @foldedspacelabs/metistry-queries

## 0.14.2

No changes in this release.

## 0.14.1

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.1

### Patch Changes

- 6b3d645: **One endpoint per necessary operation: the generic door closes over
  route-backed queries, and the page list's scope comes from the credential.**
  `GET /api/knowledge/pages` filters every row through `canSee` — and
  `GET /api/q/knowledge_pages` served the same rows with no filter at all, to
  anyone who could reach the generic door. That included the capture owner
  token, which is a `403` on `/api/knowledge/*` and has always been admitted on
  `/api/q/<name>`: a credential that may not use the scoped route could read the
  whole unscoped vault index by name, from any address. A filter with a second
  way in is not a filter.
  
  **The close is a manifest field, not a list in a server** (invariant 5).
  `packages/queries` gains one optional key on a query manifest — `expose:
  generic | route`, defaulting to `generic`, so every query written before this
  means exactly what it meant — and `QueryStore.exposure(name)` reads it back.
  `knowledge_pages.yaml` declares `expose: route`; `GET /api/q/<name>` asks the
  store and refuses anything that is not `generic` with the **unknown-query
  refusal, byte for byte**: same code, same status, same absent message, so the
  door is not an oracle for which route-only queries a build has. An unknown
  value in the field is a load-time `invalid_spec`, never a silent fall back to
  the permissive default. The dedicated route still runs the query through the
  same `QueryStore` — the door closed, not the read path.
  
  **The scope is now derived from the principal.** The `knowledgeRoutes` call
  site passed the constant `OWNER_SCOPE`; it passes `knowledgeScopeOf(auth)` —
  session / local owner to the whole vault, a principal carrying grants to
  `grantedScope`, anything else to nothing. `grantedScope` reproduces
  `mcp-brain`'s `knowledgeScope(principal).canRead` (`tier === "areas" &&
  underAreas(path, areas)`, against that package's own `underAreas`) rather than
  renaming its fields: that shape's `prefixes` is `null` for tiers `none` and
  `index`, meaning "no restriction on the TITLES those tiers browse", and `null`
  here means every vault path's CONTENT — the rename would have handed the two
  tiers that may not read a page the owner's own scope. Agent bearers keep their
  uniform `403` on `/api/knowledge/*` and reach knowledge on `/mcp`, so the
  grant path is exercised by tests today; it is real code so that the filter a
  narrower console principal needs is not invented at a call site later.

## 0.9.0

## 0.8.1

## 0.8.0

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.1

## 0.3.0

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

## 0.1.0

### Minor Changes

- First tagged release: Phases 1–5. Substrate (Postgres + migrations), the web door (passkeys, PWA, web push), capture (inbox-drain with the on-device Apple FM tier), visibility (github-state, aws-costs, claude-usage collectors; dashboard, feed, morning brief, weekly review), and delegation (tasks, agent registry with grants, mcp-brain, reconciler as sole committer, artifacts with review bundles, crews, targets with data policy, projects with the review-mode kill switch). CLI: init, doctor, up, update (git and release channels). Deployment shapes: compose and launchd (sandboxed assistant).
