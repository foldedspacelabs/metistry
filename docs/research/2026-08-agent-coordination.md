# Agent-coordination landscape — Metis as hub (2026-08-28)

Research sweep on coordinating heterogeneous AI agents (different vendors/
architectures) via shared knowledge, context, and task lists — evaluating the
idea of Metis as the coordination layer. Primary sources weighted (specs,
repo metrics, GitHub issues, arXiv); 2026 SEO sludge discounted. Companion to
`2026-08-prior-art-review.md`.

## Verdict: no standard worth adopting — roll it MCP-native. And it's small.

**A2A** (Google → Linux Foundation → AAIF, v1.0): a *federation* protocol for
mutually-untrusting organizations — capability discovery, task lifecycle.
Metistry is not a federation: one user, one trust domain, manifest-declared
endpoints. The agent surfaces Metistry actually coordinates (Claude Code,
Codex CLI, work coding agents) speak **MCP**, not A2A — A2A's native support
lives in orchestration frameworks Metistry doesn't use. And the one thing
Metistry would need — verifiable agent identity and scoped authorization —
is exactly what A2A leaves unspecified (open issue #1575, no maintainer
response; governance spec still RFC-stage). Zero named production users in
the LF's own press release. **Reject; stay watchful of AAIF.**

Two strong priors from adoption data: the cross-vendor standard that
actually won is **AGENTS.md — a markdown file at a known path** (60k+ repos,
read by 30+ agents) — boring shared substrate beats protocol; and the
coordination-MCP-server category exists (six independent projects) with
**identical primitive sets and 7–32 stars each** — a personal-scale problem
people solve for themselves in a few hundred lines, not a product category.

## The convergent primitives (every serious system landed here independently)

Beads (26.7k★, git-backed agent issue tracker), Claude Code's own
experimental Agent Teams, llm-bus, Agent Task List MCP — all converged on:
**atomic claim** (assignee+status in one operation, never read-then-write),
**leases with TTL + heartbeat** (a dead agent must not strand a task),
**append-only shared ledger**, **dependency edges with auto-unblock**
("ready work" is a lie without them), **per-agent inboxes** (pull, not
push). Claude Code ships this Claude-only, behind a flag, with "task status
can lag" as a known limitation. Nobody has a cross-vendor version with
adoption — that's the gap Metis fills for its own user.

## Failure evidence that shapes the design

- **Claude Code issue #54393** (12 coordination bugs in one overnight run):
  audit-log impersonation via self-declared agent fields; forged
  user-authority files; "integrity surfaces measure shape, not substance";
  task-creation explosion with no dedup; state-plane divergence — agents
  embedding full specs in messages instead of referencing canonical files,
  copies drifting "within minutes."
- **Governed shared memory** (arXiv 2606.24535): four failure modes of
  shared stores under multi-agent load — unauthorized leakage (Metistry:
  covered by scoped-read tiers), provenance collapse (covered IFF reports
  carry *verified* identity), stale propagation (covered by
  handles-not-copies), **contradiction persistence (Metistry's one open
  gap)**.
- **Letta's own docs** mark concurrent shared-memory rewrite an anti-pattern
  and recommend one owner for heavy edits — the sole-writer invariant,
  reached after the failure instead of before it.
- Orchestrator graveyard: ~16 dormant projects; the flagship's company shut
  down Apr 2026. Cost: multi-agent ≈ 10–15× tokens; Cursor reportedly
  abandoned equal-status agents + locking for planner/worker/judge
  (secondary source — flagged). **Hub holds state; agents pull. That is the
  version that survives.**
- Anthropic's inter-agent trust rule, worth copying verbatim: a message from
  another agent is labelled agent-sourced and **can never carry user
  authority, approve a permission, or relay a denied action**.

## Minimal viable "Metis as hub" — mostly already designed

Expose over the scoped-read MCP bridge (§4.10 tiers apply):

| Tool | Backed by | Status |
|---|---|---|
| `work.list_ready` (unblocked, unclaimed) | `work` table | needs dependency edges |
| `work.claim(id)` (atomic + lease TTL) | `work` table | **missing — the core gap** |
| `work.heartbeat(id)` | `work` table | missing |
| `work.update(id, status, note)` | `work` table | exists |
| `brief.get(id)` (handles, never payloads) | briefs | expose read-by-handle |
| `report.submit(...)` | report queue | needs verified identity + dedup |
| `knowledge.search/read` | scoped-read bridge | exists (PR #7 tiers) |

**Genuinely missing (priority order):** (1) atomic claim + expiring lease +
heartbeat — a few columns and one `UPDATE … WHERE status='pending'`; (2)
**server-side agent identity** — the hub stamps identity from the credential
onto every claim/report; nothing the caller says about itself is trusted
(the #54393 impersonation class, and invariant 7 restated); (3) idempotency
+ near-duplicate suppression on the report queue; (4) per-agent inbox as a
filtered view (a query, not infrastructure); (5) dependency edges on `work`.

**Resist building:** context translation (briefs + markdown ARE the
translation layer), capability negotiation (the target registry declares
statically — reviewable in git, unspoofable), a message bus (agents pull),
inter-agent consensus (sole-writer means the hub arbitrates — that's the
point).

## Recommendations

1. `[adopt-now]` Coordination = MCP tools on the existing bridge; **reject
   A2A** and Agent Cards.
2. `[adopt-now]` Atomic claim + lease + heartbeat on `work`; dependency
   edges. Reserve the columns in the next migration; build tools in Phase 5.
3. `[adopt-now]` Server-side agent identity on every claim/report; agent
   messages can never carry user authority.
4. `[adopt-now]` Handles, never payloads — briefs referenced by ID, fetched
   through the scoped bridge; one canonical copy.
5. `[adopt-now]` `AGENTS.md` at the vault root (CLAUDE.md imports it) — the
   cheapest cross-vendor win available.
6. `[design-for-later]` Supersession/contradiction resolution (`supersedes`
   link type / fact-validity intervals) — needs report volume first; the one
   governed-memory failure mode with no current answer.
7. `[design-for-later]` MCP Tasks extension (2026-07-28 spec) as the wire
   format for long-running dispatch — note it has NO claiming semantics;
   rec #2 stays ours regardless.
8. `[explicitly-reject]` Letta-style shared mutable memory blocks or any
   external write path to the vault; autonomous dispatch of external agents
   (hub holds state, agents pull).

**Scope discipline:** ~5 MCP tools and ~3 columns, not a subsystem. Phase 5
work on Phase 1 substrate; nothing scaffolds ahead of the plan.

## Evidence caveats

A2A production use unverifiable (supporters ≠ users); the
"category-with-no-winner" conclusion is inference from absence (moderate
confidence); #54393 is one operator's run, corroborated by MAST and the
governed-memory paper on mechanisms, not frequencies; the Cursor
equal-status-failure claim is secondary-sourced; 10–15× cost figures are
vendor-measured — treat as "roughly an order of magnitude."
