---
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/console": patch
---

**`metistry compute route-report` — where your messages actually go, as one
command.** PoC-20 phase 0's baseline
(`docs/research/2026-09-21-intent-classification-tier.md` §5.2): the share of
real messages the deterministic router placed as `/note`, as a `fast_path`
answer, as an explicit tier override, or that fell through to the default
model tier — and, among the fall-throughs, their length and their commonest
opening words, which is the shortlist to write new `fast_path` rules from.
The verdict is the research's own exit rule with your number in it:
fall-through under ~40 % and the answer is an extra regex, not a classifier.

A new seed query, `route_report`, is the one read path into it (invariant 3);
`GET /api/q/route_report` answers the same rows. It is counts only — no
message text, no thread, no vault path, and an opening word is kept only when
it is a plain word or a `/command` — so it is safe on the generic door. The
command calls no model, dials no provider and writes nothing.
