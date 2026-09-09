# Projects — the §4.21 controls on agent-to-agent review

A **project** (plan §4.19) is the collaboration boundary every other table
already carries as a bare slug: `agents.projects`, `work.project`,
`artifacts.project`. Migration `0011_projects.sql` gives it a row of its
own — not to make the user "create projects" (rows appear lazily the first
time a slug is used, via core's `ensureProject`), but to hold the three
decisions plan §4.21 says must be enforced at the tool, never by prompting:
the kill switch, the daily soft budget, and the bundle cap.

Membership is the grant (§4.21): agents in the same project dispatch review
bundles to each other with no human in the loop. Everything on this page
narrows that — nothing widens it.

## The controls, and their defaults

| Control | Where it lives | Default | What it does at `dispatchReview` |
| --- | --- | --- | --- |
| **mode** `autonomous \| review` (**Auto / Supervised** in the UI) | `projects.mode` | `autonomous` | `review` routes **every** agent-to-agent bundle to a `proposals` row (reason `review_mode`) without touching membership. The user's own dispatches are never routed. |
| **daily budget** | `projects.daily_budget_usd` | `NULL` (none) | Sum of today's `runs.cost_usd` from member agents (or rows stamped `meta.project`) strictly over the budget flips the project to `review` — once per transition. |
| **project bundle cap** | `projects.max_open_bundles` | `20` | Over the cap, the next bundle is created **queued**, never dropped. |
| **agent bundle cap** | `agents.autonomy.max_open_bundles` | `3` | Same, per sender. Checked before the project cap. |
| **may_dispatch_to** | `agents.autonomy` | absent = every member | A sender whose list excludes the recipient gets a proposal (reason `may_dispatch_to`). An empty list means nobody. |
| **accept_from** | `agents.autonomy` | absent = every member | A recipient whose list excludes the sender gets a proposal (reason `accept_from`). `"user"` is accepted in the list but is the default anyway. |

Decision order in `packages/artifacts/src/policy.ts` (`dispatchDecision`):
user's hand → project boundary (`outside_project`) → mode → sender's
`may_dispatch_to` → recipient's `accept_from`. Every proposal carries its
reason in the payload and on the `runs` row.

**Queued bundles.** "Bundles in flight" are `review` work rows that are
`open` or `in_progress` and not yet addressed (a bundle whose threads are
all resolved stops counting, so addressing frees a slot — nothing has to
close the task first). Over either cap the bundle is still ONE work row,
but born `blocked` with `history[0].note = "over_cap: <agent_cap|project_cap> <open>/<cap>"`
and `meta.bundle.queued` set. It is visible, never ready, never claimable.
Resolving a thread in the project releases the oldest queued bundle that
now fits under both caps (one per resolve; history note
`released: under cap`, `runs` op `release_queued`).

**The budget flip.** `enforceBudget` runs at the one place it changes
anything — an agent's dispatch. On the `autonomous → review` transition it
writes a `runs` row (`component=projects`, `kind=project_mode`, meta
`{project, from, to, reason: budget, spend_usd, budget_usd}`) and one
`outbound_messages` alert, deduped on text for 24h. The morning brief
names the flip in its system section; the weekly review counts them. The
budget never un-flips: the user switches back by hand, and if the spend
is still over, it flips again (recorded) without re-alerting that day.

## Routes (passkey session only — this is the user's hand)

| Route | Body | Effect |
| --- | --- | --- |
| `GET /api/projects` | — | The rollup (seed query `projects_rollup`, invariant 3): mode, budget, cap, members, open tasks, bundles in flight / queued, open threads, pending review proposals, today's spend, last activity, and the last mode change with its reason. |
| `PUT /api/projects/:id` | any of `mode`, `daily_budget_usd` (number or `null`), `max_open_bundles` (0..1000), `title`, `area` | Ensures the row (a budget can land before the first agent joins), applies the patch, records `runs` kind `project_admin` (with `from`/`to`/`reason: toggle` when the mode changed). Unknown keys are `400`. |
| `PUT /api/agents/:id/autonomy` | `{ may_dispatch_to?, accept_from?, max_open_bundles? }` | Replaces the agent's narrowing (validated: agent ids, `"user"` only in `accept_from`, cap 0..1000, no unknown keys). `{}` = no narrowing. Audited as `agent_admin` / `autonomy`. |

An owner token or an agent token gets a uniform `403` on all three, like
the rest of the management surface.

## Dashboard

The projects panel shows one row per project: a mode chip reading **Auto** or
**Supervised**, one **→ Supervised / → Auto** toggle (confirm first — setting
it back to Auto re-extends trust to every member), members, counts, spend
against budget, and why it is Supervised (`budget` vs `toggle`, with the
date). The stored values stay `autonomous` / `review`; the labels are the
vocabulary (`docs/product/glossary.md`). Agent narrowing is edited in
the agent's grants form and shown on its registry row.

## Verifying it

```sh
pnpm test                       # packages/artifacts: controls on real rows; apps/console: routes + gate
psql ... -c "SELECT id, mode, daily_budget_usd, max_open_bundles FROM projects"
psql ... -c "SELECT ts, meta FROM runs WHERE kind IN ('project_mode','project_admin') ORDER BY ts DESC LIMIT 10"
```

Rebuilding from the repo (invariant 1): `projects` is DURABLE (D6) — mode,
budget, and caps are user decisions with no upstream copy, so the table is
in the nightly dump with `agents`. Slugs already in use are backfilled by
the migration.
