# Journal

Your day, `Journal/<date>.md`, made from `Templates/Daily.md`. Type here
directly — this file is yours. Metistry writes one part of it and nothing
else: the text between `<!-- metistry:day -->` and `<!-- /metistry:day -->`
under **Today · Metistry** — the day's plan, meetings and standup at the
Morning Brief, what happened when you close the day. Move the section
anywhere; delete both markers and the heading and it is added at the end
next time. A broken marker stops the write and asks you in Needs You —
Metistry never guesses where your text ends.

Alongside it, Metistry keeps four machine-owned files nobody else writes:

- `Brief/<date>.md` — the Morning Brief: what matters today, the standup
  (embedded), Next Up for each meeting, written by `morning-brief`.
- `Plan/<date>.md` — tomorrow's plan, written by `plan-tomorrow` the
  evening before.
- `Standup/<date>.md` — a yesterday / today / blockers draft, written by
  the `standup` routine each morning.
- `Fold/<date>.md` — what happened and what was decided, written by the
  evening fold.

`Meetings/<date>-<topic>.md` is yours too, for notes you take live.

One writer per file, one writer per region of your daily note
(`docs/product/daily-flow-spec.md` §5.1). To change what any of the machine
files look like, edit the matching file in `Templates/` — never the dated
file itself.
