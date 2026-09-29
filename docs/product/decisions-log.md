# Decisions log — calls made under ratified autonomy

The coordinator of the design build (`design-build-plan.md` §3) makes S-sized
calls without stopping the program: a gap the spec left open, a contradiction
between two tickets resolved toward the code, a wording picked so a type could
freeze. Each is recorded here, dated, with the ticket or PR it landed in. **The
owner scans this page and may reverse any entry**; a reversal is a new ticket,
not an edit to history.

Calls that are the owner's to make are listed separately at the end — the
coordinator records what was built meanwhile and does not decide them.

## W0 — the freeze

| Date | Where | The call |
| --- | --- | --- |
| 2026-09-26 | F-3 (#279) | `provides:` replaces `type` on connection-type manifests. The OAuth model's keys are `authorize_url`, `token_url` (https only) and `scopes`; there is no `client_secret`, and a loopback redirect requires `pkce`. `client_id` is optional — none means bring-your-own only. `implementation: native \| builtin \| bridge`. A connection file carries its settings under `config:`. `Registry<Kind>` requires `schema: 1`; `validateManifest` still accepts a manifest without it. |
| 2026-09-26 | F-5 (#278) | An unknown request kind reads as a **report**, with the excerpt as its body and Dismiss (`skip`) its only answer. `request_type` returns the owner's word (`"pull request"`). `review` defaults to the preview body. The door names `act`, `today` and `delegate` were chosen by the agent — §2.11 names none. **Owner to confirm** (ruling (c) below). |
| 2026-09-26 | F-2 (#277) | `tools.groups: CrewToolGroup[] \| null` — `null` means no allowlist. Arrays are `readonly`. `permissions.source: GrantSource`. Two permission rows beyond the spec: Queries, and Agents-delegate. Crews and external agents get narrower row types. Per-run grants are typed **read-only** (ruling (a) below). |
| 2026-09-26 | T7-1 (#273) | The PWA keeps the CLI's words **Allow · Ask First · Never** where C93 says **On · Ask · Off** — the owner's wording call (ruling (b) below). Decline's inline colour moves to T7-3a. |
| 2026-09-26 | F-8 (#272) | The policy never moves an **active** session to another model; tool definitions are fixed for a session's life. Caps under `policy.caps` bind only turns the policy served. The planner reuses `assignments.intent`'s model with the classes `simple \| moderate \| demanding`. The eval needs ≥ 50 items per class. The policy's timeout is 400 ms. |
| 2026-09-26 | F-10 (#275) | The 17 wireframe SVGs from before design round B moved to `docs/product/design/legacy/` and are exempt from `--check` — not repainted. |
| 2026-09-26 | T1-4 (#271) | A failed run (`ok = false`) carries no `meta.outcome`; T1-3 reads both. |
| 2026-09-26 | F-4 (#276) | `write: [Journal/Digest/]` in §2.5's example is inert — the path is owner-owned. Built to §2.5's `eve_of_working_days` (Sunday–Thursday evenings), not T3-7's "Friday plans Monday" text. A schedule with no timezone is refused `no_timezone`; there is no UTC fallback. |
| 2026-09-26 | F-9 (#269) | `pwa-icon.svg`'s fill is the current `bg` token, not the stale literal C12 named. |
| 2026-09-26 | F-1 (#281) | The capture token's reach is wider than §2.1's `owner` class — `whoami`, `POST /message`, `GET /api/messages`, `/api/status`, `/api/q` — recorded as it is and pinned by a test. Values frozen for routes not yet built: `stale` is the 409 reason for conflict-resolve, restore, vault-task link and the PR doors; vault-task `schedule` takes an `Idempotency-Key`; `vault.reconciled` carries the changed-file count; `vault.sync` ∈ `commit \| push \| pull \| conflict`. |
| 2026-09-26 | x-testdb-guard (#280) | Every DB-backed test opens Postgres through `testDb()`; CI's `check-test-db.mjs` fails a test file that builds its own pool. |
| 2026-09-26 | W0 housekeeping | The plan follows the freeze: T9-1…T9-4 cite `docs/ops/dynamic-router.md` as their spec and take its file lists; T3-2 depends on T3-1 (`nextOccurrence`); T3-7's test follows `eve_of_working_days`; §2.5's `write:` example marked inert; T4-5 adds `schema: 1` to every product manifest; T4-6 refuses `kind: internal` on `POST /api/agents` and encodes the tool→cell mapping; T4-10 adds an OAuth client model for custom connections (C118); T4-15 adds a fourth reach class for IMAP; T1-3 reads `ok`/`error` and `meta.outcome`; T2-3 makes `decideProposal` read F-5's table; new tickets X-2…X-5 in W1. |

## W1 — the first build wave

| Date | Where | The call |
| --- | --- | --- |
| 2026-09-26 | F-13 (#283) | Only a passkey session is answered `local_only`; agent and capture bearers keep plain `forbidden`. `api_version` stays 1. **Owner confirmed** (below). |
| 2026-09-26 | T10-1 (#289) | One commit per act. The same principal writing the same file inside one window coalesces into one commit carrying both messages and trailers. The sweep's subject is **"Edits from Obsidian"**. A writer with no group gets one commit per write (the CLI's protected writes). |
| 2026-09-26 | T2-4 (#291) | Idempotency-Key replays are held in the console's memory (24 h, 1,000 keys), not Postgres — no migration is reserved and the note is the record; after a restart a replay answers `409 stale` with the line. |
| 2026-09-26 | T2-6 (#292) | `POST /vault/section` has a closed writer list (`day: [user, morning-brief]`). An absent note is a 404 (T3-6 decides brief-before-open). The first write appends the `## Today · Metistry` heading and the markers; the markers are matched exactly (`<!-- metistry:day -->` … `<!-- /metistry:day -->`). |
| 2026-09-26 | T5-1 (#293) | The Mac's `ReachabilityGate` treats any route it does not name as a **decision** — refused while the console is unreachable. |
| 2026-09-26 | T7-2 (#294) | At ≥ 900 px the PWA follows C110 (no bell; a Needs You sidebar row; Settings at the sidebar foot). Rooms have no nav entry (C89). |
| 2026-09-26 | T4-1 (#295) | A secret's grants are `[{to, mode}]` (the fixture was re-recorded). `present` is `null`, not `false`, where there is no Keychain to ask — unknown is not absent. |
| 2026-09-26 | T5-2 (#296) | The Knowledge sidebar row has no children: no spec names them and the newest board draws none. Designer's call to add them later (additive). |
| 2026-09-26 | T4-5 (#297) | An extension cannot carry code: code only ever comes from the product, and an extension overlays data. A targets overlay without `schema: 1` is skipped, and doctor names it. |
| 2026-09-26 | T5-3 (#299) | Component snapshots are text descriptions, not PNGs — CI's macOS and a newer Mac render fonts differently. |
| 2026-09-26 | T1-8 (#301) | Migration 0027 carries a `proposals_source_shape` CHECK: a non-null `source` needs a non-empty string `kind` and `external_ref`. |
| 2026-09-26 | T2-5 (#302) | Migration 0036 claims the spare row for the derived `vault_tasks.someday` column. The door writes `do <date>` / `someday` in `formatTaskLine`'s own spelling. |
| 2026-09-26 | T3-1 (#303) | The zone fallback is `METISTRY_TZ` only, never `TZ` — both deployment shapes set `TZ=UTC`, so reading it would be the UTC fallback F-4 forbids. |
| 2026-09-26 | T3-1 (#303), T3-4 (#314) | The two overlap on the profile facts: T3-1 shipped a minimal `profileFacts` in the runner and T3-4 took it over in core. With no `working_days` the brief and plan skip `no_working_days`; with no timezone a time-of-day routine is refused `no_timezone`. |
| 2026-09-26 | T2-18 (#304) | Live events coalesce in 250 ms bursts. Event ids are console-start × 1,000 + n. The `events` capability is advertised only when the route is served **and** wired. |
| 2026-09-26 | T4-2 (#305) | A secret reference, known value or userinfo in a URL is a refusal (`secret_in_url`). `guardedFetch` ships but nothing calls it yet — T4-18 and T4-8a wire it. |
| 2026-09-26 | T10-3 (#306) | Integrate happens off the working tree: `git merge-tree --write-tree` + `commit-tree`, then one refusing move (`merge --ff-only` / `reset --keep`), so a conflict is known before anything moves. Minimum git is 2.38. The conflict report is **not** auto-resolved when the conflict clears — §2.12 keeps `resolved_at_source` for mirrors; the owner dismisses it. |
| 2026-09-26 | T2-16 (#307) | `identity set --mark` writes the existing `icon:` key (not renamed). `identity.yaml` is read only at start, so a rename needs a restart. |
| 2026-09-26 | T2-15 (#308) | C45 runs through `refuseAnswer` / `failedAnswer` on every consequential door. Approving the enrolment of an agent revoked since it asked is now a 404 that stays pending. |
| 2026-09-26 | T4-6 (#310) | The crew `model:` forms live in a leaf module, `crew-model.ts`, so `compute.ts` and `manifest.ts` never import each other. `GET /api/agents/:id/definition` returns `definition`, `compute` and `limits`, read-only. A connection tool that starts an agent is drawn in the Write column. |
| 2026-09-26 | T4-3 (#311) | `migrate-scope`'s step 2 rewrites `auth.secret` only once the compute schema reads `{{ secret.name }}`; until T4-18 it leaves the file byte-for-byte unchanged and reports each reference. |
| 2026-09-26 | T1-2 (#312) | Wire change: the board's blocked value is `blocked`, not `needs_you` (PWA, Kit and fixture moved with it). The board query is `expose: route`. |
| 2026-09-26 | T4-4 (#313) | A key-shaped value has **no override** — it is refused with *Store as Secret*, per plan §2.14. Screen 19 §2 offers *Save as Variable*; the plan wins and T6-14 takes the plan's wording. |
| 2026-09-26 | T3-4 (#314) | Moving `standup_*` out of `Me/profile.md` is a Needs You **improvement** proposal the owner approves — never a silent edit. The routine's schedule is written to `.metistry/scheduled.yaml` (console, as `user`) **before** the proposal is raised; that authority was T3-2's line. |
| 2026-09-26 | T3-2 (#315) | A manifest's `config` fields are one of a closed five kinds (`text`, `path`, `number`, `boolean`, `choice`). An entry that does not fit its manifest **holds** that component; it never falls back to defaults. |
| 2026-09-26 | T1-3 (#316) | Routine rows in the activity feed are dated by `finished_at`, so an in-flight row neither flickers nor hides behind the `since` cursor. |
| 2026-09-26 | T2-2 (#317) | C40's refusal (a Revise that would widen access) writes no `payload.error` — the request is malformed, not a consequence that failed. The bad-shape Revise refusal keeps writing one. |
| 2026-09-26 | T1-1 (#319) | `work.description` is capped at 2,000 characters in the service. An agent sets it only at create; after that only the owner edits it. |
| 2026-09-26 | T1-6 (#321) | The owner can still read the three knowledge queries at `/api/q` (P4, "the owner sees everything"); every other credential gets the unknown-query refusal. |
| 2026-09-26 | #323 | CI cost: superseded runs are cancelled (`concurrency`), and the macOS job runs only when the app, the tokens or `ci.yml` change. Agents push once; the wave housekeeping PR records PR numbers. |
| 2026-09-26 | #324 | Built the owner's T10-3 ruling: a remote commit touching a protected path is refused at integrate — **all** of `.metistry/` (`state/` included, since git overwrites an ignored `.env`) and case-folded root names (`claude.md`, `.Metistry/…`). The whole fetch is refused, the push held, one Needs You report per offending commit. |
| 2026-09-26 | T9-1 (#325) | An `absent` policy outcome takes precedence in the record; `fall_through` still means the rules' default only (T9-4). |
| 2026-09-26 | #336 | `update-check` runs every day at 06:00 (T3-2's schedule shape), not `@daily`. |
| 2026-09-26 | T1-12 (#337) | A prose feedback row's `prose_id` is `runs.id` — `runs` already logs one row per model turn, so there is no second id scheme. |

## Rulings made by the owner in W1

| Ruling | What it settles | Built by |
| --- | --- | --- |
| (b) | Permission words are **Allow · Ask First · Never** everywhere; C93's On · Ask · Off is superseded. | PWA, CLI and Kit already; the plan quotes updated (W1 housekeeping). |
| (c) | F-5's door names `act`, `today` and `delegate` are kept. | Frozen in `client-api.ts` (F-5, F-1). |
| F-13 | `local_only` is answered to passkey sessions only; `api_version` stays 1. | F-13 (#283). |
| (a) | A routine's reserved subfolder (like `Journal/Plan/` for plan-tomorrow, `Journal/Digest/` for the Digest routine) is a routine **ownership** fact, written through the reconciler under the routine's own principal — not a grant. Per-run grants stay read-only. | §2.5's example (W1 housekeeping); T3-8 builds to it. |
| T10-3 | A remote commit touching a protected path (all of `.metistry/`, `state/` included, and case-folded root names) is **refused and reported**: nothing integrates, the push is held, one Needs You report per offending commit. | #324. |

## W2 — the second build wave

| Date | Where | The call |
| --- | --- | --- |
| 2026-09-27 | #336 | `update-check` runs every day at 06:00 (T3-2's schedule shape), not `@daily` — restated; `releases.md` and `scheduled.md` already say so. |
| 2026-09-27 | T10-5 (#362) | T10-5's accept line "Knowledge shows the request inline" belongs to **T10-7**, which draws it; T10-5's request payload carries `title` and `before_after` so T10-7 can. The plan moves the line (W2 housekeeping). |
| 2026-09-27 | T2-8 (#363) | A ticket may touch `seed/queries/` and `seed/vault/Templates/` when its door provably needs them — Close the Day needed both. |
| 2026-09-27 | T2-14 (#359) | A test-only fix that unblocks CI may ride inside a ticket PR, disclosed in its body. `agent-brief.md` says so. |
| 2026-09-27 | W2 | `pr: null` while a ticket is `in-review` is the convention: an agent pushes once, and the wave's housekeeping PR records every number. `agent-brief.md` says so. |
| 2026-09-27 | W2 | An agent's Opus co-author trailer is rewritten to the Fable trailer only when a rebase is needed anyway — never a rebase for the trailer alone. |

## Rulings made by the owner, recorded at W2

The first five were recorded in W1 (*Rulings made by the owner in W1* above) and are restated as confirmed; `METISTRY_TZ` was T3-1's call in W1 and is now the owner's ruling.

| Ruling | What it settles | Built by |
| --- | --- | --- |
| (b) | Permission words are **Allow · Ask First · Never** everywhere. | PWA, CLI, Kit; the plan and `CLAUDE.md` (W1 housekeeping). |
| (c) | The door names `act`, `today` and `delegate` are kept. | `client-api.ts` (F-1, F-5). |
| (a) | A routine's reserved subfolder is an **ownership** fact, written under the routine's principal; per-run grants are read-only. | §2.5; T3-8 builds to it. |
| T10-3 | A remote commit touching a protected path is **refused and reported**. | #324. |
| TZ | The zone fallback is **`METISTRY_TZ` only, never `TZ`**. | T3-1 (#303). |
| F-13 | `local_only` is answered to passkey sessions only; `api_version` stays 1. | F-13 (#283). |

## Ruled at the W2 checkpoint (2026-09-27)

The owner ruled on the list that was open at the W2 checkpoint. Numbers are the
owner's; two were left to the coordinator and are marked **coordinator's call**.
Plan edits carry *(ruled 2026-09-27)*; a follow-up with no ticket became an
X-track ticket in W3 (`design-build-plan.md` §3.3).

| # | Item | Ruling | Where it lands |
| --- | --- | --- | --- |
| 1 | T10-4 (#343): `GET /vault/log` serves `.metistry/` subjects to either bearer | Narrowed to the owner, like `/vault/show`. | X-6 |
| 2 | T4-18 (#352): compute calls bypass T4-2's egress guard; a provider key has no grantee | `secrets.yaml` gains a provider-key grantee, and compute calls go through T4-2's egress guard. | X-7 |
| 3 | T3-3/T4-8 (#364, #353, #374): who adds a sync's first `connection:` | **Coordinator's call** (the owner is indifferent): the connection setup flow (`metistry connections add`, T4-9/T4-10) writes it into `scheduled.yaml`; the Scheduled door keeps refusing to set it. | §2.5 and T4-10 (plan) |
| 4 | T3-8: drops `grants.write` from `routineAssignmentSchema` | Confirmed: T3-8 removes `grants.write` from `routineAssignmentSchema` and from `scheduled.md`'s example. | T3-8 (plan) |
| 5 | T4-8b (#374): the console's `validateGrants` drops `grants.connections` | An agent's connection grant persists in the agent's grants: `validateGrants` and `coerceGrants` keep `connections`. | X-8 |
| 6 | T4-8b (#374): P1 is Reads/Allow only | Accepted until T4-9. | T4-8b (plan) |
| 7 | T10-5 (#362): restore reaches the owner, but §2.3 draws "—" for the phone | §2.3 wins: restore is not reachable from the phone — the restore door's reach becomes `local`. | §2.1 (plan), X-9 |
| 8 | T2-3 (#347): a report cannot be approved; an agent cannot read the answer to its question | Reports get an acknowledge answer, which knowledge-fold reads; an agent can read back the answer to its question. | X-10 |
| 9 | T3-5/T3-6 (#342, #368): §2.13's prose fill | The marked-slot form stays, and the assistant may create files in `Journal/Brief/`, `Journal/Standup/` and `Journal/Plan/` again — T3-6's create refusal is relaxed; the routine still writes its own file. | §2.13, T3-6 (plan), X-11 |
| 10 | T2-10 (#371): C136's "the discarded side is committed first" | Confirmed. | built (T2-10, #371) |
| 11 | T4-24 (#373): Linear issues are not on the Board; no route for Add to Today | Linear issues in work and Needs You, not the Board — accepted. A route for Add to Today is a follow-up. | X-12 |
| 12 | T3-12 (#367): `budgets.ts` raises a budget refusal as a `decision` | `apps/assistant` `budgets.ts` raises it as a `report` (C96). | X-13 |
| 13 | T2-7 (#378): Today's preset and the `day_work` flags were the agent's call | Accepted: open lines due or do ≤ D, plus lines ticked on D, someday dropped; the `day_work` flags as built. | T2-7 (plan) |
| 14 | T2-7/T6-1a (#378, #379): the `where:` grammar cannot express Slipping or Owed | Extend the grammar — a carry count, a "names a person" facet, negation — so Slipping and Owed are real views. | X-14 |
| 15 | T3-7 (#357): Run Now after the 23:00 plan stays silent | Run Now after 23:00 re-renders the plan. | X-15 |
| 16 | T3-6 (#368): `{{ calendar }}` renders event titles unsanitised | Core's `{{ calendar }}` sanitises event titles. | X-16 |
| 17 | T5-7 (#355): a snoozed request coming due emits no event | The console emits `needs_you.changed` when a snooze expires. | X-17 |
| 18 | T6-2 (#370): `GET /api/messages` lacks `turn_id` | `GET /api/messages` gains `turn_id` (additive). | X-18 |
| 19 | T5-5 (#354): the offline capture queue is in memory only | The Mac's offline capture queue is persisted; a store beyond the preferences allowlist is approved. | X-19 |
| 20 | T2-11 (#366): per-attendee status is stored but not served | **Coordinator's call:** it stays stored, not served, until a screen needs it. | no ticket |
| 21 | T4-12: `collectors/eventkit-calendar` as its precedent | Confirmed. | T4-12 (plan) |
| 22 | T5-2 (#296): the Knowledge sidebar row has no children | The row stays flat for now. | T5-2 (plan) |
| 23 | `init --keep-awake --shape`: the flags' contract is unwritten | Define `init --shape` (default `launchd` on macOS); `--keep-awake` follows the chosen shape. | X-20 |
| 24 | T6-3 (#356): screen-02 §8's keys are not in the closed menu table | §8's keys are dropped from the spec for now, to be re-evaluated later. | T6-3 (plan) |
| 25 | T6-3 (#356): a routine's subject shows its raw component id | `activity_feed` carries a routine's display name. | X-21 |
| 26 | T5-4b (#351): reads a request's questions from `payload` | The Mac reads `request.questions`, not `payload`. | X-22 |
| 27 | T5-6 (#360): Settings ▸ Compute is still titled "Budgets" | Retitled to spending limits. | T6-12 (plan) |
| 28 | T4-8b (#374): `activity_feed` should surface `connection_call` | `activity_feed` and `turn_progress` surface `connection_call` rows. | X-23 |

T2-8 (#363)'s `closedDay` was already done. **Not ruled, still open:** a
secret's last-used is not stamped for syncs (T4-24, #373), and the brain is not
wired to a connection pool on a live console (T4-8b, #374).

### Later — designed after the UX build, not built now

Split **Needs You** from a new **Inbox** menu item: Needs You keeps only the
agent, permission and Metistry items; everything else (GitHub pull request
reviews, calendar invites, …) moves to Inbox, with Needs You as a sidebar on
Inbox. To be designed after the UX build completes; no ticket (plan §5).

## W3 — the third build wave

46 tickets, PRs #403–#449 (#417 is CI, not a ticket). 45 merged; **X-7 (#437)
is held open for the owner** (question 1 below). Follow-ups with no ticket
became **X-24…X-74**, specified in `design-build-plan.md` §3.3 (*Follow-ups
found in W3*) and listed as **W4 candidates** — no wave until the owner assigns
one.

### Calls the coordinator made in flight

Each is the coordinator's call; **the owner to confirm** or reverse.

| Date | Where | The call |
| --- | --- | --- |
| 2026-09-28 | X-6 (#404) | `Artifacts/` stays readable on `/vault/log` for a non-owner bearer: the console's artifacts service reads it with one. Only `.metistry/` subjects are narrowed to the owner. |
| 2026-09-28 | T4-12 (#408) | Public ICS feeds only, parsed by a hand-rolled RFC 5545 reader (no dependency). Private feeds wait on question 8. |
| 2026-09-28 | T2-12 (#407) | Moving a meeting with attendees goes through an owner-door token, `METISTRY_OWNER_DOOR_TOKEN_EVENTKIT` (new in `compose` and `.env.example`); until it is minted such a move answers `503`, naming the command. |
| 2026-09-28 | T3-8 (#413) | An agent routine's actor must be a crew. |
| 2026-09-28 | T6-6 (#410) | A paused routine is shown in words only — the paused glyph collided with Ask First's. |
| 2026-09-28 | T7-4 (#414) | The offline outbox replays captures and Tick only; Defer is not offered offline (`client-api.md` says so). Question 22 asks whether it should be. |
| 2026-09-28 | T4-19 (#423) | The instance spending limit counts and stops subscription calls too (`costOf` ignores billing); `projects_rollup` defaults to 50 rows; an existing `compute.yaml` with a `$` limit on a subscription provider now fails loudly at startup — **an upgrade hazard the 0.15.0 release notes must name**. |
| 2026-09-28 | T4-9 (#415) | A proxied `connection_call` is capped at `propose`, with Ask First the default at every autonomy level (the research doc said deny). To stay under the brain's 4,600-token ratchet the eager surface was trimmed to 4,596. |
| 2026-09-28 | X-7 (#437) | The builder stopped under U10 (the engine's sandbox cannot read `secrets.yaml`, so installs would lose compute). The coordinator widened the ticket: a sandbox parameter or an env-delivered grant, `providers add` writes the grant, `update` backfills it, `score-choice.ts` included. The review then held it for the owner (question 1). |
| 2026-09-28 | X-18 (#419) | Migration 0037: a partial index on `runs (meta->>'message_id') WHERE kind = 'turn'`, for the `turn_id` join. |
| 2026-09-28 | X-19 (#424) | The Mac's `capture-queue.json` is written `0600`. |
| 2026-09-28 | T8-6 (#426), T8-2b (#448) | Capture-session turns resolve their tier through `turnTier()`; T8-2b wires the call site T8-6 left open. The private tier has no fallback — it refuses (`PrivateTierUnavailable`). |
| 2026-09-28 | T4-13 (#430) | `--auth basic` is accepted only for providers whose manifest says `auth: basic`, checked in the CLI and in core. |
| 2026-09-28 | X-20 (#434) | `deployment.yaml` is always stamped at `init`, and `--keep-awake` is refused for the compose shape, which installs no supervisor. |
| 2026-09-28 | X-10 (#433) | A report that names its act keeps the act; only a report with none is served Acknowledge, stored as `acknowledged`. The proposals fixture took that one shape change alone, so the Mac's relative-time tests kept their timestamps. |
| 2026-09-28 | X-13 (#428) | `budget_refused` joins `client-api.md`'s report-event catalogue. |
| 2026-09-28 | T6-7 (#420) | Dropping a card on Done sends `closed`. |
| 2026-09-28 | T9-3 (#432) | No tuning mode: the complexity wording is frozen by fingerprint (§7.2), and `router-policy.ts`'s comment now says so. Recorded as built: the `d08: true` marker, below-threshold answers `moderate`, the threshold precedence and the rescued-turn formula. |
| 2026-09-28 | X-21 (#442) | The runner stamps `meta.display_name` from the manifest and `activity_feed` coalesces it, rather than title-casing the component id. |
| 2026-09-28 | X-12 (#443) | `TodayStore.addToToday` ships as a store method with no control; the control is X-61. |
| 2026-09-28 | T4-25, T4-26 (#444, #445) | One Linear transport (`post` / `linearQuery`) serves create and complete; the manifest's capabilities are read, create and complete. |
| 2026-09-28 | T4-26 (#445) | For the owner-only tracker doors, Ask First and Allow are the same at the server — the difference is the client's confirmation (§2.3). |
| 2026-09-28 | T6-11 (#449) | Settings ▸ Connections is renamed **Account** (sign-in and the instance repository); the real Connections pane is T6-13a. No console route was added. |
| 2026-09-28 | #417 | CI runs the TCC helpers' Swift tests, path-gated with the macOS job. |
| 2026-09-28 | W3 | Research PRs #400–#402 stay open for the owner; the coordinator merges tickets only. |

### Open for the owner at the W3 checkpoint

Questions, not decisions: each says what is built meanwhile. Where an answer
unblocks a W4 candidate, the ticket names this number.

**1. X-7 (#437) — the compose shape and a provider key's grantee.** X-7 makes
every compute call go through the egress guard with a `provider:<name>` grant.
Under compose, `docker-compose.yml` mounts no instance directory (D5), so the
engine has no `secrets.yaml` to read a grant from and **every `{{ secret.x }}`
provider call is refused** — including the seed's only cloud template,
`openrouter`. The PR refuses with the fix named (`env:` credentials) and
`compute.md` states the exception. Which option?
   1. **Mount `.metistry/secrets.yaml` read-only** into the assistant and console
      containers — it holds policy, never a value; mirrors launchd's
      `CONFIG_SECRETS`.
   2. **Deliver the grant through env at `up`** — no mount, but a revoke takes
      effect only at the next `up`.
   3. **Accept the break** with a migration note: compose installs move their
      providers to `env:` credentials (host-bound, no grant).

   Also yours: approve the launchd sandbox profile gaining `CONFIG_SECRETS`
   (read access to `secrets.yaml`); accept core's API break for importers
   (`ResolvedOnMachineCall.bearer` → `fetchFn`, `makeChatClient.apiKey` → `env`;
   a minor bump); and confirm the coordinator's widened scope (above). Held
   open, unmerged; X-44 and X-45 follow it.

#### Agents, crews and routines

2. **T3-8 (#413):** a routine's task is not run through `checkBrief`, so
   owner-authored text reaches a crew with a widened read grant unscanned. Scan
   it, or treat the owner's text as trusted? And is "the actor must be a crew"
   right?
3. **T3-10 (#412):** assistant- and routine-tier chat turns pass no
   `data_policy` check; the Knowledge Fold has the same gap. Intended?
4. **X-10 (#433):** the read-back returns the owner's Revise/Decline words to
   the agent that asked (the decision-block convention). Confirm?
5. **T3-11 (#422):** nothing raises a routine suggestion yet. A deterministic
   routine or a brain tool? The shipped scope is schedule / paused / every /
   raise only.
6. **X-11 (#425):** the assistant may now create today's `Journal/Brief|Standup|Plan`
   file before the routine runs, and the routine then skips the day as
   `user_owned`. Accept the skip (and rename the outcome), or should the
   routine fill its slots in that file? → X-51.

#### Connections, secrets and calendar

7. **T4-9 (#415):** `connection_call` is capped at `propose` with Ask First the
   default at every autonomy level, where the research doc said deny. Confirm?
   F-5's table stores the kind while §2.6 says `action` — which wins?
8. **T4-12 (#408):** a private ICS feed carries its secret **in the URL**, which
   T4-2 refuses (`secret_in_url`). Add a secret-as-URL door to T4-2, or leave
   private feeds to EventKit, CalDAV and Google? Built meanwhile: public feeds
   only.
9. **T2-13 (#421):** `github_write` has no grantee-kind check — an owner door is
   neither `connection:` nor `agent:`. Add an owner-door grantee kind? → X-42
   (X-41 refuses the wrong grantees either way).
10. **Carried from W2:** the live console still builds no `ConnectionPool`
    (`main.ts`, open since #374), so proxied tools answer `not_available`
    outside tests — X-8 did not change that. Which ticket wires it? And a
    secret's last-used is still not stamped for syncs (T4-24).
11. **T4-13 (#430):** an iCloud account's `pNN-caldav` host needs two owner
    commands after the first sync (X-56 automates it), and no console route
    calls CalDAV's own-event write yet (X-57). Schedule both with W4's
    calendar work?
12. **T2-12 (#407):** may the owner door move a meeting someone else
    organised? → X-55.

#### Mac screens

13. **T6-4 (#409):** the conflict word — "Take the Other" (served) or "Take the
    Fold's"? Who raises `draft_settle` (nothing does)? The fold has no
    `prose_id` for thumbs. Should Needs You's `resolve_conflict` door use the
    held-Undo model?
14. **T6-4 (#409):** `collector_health` is not served — which door serves it,
    and to whom? → X-65.
15. **T6-5 (#418):** Esc keeps the draft (C136) where screen 7 discards it;
    ⌘S / ⌘⌫ stay unbound (ruling 24); trust and per-run cost are not served;
    Permissions Edit only for connected agents. Confirm each.
16. **T6-6 (#410):** §10.2 makes a product routine's task, actor and name
    editable, but no door writes them — add one, or keep them read-only? Also:
    no `stopped` field on the wire; Week scale only.
17. **T6-7 (#420):** Delegate has no route; Today does not open the card popover
    (that is T6-1a's files); `[` / `]` are unbound (C119). Which wave takes
    each?
18. **T6-10 (#446):** screen 12 draws no Spoken table (C121 applied). Confirm?
19. **T10-7 (#441):** Restore works only under a page's current name; commits
    from before a rename are view-only. Allow restore across renames (a
    server-side T10-5/T10-6 follow-up)?
20. **X-14 (#436):** Slipping is "owed to or by" (review-01) or "owed to
    someone" (screen-05 §15.6)? Someday lines still appear in Slipping, against
    §15.5; "carried three times" is built as `carried_days >= 3`. The grammar
    has no brackets inside `or`.
21. **T6-11 (#449):** Connections → **Account**, and the interim panes
    (Connections, Secrets, Variables, Live Capture, Sessions) until T6-13a,
    T6-14 and T6-15. Confirm the name.

#### Offline and the PWA

22. **T7-4 (#414):** should Defer queue offline like Tick? And cached reads
    survive on a device revoked while it was offline until its next `401` —
    accept?

#### Compute and the private tier

23. **T8-6 (#426):** "on-machine" is the provider's self-declared
    `locality: on_machine` (the intent tier's trust model). Derive it from a
    loopback `base_url` instead? And the private tier has no fallback — it
    refuses. Confirm.
24. **T4-19 (#423):** an exhausted subscription plan window comes back as a
    provider `429` that is retried blindly, not reported. Report it? And
    confirm the instance limit counting subscription calls (above).
25. **T9-3 (#432):** confirm the eval's built calls (above): no tuning mode,
    the `d08: true` marker, below-threshold = `moderate`, the threshold
    precedence and the rescued-turn formula.
26. **The brain's eager surface** is at 4,597 of 4,600 tokens and 28 of 28
    tools. Move tools behind lazy discovery, or raise the ceiling? → X-49.
27. **X-45:** a one-character secret collides with every model body. The
    proposal refuses secrets below a minimum length when they are stored,
    rather than letting the redactor skip short values. Agree?

#### The recorder

28. **T8-2a (#411):** does #253's "no capture UI" hold cover the record sheet
    and whoever holds the control token? (T8-2b and T8-5 build the bar.)
29. **T8-2b (#448):** the recorder's socket is not namespaced per instance and
    `METISTRY_LC_SOCKET` defaults under `/tmp` (→ X-72); transcripts land in
    `Inbox/`, not `Journal/Transcripts/` (→ X-73); `meta.capture_session` stays
    unset until T8-5/T8-7. Which folder? **Owner's hand after 0.15.0:** the
    real-recording checklist in #448's body (TCC grants for Metistry
    Recorder).

#### Linear and GitHub

30. **T2-13 (#421):** GitHub refuses self-approval, so an agent's PR opened
    under the owner's account cannot be approved by the owner (`400`, GitHub's
    words kept). Accept, or give agents their own GitHub account?
31. **T4-25, T4-26 (#444, #445):** Send to Linear and `complete_issue` carry no
    server-side confirm token (the frozen single-call contract): create is
    idempotent by task key, complete is gated by the tool mode. Confirm? Race
    safety rests on Linear rejecting a duplicate `issueCreate.input.id`,
    unverified against real Linear — check it on the second instance?

#### Fixtures and tests

32. **Priority:** the flakes (X-24…X-28) and fixture drift (X-29…X-31) cost W3
    several CI reruns and one refused merge. Run them as a small batch before
    W4 dispatches, or inside W4? X-24 (plan-tomorrow, four occurrences), X-29
    (stale Mac fixtures) and X-32 (push carries message text) are the ones the
    coordinator would take first.

## Rulings the owner must make

(a), (b) and (c) were ruled in W1 — see *Rulings made by the owner in W1* above.

| # | The question | What is built meanwhile | Needed before |
| --- | --- | --- | --- |
| (a) | F-2 / §2.5 and screen 7 (§3.2) give a crew's routine `write: [Journal/Digest/]`. That contradicts T4-6 ("Knowledge Write never for a non-assistant role"), `CREW_NEVER_TOOLS`, and the one-writer rule. May a crew's routine write anywhere in the vault? | The types follow the code: per-run grants are **read-only**. §2.5's example is marked inert. | T3-8 |
| (b) | Permission words: the CLI's and PWA's **Allow · Ask First · Never**, or C93's **On · Ask · Off**? | The PWA keeps Allow · Ask First · Never (T7-1). | T7-3a / T6 Settings panes |
| (c) | F-5's door names `act`, `today`, `delegate` — keep them? | Frozen as named in `client-api.ts` (F-5, F-1). | W1 routes that serve them (T2) |
