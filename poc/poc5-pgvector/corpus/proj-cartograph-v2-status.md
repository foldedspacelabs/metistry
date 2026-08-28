---
type: project
area: product-cartograph
created: 2026-08-10
tags: [cartograph, status, v2]
---

# Cartograph v2 Status Update

As of August 2026: core canvas rendering and the typed-link model are done
and stable. Semantic search over notes (the pgvector-backed feature) is
implemented and working in dev, currently being tuned for relevance — early
internal testing shows keyword-shaped queries work well but natural-phrasing
questions sometimes surface a topically-related note instead of the most
directly relevant one, which matches expectations for embedding-based
retrieval and just needs a bit of chunking/prompt tuning before opening back
up to beta users.

Not yet started: the onboarding flow rebuild (v1's 22%-to-38% activation
improvement came from onboarding tweaks, and v2's onboarding is currently
just a blank canvas, worse than v1's starting point).

Timeline: original estimate was a 4-month build starting February 2026,
currently tracking about 6 weeks behind that, mostly due to the search
relevance tuning taking longer than scoped. Revised target for reopening a
private beta is October 2026.
