---
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-core": patch
---

**Access requests, after the owner read them: you see everything, an agent may
escalate once, and the assistant may ask.** Three rulings of 2026-09-19 on the
`request_access` loop.

**Your own access is never narrowed by a rule about agents.** The area
validator that refuses `Artifacts/…` is now `validAgentAreaGrant` — the
prefix shape plus "an agent read path would actually serve it" — and
`validAreaPrefix` is the shape alone. The refusal is typed where an agent's
grant is typed (the grants form, `request_access`), because an `Artifacts/`
grant is inert: every knowledge read path refuses it, so it reads in the
registry like access and gives none. Your own artifacts are untouched and
still `GET /api/artifacts`, over the real vault; and where the knowledge door
cannot serve one — it reads the index, which has never walked `Artifacts/` —
it now points you at the door that has the bytes instead of saying "no such
page". An agent asking for the same path still gets the one uniform sentence,
byte for byte the same as for a path that is not there.

**A decline is told to the agent, and it may escalate exactly once.** Asking
again for an area you declined no longer files a second identical row and no
longer vanishes into a dedupe: the tool answers with the decision you gave —
declined, when, your note — and offers `escalate: true` with a fuller reason.
That writes ONE new proposal flagged `escalated` with the prior id on it, and
Needs You renders *asked again after a decline*. Decline that too and the area
is closed at the tool: a third ask is refused with "ask the owner directly".
One open ask per (agent, area) throughout, and the flag comes off the record
rather than the caller's word for it. Enforced at the tool, not prompted.

**The assistant may ask now.** It was refused because `ensureInternalAgent`
replaces an internal row's grants from `METISTRY_ASSISTANT_AREAS` at every
console start, so an approval would have been silently undone. Approving an
`access_request` for an internal row now also records the area in
`agent_grant_overrides` (migration 0023, additive), which `ensureInternalAgent`
merges on top of the configured areas on the way in. Configuration stays the
floor; the approval survives the restart; revoking the credential clears its
approvals. A crew is still refused at the decision — its scope is a manifest
file, and that is an edit, not a grant.

Cost on the surface every agent pays: 40 definition tokens for the escalation
(one optional boolean and a clause), 4,224 → **4,264** against the 5,000 line.
The tool count is unchanged at 26.
