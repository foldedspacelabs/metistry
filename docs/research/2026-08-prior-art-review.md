# Prior-art review — AI brain systems & Obsidian practice (2026-08-28)

Two parallel research sweeps (open-source AI assistant/"brain" systems; Obsidian
PKM + AI-writes-the-vault practice), synthesized against the build plan. Method
note: GitHub issues, CVEs, and one production memory audit are the load-bearing
evidence; vendor benchmarks are not. Reddit coverage was thin; forum/blog
long-term-user accounts stood in.

---

## 0. Urgent, and not about prior art: the subscription floor moved

Verified (VentureBeat, 2026-05-13; original change 2026-04-04): third-party
harnesses / **Agent SDK apps authenticate with a subscription but draw from a
separate monthly "Agent SDK credit" pool, billed at standard API rates, no
rollover** — Pro $20 / Max-5x $100 / Max-20x $200 / Team-Enterprise $100–200
per seat. Interactive Claude Code CLI use stays on normal subscription limits.

Implication for Metistry: the **routines are the metered lane.** The Phase 0
auth decision (setup-token, subscription) stands, but the economics of briefs,
distillation, and any heartbeat now have a hard monthly budget at API rates.
Two consequences: (a) recommendation #6 below (deterministic pre-checks before
any model turn) is economically load-bearing, not hygiene; (b) re-price the
routine schedule during Phase 3 planning against the actual credit pool.
Whether headless official-CLI invocation counts as "interactive" is ambiguous
and not worth betting the architecture on.

> **CORRECTION (2026-08-28, user-prompted, verified against Anthropic's help
> center):** the account above missed a third beat. The metered-credit change
> was **paused on June 15, 2026 — the day it was due to take effect** — and
> never shipped: "Claude Agent SDK, `claude -p`, and third-party app usage
> still draw from your subscription's usage limits." Anthropic says a
> reworked plan will come "with advance notice." So today the routines are
> NOT metered; the paragraph above describes an announced-then-paused policy.
> Recommendation #6 stands on its cost-hygiene and behavioral merits (idle-
> cost abandonment evidence), no longer on a metering mandate. Plan §4.17
> carries the corrected framing: arbitrage is a contingency, and per-target
> cost accounting makes any future metering a config response.

---

## 1. What the survey validates (no change; recorded as evidence)

- **Deterministic router / no model in the hot path** — idle/always-on cost is
  the **#1 documented abandonment reason for personal AI in 2026** (documented
  bills: $36/day idle heartbeats, $1.8k–$6k runaways). Metistry's fast path +
  regex router is the strongest position in the field.
- **Bridges over prompt catalogs** — of ClawHub's ~13.7k skills, **7 of the
  top-10 by installs are connectors** (web, messaging, email, DB, calendar,
  docs). The demand was always doors. Metistry builds doors.
- **Lazy tool discovery** — accuracy degrades past ~10–15 tools; at 107 tools
  models fail outright; GitHub's MCP server alone is 42k tokens; retrieval-based
  tool selection tripled selection accuracy while halving tokens. The Phase 1
  spike stays, but the direction is well-evidenced.
- **Status-in-frontmatter over Archive folders; human-readable filenames;
  wikilink-on-first-mention** — all confirmed by long-term-practitioner
  accounts (backlink-driven People lookup only works if mentions are links).
- **Keyword search is the strong baseline at personal scale** — measured
  recall@10 = 1.0 keyword vs 0.77 paraphrase in a comparable system; a naive
  full-context baseline beats specialized memory frameworks on their own
  benchmark. Ambitious retrieval machinery is not where value lives.
- **Sole-writer with restricted commit tool** matches the two serious
  AI-writes-the-vault prior arts (Karpathy's raw/wiki split; vault-agent's
  protection hooks). Mainstream AI plugins are chat tools, not writers.
- **Single agent + bounded sub-calls** (Metis + escalation subagents) is the
  2026 production consensus — "80% of the benefit at 20% of the complexity."
  Token usage alone explains ~80% of multi-agent performance variance
  (multi-agent ≈ spending 15× tokens); the star-heavy orchestrator wrappers
  are measurably dead (0–2 commits/90d at 22–24k stars). Anthropic's own 400k-
  session study: humans make ~70% of planning decisions, models ~80% of
  execution — so memory/prompt files should carry *constraints*, not
  procedures.
- **Calendar/scheduling is the clearest demand/supply gap** in the skill
  ecosystem (6.5% of installs, thin supply) — the EventKit bridge is aimed at
  exactly the right target. And the #1 install *category* across the largest
  registry is meta/memory/self-improvement: users want the assistant to
  remember and improve more than they want any single capability.

## 2. Adopt now

Each item: what → evidence → where it lands.

1. **Search-before-write in `brain-commit`.** The tool refuses to create a note
   without checking existing coverage; ingest should prefer updating existing
   notes. → Duplication is the #1 documented AI-vault failure ("AI landfill");
   every serious prior art converged on this. → `mcp-brain`, Phase 2/5.
2. **Provenance on every agent-written claim**: `author: agent`, `learned_at`,
   `source` ref, `confidence`, plus a per-claim back-link to the exact source
   block. → Makes an agent-written vault auditable at a glance; second half of
   the MemGhost mitigation; answers the strong community authorship objection
   ("I don't know anymore whether I wrote this") without giving up sole-writer.
   → vault conventions + `brain-commit`, Phase 2.
3. **Freshness rule: every stored fact is timeless, dated, or a pointer.**
   Fast-changing facts are linked with an "as of" stamp, never copied in to
   rot. Weekly routine runs a freshness/contradiction/orphan lint. → Cheapest
   known defense against stale-fact rot, shipped as working code in
   obsidian-second-brain. → vault rules + weekly routine, Phase 5.
4. **Bi-temporal columns on derived facts** (`valid_at`/`invalid_at` +
   `learned_at`/`expired_at`); contradictions expire rows, never delete. →
   Two nullable timestamp pairs buy what Zep built a company on; Mem0's
   stale-fact and conflicting-fact bugs exist precisely because they skipped
   it. → db schema (cheap while young), Phase 2-3 migration.
5. **Untrusted-content quarantine (MemGhost rule).** The agent that reads
   third-party content (messages from others, email, web) must not hold vault
   commit or durable-memory-write tools in the same session; it emits
   structured intent into the report queue. One crafted email hit a Claude
   Agent SDK agent at 71.4% success; input filtering missed 9/10. → agent/
   bridge scoping, Phase 2 design rule. **Needs a plan amendment** — today's
   design has Metis both reading chat.db (which contains others' messages) and
   holding `brain-commit`.
6. **Routines: deterministic pre-check before any model turn; isolated
   minimal-context sessions; explicit memory-write path for short sessions;
   silence as default output; speak/silence ratio instrumented; ≥15-min
   floor on any proactive cadence.** → Converging failures: full-history
   replay ($36/day idle), short sessions never reaching memory-persistence
   thresholds (burn money, persist nothing), proactive lane starving the
   interactive lane; sub-15-min cadence measurably degrades the model's
   "should I speak" judgment. Reported savings for the pre-check pattern:
   $0.31 → $0.04 per triage. → router + routines, Phase 3-4; now
   economically required (see §0).
7. **Watchdog: cost-per-cycle against a rolling baseline (alert ~10×), and
   treat rate-limit-shaped output as terminal.** Runaway retry loops are
   I/O-bound — invisible to CPU/memory monitoring; "You've hit your limit"
   with exit code 0 caused a documented $1.8k bill. → watchdog, Phase 2.
8. **Preview-confirm shows the canonicalized, resolved target** (symlinks
   resolved, paths absolute), never the caller-supplied name. → GhostApproval
   (CVE-2026-12958, CVSS 9.8) hit six major tools including Claude Code via a
   decoy-named symlink. → `packages/core` preview-confirm primitive, **PR-2**.
9. **Frontmatter validation, pre-freeze:** `area`/`people` must be actual
   wikilinks (never sometimes-text); list-typed fields never collapse to
   scalars. → Named independently by two sources as the top cause of silently
   broken Bases/Dataview queries; a migration project if deferred. → CI schema
   validation, Phase 1 (lands with core).
10. **Instance-repo hygiene:** gitignore `workspace.json`,
    `workspace-mobile.json`, device-specific plugin `data.json`. → The most
    common concrete Sync/git conflict source. → seed templates, trivial.
11. **BM25/FTS + recency term alongside pgvector; chunks stay verbatim.** →
    Hybrid `0.5×vector + 0.3×FTS + 0.2×recency/importance` in plain SQL;
    extraction-at-ingest is losing to not-extracting across the field; recency
    prevents the stale-employer class of retrieval bug. → named queries /
    Phase 6 retrieval.
12. **Lazy discovery = a search entry point, resolved at runtime** — refine
    the §4.3 design toward the shape every system that scaled converged on
    (a single meta-search tool in the prompt; catalog resolved per query;
    measured 85–98% token reduction; three-level progressive disclosure as
    table stakes). Also: **skill-checking must be procedural, not
    discretionary** ("check for a relevant skill before any task" as a rule),
    and subagents provably do NOT inherit CLAUDE.md — the plan's
    brief-carries-context design is the only thing that works, so briefs must
    be complete. → core lazy-discovery spike (PR-2) + agent briefs.
13. **Operating-prompt budget**: frontier models follow ~150–200 instructions
    reliably and degrade uniformly past that; the winning CLAUDE.md practice
    is <300 lines of constraints (not procedures), never auto-generated, and
    pruned so it doesn't become a "grievance archive" of stale rules. Also:
    hooks can fail silently and a hook "block" reads to the model as
    defer-to-human — `doctor` should verify guardrails actually fire
    (behavioral check, same principle as TCC probes). → Metis operating
    prompt (Phase 2) + doctor.
14. **Skill lineup, informed by real install telemetry**: process/methodology
    skills dominate actual adoption (plan-interrogation "grill-me" 990k
    installs, TDD, writing-plans, handoff, triage) while summarize/extract
    prompt-libraries are losing share to native model ability. Metistry's
    planned skills (decision-council, weekly-review, brief-writer) are the
    right shape; add a plan-interrogation skill; adopt Fabric's
    IDENTITY/STEPS/OUTPUT skeleton and ignore its 256-pattern corpus (top ~2
    patterns claim 80% of its use). → skills/, Phase 5.

## 3. Design for later

- **Staged trust in `status`** (e.g. `draft` → `active`): AI-fresh notes are
  visibly unsettled until reviewed; every AI-vault prior art converged on
  maturity staging. Interacts with the §5 tension below.
- **Decisions as queryable structure** (a `decisions` list property on
  meeting/journal notes, or a Decision note type): meeting-template practice
  treats decisions as high-retrieval-value structure. **Pre-freeze schema
  decision needed.**
- **Sentinel markers** in mixed notes (`@generated` vs `@user` blocks) so
  re-runs never touch human text.
- **Reconciler write discipline**: atomic write-temp-rename, debounced
  batches, awareness that *any* background write trips Obsidian Sync's
  conflict detector on the same Mac (no first-party fix exists). → Phase 6.
- **Ingest-as-update with contradiction reconcile** (one source updates 5–15
  existing pages), propose-only — needs corpus mass first.
- **V-model verification**: reviewer reads the produced artifact, never the
  worker's summary (anti-narrativisation); pair with a small personal eval
  set that includes superseded facts — the axis public benchmarks skip.
- **Credential masking for bridges** (sandbox sees a sentinel; an
  out-of-sandbox proxy substitutes the real secret for allowlisted hosts).
- **Audit log discipline**: log parameter schemas + sensitivity classes +
  return size/hash, not values — enough to later prove whether data left the
  machine, without storing plaintext.
- **Context-injecting restart** in the watchdog (crash reason, time,
  pending-work count in the fresh session's first message) and heartbeat
  written from inside the work loop, never from a timer.

## 4. Explicitly rejected (with reasons on record)

- **Knowledge-graph / GraphRAG retrieval layer**: +1.5 points on the vendor's
  own ablation for ~3× latency and ~2× tokens; the flagship framework is in
  maintenance mode; graph pipelines cost 200+ LLM calls per 100 chunks and
  fail retrieval until background processing completes. Personal corpus fits
  in RAM.
- **Third-party skill marketplace**: 341 malicious skills found in the
  leading one; 7.1% of all its skills leak credentials; pattern catalogs
  plateau (Fabric has no registry at all and is fine). If ever revisited:
  trust-on-first-use pinning + re-approval on any description change.
- **Memory-extraction pipelines at ingest** (Mem0-style): a 32-day production
  audit found **97.8% junk** (89.6% even with a frontier model) — "worse than
  no memory at all." Metistry's shape (durable prose in git + verbatim chunks
  + operational rows) is the right side of this result.
- **Physical Archive folder, ID-first filenames, mainstream AI plugins in the
  write path** — all confirmed rejections from the Obsidian sweep.

## 5. Tensions needing an explicit ruling

1. **"Review by audit, not by gate" vs. the junk evidence.** The plan lets
   the assistant commit knowledge freely, reviewed weekly by digest. The
   strongest numbers in this survey argue durable-fact writes need *some*
   gate: 97.8% junk without one; "an error rate of a few percent in durable
   notes is enough to weaken trust." **Proposed reconciliation** (keeps the
   plan's spirit): commits stay free, but (a) distillation-produced *facts*
   land as `status: draft` and surface in the morning brief for one-tap
   settle/reject (the plan's existing proposal queue, extended to knowledge);
   (b) journal/log-type notes stay audit-only. Sole-writer, no ceremony,
   visible trust levels.
2. **MemGhost vs. the door**: Metis currently both reads others' messages and
   holds the commit tool. Options: (a) quarantine reads of non-user content
   behind the reduction pipeline only; (b) provenance-tag any knowledge write
   sourced from third-party content and require confirmation. Needs a §4.10/
   §4.11 amendment either way.
3. **Schema freeze contents** (Phase 1, imminent): add wikilink/list-type
   validation (§2.9)? add `decisions` structure? add `draft` to `status`
   values? — all cheap now, migrations later.

## Key sources

Mem0 production audit (10,134 memories, 2.2% acceptable):
github.com/mem0ai/mem0/issues/4573 · MemGhost:
thehackernews.com/2026/07/new-memghost-attack (OWASP ASI06) · GhostApproval:
wiz.io/blog/ghostapproval (CVE-2026-12958) · OpenClaw heartbeat economics:
openclaw issues #60719, #44033, #53740 · ClawHavoc malicious skills: Snyk ·
Agent SDK credits: VentureBeat 2026-05-13 (verified 2026-08-28) ·
obsidian-second-brain (freshness lint, sentinel markers, ingest-as-update) ·
COG-second-brain (V-model verification, tiered people CRM) · gptme
(append-only journal + typed frontmatter) · Bases schema practice: got.md,
danholloran.me · Sync conflict thread: forum.obsidian.md #108029.
