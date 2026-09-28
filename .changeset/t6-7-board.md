---
"@metistry-apps/macos": minor
"@metistry-apps/console": patch
---

**Work ▸ Board on the Mac, with the card detail and a task's room (T6-7).** Five columns — Done compact and folding to a strip in a narrow window — each card showing its column's one facet; headers counted from `board_projects`, never from the capped cards; the project filter and Has Thread. A column draws a drop target only where the task service would accept the move, each drop is one route, and a refused move goes back with the server's own sentence. Every card opens its detail (description editable by the owner, who holds it, what it waits on, its thread and Open Room); a task's room opens as a pane over the board with *Add to the Room*, the came-to-you band and Resolve. Fixes `TaskPatch.moving(to: "done")`, which sent `status: "done"` — not a task status — and now sends `closed`; Assigned → Backlog sends `owner: null`. The fixture recorder records `board_projects` for the kit.
