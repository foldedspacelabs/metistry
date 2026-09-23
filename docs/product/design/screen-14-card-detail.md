# Screen 14 — Card detail

New, 2026-09-22. The popover that opens from any card on Board or Today.

**Owner's rulings, 2026-09-22:** every card click opens this popover, with the
thread as a section inside it (C84); and work rows gain a short description (C85).

## 1. One layout, two kinds of task

The lead mark says which kind before anything is read — the **board glyph** in
`agent` for a work row, a **checkbox** for your own line — the same distinction
Today draws (screen 5 §2). Both open with the **title** and the **six facets in
their fixed order** (priority · due · estimate · people · links · state).

### A work row — an agent holds it

| Section | From |
| --- | --- |
| Description | new field (C85) |
| Held by | `claimed_by`, `lease_expires_at`, the column |
| Blocked by | `depends_on`, resolved to title and state (C37) |
| Thread | `has_thread`, last comment, **Open room →** |
| History | `history` — time, who, what |

Verbs: **Comment · Open On Board**. The review artifact it was cut from sits in
the footer. It is not yours to complete.

### A markdown task — a line in your note

**In your note:** the heading above the line and its neighbours, the line itself
highlighted, the path beside the label. The note is the description.

Verbs: **Complete · Open In Obsidian · Hand To An Agent** — Today's verbs, in
Today's order.

## 2. What this asks of the build

1. **A description on work rows (C85)** — short text, set by whoever creates the
   row, editable by the owner.
2. **Blocked by (C37)** — `depends_on` is on the row; the board query returns it
   resolved.
3. **Note context** for a markdown task, through the vault query.
4. `history`, the lease and the review artifact are already on the row.
