---
"@foldedspacelabs/metistry-core": minor
---

**A todo is a plain English line, and Metistry reads it.** Two new pieces of
public API in `core`, both pure: `parseTaskLine` / `formatTaskLine` for a
`- [ ]` line in a vault note, and `compileTaskFilter` for the `where:` /
`order:` vocabulary that templates, the app's filter chips and the Obsidian
plugin all speak.

The fields on a task line are English-shaped trailing tokens — `- [ ] Draft
the Q4 plan due friday p1 size l type planning +drey` — and they are a run at
the END of the line: the first token that is not a field ends it, so `Ask
@Jim about the pricing deck` assigns nobody and the text stays exactly as
typed. `due friday` resolves against `METISTRY_TZ` and the day it was read on,
which is recorded, so a relative date is never silently re-read as a different
one tomorrow. A field Metistry cannot read is never guessed: `due nextweek`
sets no date and sets a parse warning instead. Dataview's `[due:: 2026-09-22]`
and the Obsidian Tasks plugin's emoji are read, so a vault that already uses
them is not locked out, and nothing here can emit either one back.

`compileTaskFilter` turns `where: "due <= today or overdue"` into bind
parameters for one named query. It is not SQL, it is never interpolated into
SQL, and anything outside the closed vocabulary is refused with a message the
caller renders — a `where:` containing SQL is refused, not escaped.
