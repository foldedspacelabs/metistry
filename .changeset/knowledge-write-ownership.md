---
"@foldedspacelabs/metistry-mcp-brain": minor
---

**Behaviour change: `knowledge_write` refuses a note with no `source:` in its
frontmatter, instead of treating it as free to write.** A hand-written note —
one you wrote in Obsidian, an editor, or on another device — never carries
`source:`, and `knowledge_write` is a whole-file replace. The old default
read "no source" as "nobody owns this yet", which meant the assistant could
read a note you wrote by hand and re-emit it whole from a model turn,
overwriting it. It is now treated the same as an explicit `source: user`:
the assistant's own notes, and the evening fold's, still write and update
freely; every other existing note — including an unsourced one — is
`forbidden` ("owned by \<source\>; propose instead") and new notes are still
always free.

The one exemption is `now.md` at the vault root, by exact name: the seed
template now ships it with `source: assistant` so a fresh instance never
needs the exemption, but an instance created before this change has a
`now.md` with no frontmatter yet, and the assistant is required to keep
writing it every day. The exemption stops mattering the moment `now.md` is
stamped once, which the very first write after this change does.

If you have written knowledge to your vault by hand and want the assistant
to be able to update it going forward, the assistant can `propose` the
change instead, or you can add `source: assistant` to that note's
frontmatter yourself.
