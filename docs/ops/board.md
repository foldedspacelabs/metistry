# The Board — a Kanban view over `work`

The board is a **view**, not a table. Nothing was migrated and no fifth status
value was added: every column is a `CASE` over columns `work` already carries,
computed once in a named query and read by every surface.

Origin: `docs/research/2026-09-12-hermes-agent-review.md` — "skip Hermes as a
dependency, adopt the view". This page is phases 1 and 2 of that note's §8.
Phase 3 (the drags) is not built.

## Where it lives

| Piece | File |
| --- | --- |
| The cards | `seed/queries/board.yaml` (`GET /api/q/board`) |
| The cross-project counts | `seed/queries/board_projects.yaml` (`GET /api/q/board_projects`) |
| The panel | the **Board** tab in `apps/console/web` |
| The tests | `apps/console/test/seed-queries.test.ts`, `apps/console/test/pwa.integration.test.ts` |

Invariant 3 holds: the panel calls `/api/q/<name>` and nothing else. The
columns are decided **server-side**, so the Mac app renders the same rows with
no extra server work — the query returns plain scalar columns on purpose.

## Scope: which rows are cards

`kind = 'task'` or `'review'` — the two kinds the tasks module owns
(`CLAIMABLE_KINDS`, ruling 2026-09-06). Rows a collector reconciles from a
source of truth (`issue`, `pr`, `event`) are visible in `work` but never
claimable, so "assigned" and "in progress" would be lies about them;
`open_work` and `projects_overview` stay the view over those.

## The six columns

Read top to bottom: the **first** matching rule wins, so the list is a
decision order, not a set of overlapping filters.

| Column | Predicate | What it means |
| --- | --- | --- |
| **Backlog** | `status = 'open'` AND `owner IS NULL` | Nobody's name on it. Any agent may claim it. |
| **Assigned** | `status = 'open'` AND `owner IS NOT NULL` | Addressed to someone and not started. `claim()` sets `status = 'in_progress'` in the same statement, so *open + owner* is exactly "assigned but not started". |
| **In Progress** | `status = 'in_progress'` | Claimed. A **lapsed lease is still in this column** — the row says in progress, and the `escalated` flag says it stalled. Moving it elsewhere would hide that a claim was dropped. |
| **Needs You** | `status = 'blocked'` | The human-gated state. `UpdateInput.status` is `Exclude<TaskStatus, 'open'>`, so *nothing in the system can move a blocked row forward* — there is no route back to `open` today (§4.1 of the note). Only your hand. |
| **Done** | `status = 'closed'` and no report | Finished, nothing came back. |
| **Reported** | `status = 'closed'` and a report landed | Finished, and there is something to read. |

**Done vs Reported** is the note's §4.5: it is not on the row. It is
reconstructed from the one confirmed join between a `work` row and what an
agent produced — `crew-drain.ts` stamps `runs.meta.work_id` when it claims a
row and merges `reports` (the `mcp__brain__report` call count) when the run
finishes. `last_report_at` is the latest such run; a run with `reports: 0`
leaves the card in Done, which is the point — a crew that produced nothing
should not look like one that produced a finding.

## `escalated` — and one thing it is not

`escalated` is a boolean on every card. It is true when the row is not closed
and any of:

- the lease lapsed mid-flight (`in_progress` and `lease_expires_at <= now()`);
- it is `blocked` and **not** merely queued over a cap (`meta.bundle.queued`
  unset — an over-cap review bundle releases itself when a slot frees, §4.21,
  so it is not your problem);
- it is past `due`.

**It is not "a pending decision proposal cites this row."** The research note
proposed that join and flagged it unverified; it does not exist. Checked
against every `INSERT INTO proposals` in the tree: `decision` proposals carry
`{title, options, message_id, thread, in_reply_to}` (a chat message),
`review` proposals carry an artifact, a version and a thread, `report`
proposals carry free-text `refs`. **No proposal kind carries a work id**, so
there is no way to ask "which proposal is about this card". Either a future
migration adds one, or Needs You stays what it is here — which is arguably
more correct anyway, because `blocked` is *already* the state nothing but a
human can leave.

The panel labels the flag from fields on the wire (`lease lapsed` / `blocked`
/ `overdue`) so a red chip says why. The **decision** stays in the query.

## How to read it

- **Column headers count every card**, not the rendered ones. `limit` is **per
  column** (default 50), so a busy Backlog never crowds Needs You out of the
  page; when a column is capped the header says `showing N`.
- **The red number** beside a count is that column's escalations.
- **Ordering** is board order, then most recently touched first.
- **The project filter** comes from `board_projects`, so it only ever offers
  projects that have cards. `[` and `]` step it. Rows with no project (the
  user's default project) are counted under *all projects* and have no option
  of their own.
- **Clicking a card** opens the artifact a review bundle was cut from — the
  one card detail the console has today. Other cards are not clickable,
  because a click target that does nothing is worse than none.
- **It polls every 10 s** while the tab is visible, like the feed. Both
  queries are `cache_ttl: 0`: a board that lags lies about who holds a lease.

## Cross-project — the thing Hermes cannot do

`board_projects` is one row per `project × column` with `cards`,
`escalations`, `oldest_age_hours` and `last_activity`. Hermes makes a board
the isolation unit ("linking tasks across boards is not allowed"), so its
dashboard has a board *switcher*, never a cross-board board. Ours is a
`GROUP BY` on a column `work` already had.

The two queries repeat the same `CASE` verbatim rather than approximating each
other, and a test asserts the counts match the cards — if they ever drift, the
filter's labels start lying.

## What phase 3 adds

Not built, deliberately: **if the board is not useful read-only, the drags
should not be written** (the note's §8). When it is, phase 3 closes three
service gaps (`reopen()`, `assign()`, a `note` on renew), adds a thin console
adapter over `TasksService`, and wires the note's §6c policy table — with the
rule that keeps invariant 8 honest: *the board offers no drop the service
would refuse.* Nobody drags into In Progress; that column is owned by the
lease. Until then there is no `draggable` attribute, no drop target and no
mutating control in the panel, and a test asserts it.

## Verifying it

```sh
pnpm test   # apps/console: one fixture per column, the escalation flags, the per-column limit
curl -s --cookie "$SESSION" "$ORIGIN/api/q/board?project=&limit=50"       | jq '.rows[0]'
curl -s --cookie "$SESSION" "$ORIGIN/api/q/board_projects"                | jq '.rows[]|{project,column,cards}'
```

Rebuilding from the repo (invariant 1): nothing here is durable state. Both
queries are derived views over `work` and `runs`; drop the database, re-run the
migrations, and the board is whatever the rebuilt rows say it is.
