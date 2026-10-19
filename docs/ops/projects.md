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

## A repository → its project page (CM-3)

A coding agent knows where it is by its git remote; your projects are
**pages**, `Projects/<Name>.md`. The map between them is the page's own
frontmatter, which you write in Obsidian and git carries (invariant 1):

```yaml
---
title: Metistry
repos:
  - git@github.com:foldedspacelabs/metistry.git
  - https://github.com/foldedspacelabs/metistry-instance
---
```

One remote or a list, in whichever clone spelling you copied. The
reconciler's walk reduces each to one canonical shape — `host/path`, the
scheme and any `user@` credential dropped, an SSH `user@host:path` folded
to `host/path`, a trailing `.git` removed, the host lowercased and the path
kept as written (core's `normalizeRepoRemote`, the Context Mode Engine's
shape) — and indexes it into `project_repos (remote, path)`, a derived table
rebuilt whole every cycle (`db/migrations/0042_project_repos_and_sessions.sql`).

**Only your page counts.** `Projects/` is not a user-only directory — the
fold creates entity pages there under its own `source:` — so the walk reads
`repos:` only from a page with no `source:` or `source: user`. A page an
agent wrote never makes a repository resolve to it. Only `Projects/<Name>.md`
is a project page: a note inside a project's folder (`Projects/Drey/Notes.md`)
is *in* the project but does not stand for it.

**Never guessed.** The read is the named query `project_for_repo {remote}`
(`seed/queries/project_for_repo.yaml`): the remote is reduced in SQL exactly
as the walk reduced the stored one, and the answer is the one page that
claims it — path, title, description — or **no row** when none does or when
two do. No fallback on a checkout basename, a title or a path: an unmapped
repository is no project, because a wrong project page in a briefing is
worse than none. No route was added (ruled 2026-10-04).

**Route-only.** The query is `expose: route` (ruled 2026-09-19: a row that
carries a vault path or the owner's own text is never served by the generic
door), so `GET /api/q/project_for_repo` answers only your passkey session,
and an agent's `queries_run` gets the unknown-query refusal whatever its
grant. The consumer is CM-1's session-start briefing, which applies
`canSeeUnder` to the page before handing the handle on.

**Case.** The host is lowercased; the path is kept as you wrote it, because
some hosts keep `Org/Repo` and `org/repo` apart. If a repository's path case
varies between clones (GitHub does not care, so clones differ), list both
spellings — `repos:` is a list.

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

The **Board** tab is the per-card view of the same rows — one Kanban column
per derived state, filtered by project, with the cross-project counts a
project boundary never gets in its way (`docs/ops/board.md`).

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
