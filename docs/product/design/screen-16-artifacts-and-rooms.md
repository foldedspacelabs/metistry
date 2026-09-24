# Screen 16 — Work ▸ Artifacts, and task threads

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

## 2. Task threads — no Rooms list (C89)

**Ruled 2026-09-23: ruling 4 stands.** Round E first drew Rooms as a Work child
with its own list; ruling 4 (2026-09-18) had already demoted it, and nothing
reversed that. A thread lives where its subject lives: an artifact's in its
margin (§1), a task's in its card detail (screen 14, C84).

One table still serves both anchors (`docs/ops/threads.md`).

- **Finding threads:** Board's filter row gains **Has Thread**, and a card with a
  thread shows the thread glyph and its message count. A thread that hit the cap
  puts a `review` request in Needs You (C96), which is where the owner learns of
  it; the card says **Came to you**.
- **Open Room**, from card detail, opens the thread as a pane over Board, with
  **Board still selected** in the sidebar: the escalation band when it came to
  you; the conversation, agent turns on the 2px agent rule in the reply serif,
  your turns in the accent wash; the pips and *yours resets it* above the
  composer.
  - **The composer is *Add to the Room*** — no @, no recipient. A room cannot
    address anyone; posting wakes nobody; agents read it when they pick up the task.
  - **Resolve** is the owner's alone, and a resolved room still takes messages.

## 3. What this asks of the build

Nothing new. The artifact list, versions, files, diff and comments are routes
today; a task's thread comes from the `rooms` query with the agent tail and the
escalation reason. Build ask: `board` returns `has_thread` and a message count
per card, so the filter and the glyph need no second read.

## Corrected 2026-09-23 (review 01)

Agent turns in a room take the reply serif on the 2px rule, as in Chat; the
composer is *Add to the Room*; clock times carry AM/PM.
