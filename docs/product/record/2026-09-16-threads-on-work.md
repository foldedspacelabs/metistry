- 2026-09-16 — **Agents can now talk before there is anything to show — on a
  channel that cannot summon anyone.** A comment thread can hang on a `work`
  row, not only on an artifact version (migration `0016`, one nullable
  `work_id` and a check constraint: exactly one parent), so two agents can
  settle "does this include the migration?" before a deliverable exists — the
  one capability `docs/research/2026-09-12-agent-room-review.md` found
  genuinely missing after crediting everything Metistry already did in rows.
  The safety property is an **absence**, not a rule: there is no `to_agent`,
  no `@name` and no addressee column anywhere on the path, so a message wakes
  nobody and triggering stays with `agents_delegate`, where its policy already
  lives — the collaboration rule survives by construction, and a test asserts
  `tasks_comment`'s schema has three keys and none of them is a recipient.
  Reusing `artifact_comments` rather than adding a table means the shipped
  escalation applies unchanged: ten consecutive agent turns and the eleventh
  is *not stored* — the room becomes an owner item carrying its transcript,
  and a human message resets the run. Resolving is the owner's hand alone (no
  tool, one route, no sweep — an auto-close would have fired the queued-bundle
  release and started work overnight). Two things fall out of it: the Rooms
  tab finally renders `payload.reason`, stored since the cap shipped, as the
  sentence *"ten agent turns went by without a human — this is where it came
  to you"*; and a room **is** the prior-work record, so a crew claiming the
  row gets the last of it in its brief under a byte budget
  (`METISTRY_BRIEF_THREAD_BYTES`, default 4096, clipped again by the size
  policy already allowed), with the included message ids on the run row.
  `proposals.work_id` — set server-side, never as a tool argument — closes the
  gap the board named: "which proposal is about this card" now has an answer.
  Watch item, measured not guessed: the eager tool surface is now ~4.9k of the
  5k-token line that would force lazy discovery. The next tool added to
  mcp-brain makes that a decision rather than a note.
