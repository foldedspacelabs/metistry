---
"@metistry-apps/console": patch
"@metistry-apps/macos": patch
---

**The vault's page list, through a named query — the third knowledge door,
and the only one that is not a proxy.** `GET /api/knowledge/pages?area=&prefix=&limit=&offset=`,
which #197 deferred because `seed/queries/` carried nothing to run. No
migration: `0009_brain.sql` already added `title`, `description` and `draft`,
and `0001` has `path`, `mtime`, `status`.

**Which door a thing comes out of is settled by the schema, not by taste.** A
page's bytes and a search ranking are not derived state — there is no column
holding a note body — so those go to the reconciler's bridge. A page LIST *is*
derived: `knowledge_files` is the reconciler's own index, rebuilt from the
vault by a walk. So invariant 3 sends it through
`seed/queries/knowledge_pages.yaml`, executed by `packages/queries`, and the
route holds **no SQL of its own** — one that reached for `pool.query` would be
a second read path into state.

**Two filters that mean what they mean everywhere else.** There is no area
column, and there did not need to be: everywhere in the system an "area" is a
vault prefix (`Areas/Fsl`, which the agent registry validates and `underAreas`
matches), so `area` is derived — the first two segments under `Areas/` at any
depth, the top segment elsewhere, and `null` for a vault-root file like
`now.md`, which is an answer rather than a gap. `prefix` is **segment-wise**,
the same semantics an area grant has: `Areas/Health` covers `Areas/Health/…`
and never `Areas/Healthcare/…`, because a substring match is how a prefix
filter leaks. Ordered by `path`, which is the primary key, so `offset` walks a
total order and no row ties or jumps between windows.

**What no parameter can turn on.** Drafts are excluded by the same clause
`mcp-brain` applies at every tier, so the owner's list and an agent's index
cannot disagree about what a draft is; an unsettled `conflict` row is excluded
because its title and mtime are not facts yet. And the route's own scope
filter runs over the query's rows — the same `canSee` the search and page
routes use — so a row in the index that is not vault CONTENT never reaches a
client, the owner's included. The query is overlayable per instance (D4); the
filter is not, which is why both hold the line. A row whose `path` is not a
string is dropped rather than passed: a list entry whose scope cannot be
decided is not a list entry.

**There is no `total`, on purpose.** A count over the unscoped filter is
precisely the "directory listing of what was filtered" the knowledge routes
refuse to publish — a narrowed principal would learn how many pages it cannot
see. Callers page until a window comes back shorter than `limit`. For the same
reason a filter pointing outside the scope answers an empty `200` rather than
a `400`: refusing `prefix=.metistry` by name would say which prefixes exist.
Only the filter's shape is validated.

MetistryKit gains the matching `knowledgePages` method, the
`KnowledgePageList` / `KnowledgePageEntry` shapes and a `pages` store section
beside `knowledge` — two sections, because browsing the vault and searching it
are two questions and a search must not blank the list you were reading.

The list is ordered by `path COLLATE "C"` — byte order, explicitly, rather
than the database's own locale. A glibc locale collation ignores punctuation
at the primary level, so `Areas/Health/sleep.md` sorts before
`Areas/Healthcare/…` on one cluster and after it on another: same rows, same
query, two different windows, and a client paging with `offset` would see a
page twice or not at all depending on which machine the database was
initialised on. CI (Linux) and the owner's Mac disagreeing is how it was
found.
