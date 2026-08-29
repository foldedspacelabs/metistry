# Plan review synthesis — 2026-08-29

Four independent staff-level reviews of the build plan, run pre-implementation
at the owner's request: **security boundaries** (01), **architecture &
simplification** (02), **coherence & consistency** (03), **user voice** (04).
Full reports alongside this file. This synthesis consolidates, notes where
reviewers converge or conflict, and ends with a prioritized decision list.

## The headline: three well-defended flanks, three undefended ones

Each reviewer independently found the same *shape* of gap — the plan defends
brilliantly against the failure modes Phase 0 measured, and thinly against an
adjacent one it hasn't:

| Defended (with evidence) | Undefended (each reviewer's core finding) |
|---|---|
| Prompt-level failure → enforce-at-the-tool | **Authorization by convention** (01): shell/git reach of the engine, bridge auth, token tiers, XSS — each "enforced" by an unwritten assumption |
| Cost runaway → deterministic routing, budgets, watchdog | **Operational failure** (02): no update rollback, two git committers, a `runs` table blind to in-flight calls — "nobody will attack this before Postgres fills a disk" |
| Money-driven abandonment → the strongest cost architecture reviewed | **Attention-driven abandonment** (04): 13 features independently route into an unspecified morning brief; 10–25 decisions/day vs a real budget of ~5 |

## Critical items (fix before any implementation)

1. **Write the missing invariant** (01-crit-1): the engine container has **no
   shell and no raw git** — `brain-commit` + allowlisted bridges are the
   entire mutating/outbound surface. Every §4.6 governance claim collapses
   without it.
2. **Propagate the product/instance split into the file layout** (02-crit-1):
   `queries/`, `agents/`, `routines/`, `rules.yaml` need an instance-side
   home with product defaults and a filename-wins overlay; `now.md` →
   `Knowledge/now.md` (currently `brain-commit` cannot write it); rewrite
   §4.6's protected paths for the two-repo reality. "Adding a query is a
   file, not a deploy" is currently false.
3. **TCC bridges must bearer-authenticate the container** (01-crit-2):
   loopback is reachable from the container (PoC-4 proved it) and is not a
   trust boundary; today a container compromise drives the whole TCC surface
   unauthenticated.
4. **Token privilege tiers + output encoding** (01-crit-3/4): management
   endpoints require the owner credential, never an agent token (else agents
   self-accept their own proposals); all agent-authored text is
   output-encoded in the PWA (stored XSS currently upgrades a tier-0 capture
   token into management compromise).
5. **Reconcile invariant 1 with the schema** (02-crit-2): four of eight
   tables hold non-derivable state (`runs`, `sessions`, `inbox` triage,
   `work` threads/tasks). Label durable vs derived; make the nightly dump
   load-bearing for the durable set; make the quarterly drill a real
   down-v/rebuild.
6. **One git committer** (02-crit-3): the reconciler commits; `brain-commit`
   becomes write+enqueue. Give the reconciler a home (`apps/reconciler`,
   `runs_on: host`, manifest `type: service`)