Read in full: the 1837-line build plan, `docs/poc/RESULTS.md`, both research docs, README, CLAUDE.md, and everything built so far (migration 0001, compose, ops scripts, seed, package.json).

---

# Architecture review — Metistry build plan

## Findings, most important first

### 1. [critical] [seam] §4.4 / §4.6 / §4.15 — the product/instance split was decided but never propagated into the file layout, and the plan now contradicts itself in four places

The split (§4.15, decided 2026-08-28) says the product repo holds `router/`, `agents/`, `collectors/`, `routines/`, `skills/`, `db/migrations/`, and the instance repo holds `Knowledge/`, `inbox/`, `identity.yaml`, `rules.yaml`, `sources.yaml`, `deployment.yaml`, `now.md`, `metistry.lock`. Consequences the plan hasn't absorbed:

- **§4.4 promises "adding a query is a file, not a deploy."** Post-split, `router/queries/` is product code — adding a named query for your own dashboard is a PR to the OSS repo and a release. That promise is now false, and named queries are the single most-added artifact in the design (§5: "add a dashboard panel → a named query"; "add a command → a rule in `rules.yaml` plus a named query").
- **`rules.yaml` has two homes.** §4.6/§4.8 call it `router/rules.yaml` (product, protected, PR-required); §4.15 puts `rules.yaml` at the instance root. Same file, two repos, two governance stories.
- **§4.6's three enforcement layers are written for the pre-split world.** All nine protected paths are product-repo paths. In the instance repo the only protected things are the four YAML files, and layers 2 (GitHub ruleset) and 3 (CODEOWNERS) don't exist there — the FSL org is free-tier with no private-repo protection (your own memory note). Only layer 1 (`brain-commit` refuses non-`Knowledge/` paths) survives, which is fine, but the section should say that rather than describe protections that evaporated.
- **`now.md` is in two places.** §4.14's vault tree puts it at `Knowledge/now.md`; §4.15's instance tree puts it at the instance root next to `Knowledge/`. This one is load-bearing: `brain-commit` stages only `Knowledge/`, so if `now.md` sits at the root, the assistant is mechanically unable to write its own working memory — the thing the evening routine exists to maintain.
- **§5's "add a collector → a migration if it needs a table"** means a *local* extension (§5, provenance level 3) requires a migration in the *product* repo.

This is the definition of cheap-now/painful-after-Phase-2: every one of these is a directory decision today and a layered-config retrofit plus data migration later.

**Recommendation:** decide the overlay now. The instance repo owns *all configuration-shaped things* — `queries/`, `agents/`, `routines/`, `rules.yaml`, `extensions/`, and an `instance-migrations/` dir applied after product migrations. The product ships defaults in `seed/`; the loader resolves instance-first-by-filename and logs which layer won. Fix `now.md` to `Knowledge/now.md` and rewrite §4.6's protected-path list against the two-repo reality.

---

### 2. [critical] [ops] §1 invariant 1 vs `db/migrations/0001_init.sql` — the schema already fails the invariant's own test, and the backup story is built on that false premise

Invariant 1: `docker compose down -v`, rebuild, run collectors once → back in business "minus historical trend lines. Anything failing that test belongs in the backup; nothing else does."

Run that test against 0001 honestly:

| table | survives `down -v` + rebuild? |
|---|---|
| `metrics` | no — acknowledged (trend lines) |
| `runs` | **no** — and the entire §4.17.D visibility story, the §4.10 grant audit, and invariant 8's "audit logs" depend on it |
| `sessions` | **no** — rolling summaries, open loops, decisions, refs. §4.16 rule 6 makes this table *the* continuity mechanism when a transcript is lost. Losing it loses every thread |
| `work` | partially — `kind: issue`/`event` reconcile from source; `kind: thread`/`task` have no source |
| `inbox` | **no** — triage state (which of 400 captured files were already accepted/rejected). On rebuild, `inbox-drain` re-classifies everything or orphans it |
| `knowledge_files` / `knowledge_links` / `embeddings` | yes — genuinely derived |

So four of eight tables hold non-derivable state. The invariant as written will be cited later to justify treating the nightly dump as optional, and the quarterly drill (§5) as a formality.

**Recommendation:** (a) annotate every table in the migration `-- durable` or `-- derived`, and make that a CI-checked comment convention on future migrations; (b) restate invariant 1 as "git is the record for *knowledge*; Postgres holds derived state plus a named durable set that the nightly dump must cover"; (c) make the quarterly drill the real one — `down -v`, rebuild from the instance repo + last dump, run collectors, verify three queries — not a scratch-DB restore that never touches the live path. Alternatively, push `sessions` summaries and inbox triage outcomes into the instance repo (a sidecar per inbox file, which PoC-7 already writes) and shrink the durable set to `runs` + `metrics`.

---

### 3. [critical] [seam] §4.6 / §4.12 / §4.13 / §4.15 — two git committers, an unowned reconciler, and no decision on how a containerized assistant reaches the vault

Three unresolved things that are all the same seam:

- **Two writers to the instance repo.** §4.6: the assistant calls `brain-commit`. §4.13: "The reconciler owns commits" and mobile edits "get committed on the next reconciler cycle." §4.15: "written by `brain-commit` and the reconciler." The plan rejects Obsidian Git with "Two committers to one repo is the exact conflict scenario this design avoids" — and then ships two committers. Concurrent `git commit` on one worktree is an index-lock race, and a crash between them leaves a partially staged tree.
- **The reconciler has no home.** It appears eleven times and owns indexing, rename-by-hash, link parsing, conflict detection, cross-area-move surfacing, freshness, *and* committing. It is not in `apps/`, not in `packages/`, has no manifest `type` (the schema allows `bridge | collector | agent | routine | target`), and appears in no phase except obliquely as Phase 6's `knowledge-embed` collector. The single most operationally central non-model component is unassigned.
- **Filesystem seam undecided.** Decision #9 puts the assistant in Docker. Invariant 7 rule 2 says "no component assumes it shares a filesystem with another." But `brain-commit` writes vault files and runs git. Either the vault is bind-mounted into the assistant container (violating rule 2, and breaking the `cloud` profile where the Mac holds the Obsidian-Sync'd vault) or `mcp-brain` runs `runs_on: host` as an HTTP bridge like the TCC bridges (consistent, and the shape PoC-1/4 already validated). The plan never says which, and it changes what `mcp-brain` is.

**Recommendation:** one committer — the reconciler — full stop. `brain-commit` becomes write-file + enqueue-commit-intent; the reconciler batches and commits at a quiescent moment (verify `git status` stable across two reads before committing, per the prior-art note that any background write trips Sync's conflict detector). Give the reconciler a home: `apps/reconciler` as a `runs_on: host` service with a manifest, so `doctor` can see it. Rule that `mcp-brain` is `runs_on: host` under `local-mac` and the sole holder of a vault mount, with the `cloud` profile using a cloned worktree + git webhook (§4.16 rule 4 already anticipates the trigger half; this is the other half).

---

### 4. [major] [simplify] §4.2 / §4.15 / invariant 3 — `apps/router` as a third container, and no code home for the "one read path"

`apps/router` ships as its own image (`ghcr.io/foldedspacelabs/metistry-router`). But the console already serves `/api/q/:name`, `POST /message`, `/api/state`, and `/api/stream`; PoC-8 built the fast path *inside* an HTTP server; and the 200 ms bar is met at 0.6 ms cached. A separate router adds a hot-path network hop, a second pg pool, a second `rules.yaml` loader, and a second deployment to version — for nothing the console isn't already doing.

Worse: invariant 3 says named queries are consumed by "the router, the `brain-query` MCP bridge, the console, and Obsidian" from "one implementation" — but **no package implements them**. `packages/core`'s listed scope (manifest schema, lazy discovery, redaction, preview-confirm, `check()`) doesn't include query loading, param validation, TTL caching, or the `as_of` stamp. Three consumers will each write their own, and PoC-8's build notes ("`psql -c` has no safe param binding") say the first one written wrong is an injection bug.

**Recommendation:** collapse `apps/router` into `apps/console` (router becomes a module, `rules.yaml` a config file). Create `packages/queries` — loads YAML query defs, validates params by declared type, executes against an injected pg pool, caches per `cache_ttl`, returns `{rows, as_of}`. That package *is* invariant 3. Do it before Phase 2 writes the first `/api/q` handler.

---

### 5. [major] [core] §4.3 / Phase 1 — core is too thin on the four things every component needs, and `check()` has no defined return type

Current scope: manifest schema, lazy discovery, redaction, preview-confirm, `check()`. What's missing, each of which will otherwise be reinvented 8+ times:

- **`runs` emission.** "Every bridge logs one row per call to `runs`" (§4.3), but rule 1 forbids packages importing Postgres. Unspecified, so bridge #1 writes a pg client into a "standalone" npm package and the arrow reverses. Core should define a structured event emitter (JSON lines to stdout, or an injected sink) and the host persists.
- **HTTP bridge auth and error shape.** Invariant 8 requires every request authenticated as if internet-exposed, "uniform errors that don't leak existence," and misuse tests shipped with each interface. If each bridge hand-rolls bearer validation, invariant 8 dies by a thousand implementations. Auth + the uniform error envelope + a shared misuse test kit belong in core, written once, tested once.
- **Config-from-env loading and validation.** "No absolute paths, config from environment" is currently a rule to remember. `loadConfig(schema)` makes it a rule that's enforced.
- **Manifest *runtime*, not just schema.** Registry discovery, `source: npm | uvx | local` resolution (§5), and — importantly — the *same* validator used by CI and by `metistry doctor`. Two implementations will diverge, and doctor is the one that runs on a stranger's machine.
- **`check()`'s return type is undefined.** Four consumers (doctor, watchdog, `/health`, CI) need one shape. From PoC-1/9 it must carry: status, latency, a human remediation string, and an assertion that the probe was *behavioral* (attempted the privileged read) rather than a permission-API read — the exact failure mode that produced three false reports in Phase 0.

**Too fat in one place:** lazy discovery is the plan's own biggest untested claim, and the spike is correctly scheduled before the freeze — but putting it inside `core` means a bad spike result forces a core redesign that every bridge already imports. Ship it as `packages/mcp-discovery` (or a `core/discovery` subpath export) with `eager` as the default, so the swap is a dependency change rather than an interface break.

---

### 6. [major] [simplify] §4.2 / §4.10 / §4.11 / §4.14 / §4.18 — five approval queues that are one queue

The plan already unified internal/external knowledge access (2026-08-29). The same unification is available here and hasn't been taken. Today there are five distinct "an agent suggests something, you tap yes or no" surfaces:

1. `inbox` rows with `proposal jsonb` and `status new|classified|accepted|rejected` (migration 0001)
2. The `brain-report` queue that Metis folds in on the evening routine (§4.10)
3. `GET /api/proposals` + `POST /api/proposals/:id` allow / deny / accept_with_changes (§4.2) — storage unspecified
4. `status: draft` notes surfaced in the morning brief for one-tap settle/reject (§0, §4.14)
5. Grant elevation requests, `POST /api/grants/requests/:id` (§4.2, §4.10)

Plus the PoC-14 remnant (split suggestions surfaced for confirmation) if it ever ships. Every one has the same shape: provenance (source agent, trust level, session), a payload, a decision, feedback routing back to the source agent's inbox (§4.18), and a `runs` audit row. Five implementations means five notification paths, five API shapes, five places the event-driven push in §4.18 has to hook, and five places to get the "agent messages can never carry user authority" rule right.

**Recommendation:** one `proposals` table — `kind` (capture | report | knowledge_draft | grant_request), `source_agent`, `trust`, `payload jsonb`, `decision`, `feedback`, `decided_at` — one triage endpoint, one push notification, one brief section. `draft` frontmatter stays as the *vault-side* marker of the same row. This is one table and one UI instead of five, and it's the difference between "event-driven triage" being a Phase 5 feature and being a Phase 5 project.

---

### 7. [major] [scope] §3 — the phasing is honest about ordering and dishonest about duration; here is what I'd cut

Counting always-on parts at the end of Phase 5 as scoped: 4–5 containers (db, assistant, console, router, possibly Home Assistant), 6–8 launchd services (messages, eventkit, apple-fm + Swift helper, health, watchdog, reconciler, Ollama for embeddings *and* the tier scorer), ~6 collectors, ~5 routines, ~8 published npm packages under changesets with Developer ID signing and notarization, 3 container images to ghcr, a 5-command CLI, a PWA with push and a management UI, and the instance-repo release/migration machinery. That is a small platform team's surface area.

Against that, the stated durations — Phase 1 a weekend, Phase 2 a weekend, Phase 3 a few evenings, Phase 4 a week of evenings — are off by roughly 3–5x. Phase 2 alone is: a code-signed, notarized, stably-identified native binary (first-time notarization is an afternoon of failure on its own), the `attributedBody` typedstream decoder, a launchd plist with correct `KeepAlive` (PoC-11 found the `launchctl submit` respawn trap), the Agent SDK container with token injection, `sessions` wiring plus the delete-transcript-and-re-brief test, the router, `rules.yaml`, `runs` logging, and the reader/writer separation rule from §4.11. That is several weekends, and the "Done when: you text yourself and get a useful answer" gate is the right gate — it just isn't a weekend away.

**What I'd cut or defer owning this alone:**

- **`apps/router`** — fold into console (finding 4). −1 image, −1 pool, −1 hot-path hop.
- **The management API + PWA management UI (agents, grants, projects) out of Phase 4.** For one user with zero external agents, `metistry grant <agent> <area>` writing the same server-side row is 20 lines against a CRUD surface plus auth plus misuse tests. Invariant 8 says keep this surface small; the smallest version is the one that doesn't exist until a second agent does.
- **Web push out of Phase 4.** PoC-6 passed, but production push means VAPID key management, a subscriptions table, service-worker lifecycle, and iOS reinstall quirks. iMessage already notifies and is the primary door. Push earns its place alongside event-driven triage (Phase 5+), not before.
- **The coordination hub (§4.18) stays late, and the management API stays with it.** The research is right that it's ~5 tools and ~3 columns of *code* — but leases, heartbeats, dependency edges, per-agent inboxes, project rollups, and feedback routing are operational surface. Reserve the columns in a migration now (free); build the tools when a second agent is actually doing work.
- **`mcp-health`** — listed in §4.15's package tree, appears in no phase, has no named consumer, and §4.16 says HealthKit has no fallback. Delete it from the tree until a query needs it.
- **Home Assistant.** §7 recommends it ("Docker on the Mac"); §6.10 defers HomeKit and drops video analysis; PoC-10 is deferred for lack of hardware. Resolve to "not now" — HA is an entire platform with its own upgrade treadmill, and adopting it adds more maintenance than the whole home tier currently returns.

---

### 8. [major] [ops] §4.15 — `metistry update` has no rollback, and compose upgrades have no migration ordering rule

"`metistry update` bumps `metistry.lock`, pulls the pinned artifacts, and runs migrations (the `schema_migrations` table makes that idempotent)." Idempotent is not recoverable. As specified there is no pre-update dump, no down migration, no lock rollback, and the new images are already running when migration 3 of 5 fails. On a solo-maintained personal system, a failed migration at 11pm on a Tuesday is the scenario that ends projects.

Related, and cheap now:

- **No ordering rule for compose + schema change.** If console and assistant both migrate at boot, two containers race. `ops/scripts/migrate.sh` has no `pg_advisory_lock`, so concurrent runs can both pass the `schema_migrations` check and both apply.
- **No forward-only/additive rule stated.** With no down migrations, every schema change must be additive-first (add column → backfill → switch readers → drop in a later release). Unstated, this gets violated the first time a column is renamed, and instances on older locks break.
- `migrate.sh` currently requires the repo checkout and a host `psql`. An instance install has neither. Migrations need to ship inside a released artifact and run from a container.

**Recommendation:** `metistry update` = `pg_dump` → pull → run migrations in a one-shot `migrate` compose service holding `pg_advisory_lock` → start services with `depends_on: {migrate: {condition: service_completed_successfully}}` → `metistry doctor` → on any failure, restore the dump and re-pin the previous lock. Write the additive-first rule into `CLAUDE.md` next to the invariants.

---

### 9. [major] [ops] `db/migrations/0001_init.sql` `runs` — you cannot see an in-flight or crashed call, which is exactly the runaway you're trying to catch

`runs` has `ts` + `duration_ms` + `ok`, i.e. rows are written on completion. A call that hangs, retries in a loop, or dies logs nothing at all. The prior-art review's recommendation #7 — cost-per-cycle against a rolling baseline, alert at ~10x, treat rate-limit-shaped output as terminal, backed by a documented $1.8k bill and the note that runaway retry loops are I/O-bound and invisible to CPU monitoring — is in the research and **did not make it into the plan's watchdog or §4.17.D**. §4.17.D covers budgets, but budgets are enforced at the dispatch tool on completed spend.

**Recommendation:** two-phase rows — insert on start with `started_at` and a null `finished_at`, update on completion. Then "what is running right now," "what died mid-call," and "what has been retrying for 40 minutes" are all one named query, and the watchdog gets its rolling-baseline probe for free. This is a column pair in 0001, today, versus a migration plus a rewrite of every emit site later.

---

### 10. [major] [seam] §4.2 — `POST /message` returns 202 with nothing durable behind it

"Build the client as a messaging client from day one — retrofitting that is painful" is exactly right, and then there is no queue. No table in 0001 holds a pending message; `sessions` has no pending concept. If the assistant container is restarting (which it will be, on every `metistry update`), a 202 is a lie and the message is gone. Same for the iMessage door: the bridge polls `chat.db` and hands off — to what, if the assistant is down?

**Recommendation:** inbound messages land in a durable row before the 202, and the assistant drains it. This is one small table (or a `kind: message` convention on `inbox`) and it also gives you the redelivery path after a crash, the "what did I ask while it was down" answer, and a natural place for the deterministic pre-check that prior-art rec #6 wants before any model turn.

---

### 11. [major] [stack] §4.15 — the signed-binary requirement is the hidden long pole on Phase 2's critical path, and two of the three bridges are already Swift

The requirement is correct and empirically forced (three grant-rot variants in Phase 0). But look at what it implies for a TypeScript-everywhere stack: each TCC bridge must be a stable-identity signed binary, shipped *inside an npm package* so `npx @foldedspacelabs/mcp-messages` still works for a stranger. For a Node bridge that means Node SEA, per-arch, code-signed with your Developer ID, notarized (a release step requiring an Apple ID + app-specific password, and "CI signing needs certificate management if releases ever move off this Mac" — the plan says this, then moves on). That is a build-system project sitting directly on the path to "you text yourself and get a useful answer."

Meanwhile `mcp-apple-fm` is *already* a Swift helper (FoundationModels is Swift-only), and EventKit is a Swift/ObjC framework where the Node route means a bridge process shelling to a Swift helper anyway. So the plan already has a Swift toolchain, a Swift signing story, and a Swift binary in an npm package — for one of three, with a second that wants it.

**Recommendation (high conviction, and it reduces total machinery):** write all three TCC bridges as Swift binaries that speak MCP over HTTP directly — `messages` is a SQLite read plus the validated `attributedBody` decoder plus an AppleScript send; `eventkit` is CRUD; `apple-fm` is already Swift. One toolchain, one signing story, no SEA, no Node-in-a-signed-wrapper, and the npm packages become thin publishers of a prebuilt notarized binary (which is what they were going to be regardless). TypeScript keeps everything else. Decide this before Phase 2, because it determines what `packages/core` must be usable from — if the native tier is Swift, core's bridge contract needs a documented wire-level definition (manifest shape, auth header, error envelope, `check()` response JSON) rather than a TypeScript base class, which is a *better* contract for an OSS project meant to be forked.

---

### 12. [major] [simplify] §4.3 / §4.2 / PoC-11 — three health mechanisms, and the two components most likely to die silently aren't in the registry

`check()` (per component), `metistry doctor` (iterate registry, call check), `/health` (liveness + collector staleness), and the watchdog (independent model-free probes of token, container, collector staleness) are four things doing one job with at least two implementations of staleness. Worse, invariant 5 says "everything is a directory with a manifest" and the manifest `type` enum is `bridge | collector | agent | routine | target` — **the watchdog, the reconciler, and the console have no type**, so `doctor` cannot see them. The reconciler and the watchdog are precisely the two components whose death is invisible (PoC-11 already produced a false `docker:DOWN` from a launchd PATH gap).

Also note a real, legitimate tension with invariant 3: the watchdog must probe collector staleness *without* depending on the console (that independence is its entire point, PoC-11). So the watchdog is a deliberate exception to "no component talks to Postgres directly" and should be named as one — otherwise the first implementer either silently violates the invariant or makes the watchdog depend on the thing it watches.

**Recommendation:** add `type: service` to the manifest enum and register the reconciler, watchdog, and console. The watchdog becomes a scheduler + out-of-band alert channel over the same `check()` results doctor uses — not a second probe implementation. Name the invariant-3 exception explicitly, with the reason. And add the cheapest possible watchdog-liveness check: a weekly "still here" message, so silence is a signal rather than the normal state.

---

### 13. [major] [scope] §Terminology / §4.5 — routines have a schedule and no runner

"Routine | A schedule, nothing more | Triggered by Cron | Writes nothing directly." Nothing in the plan owns firing them. Host cron? launchd? A cron container? For a system whose daily value is the morning brief, the evening distillation, the nightly triage, the nightly sweep, and the weekly review, the scheduler is unassigned — and three of those routines are the ones that make the vault compound.

It also has no home for the behavioral rules the research says are load-bearing: deterministic pre-check before any model turn, isolated minimal-context sessions, silence as default output, speak/silence ratio instrumented, ≥15-minute cadence floor (prior-art rec #6, backed by the $36/day idle-heartbeat evidence).

**Recommendation:** one routine runner inside `apps/console` — it already has the pg pool, the named queries, and the `runs` sink. Schedules come from manifests, each fire writes a `runs` row with a per-routine-per-day idempotency key (which also gives you finding 15's half-run detection), and the pre-check hook is a runner feature rather than something each routine remembers.

---

### 14. [major] [stack] `CLAUDE.md` — "ask before adding a dependency" is right, but Phases 2–4 need a pre-approved list or it becomes a per-PR debate

Predicted actual needs, based on the PoC evidence: `@modelcontextprotocol/sdk` (§7, decided), `@anthropic-ai/claude-agent-sdk`, `pg` (PoC-8: "real console must use a persistent pool"), a YAML parser (manifests, queries, `rules.yaml`, frontmatter — four consumers), a schema validator (`zod` or `ajv`) for the manifest runtime shared by CI and doctor, a frontmatter parser (or hand-rolled on the YAML lib), a cron parser (`croner`/`cron-parser` — CI validates "every `schedule` a parseable cron," and the runner needs the same one), `chokidar` (the plan names it). That is ~7–8 runtime dependencies. Everything else the PoCs proved you can hand-roll and should: HTTP (node:http), multipart (PoC-7, Buffer-based, 25 MB byte-identical), VAPID/web push (PoC-6, node webcrypto), SSE, env loading (`node --env-file`), git (shell out).

Two smaller stack notes:

- **§5 says "add a collector → `collectors/<name>/{manifest.yaml, run.py}`."** Python contradicts CLAUDE.md's stack and would mean a second runtime in the images, a second dependency manager, and a second `check()` implementation. Either a doc bug or an undeclared decision — I'd rule TypeScript collectors.
- **changesets across ~8 packages with one maintainer** is per-package ceremony on every change. Consider fixed/locked versioning (changesets supports it) so a release is one decision, not eight.

**Recommendation:** write the approved list into `CLAUDE.md` now, with the "hand-rolled, PoC-proven" list beside it. The rule then protects you from dependency 9, which is the one it was written for.

---

### 15. [major] [ops] §4.6 / §4.10 — no story for a routine that dies halfway through writing knowledge

The evening distillation writes N notes and commits. If it dies after 3 of 6, you get a half-distillation in the record with nothing marking it as partial, and the next night's run either duplicates or skips — and duplication is the #1 documented AI-vault failure mode in your own prior-art review ("AI landfill"). Similarly, a crash between file write and commit leaves an uncommitted file that the reconciler will happily index (invariant 1 says git is the record; the index would then hold something the record doesn't).

**Recommendation:** `brain-commit` is all-or-nothing at the git level — stage every file of one logical unit, commit once, or nothing. Each routine writes a `runs` row with a per-routine-per-day idempotency key at start and completion, so a half-run is detectable and safely re-runnable. And the reconciler indexes committed state only, never the working tree — which also makes "the index is derived from git" literally true.

---

### 16. [minor] [ops] §6 decision 1 + `inbox` table — triage state is the only record that a captured file was handled, and it isn't derivable

Decision #6.1: "Inbox: files. Triage record is a Postgres row referencing the file." After a rebuild, `inbox-drain` re-classifies every file that ever landed, or silently orphans them. §4.11's over-extraction concern makes this worse: re-proposing 200 already-rejected items is exactly the "queue of forty proposals a day gets ignored" failure.

**Recommendation:** the triage outcome goes in the file's metadata sidecar (PoC-7 already writes one), or accepted/rejected files move out of `inbox/`. Then the PG row is genuinely derived and decision #6.1's "files" claim is true end to end.

---

### 17. [minor] [seam] §4.2 / §4.13 — Obsidian is named as a named-query consumer, but reaching an authenticated HTTP API from Obsidian requires a plugin that is in no phase

"Obsidian pointed at `knowledge/`, reading state via the console HTTP API" (Phase 6). Obsidian cannot call a bearer-authenticated endpoint without a community plugin or a custom one — and §4.13 explicitly rejects mainstream AI plugins in the write path, and the prior-art review found 341 malicious skills in the leading marketplace.

**Recommendation:** the console renders a `Knowledge/Dashboard.md` on the reconciler cycle (or a routine) with the fast-path answers and freshness stamps. No plugin, works on mobile through Sync, uses the same named queries, and one fewer consumer of invariant 3. Drop Obsidian from the API consumer list.

---

### 18. [minor] [simplify] §4.7 / PoC-9 — `work` vs Reminders has no rule, and it will drift

"Todos — never markdown lists that rot: `/note` or capture → triage → the `work` table **or** Reminders, where status lives" (§4.14), and "Reminders is a *surface*, not a store. The shopping list lives there" (PoC-9). Two stores for tasks with an implicit boundary. §4.7 also says collectors reconcile `work` status from the source — is Reminders a source that a collector reconciles, or a separate world?

**Recommendation:** one sentence of rule. Something like: Reminders holds things the *phone* must nag you about (time/location triggers, shared lists); `work` holds things the *system* tracks status on; a `work` row may carry `external_ref: reminder:<id>` and a collector reconciles it, exactly like GitHub issues. Then there is one status view and one federation mechanism, not two.

---

### 19. [minor] [doc] cross-document hazards in a plan that is cited by number ~30 times

- **Invariant numbering collides.** The plan has 8 invariants; `CLAUDE.md` has 7, differently ordered. Plan #4 = deterministic router; `CLAUDE.md` #4 = manifest. Plan #7 = cloud-portable; `CLAUDE.md` #7 = enforce-at-the-tool — and the coordination research already cites "invariant 7 restated" meaning enforce-at-the-tool, which under the plan's numbering is wrong. "Enforce at the tool" has no standalone number in the plan at all (it's folded into #2). For a doc explicitly meant to be reviewable in a year, make `CLAUDE.md` reference the plan's numbering verbatim, or stop numbering in one of them.
- **Duplicate `### 4.4`** — "Skills" and "Named query contract" share the number; §4.4 is cited elsewhere.
- **§7 recommends Home Assistant vs §6.10 defers HomeKit** (finding 7).
- **`docker-compose.yml` line comment**: "loopback only — remote access rides the tailnet, never a LAN bind." Invariant 8 says code never assumes a routing layer and docs may only suggest patterns. This is shipped product code telling a stranger their exposure model. Reword to "loopback by default; exposure is your routing layer."
- **§4.15 rule 1** ("no package imports project config, Postgres, or the vault") vs `mcp-brain`, which is by definition vault + Postgres + named queries. Needs an explicit carve-out: config *injected via env* is not an import — otherwise the first implementer either breaks the rule or fragments `mcp-brain`.

---

## What is genuinely strong

- Phase 0 is unusually honest work: two informative FAILs preserved rather than buried, an invariant defended against the author's own proposed amendment (PoC-14, then PoC-15/16 held to a confirmatory eval anyway), and an ill-posed cost criterion corrected mid-flight rather than reported as a pass.
- The TCC findings were converted into hard structural rules — own launchd service, stably-signed binary, behaviorally-probing `check()` — instead of remaining as notes. Three separate silent-failure modes found and each one turned into a design constraint.
- "Enforce at the tool" is applied where it costs something: deterministic redaction of *model output* after a local model copied a live OTP through an explicit prompt instruction; grants attached server-side to credentials; reader/writer separation for untrusted content.
- The product/instance repo split, decided before a vault existed. It makes the work/personal IP boundary mechanical rather than disciplinary, and it was nearly free at the moment it was taken.
- Deferral discipline backed by numbers, not taste: GraphRAG rejected on its own vendor's ablation, A2A rejected on adoption evidence, orchestration frameworks rejected on "who owns the code in six months," Phase 6 knowledge deliberately last.

---

## Top 3 "change before writing code"

1. **Resolve the config/code overlay implied by the product/instance split** (finding 1). Move `queries/`, `agents/`, `routines/`, and `rules.yaml` to the instance layer with product defaults and a filename-wins overlay; fix `now.md` to `Knowledge/now.md`; rewrite §4.6's protected-path list for two repos. This contradiction is currently *in* the plan, and it gets more expensive every phase.

2. **Fix the substrate contracts before Phase 2's first handler.** Create `packages/queries` as the one implementation of invariant 3; collapse `apps/router` into the console; freeze `check()`'s return shape; add HTTP-bridge auth + a uniform error envelope + `runs` emission to `core`; and add `started_at`/`finished_at` to `runs` in migration 0001 while it costs one line. Every one of these is retrofitted across a dozen components otherwise.

3. **Reconcile invariant 1 with the schema, and name the vault seam.** Label each table derived vs. durable; make the nightly dump load-bearing for the durable set and the quarterly drill a real rebuild; declare one git committer (the reconciler) and one vault-holding process (`mcp-brain`, `runs_on: host`); and make `metistry update` dump-before-migrate with lock rollback. This is the difference between an outage and data loss on a system with one operator.

---

## Verdict

Buildable by one person — but not on the stated schedule, and not at the stated end-state scope without cuts. The architecture is genuinely sound: the seams that matter (deterministic router, sole-writer vault, brief-as-context-transfer, TCC-bound native tier as its own signed services, product/instance split) are cut in the right places and defended by real evidence rather than taste, and the Phase 0 discipline suggests the author will keep making honest calls when findings contradict the design. The failure risk is not any single component; it is the *count* of always-on parts — roughly a dozen services plus a publishing pipeline with notarization — colliding with a solo maintainer's weekend, at which point the system's own maintenance cadence (weekly review, quarterly restore drill, monthly spend check) becomes the first thing to lapse, and an unmonitored personal AI that writes to a vault decays quietly. The plan is thorough on security failure and comparatively thin on operational failure, which is backwards for a one-operator system: nobody will attack this before Postgres fills a disk or a migration fails at 11pm. Cut the router container, the management UI, push, the coordination hub, `mcp-health`, and Home Assistant from the pre-Phase-6 scope; spend that budget on the update/rollback path, one committer, and a `runs` table that can see a hung call. Do that, treat each stated phase duration as roughly a month of evenings rather than a weekend, and this is a system that will still be running in three years — which is the only success criterion that matters here.
