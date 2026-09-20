- 2026-09-20 — **The fold has its own file; your daily note is yours.** The
  evening fold used to write straight into `Journal/<date>.md` — the same
  file you write in by hand. It now writes `Journal/Fold/<date>.md` instead,
  and the ownership rule that already refused an assistant write to a note it
  does not own (`source:` neither its own nor the fold's) now backs that up
  at the tool: nobody, not even the fold, edits your daily note again. When
  you have stamped `Templates/Fold.md`, the fold renders it itself — dates,
  your requests, an included section verbatim — and only asks a model to fill
  the handful of prose slots the template marks as its own, in one turn, over
  a rendered skeleton it cannot touch anywhere else. An instance that has not
  stamped that template yet loses nothing: the fold writes the same freeform
  note it always did, still at the new path, with one visible line saying why
  there was no template to render.
