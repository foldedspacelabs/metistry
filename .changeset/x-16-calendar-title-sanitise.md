---
"@foldedspacelabs/metistry-core": patch
---

Ruling 16 (X-16): `{{ calendar }}` sanitises event titles before writing them
into a Journal note. A title is written by whoever sends the invite, not the
owner, so it can no longer break out of its rendered line to open a markdown
heading, a frontmatter delimiter or a task marker, complete a `[[wikilink]]`,
or slip in raw HTML — the whole event still renders on one line, inert.
