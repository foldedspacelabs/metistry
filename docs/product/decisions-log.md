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

## Rulings the owner must make

| # | The question | What is built meanwhile | Needed before |
| --- | --- | --- | --- |
| (a) | F-2 / §2.5 and screen 7 (§3.2) give a crew's routine `write: [Journal/Digest/]`. That contradicts T4-6 ("Knowledge Write never for a non-assistant role"), `CREW_NEVER_TOOLS`, and the one-writer rule. May a crew's routine write anywhere in the vault? | The types follow the code: per-run grants are **read-only**. §2.5's example is marked inert. | T3-8 |
| (b) | Permission words: the CLI's and PWA's **Allow · Ask First · Never**, or C93's **On · Ask · Off**? | The PWA keeps Allow · Ask First · Never (T7-1). | T7-3a / T6 Settings panes |
| (c) | F-5's door names `act`, `today`, `delegate` — keep them? | Frozen as named in `client-api.ts` (F-5, F-1). | W1 routes that serve them (T2) |
