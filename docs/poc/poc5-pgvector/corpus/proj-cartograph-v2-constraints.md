---
type: project
area: product-cartograph
created: 2026-02-03
tags: [cartograph, constraints, v2]
---

# Cartograph v2 Constraints

Hard constraints for the v2 rebuild, agreed with Ana before scoping began:

Team capacity: both of us are part-time on this (evenings/weekends around day
jobs), so the v2 scope has to fit roughly 10-12 hours/week combined for an
estimated 4-month build. Anything that doesn't fit that budget gets cut, not
deferred-with-a-plan-to-somehow-still-do-it.

Performance: canvas view must stay smooth (target 30fps interaction) up to
1,000 notes in a single graph on mid-range hardware — set based on the v1
metrics note showing complaints starting around 400 notes, giving headroom.

Explicitly cut from v2 scope: real-time collaborative editing (multiple users
editing the same graph simultaneously) — big engineering lift, and the user
research showed the Synthesizer and Serial Journaler personas are both
fundamentally solo-use cases. Also cut: mobile native apps, v2 ships
web-only with a responsive layout, native apps revisited only if there's
real retention data justifying the investment.

Budget: no paid infrastructure beyond a single small managed Postgres
instance and static hosting until there's paying revenue.
