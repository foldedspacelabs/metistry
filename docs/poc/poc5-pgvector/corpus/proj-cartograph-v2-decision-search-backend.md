---
type: project
area: product-cartograph
created: 2026-02-02
tags: [cartograph, decision, v2]
---

# Cartograph v2 Decision: Search Backend

Decision: for Cartograph v2, semantic search over notes will run on Postgres
with the pgvector extension, not a dedicated vector database (evaluated
Pinecone and Weaviate) and not Elasticsearch with a dense-vector field
(which is what a prototype briefly used).

Reasoning: v2's whole data layer is already moving to a single managed
Postgres instance to simplify ops for a two-person team, and pgvector's HNSW
index (added in pgvector 0.5) closes most of the recall/latency gap against
dedicated vector DBs at the scale Cartograph actually operates at — the
largest beta user's graph was under 3,000 notes. Running one database instead
of two also means one thing to back up, one thing to monitor, and one
connection pool to reason about.

Trade-off accepted: if a future large-enterprise tier ever needs
tens-of-millions-of-vectors scale, this decision would need revisiting — but
that's explicitly not the problem being solved in 2026. Embedding model
chosen: a local/self-hostable embedding model so per-note embedding cost
doesn't scale with an external API bill as the user base grows.
