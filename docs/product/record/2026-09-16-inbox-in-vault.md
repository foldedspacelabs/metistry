- 2026-09-16 — **The inbox is in the vault, and what you type by hand is
  first-class.** Captures used to land in a gitignored folder beside the
  vault: invisible in Obsidian, absent from every backup the repo provides,
  and gone after a rebuild — the one hole in "git is the record". They now
  live at `Knowledge/Inbox/`, inside the vault Obsidian already opens, and
  they are committed like everything else. The benefit is a sentence that
  could not be said before: **the capture you made on your phone at the
  airport is a file you can open, edit and search on the laptop, in the same
  app as the rest of your notes, and it is in the backup.**
  The other half is the promise underneath it. A note you add to that folder
  by hand, or an edit you make to a capture that is already there, is noticed
  by content hash and goes back into triage — a refinement is treated as new
  information rather than ignored, while a "no" you already gave stays given.
  And the assistant's only write path into the vault can no longer replace a
  file it has not read: omitting the content hash now means *create only*, so
  a correction you make in Obsidian while the assistant is mid-thought wins
  and the assistant is told to re-read. That is a safety mechanism shipped,
  not a prompt asking it to be careful — the difference the whole product
  rests on.
  Large captures (over 5 MiB) go to a `.large/` folder the repo does not
  carry: visible in the vault, out of the history, stated as a trade-off
  rather than a surprise. An instance created before today moves with one
  verb, `metistry migrate-inbox`, which also handles a second instance that
  had already moved its inbox under a different spelling.
  `docs/ops/inbox.md`.
