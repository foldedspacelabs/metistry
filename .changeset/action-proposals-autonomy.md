---
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
---

**Approve now does something on an `action`.** `action` was a word in the
console's view map that nothing emitted; it is now a request kind carrying a
**closed** `payload.action = {kind, args}` — exactly four kinds
(`dispatch`, `task_update`, `comment`, `capture`), held in `packages/core` as
data plus a zod schema each, so an unknown kind or an unnamed argument is a
`400` naming the field. Allowing one runs it through the *same service call the
owner's own click makes* (`dispatch()`, `TasksService.update()`,
`workComment()`, `captureToInbox()`), as the `user` principal, with the
proposal's `source_agent` recorded as `on_behalf_of` and the result written
back to `payload.result`. A refusal leaves the row **pending** carrying the
error — and nothing is half-applied, because one action is one service call.
No sending, no git, no shell, no grants: every kind is a door onto something
the console could already do, never a new power (taskuary review ADOPT 6).

**Autonomy levels, and widening is now allowed — by your hand only** (A3 /
OPEN-2). `agents.autonomy` gains `{level: observe | propose |
act_within_scope, actions: {<kind>: allow | propose | deny}}` beside the §4.21
narrowing keys, so one record answers both "how much room" and "which action".
The level is a **ceiling** and the per-kind entry the value — the effective
mode is the lower of the two, which is what makes "it only ever runs on its own
at `act_within_scope`" arithmetic rather than a rule that could be forgotten.
Defaults: everything `deny` at `observe` (**and with no level at all**, so this
release widens nobody), everything `propose` at `propose`, and
`comment`/`capture`/`task_update` `allow` at `act_within_scope` while
`dispatch` stays `propose` — off-machine is a human decision by default. A
change that raises anything is admitted only through `PUT
/api/agents/:id/autonomy` (the `user` principal) and the new `metistry agents
autonomy <id> --level … --allow <kind>`; every other caller is narrowing-only
by default, and every raise writes a `runs` row `agent_admin` /
`autonomy_widened` plus one Needs You alert, so a raised bar is never silent.

**`propose_action` in mcp-brain**, in its own crew grant group `actions` (the
same opt-in rule `rooms` follows). It answers `executed` or `pending`; a denied
kind is a `forbidden` envelope naming `autonomy.actions.<kind>`. Registration
is **lazy by credential**: an agent whose table admits nothing is not offered
the tool, which is every agent until you set a level — so the eager definition
surface stays at 25 tools / ~4.9k tokens for everyone, and an opted-in
principal carries 26 knowingly. Deferring on the credential costs none of the
+1 discovery turn a meta-tool index would.

Needs You renders an action's kind, argument preview, reason and result; the
Agents panel shows each agent's level and resolved table with widen/narrow
controls. `docs/ops/actions.md` is the whole design.
