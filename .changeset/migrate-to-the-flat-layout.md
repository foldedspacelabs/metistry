---
"@foldedspacelabs/metistry-cli": minor
---

**`metistry migrate-layout` moves an existing instance onto the flat layout.**
The 2026-09-17 ruling shipped for new instances; this is the verb that carries
an old one across. `git mv` for what git tracks and a plain move for what it
does not: the config half into `.metistry/`, the gitignored `state/` with it,
every entry of `Knowledge/` up to the instance root (`Knowledge/CLAUDE.md`
becomes the root `CLAUDE.md`, a `Knowledge/.obsidian/` comes up too), a
pre-#156 root `inbox/` normalised and merged into `Inbox/`, the `.gitignore`
rewritten with your own lines kept, and one commit at the end. It restarts
nothing.

The whole plan is read off the filesystem *before* anything moves, so a name
collision between `Knowledge/` and the instance root is refused with both
sides named and the tree exactly as it was. A dirty git tree is refused too
(`--allow-dirty` overrides), and a running reconciler is named in a warning —
it is the instance repo's sole committer, and it would otherwise sweep the
migration into commits of its own halfway through.

Stored paths follow in ONE transaction: `Knowledge/` drops out of
`knowledge_files`, `knowledge_links`, `embeddings`, `inbox` and
`projects.area`, a pre-2026-09-16 bare capture filename becomes
`Inbox/<file>`, and a read grant covering the whole vault becomes `/`. With no
database configured the rewrites are named and skipped rather than failing, so
the files still move. `--dry-run` prints every move and every row count and
touches nothing; `--json` reports the result.

The Mac app reads both layouts now — a legacy folder is adopted, not refused,
and Status and the first-run wizard both say "Legacy layout — run `metistry
migrate-layout`". `metistry connect`'s editor configs were already free of
instance paths; a test now holds them that way.
