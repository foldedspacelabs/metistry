---
"@metistry-apps/console": patch
"@metistry-apps/macos": patch
---

**The vault's link graph, through a named query — the fourth knowledge door
and the last piece §6.1 left open.** `GET
/api/knowledge/links?path=&limit=&offset=`, over
`seed/queries/knowledge_page_links.yaml`. No migration: `0001_init.sql` has
`knowledge_links (from_path, to_path, kind)` with the primary key on all
three and an index on `to_path`, so both directions are one indexed lookup.
The graph is derived state — the reconciler parses it out of the notes on
every walk and re-resolves a note's edges whenever the note or the path set
moves — so invariant 3 sends it through `packages/queries` and the route
holds no SQL of its own.

**One list, keyed by the other end.** `direction` is a column (`outgoing` =
this page links there; `incoming` = that page links here) and `path` is
always the far side of the edge. That is not a presentation choice: it is
what lets one predicate decide every row. Two arrays would be two chances to
filter them unevenly, and the filter is the point — **both ends are scoped**.
The `path` parameter is checked before anything runs (a path the caller may
not see gets the `404` a missing page gets: "this page has four backlinks" is
a fact about a page), and every row goes through the same `canSee`. A page
inside a grant that links *out* of it, and a page outside a grant that links
*in*, both come back dropped rather than listed.

**Never in the list:** an edge whose other end is a draft or an unsettled
`conflict`, at either end and at every tier — the same rule the page list
applies, so a draft cannot be discovered through the graph after being hidden
from the list. Dropped rather than blanked, because a row saying "there is
something here you may not see" is the disclosure the rule exists to prevent.
**An unresolved wikilink stays**, marked `resolved: false` with a title
derived from its own path: a note not written yet is how a vault gets
written, and Obsidian renders it rather than hiding it.

Ordered outgoing first, then by path in byte order (`COLLATE "C"`), then by
`kind` — the link table's primary key read the other way round, so the order
is total and `limit`/`offset` cannot repeat or skip an edge. The same target
reached as a wikilink and as an embed is **two edges**, which is why the
client's row identity is the triple and not the path. No `total`, for the
page list's reason. The query is `expose: route`, so `/api/q/knowledge_page_links`
answers the `404` an unknown name gets.

MetistryKit gains `knowledgeLinks(path:limit:offset:)`, the
`KnowledgePageLinkList` / `KnowledgePageLink` shapes with `outgoing` and
`incoming` as views of the one list, and `isLastPage`/`nextOffset` beside the
page list's.
