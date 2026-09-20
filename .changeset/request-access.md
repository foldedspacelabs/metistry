---
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
---

**`request_access`: an agent asks for the area it was refused, and the owner
grants it in Needs You.** Ruled 2026-09-19, the upgrade path proposed in
#216 and refined in #221. Tier `index` could already see that a page exists,
be refused its content, and be told which area would unlock it — and then had
nowhere to put that. The only mechanism was a free-text `requests_create`
report and a hope.

Now the refusal names a tool: `request_access {area, reason}` writes ONE
`proposals` row of kind `access_request` with the ask, the reason and what the
credential holds today, deduplicated on `(agent, area)` while it is pending
(migration 0022's partial unique index, so a retry storm is one row). It
**grants nothing** — it is a row. Every tier may ask, `none` included; an
internal principal may not, because the assistant's scope is configuration in
the user's hand and an approved ask would silently revert at the next restart.
The area is validated at the tool with the same rule the grants validator
uses, so a crafted prefix (`..`, `.metistry/`, `Artifacts/`, lowercase, the
bare vault) never reaches a proposal, let alone a grant.

The owner answers it with the three answers every request already takes.
**Approve calls `writeGrants` — the same function `PUT /api/agents/:id/grants`
calls**, with the same `validateGrants` and the same `agent_admin` audit row,
`via: triage`; **Revise** grants a narrower prefix instead (`{area}` on the
existing triage route); **Decline**, Later and Skip grant nothing. The
console's mutating surface gains no verb and no route (invariant 10): this
kind is a new branch onto a service that already existed. It widens by exactly
the prefix asked for — never `queries`, never a second area, never one already
covered — and a revoked agent cannot be granted anything: revoking settles its
pending asks as `deny`.

`packages/core` gains `validAreaPrefix` / `AREA_PREFIX_RE` /
`AREA_PREFIX_REFUSAL`, lifted out of the console so both doors refuse the same
strings in the same sentence. It also folds `isVaultPath` into that rule,
which tightens the owner's own grants form slightly: `Artifacts/…` is now
refused where it used to be admitted as an inert grant every read path
ignored.

Cost on the surface every agent pays: 189 definition tokens, taking the eager
`tools/list` from 4,035 to **4,224** against the 5,000 line — still smaller
than the 4,979 it carried a week ago with one tool fewer. The tool COUNT
ceiling in `ops/scripts/check-tool-surface.mjs` moved 25 → 26 deliberately,
with the reasoning written beside the number; the tool after this one fails
that check again.
