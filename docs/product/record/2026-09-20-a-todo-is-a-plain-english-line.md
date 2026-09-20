- 2026-09-20 — **A todo is a plain English line, and Metistry reads it.** A
  task is a `- [ ]` line in your own note, typed the way you would say it:
  `Draft the Q4 plan due friday p1 size l type planning +drey`. The fields are
  a run at the end of the line, so the first word that is not one of them ends
  it — `Ask @Jim about the pricing deck` assigns the deck to nobody, and your
  sentence survives intact. Everything Metistry works out from that line — the
  date behind `due friday`, the person behind `@Jim`, the four-level priority
  behind `critical` — it works out on read and keeps in its own index; the
  bytes in your note are never touched, so there is nothing to opt out of. A
  field it cannot read is never guessed: `due nextweek` produces one visible
  line in the day's plan naming the token, not a date you did not mean. If you
  already use Dataview or the Obsidian Tasks plugin, their syntax is read too,
  and never written back. The same day's second piece is the filter language
  the plan, the app and the plugin all share — `due <= today or overdue` — so
  a view you build in one place can be pasted into another. It compiles to
  bound parameters of a single named query and is refused outright if it is
  anything but the vocabulary: a filter carrying SQL never reaches the
  database as text, because the code that would have to quote it does not
  exist.
