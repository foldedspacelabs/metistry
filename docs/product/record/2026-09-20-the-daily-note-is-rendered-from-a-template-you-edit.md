- 2026-09-20 — **The daily note is rendered from a template you edit.** The
  plan, the standup and the fold are produced from markdown files in your own
  vault (`Templates/`), which you edit in Obsidian like any other note — eight
  directives that fill in the day's date, your tasks in the order you asked
  for, tomorrow's calendar, what an agent is waiting on you for, and your own
  prioritisation prose included verbatim. What the engine cannot do is built
  into its shape: a filter never becomes SQL text, a routine rendering a file
  never calls a model, an included file's own directives are never evaluated,
  and a recurring task is written into your note only by your own hand. A
  directive that cannot be satisfied renders one visible line naming the
  template and the line number, and the rest of the file still renders — a day
  with no plan because the calendar was down is the worst possible outcome.
  Every rendered file ends by naming the template and version that produced
  it, and `metistry templates check` tells you whether the edit you just made
  reads, without waiting for the next run.
