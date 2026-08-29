---
type: area
area: product-cartograph
created: 2026-01-15
tags: [cartograph, product, metrics]
---

# Cartograph Key Metrics Dashboard Notes

Metrics tracked weekly during the v1 beta, kept here as a reference for what
"good" looked like before the v2 rebuild reset most numbers to zero:

Activation: % of signups who create at least one typed link within 7 days.
V1 baseline settled around 38% by the end of the beta after onboarding
tweaks (started around 22%).

W4 retention: % of activated users still creating notes in week 4. V1
baseline ~51%.

Graph size at churn: median note count when a user went inactive was 12 —
suggests the "aha moment" of a genuinely useful graph needs more like 30-40
notes, and most churned users never got there.

Performance complaint threshold: canvas rendering complaints started
appearing consistently above ~400 notes in a single graph on typical beta-user
hardware, which directly informed the v2 rendering-performance requirement.

V2 doesn't have real numbers yet (see the v2 launch status note for where
that stands) — this note will get a fresh set of baselines once v2 has beta
users again.
