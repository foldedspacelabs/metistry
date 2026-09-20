- 2026-09-19 — **The assistant can no longer overwrite a note you wrote by
  hand.** `knowledge_write` is a whole-file replace, and it decided who owns
  a note by reading `source:` out of its frontmatter — but a note you write
  yourself, in Obsidian or any other editor, never carries `source:` at all.
  The original rule read that absence as "nobody owns this yet, so it's free
  to write", which meant a model turn — the evening fold reading your notes
  to write its own — could silently re-emit and replace one you wrote by
  hand. No `source:` now means the note is yours, the same as an explicit
  `source: user`; the assistant still writes and updates its own notes and
  the fold's freely, and can still create anything new, but an existing note
  with no stated author is refused rather than assumed available. The one
  named exception is `now.md`, the single note the assistant is required to
  keep current every day, seeded with its own provenance from here on so a
  fresh instance never needs the exception at all, and closed permanently the
  first time an existing instance's copy is written under the new rule.
