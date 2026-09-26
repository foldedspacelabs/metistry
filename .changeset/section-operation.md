---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/reconciler": minor
---

**The section operation: one writer per region in the owner's daily note
(plan §2.13, T2-6).** The reconciler serves `POST /vault/section {path,
marker, body, principal, expected_outer_sha}`: it replaces the bytes between
`<!-- metistry:day -->` and `<!-- /metistry:day -->` in `Journal/<date>.md`
and nothing else, appending `## Today · Metistry` with the markers the first
time. It refuses `section_missing` (409) unless the note has exactly one
clean pair outside any code block or frontmatter — two pairs, a lone marker,
a marker quoted in code, an annotated one — and `conflict` unless the bytes
outside the region hash to `expected_outer_sha`. Its writers are enumerated
(`morning-brief`, `user`) and bounded by the bearer as every mutation is;
every other non-user write to the note is still refused by `writeAllowed`.
Optional `run` / `turn` make the section part of its run's commit, so a
Morning Brief's brief file and section are one commit (plan §2.21).

`@foldedspacelabs/metistry-core` adds the grammar callers hash with —
`scanNoteSection`, `writeNoteSection`, `NOTE_SECTIONS`,
`sectionMissingMessage` — and the `section_missing` error code (`409`).
