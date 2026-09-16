- 2026-09-16 — **Approve can now *do* the thing, and how much an agent may do
  on its own is a table you raise deliberately rather than a property of the
  code.** The two accepted decisions that widen agent autonomy under enforced
  gates, shipped together because neither is safe alone. **Executable actions**
  (`docs/research/2026-09-16-taskuary-review.md` ADOPT 6): a request may now
  carry `{kind, args}` from a **closed set of four** — dispatch a brief to a
  target, patch a card, comment, capture — and allowing it runs the action
  through the *same service call the owner's own click makes*, as the owner,
  with the asking agent recorded as provenance and the result written onto the
  request. What is absent is the design: no mail, no messages, no git, no
  shell, no credential or grant change. Every kind is a **door onto something
  the console could already do**, with the audit row it already wrote — so the
  new power is a gesture saved, not a reach extended, and a failure leaves the
  request pending with the error rather than half-applied, because one action
  is one service call. **Autonomy levels** (agent-room A3; the narrowing-only
  rule that blocked it was the owner's to overturn and was overturned the same
  day): every agent carries `observe | propose | act_within_scope` plus a
  per-kind table, and the level is a **ceiling** — the effective answer is the
  lower of the two, which is what makes "it only ever acts unprompted at the
  top level" arithmetic rather than a rule a later edit could forget. The
  defaults are the product position: an absent level means *nothing*, so the
  release widens nobody; and `dispatch` stays human at **every** level unless
  you say otherwise, because that is the one kind that leaves the machine.
  Trust is raised by hand, in one of exactly two places, and a raise is never
  silent — it writes its own audit row and puts one alert in the queue that
  needs you. The agent's tool follows the same instinct twice over: it is opt-in
  per crew like the room tools, and an agent you have given no room is not even
  *shown* that it exists — which, as a side effect, kept the shared tool surface
  under the definition-token budget without paying the extra round trip a
  lazy-loading index would have cost.
