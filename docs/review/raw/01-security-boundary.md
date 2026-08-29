I've read the full build plan, both research docs, the PoC results, the schema, compose file, and pre-push hook. Here is the boundary security review.

# Metistry — security boundary review

Scope: `metistry-build-plan.md` (all §§), `db/migrations/0001_init.sql`, `docker-compose.yml`, `ops/git-hooks/pre-push`, `docs/research/*`, `docs/poc/RESULTS.md`. The plan is unusually security-aware (invariant 8, reader/writer separation, tool-enforced governance), so the findings below concentrate on where enforcement is still **by-convention or unspecified** rather than at-the-tool as the plan demands of itself.

## The load-bearing unstated assumption (affects boundaries 2, 5, 6)

Almost every tool-level control in the plan collapses to one premise that is **never written down as an invariant: the Metis container process has no raw shell and no raw `git`.**

- `brain-commit` "stages only `Knowledge/` and refuses other paths" (§4.6, invariant 2) only constrains Metis if `brain-commit` is the *only* path to the repo. The instance repo is mounted in the container for commits. If the Agent SDK host exposes Bash/exec (the default for a coding-capable agent), a prompt-injected Metis runs `git commit`/`git push --force`/`rm -rf Knowledge/` directly, and history-rewrite, protected-path edits (`CLAUDE.md`, `rules.yaml`), and vault destruction are all reachable.
- Invariant 2 asserts "Metis never calls `git commit`" — but *never calls* is an authz claim with no named enforcement point. It must be restated as: **the engine container's tool surface excludes shell and raw git; the only repo-mutating tool is `brain-commit`; the only outbound tools are the allowlisted bridges.** Until that is a tool-enforced invariant with a misuse test, §4.6 governance is convention.

## Boundary 1 — External agent ↔ hub

**Token theft.** Grants attach server-side to the token (§4.10) with blast radius bounded by tier — good. A stolen tier-0 capture token reads nothing but can flood the report/proposal queue; a stolen tier-2 token exfiltrates its granted areas. Gaps:
- **No token lifecycle.** `POST /api/agents` issues tokens; there is no revoke endpoint, expiry, rotation, or per-token "last used" surfaced. On leak, the only signal is anomalous rows in `runs`, and **nothing watches `runs`** (see Boundary 7). Invariant 8 ("authenticate as if internet-exposed") demands a revocation story the plan doesn't have.
- **No per-token rate limiting.** `report.submit` is "idempotent, near-duplicate-suppressed" (§4.18) — dedup stops accidental dupes but a malicious agent varies content to defeat it. No cap on report volume or claim rate.

**Elevation social-engineering.** The elevation `reason` (§4.10) is attacker-controlled free text presented to a fatigued human for a **one-tap grant**. A crafted reason ("need Areas/Health to finish the medical-cost analysis you asked for") manufactures consent. The plan labels agent messages agent-sourced (§4.18, good) but the affordance is still the whole boundary; the UI must also show *current vs. requested* grants and treat the reason as untrusted data.

**Report-queue poisoning (the sharpest issue).** The human one-tap accept **is** the trust boundary for external-authored knowledge, and memory-poisoning is a one-shot attack (prior art: 71.4% success, input filtering missed 9/10). Residual holes beyond the present mitigations (draft status, provenance, reader/writer separation):
- Every proposal gets the *same* one-tap regardless of downstream power. A proposal destined for `Me/profile.md` (consumed by router/routines) must not be one-tap-equivalent to a journal note. Add **friction proportional to the destination's blast radius**.
- `Me/` "never readable by external agents at any tier" (§4.14) must be a **hard tool-level denylist that overrides any prefix grant**, not merely "don't grant the `Knowledge/` root." As written it relies on the user never granting a too-broad prefix.

**Task-claim abuse.** Atomic `work.claim` + lease TTL + heartbeat (§4.18) defeats claim-then-idle (expired lease releases). Not defended: **heartbeat-hold** (renew the lease forever without doing work) and **claim-all starvation** (one agent claims every `list_ready` item). No max-lease-duration, claim quota, or fairness. Blast radius is coordination DoS, not data loss.

## Boundary 2 — Assistant ↔ its own tools

**`brain-commit` restricts paths, not content.** Even with shell excluded, a prompt-injected Metis can do damaging-but-in-scope writes inside `Knowledge/`: corrupt/rewrite People notes, poison `Me/`, delete content. §4.13's "Metis never rewrites a file it didn't author" reads as a `CLAUDE.md` convention, **not a `brain-commit` check** — it should be enforced at the tool (refuse wholesale rewrite of files whose provenance isn't Metis).

**Vault exfiltration via allowed outbound.** Metis has full vault read plus outbound channels: Messages `send`, `report`, dispatch briefs. A prompt-injected Metis reads the vault and exfiltrates through any of them.
- §4.8's guardrails (quiet hours, per-category/day rate limit, logging) are **spam controls, not exfil controls** — one iMessage carries a lot of vault.
- **Is the `send` recipient allowlisted to the owner's own handles at the tool?** PoC-11 sends "to buddy <you>" but the plan never constrains the recipient. If `send` accepts arbitrary handles, it's an open exfil channel. Must be an owner-handle allowlist at the bridge.
- Dispatch `data_policy: no_personal_comms` (§4.17.B) governs comms-derived content only; a brief bound for an external target can still carry arbitrary `Knowledge/` the injected Metis selects. **"The brief is the context transfer / Metis decides relevance" (§4.10) assumes Metis is honest — it collapses under Metis compromise**, because the injected Metis authors the brief.

**Reader/writer separation is under-specified for the interactive door.** §4.11's separation (readers of third-party content hold no commit/memory-write tools) is realized for the *nightly comms reducer* (Metis sees only stage-2 redacted rows). But the **interactive iMessage door** hands Metis raw thread text, which includes *others'* (crafted) replies, into a session that also holds `brain-commit` and outbound tools. This is exactly tension #2 the prior-art review flagged as "needs a plan amendment"; the reduction pipeline doesn't cover it, and there is **no named mechanism that binds a session's toolset to whether its inputs are trusted.** As written the separation is aspirational, not tool-enforced.

## Boundary 3 — Container ↔ host

**Loopback is not a trust boundary here.** PoC-4 confirmed Docker's userland proxy makes 127.0.0.1-bound host bridges reachable from the container, and `docker-compose.yml` binds Postgres `127.0.0.1:5432`. So "loopback only" isolates from the LAN but **not from the container**, which is a distinct trust domain holding the entire TCC surface.

**Do the host TCC bridges bearer-authenticate the container, or trust loopback?** This is the pivotal unresolved question. PoC-1/PoC-4 drove the bridge with `denials:[]` and no mention of a bridge token. Phase-0 open question #5 says "require real auth on any TCC-privileged bridge **before it is proxied anywhere**" — implying loopback-local calls are currently unauthenticated. Under invariant 8's own logic that's a gap: if the Messages/EventKit/FDA bridges trust loopback, then **any container compromise (or any other host/tailnet process that reaches the port) drives TCC-privileged actions unauthenticated** — read all Messages/Mail, send iMessage to anyone, CRUD calendar/reminders. **The TCC bridges must require a bearer token from the container**, per-bridge, and ship a misuse test.

**Blast radius of container compromise:** full TCC surface via the host bridges + the subscription **OAuth token in container env** (`CLAUDE_CODE_OAUTH_TOKEN`, ~1yr, no auto-refresh, no revocation-on-leak story; env vars leak via logs/crash dumps) + Postgres (app user has full SQL) + the mounted instance git repo. The watchdog tracks token *expiry*, not *misuse*.

**Invariant 3 is app-layer convention at this boundary.** "One read path / no arbitrary SQL" is enforced in the console/router, not by the DB — the app DB user holds full DDL/DML. PoC-8 explicitly flagged that `psql -c` has no safe param binding; if any named query interpolates params instead of using a parameterized driver, **SQL injection through a named-query param reopens arbitrary SQL.**

## Boundary 4 — Console HTTP API (management surface)

This is the crown-jewels boundary: token issuance, grant PUT, proposal accept, elevation approve.

**Stored XSS from agent-authored fields → management-token theft (critical).** The triage UI renders agent-authored content: proposal text, report bodies, provenance, elevation `reason`. A **write-only, tier-0 capture agent** can submit a proposal whose text is an XSS payload; when the user opens the triage PWA, it executes with the **management bearer token in scope** (stored in the phone's PWA/localStorage) and exfiltrates it. This **upgrades a write-only capture token into full management compromise** (mint tokens, self-grant reads, self-accept poison). The plan never mentions output-encoding agent-authored fields. Highest-leverage concrete attack in the design.

**Token privilege tiers are not enumerated.** The plan says management mutations "carry the same auth as everything else — a bearer credential on every request" (§4.2). If agent tokens and the owner credential share one namespace, it must be **explicitly forbidden** that an agent token can call `POST /api/proposals/:id` (accept), `PUT /api/agents/:id/grants`, or `POST /api/agents` — otherwise an agent self-accepts its own poison or self-elevates. Management endpoints must require the **owner** credential, distinct from any agent token, and this needs a misuse test.

Good posture already present: header bearer (avoids cookie-CSRF), "authorize server-side per request, never per session-establishment," uniform existence-non-leaking errors (§4.2). Keep those.

## Boundary 5 — TCC host bridges (native tier)

Stable-signed binaries (Developer ID, Team-ID-bound grants) solve **grant-rot / availability**, not authz. Each is a loopback HTTP server carrying FDA/Automation/EventKit — powerful ambient authority whose only gate is the bridge token (Boundary 3). One correction to how the plan frames a control:

**Preview-then-confirm is not a security control against a compromised caller.** §4.3/PoC-9's "destructive tool triggers confirmation in Metis" protects against model *slips* — but the confirmer (Metis) is **inside** the trust boundary, so a prompt-injected Metis simply issues both calls. Truly dangerous operations (mass delete, `send` to a novel recipient) need **out-of-band human confirmation**, not in-agent confirmation. The plan should distinguish these; today they're treated as one class.

## Boundary 6 — Git / protected-path governance

Enforcement layers (§4.6): (1) `brain-commit` path refusal, (2) GitHub ruleset — **unavailable on the free org tier** (confirmed in the repo's own MEMORY notes), (3) CODEOWNERS (review-only, doesn't block pushes). So the actual server-side line of defense doesn't exist, and the real enforcer is `ops/git-hooks/pre-push`, which is:
- **Client-side and per-machine** (its own comment admits this).
- Bypassable by `METISTRY_ALLOW_MAIN_PUSH=1` (documented escape hatch) **and** by `git push --no-verify`, which skips pre-push hooks entirely and isn't mentioned.

Net: protection of `CLAUDE.md` (Metis's own constraints) and `router/rules.yaml` (routing/budget — "an agent that can edit its routing can grant itself Opus on everything," §4.6) reduces to **(a) `brain-commit` refusing non-`Knowledge/` paths AND (b) Metis having no shell/raw-git** — i.e., back to the unstated assumption at the top. The `Brain-Source: cos` trailer that distinguishes agent commits is **self-declared and forgeable** by anything other than `brain-commit` (§4.18 itself cites audit-field impersonation as a documented attack class).

## Boundary 7 — Watchdog

Model-free (can't be prompt-injected), out-of-band iMessage, minimal surface — correctly scoped. One structural gap: it is an **availability/cost watchdog, not a security monitor.** It probes token expiry, Docker liveness, collector staleness, and (prior-art rec #7) cost-per-cycle. Nothing watches the `runs` table — which logs every read, grant, escalation, and outbound — for **abuse signatures**: an agent token suddenly reading every note in its scope (exfil), a spike in elevation requests, a burst of outbound. Given invariant 8's "adversaries probe every interface," the absence of any `runs`-based anomaly alarm means token leaks and slow exfil are only ever visible in post-hoc audit, never caught live.

---

## Priority summary

**Critical — settle before Phase 1 freezes `core`/tool surface:**
1. Write the missing invariant: the engine container has **no shell and no raw git**; `brain-commit` and the allowlisted bridges are the entire mutating/outbound surface. Everything in §4.6 depends on it. (B2/B6)
2. **TCC host bridges must bearer-authenticate the container** — loopback is reachable from the container and is not a trust boundary; the container holds the whole TCC surface + OAuth token. (B3/B5)
3. **Output-encode all agent-authored fields in the console/PWA** — stored XSS in the triage UI turns a write-only tier-0 token into management-token theft. (B4)
4. **Separate token privilege tiers**: agent tokens confined to capture/report/scoped-read; management endpoints require owner auth. Ship misuse tests. (B4)

**High:**
5. Owner-handle allowlist on Messages `send`; out-of-band confirm for novel-recipient/mass-delete; recognize the brief-as-boundary collapses under Metis compromise. (B2/B5)
6. Name the enforcement point for reader/writer separation on the **interactive** iMessage door (third-party text currently enters a commit/exfil-capable session). (B2)
7. Friction proportional to a proposal's destination power; make `Me/` a hard tool-level denylist independent of prefix grants. (B1)
8. Token lifecycle (revoke/rotate/expire) + a `runs`-based abuse monitor in the watchdog. (B1/B7)

**Medium:** task-claim quotas/lease caps and report rate-limits (B1); elevation-reason UI hardening (B1); `--no-verify`/free-tier reality means protected-path enforcement is entirely client-side (B6); parameterized named queries or invariant 3 reopens arbitrary SQL (B3); stop counting in-agent preview-confirm as a security control (B5).

The recurring theme: the plan's motto is "enforce at the tool, never by prompting," and it lives up to it for the *availability* findings Phase 0 surfaced (TCC identity, redaction, signed binaries). The remaining exposure is that several *authorization* boundaries — Metis's git/shell reach, host-bridge auth, management-vs-agent token privilege, and the human triage tap — are still enforced by convention or by an unspecified mechanism, and each has a concrete adversary in the plan's own threat model.
