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

## A card can be born from a proposal

Most cards arrive from `tasks_create`, from a crew's dispatch, or from a
collector reconciling a source of truth. One more door exists since
`docs/research/2026-09-16-taskuary-review.md` ADOPT 2: **Approve as Work** in
Needs You. A `knowledge` or `report` proposal whose payload carries
`suggested_work` — which the drain sets deterministically for a `todo`-shaped
capture, no model — offers one extra answer, and the click inserts the `work`
row and links it back as `proposals.work_id`.

Such a card lands in **Backlog**: `status = 'open'`, `owner IS NULL`, no claim.
That is not a default nobody thought about — accepting a capture says *this
should get done*, not *this is So-and-so's*, and addressing it to somebody
would be a second decision the click did not make. Any agent may claim it, like
any other backlog card.

§4.12 is intact throughout: nothing auto-creates a card. The drain still emits
only proposals, and a suggestion nobody accepts stays a suggestion.
`docs/ops/reply-feedback.md` has the verb.

## `escalated` — and one thing it is not

`escalated` is a boolean on every card. It is true when the row is not closed
and any of:

- the lease lapsed mid-flight (`in_progress` and `lease_expires_at <= now()`);
- it is `blocked` and **not** merely queued over a cap (`meta.bundle.queued`
  unset — an over-cap review bundle releases itself when a slot frees, §4.21,
  so it is not your problem);
- it is past `due`.

**It is not "a pending decision proposal cites this row."** The research note
proposed that join and flagged it unverified. When this page was written the
join did not exist at all: checked against every `INSERT INTO proposals` in the
tree, no proposal kind carried a work id. Migration `0018` added
`proposals.work_id` and two paths set it — a work thread past the ping-pong cap,
and an Approve as Work above — so the join is now *possible*. It is still not
what `escalated` means, deliberately: `blocked` is already the state nothing
but a human can leave, and a card is not more stuck because somebody filed a
note about it. If that ever changes it should change in `board.yaml`, as a
fourth clause with its own sentence, rather than by widening one of these
three.

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
