---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
---

**The private tier** (plan §2.15, T8-6). `assignments.tiers.private` is the tier a capture session's turns run on, and it may only name a provider with `locality: on_machine`: `metistry compute assign private` (and the console's `POST /api/compute/assign`, which runs the same verb) refuses an off-machine provider before anything is written, and the schema refuses it at load, naming `assignments.tiers.private.model`. Core gains `PRIVATE_TIER`, `resolvePrivateTier`, `privateTierIssue`, `turnTier` and `PrivateTierUnavailable`; `resolveAssignment(cfg, "private")` never falls back — not to `assignments.default` (which may be off the machine, or shadowed there) and not to `rules.yaml` — and throws `PrivateTierUnavailable` with the command that fixes it instead.
