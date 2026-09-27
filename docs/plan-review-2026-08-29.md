# Pre-implementation review — synthesis & decision queue (2026-08-29)

Consolidates four independent staff-level reviews (`raw/01`–`raw/04`: security
boundaries, architecture/simplification, coherence, user-voice) plus a partial
draft from another session (`SYNTHESIS-other-session.md`). Every finding is
tagged **Critical / Should-do / Option** and given a **predicted phase**.
Security findings that discuss attack classes are stated here only as defensive
requirements; their mechanism detail is quarantined in
[§10 Security — defensive detail](#10-security--defensive-detail-flagged) for
separate review.

Priority = my judgment combining each reviewer's own severity, retrofit cost,
and the interface pivot below. Phase vocabulary follows the plan (Pre-1 = before
`packages/core`/tool-surface freezes; 1 substrate, 2 door, 3 capture, 4
visibility/web, 5 delegation, 6 knowledge; Later; Ongoing).

---

## 1. Executive summary

The plan is **buildable by one person and architecturally sound** — but all four
reviewers independently found the *same shape* of gap. It defends brilliantly
against the failure modes Phase 0 measured, and thinly against the adjacent ones
it hasn't:

| Well-defended (with evidence) | Under-defended (each reviewer's core finding) |
|---|---|
| Prompt-level failure → enforce-at-the-tool | **Authorization by convention** (sec): the engine's shell/git reach, bridge auth, token tiers, and UI output-encoding are each "enforced" by an unwritten assumption. |
| Cost runaway → deterministic routing, budgets, watchdog | **Operational failure** (arch): no update rollback, two git committers, a `runs` table blind to in-flight calls. "Nobody will attack this before Postgres fills a disk." |
| Money-driven abandonment → the strongest cost design reviewed | **Attention-driven abandonment** (ux): ~13 features independently route into an unspecified morning brief — 10–25 decisions/day against a real budget of ~5. |

**Go/no-go:** proceed to implementation, but **do a Pre-1 fixes pass first.** The
critical items are concentrated in exactly the places that are cheap to fix now
and expensive to retrofit: the substrate contracts (`core`, named queries,
schema), the file layout implied by the product/instance split, and a
one-hour consistency sweep. None require re-architecting; several are one-line
schema or naming decisions that calcify the moment Phase 2 writes against them.

**The five things that most change what gets built:**
1. **The interface pivot** (§2) — iMessage out as primary, web app in — which
   the reviews already argued for from three directions and which reshuffles
   phase priorities.
2. **Freeze the substrate contracts before Phase 2** — `packages/queries` as
   the one implementation of invariant 3; fatten `core`; add `started_at`/
   `finished_at` to `runs` now.
3. **Write the missing "no shell / no raw git in the engine" invariant** — most
   of §4.6's governance silently depends on it.
4. **Give the daily review a hard budget** (cap 5, auto-expiry, one owner) — the
   single change the user-voice review says most decides month-6 survival.
5. **Re-sequence keyword recall to Phase 2** — the one capability that makes the
   system feel indispensable is currently scheduled dead last, against the
   project's own evidence that keyword search nearly covers it.

---

## 2. The interface pivot (owner decision, already taken)

**Decided:** iMessage is not the primary interface — too insecure, and not rich
enough for a delightful UI. Lean into the **web app** (and eventually iOS).

This is well-supported by the reviews, from three independent angles:
- **Security:** iMessage as the interactive door hands a commit-capable,
  outbound-capable session raw text that includes *other people's* (potentially
  crafted) messages — the hardest reader/writer-separation gap in the plan
  (SEC-8). Demoting it shrinks that surface.
- **UX:** the brief arrives in iMessage but every "one-tap" action needs the
  PWA — two apps, ~11 taps before coffee (UX-2). And chat.db has no change
  API, so a polled iMessage round-trip (~6s) is *slower* than the Haiku turn the
  fast path exists to beat (UX-5).
- **Architecture:** none — it removes a component rather than adding one.

**What it resolves:** UX-2 (brief-where-I-can't-act), UX-5 (poll latency), and
much of SEC-8 (untrusted interactive door).

**What it newly requires — and the tension to decide (D2):** the reviews
recommended *deferring* the web management surface and web push to Phase 4+.
The pivot pulls a **minimal interaction web UI** (ask/answer + capture + triage)
onto the critical path as the *primary door* — while the *full* management API
(agent/grant/project CRUD) can still defer. And notifications now need web push
(PoC-6 passed) or the iOS app, earlier than planned. Splitting "minimal web
door (early)" from "full management console (later)" resolves the tension; see
D1/D2.

---

## 3. Cross-cutting themes (raised independently by ≥2 reviewers — highest signal)

- **T1 · Authorization-by-convention** (sec + arch). The plan's motto is
  "enforce at the tool," and it lives up to it for *availability* (TCC identity,
  redaction, signed binaries) but several *authorization* boundaries are still
  convention: the engine's git/shell reach, host-bridge auth, management-vs-agent
  token privilege, and the human triage tap. → CRIT-1, CRIT-6, CRIT-7.
- **T2 · The product/instance split never reached the file layout** (arch + coh).
  `rules.yaml`/`queries/`/`agents/` have two homes; `now.md` sits where
  `brain-commit` can't write it; §4.6's protected paths are all pre-split. → CRIT-4.
- **T3 · One queue, not five** (arch + ux + coh). Inbox proposals, `brain-report`,
  `/api/proposals`, `draft` notes, and grant elevations are five surfaces with
  one shape — and the user-voice review shows the *sum* (uncapped daily decisions)
  is the top abandonment risk. → CRIT-9 + SHOULD-13.
- **T4 · Scope/phasing realism** (arch + ux). Phase durations are ~3–5× optimistic;
  the always-on part count (a dozen services + a publishing pipeline) is the real
  solo-maintainer risk. Both reviews recommend cutting the same things. → §6.
- **T5 · Time-to-first-value & the recall gap** (ux, echoed by arch's Phase-6
  note). The wow moment sits behind the entire native tier; the killer feature
  ("what did we decide about X") is Phase 6 though keyword search is ~an
  afternoon. → SHOULD-1, SHOULD-2.
- **T6 · The `runs` table is load-bearing but under-built** (sec + arch). It's the
  audit log (invariant 8), the cost monitor, and the visibility story — yet it
  can't see an in-flight or crashed call, and nothing watches it for abuse. → CRIT-8, SHOULD-9.

---

## 4. Critical — resolve before/at Phase 1 (contract & schema decisions that calcify)

| ID | Finding | Area | Src | Phase | Fix |
|---|---|---|---|---|---|
| CRIT-1 | Missing invariant: the engine container has **no shell and no raw git**; `brain-commit` + allowlisted bridges are the *entire* mutating/outbound surface. All of §4.6 depends on this unwritten premise. | sec | 01 | Pre-1 | Write it as an invariant with a misuse test; the engine's tool surface excludes shell/exec/raw-git. |
| CRIT-2 | Substrate contracts have no home: **no package implements named queries** (invariant 3), and `core` is too thin (`runs` emission, HTTP-bridge auth + uniform error envelope, config-from-env loader, manifest *runtime*, and an undefined `check()` return type). | arch | 02·4,5,12 | Phase 1 (before Phase 2's first handler) | `packages/queries` = the one invariant-3 impl (YAML load, typed param validation, TTL cache, `{rows, as_of}`, **parameterized pg driver not `psql -c`**); fatten `core`; freeze `check()`'s return shape (status/latency/remediation/behavioral-probe assertion). |
| CRIT-3 | `apps/router` as a third container/image adds a hot-path hop, a second pg pool, and a second deploy for what the console already does. | arch | 02·4 | Pre-1 | Fold router into `apps/console` as a module; `rules.yaml` becomes a config file. |
| CRIT-4 | **Product/instance split not propagated to file layout.** `queries/`/`agents/`/`routines/`/`rules.yaml` have two homes; `now.md` is where `brain-commit` (stages only `Knowledge/`) cannot write it; a *local* extension would need a migration in the *product* repo; §4.6 protected paths are all pre-split. | arch·coh | 02·1, 03·7 | Pre-1 | Instance repo owns all config-shaped things (`queries/`, `agents/`, `routines/`, `rules.yaml`, `extensions/`, `instance-migrations/`); product ships defaults in `seed/`; loader resolves instance-first-by-filename. Move `now.md` → `Knowledge/now.md`. Rewrite §4.6 for two repos. |
| CRIT-5 | **Schema fails invariant 1's own rebuild test:** 4 of 8 tables hold non-derivable state (`runs`, `sessions`, `inbox` triage, `work` threads/tasks). The backup/DR story rests on a false premise. | arch | 02·2 | Pre-1 / 1 | Label each table `-- durable`/`-- derived` (CI-checked); restate invariant 1 ("git is the record for *knowledge*; Postgres holds derived state + a named durable set the nightly dump must cover"); make the quarterly drill a real `down -v` rebuild. Optionally push `sessions` summaries + inbox outcomes into the instance repo to shrink the durable set. |
| CRIT-6 | **Two git committers + unowned reconciler + undecided vault filesystem seam.** The plan rejects Obsidian-Git for "two committers" then ships two; the reconciler (11 mentions, owns indexing/rename/links/commits) has no `apps/` home and no manifest type; and whether the containerized assistant reaches the vault by bind-mount (violates invariant 7) or host-bridge is undecided. | arch·sec | 02·3, 01 | Pre-1 / 1 | **One committer = the reconciler**; `brain-commit` becomes write-file + enqueue-commit-intent (all-or-nothing at git level). Home it as `apps/reconciler`, `runs_on: host`, `type: service`. Rule `mcp-brain` is `runs_on: host` and the sole vault-mount holder. |
| CRIT-7 | **Management-vs-agent token privilege undefined**, and agent-authored text is rendered in the triage UI without output-encoding. Together these let a *write-only* capture token reach management actions. (Mechanism detail: §9.) | sec | 01·B4 | Pre-1 (design) / 4 (impl) | Management endpoints require the **owner** credential, never an agent token; **output-encode all agent-authored fields** in the web UI; ship misuse tests. |
| CRIT-8 | `runs` rows are written on completion (`ts`+`duration_ms`+`ok`), so a hung, looping, or crashed call logs *nothing* — invisible to the exact cost-runaway the watchdog exists to catch. | arch | 02·9 | Phase 1 | Two-phase rows: insert on start (`started_at`, null `finished_at`), update on completion. One column pair now vs a migration + every-emit-site rewrite later. |
| CRIT-9 | **TCC host bridges likely trust loopback rather than authenticating the container.** Loopback is reachable *from* the container (PoC-4), which holds the whole TCC surface + the OAuth token + Postgres — so this is a real trust boundary, not an isolation one. (Detail: §9.) | sec | 01·B3/B5 | Pre-1 (decide) / 2 (impl) | Each TCC bridge requires a per-bridge bearer token from its caller; ship a misuse test. Resolve Phase-0 open-question #5 now. |
| CRIT-10 | **Consistency defects in CI-enforced ground truth**: casing drift incl. *inside invariant 2* (`knowledge/` vs `Knowledge/`) — the exact bug §4.15/inv-8 warn about; duplicate `§4.4`; "Six rules" over 7 items (§4.16); the "frozen" frontmatter schema is missing the `id` field added the next day (load-bearing for durable refs); invariant 5's enumeration lacks "targets". | coh | 03·1-6 | Pre-1 | One ~1-hour sweep: normalize `Knowledge/` casing, renumber §4.4, fix the count, add `id` to the canonical schema + CI shape-check, add "targets" to invariant 5. |
| CRIT-11 | **Decision: write the three TCC bridges in Swift.** Two of three (`apple-fm` mandatory, `eventkit` effectively) already are; a Node bridge needs SEA + per-arch signing + notarization inside an npm package — a build-system project on Phase 2's critical path. | arch·stack | 02·11 | Pre-2 | Adopt one Swift toolchain for all three; the npm packages become thin publishers of prebuilt notarized binaries; **`core`'s bridge contract becomes a wire-level spec** (manifest shape, auth header, error envelope, `check()` JSON) — a *better* contract for a forkable OSS project anyway. |

---

## 5. Should-do — real value or real risk, within its phase

| ID | Finding | Area | Src | Phase | Fix |
|---|---|---|---|---|---|
| SHOULD-1 | **Recall ("what did we decide about X") is Phase 6**, though keyword/FTS over the vault is ~an afternoon and the research shows keyword recall@10=1.0 vs 0.77 paraphrase. It's the one behavior that makes the system indispensable. | ux | 04 | **Phase 2** | Ship ripgrep/FTS-backed recall as a named query in Phase 2; embeddings stay Phase 6. |
| SHOULD-2 | **Time-to-first-value is hours**, and the wow ("text yourself, get an answer") sits behind the entire native tier — the max-risk Day-1 stretch is between the user and the reason to continue. | ux | 04 | Phase 2-3 | `metistry init` ends in <10 min with a working local capture + fast path, **zero TCC**; the native tier becomes a progressive unlock via a `doctor` capability checklist (which also becomes grant-rot recovery). |
| SHOULD-3 | **Morning brief is unspecified** (10 references, 0 spec) and is the sink for ~13 features → 10–25 decisions/day vs a real budget of ~5. Top abandonment risk; "audit-not-gate becomes a gate enforced by guilt." | ux | 04 | Phase 3-4 (design Pre-3) | Spec it (**RATIFIED D10 — soft budget, not hard**): surface the most impactful items, +1–2 extra if also critical; **link to full detail in knowledge, don't truncate** — keep the daily view actionable but let the user open the full list to optimize. Plus consequence-ranking, auto-expiry (un-acted → `draft, reviewed:never`, searchable), batch actions, one owner. |
| SHOULD-4 | **Five approval queues that are one** (inbox / brain-report / api proposals / draft notes / grant elevations). Five notification paths, five API shapes, five places to get "agent messages carry no user authority" right. | arch·coh | 02·6, 03·9 | Phase 3-4 (reserve schema Pre-1) | One `proposals` table (`kind`, `source_agent`, `trust`, `payload`, `decision`, `feedback`, `decided_at`), one triage endpoint, one push, one brief section; `draft` frontmatter is the vault-side marker of the same row. |
| SHOULD-5 | Named-query params via string interpolation (`psql -c` has no binding, PoC-8) would reopen arbitrary SQL through a query param. | sec | 01·B3, 02 | Phase 1 | Parameterized pg driver in `packages/queries` (folded into CRIT-2). |
| SHOULD-6 | **`metistry update` has no rollback**; no migration ordering (concurrent containers can double-apply); no additive-only rule; `migrate.sh` needs a repo checkout + host `psql` an instance lacks. | arch | 02·8 | Phase 4-5 (additive rule → Pre-1 into CLAUDE.md) | `update` = `pg_dump` → pull → migrate in a one-shot service holding `pg_advisory_lock` → start via `depends_on: service_completed_successfully` → `doctor` → on failure restore dump + re-pin lock. Write the additive-first rule next to the invariants. |
| SHOULD-7 | **`POST /message` returns 202 with nothing durable behind it** — a message sent during an assistant restart (every `update`) is lost. | arch | 02·10 | Phase 2 | Inbound lands in a durable row before the 202; the assistant drains it. Also the natural home for the deterministic pre-check before any model turn. |
| SHOULD-8 | **Routines have a schedule and no runner**, and no home for the load-bearing behavioral rules (deterministic pre-check, isolated minimal-context sessions, silence-default, ≥15-min floor). | arch | 02·13 | Phase 3-4 | One routine runner in `apps/console` (has the pool, queries, `runs` sink); schedules from manifests; per-routine-per-day idempotency key; pre-check as a runner feature. |
| SHOULD-9 | **Nothing watches `runs` for abuse** (an agent token reading its whole scope; elevation spikes; outbound bursts). Watchdog is availability/cost only. | sec | 01·B7 | Phase 4-5 | A `runs`-based anomaly probe in the watchdog (pairs with CRIT-8's in-flight visibility). |
| SHOULD-10 | **Capture has no failure fallback** — HTTP-first, offline queue is an iOS-app feature, phone often off-tailnet. One silent drop ends the trust. | ux | 04 | Phase 3 | Capture Shortcut writes to a local file (iCloud Drive, already a `local-mac` path) on any HTTP failure; `inbox-drain` picks up either path. Ship a real Capture Shortcut (Siri phrase, dictation, Action Button), not just `/status`. |
| SHOULD-11 | **The compounding loop depends on the user writing prose on their busiest days** — 6 meetings → 0 notes → empty distillation; the system starves when most needed. | ux | 04 | Phase 3-4 | Calendar-driven meeting-note **pre-creation** (EventKit passed): a collector stamps a note per event, attendees pre-wikilinked (matched by email, unknowns auto-stubbed `draft`), empty decisions/actions. Typing 3 lines beats filing. |
| SHOULD-12 | **`gui/501` LaunchAgents + a watchdog that alerts through iMessage** — one reboot to the login window kills the native tier *including its own alarm*; a push subscription silently 410s after a Home-Screen reinstall. | ux·ops | 04 | Phase 2-4 | External dead-man's-switch: watchdog pings a free uptime service; if pings stop, *that* service emails the user (covers the one failure the design can't self-report). Treat a push 410 as a real alert. |
| SHOULD-13 | **Nothing is fixable from a phone** — the management API has no ops verbs; a bridge dies while traveling and waits for the Mac. | ux·ops | 04 | Phase 4 | Actionable watchdog messages (what failed / **degraded vs dead** / the exact fix command / what still works) + `POST /api/components/:name/restart` (scoped, audit-logged). SSH-from-phone is the honest interim; say so. |
| SHOULD-14 | **Manifest `type` enum lacks the components most likely to die silently** — reconciler, watchdog, console have no type, so `doctor` can't see them; three overlapping health mechanisms. | arch | 02·12 | Phase 1 | Add `type: service`; register reconciler/watchdog/console; watchdog schedules over the same `check()` results `doctor` uses; name the invariant-3 exception (watchdog must probe without the console) explicitly. |
| SHOULD-15 | **Dependency governance & stack drift**: "ask before adding a dep" needs a pre-approved list (~7–8 real ones) or it's a per-PR debate; §5's collectors are `run.py` (Python) vs a TS-everywhere stack + zero-Python Phase-0 finding; changesets across ~8 packages is solo ceremony. | arch·stack | 02·14 | Pre-1 | Write the approved list + the "hand-rolled, PoC-proven" list into `CLAUDE.md`; rule **TypeScript collectors** (delete `run.py`); consider changesets fixed/locked versioning. |
| SHOULD-16 | **Reader/writer separation is unspecified for the interactive door** (reduced but not removed by the pivot — iMessage may remain a capture/notify channel, and web input can still carry pasted third-party content). | sec | 01·B2 | Phase 2 | Name the enforcement point that binds a session's toolset to whether its inputs are trusted; keep untrusted-content readers off commit/memory-write tools. |
| SHOULD-17 | **Preview-confirm is not a security control against a compromised caller** (the confirmer is inside the boundary); the Messages `send` recipient may be un-allowlisted (open exfil channel). (Detail: §9.) | sec | 01·B2/B5 | Phase 2 | Owner-handle allowlist on `send` at the bridge; out-of-band human confirm for genuinely dangerous ops (mass delete, novel recipient) — distinct from in-agent preview. |
| SHOULD-18 | **Routine mid-write leaves partial knowledge** (dies after 3 of 6 notes) → the #1 documented AI-vault failure (duplication); a crash between write and commit leaves an uncommitted file the reconciler would index. | arch | 02·15 | Phase 3-5 | `brain-commit` all-or-nothing; per-routine-per-day idempotency key; reconciler indexes **committed** state only. |
| SHOULD-19 | **Away/vacation → 150–400 pending items**; no expiry, rollup, or cap; the user opens the PWA once, sees the badge, never again. | ux | 04 | Phase 4-5 | Explicit **away mode** (pause distillation/briefs, cap queues) + one "while you were gone" rollup with **auto-archive**. All mechanisms already exist (status frontmatter, audit-not-gate) — only the policy is missing. |
| SHOULD-20 | **Inbox triage state isn't derivable** — after a rebuild, `inbox-drain` re-classifies everything or orphans it (re-proposing rejected items = the "40 ignored proposals" failure). | arch | 02·16 | Phase 3 | Triage outcome into the file's metadata sidecar (PoC-7 writes one) or move accepted/rejected files out of `inbox/`; then the PG row is genuinely derived. |
| SHOULD-21 | **Slow turns are silent** — a deep-tier turn with no ack invites a re-send (duplicate turn + cost). | ux | 04 | Phase 2 | Any turn expected >~5s gets an immediate ack naming the tier ("thinking — deep tier"). |
| SHOULD-22 | **`Me/` sensitivity is convention** — "never readable by external agents" relies on the user never granting a too-broad prefix. | sec | 01·B1 | Phase 4-5 | Hard tool-level denylist on `Me/` that overrides any prefix grant. |
| SHOULD-23 | **Init interview risks a bad permanent profile** if it's a long question set at minute 3. | ux | 04 | Phase 3 | Cap at ~4 questions (name, tz, quiet hours, current focus); the assistant earns the rest via one proposal/day (§4.14 already supports it). |
| SHOULD-24 | **audit-not-gate (ruling #1) is cited for two different mechanisms** — direct-draft-commit (system never blocks) vs proposal triage (content never lands until approved = a gate by construction). Blurs a real distinction. | coh | 03·9 | Pre-1 | One sentence distinguishing "the agent isn't blocked" from "the fact isn't gated." |

---

## 6. Option — judgment calls, defer freely / scope cuts

| ID | Finding | Area | Src | Phase | Note |
|---|---|---|---|---|---|
| OPT-1 | Scope cuts the reviews proposed (management API+UI, web push, hub tools, `mcp-health`, Home Assistant). | arch·scope | 02·7 | — | **RATIFIED (D9): only Home Assistant is cut.** The web management UI, web push, coordination tools, and `mcp-health` are **kept** — consistent with the web-first pivot. Fold-router still stands (CRIT-3). Reserve the hub's claim/lease/dependency columns in a migration now regardless. |
| OPT-2 | Local meeting **transcription** (transcript into the vault, human-marked decisions, explicitly **no** auto-extraction per PoC-13). High user value, large build. | ux | 04 | Later | Architecture supports it (native bridge + on-device model); resist the auto-extract trap. |
| OPT-3 | Near-miss logging (model turn a named query could've served) + a `/help` generated from live `rules.yaml`. | ux | 04 | Phase 4 | Feeds the §4.17.D tuning loop for free. |
| OPT-4 | Batch proposal actions + per-source accept-rate scorecard with an offer to mute low performers; monthly spend push; instrument the §5 "on drift" heuristics (panel views, accept rates). | ux | 04 | Phase 4-5 | The user won't self-notice drift; instrument it. |
| OPT-5 | Per-token rate limits; task-claim quotas + max-lease-duration (heartbeat-hold, claim-all starvation); elevation-reason UI hardening (show current-vs-requested, treat reason as untrusted). | sec | 01·B1 | Phase 5 | Coordination-DoS blast radius, not data loss. |
| OPT-6 | Obsidian can't call an authed API without a plugin → render `Knowledge/Dashboard.md` on the reconciler cycle instead; drop Obsidian from the invariant-3 consumer list. | arch | 02·17 | Phase 6 | Works on mobile through Sync; one fewer consumer. |
| OPT-7 | `work` vs Reminders has no boundary rule and will drift. | arch | 02·18 | Phase 3 | One rule: Reminders = things the *phone* nags about; `work` = things the *system* tracks status on; `work.external_ref: reminder:<id>` reconciled by a collector. |
| OPT-8 | Token lifecycle (revoke/expire/rotate/last-used) for external-agent tokens; no revoke endpoint today. | sec | 01·B1 | Phase 5 | Needed before external agents are real, not before. |
| OPT-9 | Minor doc nits: outcomes-table PASS vs RESULTS PARTIAL (PoC-2); PRODUCT.md stale PoC count (14→16); §4.14 "§2 research" dangling citation; §4.18 "~5 tools" (actually 7–8); top diagram's fixed "Anthropic Haiku→Opus" box vs §4.17 configurable tiers; PoC-12's stale `brain/knowledge` layout; `bridges/`/bare-`router/` paths vs `packages/mcp-*`/`apps/router`; compose comment "rides the tailnet" vs invariant 8; invariant-numbering collision plan (8) vs CLAUDE.md (7). | coh | 03·7,8,10-14; 02·19 | Pre-1 | Batch with the CRIT-10 sweep. |

---

## 7. Conflicts & tensions (for the owner — not resolved here)

- **C1 · Defer the web surface (arch/ux) vs the interface pivot (owner).** The
  reviews say defer the management API + push to Phase 4+; the pivot needs a web
  door earlier. **Resolution to weigh (D2):** split *minimal interaction web UI*
  (early, primary door) from *full management console* (deferred to multi-agent).
- **C2 · Simplify vs harden.** OPT-1 cuts the management API to shrink the attack
  surface (invariant 8: "keep it small"); CRIT-7 requires that same surface to
  have owner-vs-agent token separation and output-encoding *when it exists*.
  Not contradictory — but the smallest safe version is "doesn't exist until a 2nd
  agent does, and when it does it ships with the token/XSS rules." Decide the
  ordering.
- **C3 · One committer (reconciler) vs commit latency.** Routing all writes
  through the reconciler (CRIT-6) is correct for safety but adds latency between
  "assistant decides to write" and "it's in git." Acceptable for knowledge;
  confirm it's acceptable for `now.md`/session state.
- **C4 · Bind-mount the vault (simple) vs invariant 7 "no shared filesystem"
  (portability).** CRIT-6 proposes `mcp-brain` as `runs_on: host` holding the
  sole mount; that's consistent locally but the `cloud` profile needs the
  cloned-worktree + git-webhook path (§4.16 rule 4 has the trigger half only).
- **C5 · A partial synthesis from another session exists**
  (`SYNTHESIS-other-session.md`, truncated at the critical list). Its content is
  a subset of this document; keep or delete at your discretion.

---

## 8. Decisions (ratified 2026-08-29)

The owner ratified the queue below. These are now design direction; full
propagation into `metistry-build-plan.md` happens in the Pre-1 fixes pass
(implementation stays on hold until then). D5 and D6 remain open.

| # | Decision | Ratified answer | Effect on findings |
|---|---|---|---|
| D1 | iMessage's residual role | **Drop iMessage entirely** — lean on the web app. | Removes the interactive-door security surface (SEC-8 / SHOULD-16 largely moot) and the Messages `send` allowlist concern (SHOULD-17). **The watchdog's out-of-band alert can no longer be iMessage** → the external dead-man's-switch + email (SHOULD-12) becomes the alert channel, and web push (D2) the primary notification. |
| D2 | Web surface | **Move the web app up as the primary interface, and use it for notifications (web push).** iOS comes later; the web app stays primary for most users regardless. | Resolves C1. A minimal interaction/capture/triage web UI is now on the early critical path; web push adopted now (not deferred). |
| D3 | Swift for all three TCC bridges | **Yes.** | CRIT-11 adopted; `core`'s bridge contract becomes a wire-level spec. |
| D4 | Product/instance overlay | **Yes** (instance owns config-shaped things; product ships `seed/` defaults; filename-wins overlay). | CRIT-4 adopted. |
| D5 | One committer (reconciler) | **Open — unresolved for now.** | CRIT-6 stays flagged; revisit before the reconciler is built. |
| D6 | Restate invariant 1 + durable set | **Open — unresolved for now.** | CRIT-5 stays flagged; revisit before backup/DR is built. |
| D7 | Unified `proposals` table | **Yes** — collapse the five queues. | SHOULD-4 adopted; shapes the schema (cheap now). |
| D8 | Keyword recall → Phase 2 | **Yes**, move it up. | SHOULD-1 re-sequenced to Phase 2. |
| D9 | Scope cuts | **Drop Home Assistant only.** Keep the full management UI, web push, coordination tools, and `mcp-health`. (Fold-router still stands — CRIT-3.) | OPT-1 revised: only HA is cut; everything else stays (consistent with the web-first pivot). |
| D10 | Daily-review budget | **Soft budget, not hard.** Surface the most impactful items (+1–2 extra if also critical); **link to full detail in knowledge rather than truncating**; keep the daily view actionable but let the user open the full list to optimize. | SHOULD-3 revised: soft cap + "see all" affordance, not a hard cap-5. |

**Still open (later):** D5, D6, plus token lifecycle (OPT-8), transcription
(OPT-2), Reminders/`work` rule (OPT-7), Obsidian dashboard (OPT-6), rate-limit
tuning (OPT-5).

---

## 9. What the reviews validated (protect these)

Named by multiple reviewers as genuinely strong, and worth not losing in the
churn of fixes:

- **Phase 0 discipline** — two informative FAILs preserved, an invariant defended
  against the author's own proposed amendment (PoC-14→15→16), an ill-posed cost
  criterion corrected mid-flight.
- **Enforce-at-the-tool where it costs something** — deterministic redaction of
  *model output*, server-side grants, reader/writer separation for untrusted
  content.
- **The product/instance split** — decided before a vault existed; makes the
  IP boundary between contexts mechanical.
- **The cost architecture** — deterministic router failing open to the model,
  fast paths, per-tier budgets, model-free watchdog. The user-voice review calls
  it the best-defended flank it has seen.
- **Small delighters** — naming the assistant on first run, freshness stamps,
  `degrades: absent` (capability-off, not mystery-error), leases that expire on
  their own. The user-voice review's ask: make *everything* degrade like a lease.

---

## 10. Security — defensive detail (flagged)

> **Read separately.** This section discusses attack *classes* solely to specify
> the defenses for the owner's own authorized system. It contains no exploit
> code or step-by-step procedures — only the boundary, the risk in one line, and
> the control to enforce. It is split out per the owner's request in case the
> subject matter trips an automated review.

The security review covered seven trust boundaries. The recurring theme: the
plan enforces *availability* at the tool but leaves several *authorization*
boundaries to convention. Defenses to specify, by boundary:

- **B1 · External agent ↔ hub.** Enforce: per-agent token *lifecycle* (revoke/
  expire/rotate, surface last-used); rate/volume limits on report submission and
  task claims; treat the elevation `reason` field as untrusted text and show
  current-vs-requested scope on the approval; a **hard `Me/` denylist that
  overrides any prefix grant**; friction on a proposal proportional to its
  destination's power (a `Me/profile.md` write ≠ a journal note).
- **B2 · Assistant ↔ its own tools.** Enforce: `brain-commit` constrains
  *content* as well as path (refuse wholesale rewrite of files it didn't author);
  an **owner-handle allowlist** on the Messages `send` recipient; recognize that
  "the brief carries only what Metis chooses" assumes an honest Metis and does not
  hold under Metis compromise — so the outbound channels are the exfiltration
  surface to bound.
- **B3 · Container ↔ host.** Enforce: **loopback is not a trust boundary** (it's
  reachable from the container); the host TCC bridges must bearer-authenticate
  their caller; the app DB user should not hold full DDL/DML if avoidable; and
  named-query params must use a parameterized driver (never string-interpolated
  SQL). Note the container's blast radius: the TCC surface + the OAuth token in
  env + Postgres + the mounted repo — so bridge auth and token handling are the
  load-bearing controls.
- **B4 · Console/web management surface.** Enforce: **output-encode all
  agent-authored fields** in the UI (stored content from a low-privilege token
  must not execute in a page holding the owner's credential); **management
  endpoints require the owner credential**, structurally distinct from any agent
  token; header bearer + per-request server-side authz + existence-non-leaking
  errors (already the plan's posture — keep it).
- **B5 · TCC host bridges.** Enforce: in-agent preview-confirm is a defense
  against model *slips*, **not** against a compromised caller (the confirmer is
  inside the boundary); genuinely dangerous operations need **out-of-band** human
  confirmation.
- **B6 · Git / protected-path governance.** Reality: server-side rulesets are
  unavailable on the current org tier, CODEOWNERS is review-only, and the
  client-side pre-push hook is per-machine and bypassable — so protected-path
  enforcement reduces to `brain-commit` refusing non-`Knowledge/` paths **and**
  the engine having no shell/raw-git (CRIT-1). The `Brain-Source` trailer is
  self-declared; don't treat it as an authorization signal.
- **B7 · Watchdog.** Enforce: add a `runs`-based abuse-signature probe (scope-wide
  reads, elevation spikes, outbound bursts) — today the watchdog sees availability
  and cost but not misuse, so a token leak or slow exfiltration is only ever
  visible in post-hoc audit.

Critical security items are surfaced in §4 as CRIT-1, CRIT-7, CRIT-9 (and
SHOULD-5/16/17/22, OPT-5/8) with plain-language fixes; this section is the
boundary-by-boundary defensive rationale behind them.

---

*Sources: the four raw reviews (security, architecture/simplification, coherence, user-voice) and a partial other-session synthesis — all consolidated here and then removed from the working tree (they remain in this PR's git history). Reviewer severities preserved; priority/phase are this synthesis's judgment.*
