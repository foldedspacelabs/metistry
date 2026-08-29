---
type: technique
area: product-cartograph
created: 2026-02-15
tags: [technique, cartograph, engineering]
---

# Technique: Commit Hygiene for the Cartograph Side Project

Small-team-of-two convention adopted for the Cartograph codebase: commits
scoped to one logical change each, commit messages stating what changed and
why rather than just what changed, and a lightweight rule that any commit
touching the search/embedding pipeline gets a short note in the commit body
about what was measured or tested, given how easy it is for retrieval
quality regressions to go unnoticed without an explicit before/after check.

Branching is simple — short-lived feature branches merged after the other
person reviews, no elaborate release-branch process, appropriate for a
two-person part-time team where a heavier process would just be overhead.

This convention became more important once the pgvector-backed search
feature (see the v2 search backend decision) started being actively tuned
for relevance — the discipline of noting what was tested in each
search-related commit is what made it possible to track why relevance
tuning was taking longer than the original schedule, per the August status
note.
