# Screen 13 — Work ▸ Projects

New, 2026-09-22. **Projects appear on first use** — a project row exists the first
time a task, agent or artifact names it (migration 0011: "the user never has to
create a project"). So there is no New Project.

**Owner's ruling, 2026-09-22 (D13):** a project holds permissions, and every agent
in it inherits them by default.

## 1. The list

One row per project: **name**, **mode**, **agents**, **work** (open · blocked),
**spend today** against the budget, **last activity**. All of it comes from
`projects_rollup` today.

**Mode is read first after the name, and it uses the channels honestly (C83):**

| State | Mark | Channel |
| --- | --- | --- |
| Autonomous | quiet outline | none — the default |
| Review, chosen by you | heavier outline, review glyph | **weight**: it matters more, nothing is wrong |
| Review, forced by budget | warning tint, *over budget* | **tint**: this one is a fault |

§3.12 of the design system gave review `presence-blocked` in every case; a mode
you chose is not a fault, so the tint is kept for the budget case only.

## 2. A project

- **Header** per §3.12: name, mode chip, the review toggle, and a footnote —
  *$5 a day · 20 handoffs at once*, or *review since 2:40 PM (over budget)*.
- **In flight:** open, blocked, handoffs in flight, queued, open threads, spent today.
- **Permissions**, labelled *every member gets these*, in the same table as
  Agents (C58) so access reads one way everywhere.
- **Agents:** each shows only what it has **beyond** the project — *+ Areas/Finance*
  — or *project access only*. On an agent's own page, inherited access carries the
  project's name as its provenance (amendments §3.2).
- **Recent runs**, each linking to Run detail.

## 3. Over budget

The project puts itself in review. The header says when, why and what changed, in
one sentence — *Went over its $3 budget at 2:40 PM. Handoffs between agents now come
to you.* — with **Raise Budget** beside it.

## 4. Confirmations

- **Back to autonomous:** *Its agents will hand work to each other without you
  again.* Destructive role on the button (§3.12, P3).
- **Into review:** *3 handoffs in flight will wait for you.*
- **Adding an agent:** names exactly what it inherits. Joining a project **is** a
  grant, and this is the one place inheritance could otherwise hide one.

## 5. What this asks of the build

1. **Project grants** (D13), inherited by every member, with the project as
   provenance wherever the grant is shown.
2. **Why a project is in review** — owner or budget, and when.
3. **Rename the area rollup (C82):** `projects_overview` groups by Knowledge area,
   so the dashboard panel and the morning brief's section become *Areas*.
4. `projects_rollup` already returns everything else on the list.
