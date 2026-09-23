# Screen 16 — Work ▸ Artifacts and Rooms

New, 2026-09-23. **Owner's ruling:** comment threads sit in the margin beside the
lines they are about, not in a list below.

## 1. Artifacts

An artifact is a folder in git (`Artifacts/<project>/<slug>/`); every version is
one commit, and the database is a rebuildable index (0010). Comments are on an
**exact version**, optionally pinned to one file and a line range.

- **The list:** title and slug, project, kind, **latest** (version and who made
  it), open threads across all versions, updated.
- **An artifact:** the version rail on the left (version, author, message, when);
  the version at reading width; threads in the right margin, **level with their
  highlighted lines**.
  - **When two threads would collide, the lower one moves down** and keeps a
    leader to its line; replies fold to a count. Verified by measurement: the
    first thread sits at 0px from its line, the pushed one 35px below with an 8px
    gap between cards.
  - Switching version in the rail shows that version's threads.
- **Compare:** the diff between two versions. A thread about a line that changed
  stays on its version and says so — *1 thread on v2 is about a line v3 changed. It
  stays on v2.* — with **Open on v2 →**.

## 2. Rooms

One table serves both anchors, an artifact version and a work row
(`docs/ops/threads.md`).

- **The list:** anchor glyph, title, **who has spoken** (a room has no members),
  message count, and **agent turns in a row** as ten pips against the cap. A room
  that hit the cap says **Came to you** and the stored reason, as a sentence.
- **A room:** the escalation band when it came to you; the conversation with the
  2px agent rule and your turns in the accent wash; the pips and *yours resets
  it* above the composer.
  - **The composer is *Add to the room*** — no @, no recipient. A room cannot
    address anyone; posting wakes nobody; agents read it when they pick up the task.
  - **Resolve** is the owner's alone, and a resolved room still takes messages.

## 3. What this asks of the build

Nothing new. The artifact list, versions, files, diff and comments are routes
today; rooms come from the `rooms` query with the agent tail and the escalation
reason on each row.
