---
type: project
area: product-cartograph
created: 2025-09-10
tags: [cartograph, decision, v1]
---

# Cartograph v1 Decision: Search Backend

Decision made during v1's build (mid-2025): search over notes would be plain
Postgres full-text search (tsvector/tsquery with a GIN index), not semantic
search at all. Semantic/vector search was explicitly deferred to a later
version.

Reasoning at the time: v1 was scoped as a fast beta to validate the core
typed-link canvas concept, and full-text search is close to zero additional
infrastructure on top of the Postgres database v1 already needed — no new
extension, no embedding model to run, no embedding cost or latency. The bet
was that early beta users would tolerate keyword search while the actual
differentiator (the canvas) got validated.

That bet mostly paid off — search quality was rarely cited as a complaint in
v1 beta feedback, "can't find that note I know I wrote" was mentioned by a
handful of Synthesizer-persona users with large graphs, which became one of
the inputs into prioritizing real semantic search (via pgvector) for v2. See
the v2 search backend decision note for what replaced this.
