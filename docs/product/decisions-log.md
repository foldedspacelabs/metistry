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

## Rulings the owner must make

(a), (b) and (c) were ruled in W1 — see *Rulings made by the owner in W1* above.

| # | The question | What is built meanwhile | Needed before |
| --- | --- | --- | --- |
| (a) | F-2 / §2.5 and screen 7 (§3.2) give a crew's routine `write: [Journal/Digest/]`. That contradicts T4-6 ("Knowledge Write never for a non-assistant role"), `CREW_NEVER_TOOLS`, and the one-writer rule. May a crew's routine write anywhere in the vault? | The types follow the code: per-run grants are **read-only**. §2.5's example is marked inert. | T3-8 |
| (b) | Permission words: the CLI's and PWA's **Allow · Ask First · Never**, or C93's **On · Ask · Off**? | The PWA keeps Allow · Ask First · Never (T7-1). | T7-3a / T6 Settings panes |
| (c) | F-5's door names `act`, `today`, `delegate` — keep them? | Frozen as named in `client-api.ts` (F-5, F-1). | W1 routes that serve them (T2) |
