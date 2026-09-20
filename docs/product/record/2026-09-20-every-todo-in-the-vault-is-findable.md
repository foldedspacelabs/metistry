- 2026-09-20 — **Every todo in your vault is findable within a reconcile.**
  The pass that already walks your notes and hashes them now also reads every
  `- [ ] …` line in them, so a task you typed in a meeting note three weeks
  ago is as findable as one you typed this morning — with due dates,
  priorities, who it is waiting on and how long it has been carried — and
  without a single copy of it living anywhere but the line you typed. Nothing
  is written back into your notes: the parser reads loosely, resolves
  `due friday` and `@Jim` against the day it read the line and the people in
  your vault, and puts the answer beside the line rather than in it. The
  identity degrades honestly, which is what makes the index safe to trust
  before there is any plugin minting ids: change a date on a line and it is
  the same task, re-type the words and it is a new one, and the clock that
  says how long something has been sitting survives both a re-walk and a
  rename. The files that merely *show* your todos — tomorrow's plan, the
  fold, the standup — hold none of them, decided by the same ownership rule
  that stops the assistant overwriting a note you wrote, so nothing is ever
  counted twice. And an agent waiting on something only you can do now says
  so on its card, while still being free to do everything else: the wait is
  visible and it never blocks.
