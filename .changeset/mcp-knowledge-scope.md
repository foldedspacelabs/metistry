---
"@foldedspacelabs/metistry-mcp-brain": patch
"@metistry-apps/console": patch
---

**One scope rule for every knowledge read, on both doors.** `expose: route`
closed the console's generic `GET /api/q/<name>` over the page list and the
link graph and left the other generic door open: `queries_run` on the `/mcp`
mount ran any named query for any holder of a `queries: true` grant. That
grant is a separate axis from the knowledge tier, so it was a way past the
tiers entirely — an agent at tier `none`, which `knowledge_search` will not
tell a single title, could page the whole vault index and the whole wikilink
graph; a `tier: areas` agent could read the titles of every area it was never
granted. Ruled 2026-09-19: *"all queries including /mcp should be scoped and
follow the same token based enforcements."*

**`queries_run` honours `expose`.** It asks the same `QueryStore.exposure(name)`
the console asks and refuses a route-backed query with the **unknown-query
refusal, byte for byte** — same code, same `no such query: <name>` — and
`queries_list` does not name one, because a list that named a query the runner
refuses would publish the route-only set in the same breath. Read off the
manifests, never matched against a list in the server (invariant 5).

**The scoped door beside it is `knowledge_list`**, which runs the SAME two
named queries through `packages/queries` and filters them with the same
function the console's routes use. `links_for: <path>` lists one page's links
in both directions out of `knowledge_page_links`, with **both ends** of every
edge scoped — a backlink cannot report that a note exists in an area the
caller was never granted — and needs an `areas` grant covering the page,
because a backlink names a note. Without a vault bridge the listing comes from
the reconciler's index (`knowledge_pages`) instead of the tool being
`not_available`, and every entry carries path, title and one-line description
— never content, at any tier. It rides `knowledge_list`'s existing definition
rather than arriving as a new tool pair because the eager `tools/list` budget
now sits within 80 characters of the 5k line a new tool would have to buy with
`discovery: lazy` (`packages/mcp-brain/test/brain.test.ts`).

**That function is now singular.** `canSeeUnder(path, areas)` lifts into
`packages/mcp-brain/src/knowledge.ts`, beside the `underAreas` it always
called and the `isVaultPath` core always owned; `apps/console`'s `canSee` is a
rename over it, and `knowledgeScope` gains `canList` — the same question asked
about a TITLE rather than content. Tier `index` may be told a page exists
anywhere in the index (that is the discovery the tier is for: an agent finds
`Areas/Health/sleep.md` so it can ask you for the area that holds it) and may
read none of it; tier `areas` lists and reads its prefixes; tier `none` gets
nothing and is told "not granted", never "not found". The same lift hardened
`knowledge_list`'s bridge branch, which applied no vault-path rule at all: a
tier `index` browse of the vault root listed `.metistry/`, `.obsidian/`,
`Artifacts/` and the root `CLAUDE.md` — machinery, and not knowledge for the
owner either.
