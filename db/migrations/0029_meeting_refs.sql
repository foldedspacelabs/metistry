-- 0029_meeting_refs — a calendar event → its meeting note, and an attendee's
-- address → a person page (design-build-plan §2.9, §2.10; today-hub-requests
-- A3 and A4; ticket T1-10).
--
-- Today's Next Up shows a meeting and the people in it. Nothing linked either
-- to the vault: "Open notes" could not tell opening the note from making a
-- second one, and an attendee is an email while a person is a page. These are
-- the two maps, and both are the same shape — `(key, path)`.
--
--   * `vault_meeting_refs (event_id, path)` — from the `event_id:` in a
--     meeting note's frontmatter. Only a note under `Journal/Meetings/` is
--     read, and that directory is the user's at the tool (`isUserOwnedPath`),
--     so no agent can write a note that claims the owner's meeting.
--   * `people_emails (email, path)` — from the `email:` (one address or a
--     list) in a People page's frontmatter, lowercased. Only a page the user
--     owns (no `source:`, or `source: user`) is read: an agent may create a
--     page under `People/`, and a page it wrote never makes an attendee
--     resolve to it.
--
-- Neither table holds a guess. A row exists because a file the owner wrote
-- names the key in a field of its own; nothing is inferred from a filename,
-- a title or a display name. `people_by_email` then refuses to choose between
-- two pages that claim one address — an unmatched or ambiguous attendee
-- renders as a plain name.
--
-- DURABILITY — DERIVED IN FULL (invariant 1). Every row comes back from the
-- markdown: the reconciler's walk reads every note's frontmatter on every
-- pass and rebuilds both tables whole, so `docker compose down -v`, rebuild,
-- one walk, and they are exactly what they were. Nothing here is backed up
-- and nothing here needs to be.
--
-- ADDITIVE (CLAUDE.md, migrations are additive-first): two new tables, no
-- column rewritten, no existing row touched. Every statement is
-- `IF NOT EXISTS`, so applying the file twice is a no-op the second time even
-- outside the runner's own bookkeeping.
--
-- ROLLBACK NOTE: `DROP TABLE IF EXISTS vault_meeting_refs, people_emails;` —
-- after reverting the reconciler's write of them (apps/reconciler/src/
-- indexer.ts `syncPairs`) and `people_by_email`'s read. Nothing references
-- either table — no foreign key in or out, deliberately: `knowledge_files` is
-- derived too, and a derived index that can refuse to be rebuilt is not
-- derived — and the next walk after a re-apply rebuilds both from the vault.
--
-- INVARIANT 3, as 0024 states it: the reconciler already writes the index
-- tables directly; these are two more. Every READ is a named query in
-- `seed/queries/` executed by `packages/queries`.

CREATE TABLE IF NOT EXISTS vault_meeting_refs (
    event_id text NOT NULL,   -- derived: the meeting note's frontmatter `event_id:`, verbatim (ids are opaque and case-sensitive)
    path     text NOT NULL,   -- derived: vault-relative path of the meeting note, under Journal/Meetings/
    PRIMARY KEY (event_id, path)
);

COMMENT ON TABLE vault_meeting_refs IS
  'Derived in full: one row per (event_id, meeting note) — the `event_id:` frontmatter of a note under Journal/Meetings/, which only the user writes. Rebuilt by the reconciler''s walk (plan §2.9, T1-10). The same id in two notes is two rows; the reader decides, the walk never drops one.';

-- "Which event is this note for" — a rename, the note's own page.
CREATE INDEX IF NOT EXISTS vault_meeting_refs_path_idx ON vault_meeting_refs (path);

CREATE TABLE IF NOT EXISTS people_emails (
    email text NOT NULL CHECK (email = lower(email)),  -- derived: one address from a People page's `email:`, lowercased by the walk; the CHECK pins the lookup contract `people_by_email` relies on
    path  text NOT NULL,                               -- derived: vault-relative path of the People page the user owns
    PRIMARY KEY (email, path)
);

COMMENT ON TABLE people_emails IS
  'Derived in full: one row per (address, People page) from the `email:` frontmatter of a page the user owns. Rebuilt by the reconciler''s walk (plan §2.9, T1-10). Two pages claiming one address are two rows, and people_by_email resolves neither — a person is never guessed.';

-- "Which addresses does this page claim" — the person page's own view.
CREATE INDEX IF NOT EXISTS people_emails_path_idx ON people_emails (path);
