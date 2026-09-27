---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-mcp-brain": minor
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/console": minor
"@metistry-apps/routines": minor
---

The Morning Brief (T3-6; plan §2.13, §2.5; C97, C102, C103, C111). At 07:00 on
a working day `morning-brief` renders `Templates/Brief.md` (seeded) into
`Journal/Brief/<date>.md` as principal `morning-brief` — the standup embedded
by reference, today's timed meetings under **Next Up**, what is waiting on you
— writes the daily note's `metistry:day` section model-free through
`POST /vault/section` (never creating the note; broken markers raise one
`note` request), and enqueues ONE assistant turn for the file's prose slots.
File and section are one commit: the runner now hands every run its
`ctx.runId`. The chat message stays, opening with the file.

**C103 — prose outside fold templates.** Core's `PROSE_SOURCES`
(`knowledge-fold`, `standup`, `morning-brief`) is where `{{ prose }}` renders a
slot; every other writer still gets the refusal note, now `PROSE_REFUSAL`. New
`prose-slots.ts`: `fillProseSlots` accepts a change to a pending slot's line —
one line of prose, no block, no comment — and nothing else, and marks each
filled line `<!-- metistry:written N -->`. `JOURNAL_MACHINE_DIRS` gains
`Brief`; `JOURNAL_ROUTINE_DIRS` / `journalRoutineOf` name the routine that owns
each folder it writes. `CalendarEvent` gains `attendees`.

**`knowledge_write` in a routine's own folder** (`Journal/Brief/`,
`Journal/Standup/`, `Journal/Plan/`) now does exactly one thing: fill the
pending prose slots of a file the routine wrote, in the routine's name with the
reply's turn. A create there, `Journal/Plan/` at all, a file the routine does
not own, a stale hash, or any other changed byte is refused — before this, the
assistant could create a file in those folders and pre-empt the routine's own.

The Standup enqueues the same one turn when its template has `prose` (the
seeded one has none). The console's vault client gains `section`, surfacing
`section_missing` by code. `metistry templates check` knows `Brief.md` renders
as `morning-brief`.
