---
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
"@metistry-apps/reconciler": minor
"@foldedspacelabs/metistry-mcp-brain": patch
---

**The inbox moved inside the vault, and human edits became first-class.**
Captures live at `Knowledge/Inbox/` — Obsidian's vault root is `Knowledge/`,
so that is the only place it can see them, add to them and edit them — and
they are tracked, so git carries them: the inbox used to be the one thing a
`docker compose down -v` rebuild could not bring back (invariant 1).
`docs/ops/inbox.md`.

- **One sink, every door.** `POST /capture`, the `/note` fast path, the
  bridge's `capture` tool and the collectors all write through the
  reconciler's vault bridge with `expected_sha256: ""` — must not exist — so
  a capture can never land on a file someone already wrote. The console still
  holds no part of the instance repo (D5, invariant 7), and each capture is a
  commit. With no bridge configured it degrades to a plain directory: capture
  keeps working, and moving those files into `Knowledge/Inbox/` later is
  enough for the scan below to pick them up.
- **Files you write yourself are indexed.** The reconcile loop already walks
  the vault by content hash, so it now also reconciles `Knowledge/Inbox/`: a
  note you added in Obsidian gets a triage row, an edit to a capture
  refreshes its hash and — if it had already been classified or accepted —
  sends it back to `inbox-drain`, because a refinement is new information. A
  `rejected` row stays rejected; a deleted file archives its row rather than
  losing it; the file coming back re-opens it. No new watcher, no new
  component talking to Postgres (invariant 3).
- **`knowledge_write` can no longer overwrite a note it has not seen.**
  Omitting `expected_sha256` used to mean "unconditional", which meant an
  edit *you* made to a page the assistant owns could vanish with no conflict
  and no trace but the commit. It now means create-only: an existing note
  answers `conflict` with the current hash, so changing a note requires
  `knowledge_read` first. Misuse test ships with it.
- **Big captures.** Above `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB) a
  capture goes to `Knowledge/Inbox/.large/`, which the instance gitignores:
  Obsidian still sees a 40 MB screen recording, the repo does not carry it.
- **`metistry migrate-inbox`** moves an existing instance — files (`git mv`
  for what git tracks), `.gitignore`, and `inbox.path` rows to the
  repo-relative form `db/migrations/0001_init.sql` always documented — with
  `--dry-run`, idempotent, restarting nothing. A second instance that already
  moved its inbox to a lowercase `Knowledge/inbox/` is renamed through a temp
  name, because macOS is case-insensitive and `git mv` would otherwise move
  the directory inside itself.

Migration `0015_inbox_in_vault.sql` is additive: a partial unique index makes
"one row per inbox file" true at the database, since the capture path and the
scan both reach that directory now.
