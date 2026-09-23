# Design round E — build impact

**Engineering's read of `design/round-0-plan-review`, 2026-09-22.**
Written against `origin/main` at `ebf3651` (merge of #259).
The design branch's merge base is `47c8db6` (#250, v0.11.0), so **main has nine
merges of movement the designer did not see** — #251, #252, #255, #256, #257,
#259 and the release. Every file:line the designer cites was re-checked against
`ebf3651`; the drift is recorded in §1.2.

**This is a review to plan with, not a build order.** The owner's stance of
2026-09-22 stands over all of it:

> these changes are preliminary and may change before I finalize the design…
> a preview to help shape future plans… we can work out most of the details
> after the final design comes back.

Spend and run metrics have moved to a **System button outside the tabbed UI**;
the details are the owner's to give. Nothing below asks for a decision today
except where it is labelled as a question in §5.

Three standing rules shaped how this was written. The designer's own framing —
*the design is drawn against the product as it should be, not as the wire
currently serves* — means a missing query here is a **design finding, not a bug
report**. `CLAUDE.md`'s *report contradictions, don't route around them* means
§2 lists and does not resolve. And *don't build ahead of the plan* is why §4
separates what is safe to build now from what must wait for the final design.

---

## 1. Inventory

### 1.1 The ratified rules, and what each one costs to honour

From `HANDOFF.md` §3 and `design-system-amendments.md`. "Status" is against
`origin/main` today, not against the design branch.

| Rule | Status on main | Smallest change it implies | Package | Effort | Depends on |
| --- | --- | --- | --- | --- | --- |
| **Eight nav rows** — Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents · Routines, then Pinned (C30, C50, C57) | **Contradicts merged decisions** — see §2.1. The PWA ships eleven buttons — Feed · Chat · Board · Dashboard · Capture · Needs You · Status · Devices · Agents · Artifacts · Rooms (`apps/console/web/index.html:23–33`); `app-ux-plan.md:257` and `design-system.md:93` both ratify six rows with *Insights* | nothing until the nav question is settled. When it is: one list in `index.html` + `style.css:118–128`'s glyph rules, plus MetistryKit's sidebar | `apps/console`, `apps/macos` | M | the whole of §2.1; C60 |
| **Resources moves to Settings ▸ Resources** (C57) | not started, and **the word collides three ways** — see §2.4 | none yet | — | — | C62 fork |
| **The assistant is not on Agents** (C52) | partially. `ASSISTANT_DEFAULT_AREAS = [VAULT_ROOT_AREA]` is real (`apps/console/src/agents.ts:104`) and `describeScope` does render it as a role + scope triple (`packages/core/src/access.ts:1116`). No surface currently filters the internal principal out of a roster | a filter on the roster view, not a change to `describeScope` — the CLI still needs the triple. See §2.3 for why this is not clean | `apps/console`, `apps/macos` | S | §2.3 |
| **An agent is a capability; a routine is an assignment** (definition file is the user's hand, task prompt is appended) | not started. `routines/*/manifest.yaml` has `name · type · description · schedule · requires` and nothing else; no `agent` field, no task prompt, no per-routine grant | three manifest fields + a loader change + a grant-merge path at dispatch. This is the designer's D2+D3+D8 and it is **one feature**, not three | `packages/core` (manifest), `apps/console` (runner) | **L** | invariant 2 (a manifest is a human change) |
| **Permissions are one table — Resource × Read × Write, absence is the denial** (C58) | not expressible as drawn — see §2.6. The data is in `describeScope`'s `tier`/`areas`, `projects`, and `autonomy.detailed`, but no function emits a row-per-resource table | a `describePermissions(p): PermissionRow[]` beside `describeScope` in `packages/core/src/access.ts`, so the CLI, the console and MetistryKit render one computation | `packages/core` | M | the Read/Write question in §2.6 |
| **Access always shows its provenance** (base · approved in Needs You *#311* · during \<routine\> only · Through Metistry) | partially. `grant_source` (0025) and `agent_grant_overrides` (0023) exist and `sourceLabel()` (`access.ts:1100`) says two of the four in words. The queue-approval marker has no proposal id on it; the routine and proxy provenances have no data at all | carry the approving `proposals.id` into `agent_grant_overrides`; the other two wait on the routine-grant and proxy features | `packages/core`, `apps/console`, `db/migrations` (additive) | S for the queue marker, L for the rest | D2, D9 |
| **A routine's schedule is not when it acts** | not started. The silence conditions are prose inside each manifest's `description` (see `routines/plan-tomorrow/manifest.yaml`, which explains "hourly because the runner has no time of day" in a paragraph) | the designer's D5 (`acts:` on the manifest) and D6 (`next_run_at`). `packages/core/src/schedule.ts` already computes due-ness — D6 is exposing what it knows | `packages/core`, `routines/*` | M | — |
| **Nothing-to-do is a first-class outcome; a tick that did nothing gets no row** | partially. `runs.ok` cannot distinguish *acted* from *silent* — the designer's D7. `packages/core/src/failure.ts` already treats `collector_run` and `routine_run` as one class (`SCHEDULED_KINDS`) | one `meta.outcome` value written by each routine, read by the feed | `routines/*`, `seed/queries` | S | D7 ratification |
| **Three colour channels; priority is never red; facet order is priority · due · estimate · people · links · state** | not started (no facet vocabulary in code at all) | a shared facet renderer once a screen needs it | `apps/macos` kit | M | final design |
| **The four states, plus `partial` proposed** (C28) | `partial` is **unratified**. Its two instances are real: `knowledge_files.status = 'conflict'` (`0001_init.sql:97`) and `vault_tasks.parse_warning` | ratify or refuse. If ratified: one token pair + one copy rule; the data is already there | `docs/product/design`, then consumers | S | an owner ruling |
| **Agent prose is one component; serif stack is `Charter, Sitka, …`, never `ui-serif`** | not started. `tokens.json` on main has no serif in `type.$meta`; the branch's does | ships with the branch's `tokens.json` | generated | S | token merge |
| **Times are 12-hour with AM/PM** | not started; `WireTime` (`console-data.swift:54`) parses, does not format | one formatter in MetistryKit | `apps/macos` | S | — |
| **A failed consequential operation leaves the request pending** (C45) | **already true in code, undocumented as a rule.** `apps/console/src/server.ts:1376–1378` states it in a comment — *"this runs BEFORE the row is settled, so a refusal leaves the request pending with the reason"* — and the access-request path implements it | write it into the design system and add a misuse test per interface (invariant 8). No behaviour change found that is needed | `docs`, `apps/console` tests | S | an owner nod that it is a *rule* |
| **`Ask` = pause when interactive, defer when unattended** (C59) | not started; there is no proxied-tool concept yet. `apps/console/src/push.ts:56` does map `alert` → `"Needs You"`, as cited | a run-context flag on the ask path, once there is an ask path | `packages/core`, `apps/console` | M | D9, and §2.7 |
| **`border-control` is the only border token over 3:1; a mark takes an ink token** (C49) | ships with the branch's `tokens.json` (`border-control` is one of 28 new roles) — **and the branch loosens the CI check to let it pass.** See §3.2 | nothing extra | generated | S | §3.2 |
| **Two marks separate by weight, not two inks** (C54) | the tool the designer names for this, `dataviz/scripts/validate_palette.js`, **does not exist in this repo** — see §3.4 | either vendor the validator or drop the instruction | `ops/scripts` | S | a ruling on where design tooling lives |
| **A frame is measured, never estimated** (C67) | branch-only; `boards/check-frames.mjs` needs `playwright`, which is not a dependency of this repo and is not on `CLAUDE.md`'s pre-approved list | ask before adding, or keep the checker out of `package.json` as a documented manual step | — | S | §3.3 |

### 1.2 Every C-number that names code — citation verified against `ebf3651`

Only C-numbers whose evidence column points at repository code are listed.
C-numbers that cite design documents against each other are the designer's own
territory and are not re-checked here.

| C | Cited as | Verified? | Status on main | Smallest change | Package | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| **C1** | `docs/ops/board.md:107` | **exact** — `:107` is *"The **red number** beside a count is that column's escalations."* | not started. Review decision 11 (2026-09-18) ruled it becomes a `footnote` count with a glyph | edit `board.md` + the renderer | `docs/ops`, `apps/console` | S |
| **C2** | `docs/ops/board.md:44` | **exact** — `:44` is the `Needs You` / `status='blocked'` row | not started. Review decision 3 ruled it becomes **Blocked** | `board.md:44`, `Board.label(for:)` (`console-data.swift:590`) | `docs/ops`, `apps/macos`, `apps/console` | S |
| **C5 / C62** | `apps/macos/sources/kit/settings-view.swift:47` | **exact** — `:47` is `.frame(width: 640, height: 520)` | open. This is the **real fork** the designer asks an early opinion on | either drop the fixed frame (one line, plus a layout pass on six panes) or Resources is not a Settings pane | `apps/macos` | S to change the line, M to survive XXXL |
| **C6** | `style.css:224, 285–297` | **exact** — `:224` is the `failed` 10% mix; `:285/:286` are `.chip.review` / `.chip.autonomous` at 14%; `:292–:297` are the six presence chips at 14% | superseded by the branch's quiet-fill roles — the 28 new tokens include `presence-*-quiet`, `ok-quiet`, `failed-quiet`, `degraded-quiet`, `absent-quiet` | repoint the `color-mix()` calls at the declared tokens | `apps/console` | S |
| **C7** | computed | consistent with C6 | same fix | same | `apps/console` | S |
| **C9** | `ops/release/build-app.sh:130` | **exact** — `:130` is `node "$root/ops/release/make-app-icon.mjs" "$icon_tmp/icon.png" 1024`, and there is no `ICON_PNG` variable anywhere in the file | not started; **ratified as decision 16** (owner said yes, 2026-09-18) | add `ICON_PNG` with the generator as the fallback | `ops/release` | S |
| **C10** | `apps/console/web/app.js:431` | **drifted to `:433`** — the `c.status === "ok" ? "ok" : "failed"` collapse is real and unchanged | not started. A live P5 violation | three-way on `degraded`/`absent`, with the new quiet-fill tokens | `apps/console` | S |
| **C12** | `apps/console/web/icon.svg` | **exact** — `#7ea9ff` on `#0e1216`, the dark-mode pair, served in both appearances | not started, and **the branch makes it worse**: `accent` dark moves to `#6ec9d6`, so the placeholder would be stale as well as wrong | replace from the branch's `brand/pwa-icon.svg` | `apps/console` | S |
| **C13** | `apps/console/web/index.html:17` | **exact** — `:17` is `<link rel="apple-touch-icon" href="/icon.svg" />` | not started. The installed PWA has no home-screen icon on iPhone | one PNG + one line | `apps/console` | S |
| **C19** | `seed/queries/activity_feed.yaml` | **exact** — `:82` is `OR (r.kind = 'collector_run' AND r.ok = false)`, and the output column list (`:159`) carries no `ok` | not started | add `ok` to the projection and admit successful rows behind a filter | `seed/queries` | S |
| **C20** | `db/migrations/0001_init.sql:21` vs `packages/tasks/sql/schema.sql:71` | **exact on both** — `ok boolean NOT NULL` at `0001:21`, `ok boolean` at `schema.sql:71` | open. Two schemas, one table | decide which is authoritative; migrations are the record (invariant 1) | `packages/tasks` | S |
| **C21** | `apps/console/src/server.ts:777` | **drifted to `:968`** (route dispatch at `:806`). The `WHERE` clause at `:983` is `decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())` — the snoozed count is indeed unobtainable | the designer already closed this by removing the header (`bellpanel()` deleted) | — | — | — |
| **C22** | `db/migrations/0002_review_decisions.sql:26` | **exact** — `:26` is `trust text NOT NULL, -- internal \| external \| user`. Returned on every queue row (`server.ts:982`) | open. No surface renders it | one chip, once P1's distinction has a place | `apps/console`, `apps/macos` | S |
| **C23** | `apps/console/src/server.ts:428` | **drifted to `:550`** (`POST /capture`); the response shape is unchanged | open | either drop the receipt from the spec or accept a two-stage receipt | `docs/product/design` | S |
| **C24** | `apps/console/src/server.ts:435` | **drifted to `:554`** — `Idempotency-Key` handling is real, `idempotency-replayed` set at `:579` | open, documentation only | name it in the capture spec | `docs` | S |
| **C25** | `apps/console/src/server.ts:454` | **drifted to `:576`** — `source: "http"` is hardcoded in the `captureToInbox` call | open | let the door pass a source from the credential's kind | `apps/console` | S |
| **C28** | `daily-flow-spec.md` §6.4; `knowledge_files.status` | **exact** — `0001_init.sql:97` is `status text NOT NULL DEFAULT 'dirty' -- clean \| dirty \| conflict`, and `knowledge_pages.yaml` drops `conflict` rows | **needs ratification**, no code needed to prove it | — | — | S |
| **C33** | `docs/ops/reply-feedback.md` | exists; feedback is keyed to `outbound_messages` (`0004:4`) and `reply_feedback` | open. Request B7 wants a `prose_id` | additive table or column | `db/migrations`, `apps/console` | M |
| **C37** | `seed/queries/board.yaml` lacks `blocked_by_task` / `blocked_by_task_open` | **half wrong now.** `board.yaml` still lacks them — but **`seed/queries/day_work.yaml:107–108` computes both**, and `:121` uses `blocked_by_task_open` to derive the `waiting_on_me` flag. The columns exist; the *board* query does not have them | port the `LEFT JOIN` from `day_work` into `board.yaml` | `seed/queries` | S |
| **C40** | `apps/console/src/server.ts:1389` | **exact** — `:1389–1390` validate `accept_with_changes` with `validAgentAreaGrant(area)` only, which is a shape check. A revised area *outside* the asked prefix would be applied | not started. Ruled 2026-09-20 that Revise can only grant less | one `underAreas(area, [asked])` guard at `:1390`, plus a misuse test | `apps/console` | **S** |
| **C41** | `apps/console/src/agents.ts:616`; `packages/core/src/access.ts:1038` | **exact** — `widenedGrants` at `:616` returns `{ tier: "areas", … }` unconditionally, and its doc comment at `:600–615` now names the trade explicitly | partially: the code documents the trade, the payload does not carry it, so the card still derives it | return the prior tier beside the new one in the answer body | `apps/console` | S |
| **C42** | `packages/mcp-brain/src/access.ts` `MAX_DECLINES` | **exact** — `:86` is `const MAX_DECLINES = 2; // limit: fixed — …`; the refusal at `:133` writes no proposal row | not started | a `runs` row (not a proposal) when the ceiling refuses | `packages/mcp-brain` | S |
| **C43** | `seed/queries/activity_feed.yaml`; `routines/plan-tomorrow/run.ts:71` | **exact on the query, approximate on the routine** — `run.ts:71` is `PLAN_DIR = "Journal/Plan"`, not the run-recording line; the `runs` branch at `:81` admits seven kinds and `routine_run` is not among them; `plan-tomorrow` is `@hourly` as described | not started, **and it was ruled for on 2026-09-20** | add `routine_run` to the kind list, add a `routine` value to the derived `grp` at `:77` | `seed/queries`, then every `group` consumer | M (the vocabulary is closed and read by three surfaces) |
| **C45** | `apps/console/src/server.ts:1380` | **exact in substance** — `:1376–1378`'s comment states the rule in the designer's own words | already the behaviour; not stated as a system rule | see §1.1 | `docs` | S |
| **C46 / C47 / D4** | `packages/core/src/actions.ts` `effectiveActions` | **DONE — merged as #259 (`c69abc3`).** `effectiveActionsDetailed()` at `actions.ts:196` returns `{ mode, source }` with `ActionSource = "set" \| "defaulted" \| "clamped"` (`:170`); `effectiveActions` at `:220` is now a projection of it, never a second computation. `describeScope` carries it as `autonomy.detailed` (`access.ts:1142`), and MetistryKit reads it at `console-data.swift:929` (`AgentActionEntry`). The console's "no notion of the effective table" complaint is also closed | **nothing** | — | — |
| **C48 / C64 / C1(screen 7)** | `seed/queries/agent_presence.yaml`; `activity_feed.yaml` | **exact** — `agent_presence.yaml` contains the string "collector" **zero times**; `activity_feed` takes failures only | **not started as a query — but the data exists.** Collectors write `runs` rows with `kind = 'collector_run'` and `ok = true` (`collectors/devin-knowledge/run.ts:180` reads `WHERE component = $1 AND kind = 'collector_run' AND ok`), and `packages/core/src/failure.ts:84` already computes "failed since its last success" per component | a `collector_health.yaml` over `runs`: last ok ts, last failure ts, last error, per component. **No migration** | `seed/queries` | **S** |
| **C52** | `apps/console/src/agents.ts:104`, `:424`; `access.ts` `ROLE_LABEL` | **exact on all three** — `:104` is `ASSISTANT_DEFAULT_AREAS`, `:424` uses it as the configured default, `ROLE_LABEL` is at `access.ts:1091` | see §1.1 and §2.3 | — | — | S |
| **C53** | `packages/core/src/actions.ts` `actionSchema`, `commentArgs` | **exact** — `ACTION_KINDS` at `:34`, `commentArgs` at `:77` is a `z.union` of the `work_id` and `artifact_id`+`version_id` shapes, `actionSchema` at `:97` | open, presentation only | the Model · Action · May mapping belongs with `describePermissions` | `packages/core` | S |
| **C55** | `routines/*/manifest.yaml` | **exact** — all five manifests carry `name`, and `name` is the directory slug in every one | not started | `display_name` on the manifest schema; `name` stays the handle | `packages/core` (manifest schema), `routines/*` | **S** |
| **C56** | `CLAUDE.md` Packages | accurate quotation of the bridge contract | see §2.7 for the contradiction it creates | — | — | — |
| **C59** | `apps/console/src/push.ts` | **exact** — `NOTIFICATION_TITLE` at `:51`, `alert: "Needs You"` at `:56` | see §2.7 | — | — | — |
| **C62** | `settings-view.swift:47` | **exact** (see C5) | the fork | — | `apps/macos` | — |
| **C65** | `routines/knowledge-fold/run.ts`; `Templates/Fold.md` | **exact** — `FOLD_DIR = "Journal/Fold"` at `run.ts:103`, rendered from `Templates/Fold.md` (`:100`), and `seed/vault/Templates/Fold.md` ships | **cheaper than drawn.** `Journal/Fold/<date>.md` is a vault path, so `classify()` (`access.ts:73`) returns `knowledge` and **`GET /api/knowledge/page?path=…` already serves its body to the owner today** (`knowledge-routes.ts:226`; MetistryKit `knowledgePage(path:)`). `GET /api/knowledge/links` already serves its outgoing wikilinks with `kind` (`knowledge_page_links.yaml`). The **only** missing piece is *which file is newest* | one named query — `SELECT path FROM knowledge_files WHERE path LIKE 'Journal/Fold/%' ORDER BY path DESC LIMIT 1` — or a route that resolves it. **No migration, no new read path** | `seed/queries` | **S** |
| **C66** | `seed/queries/knowledge_pages.yaml`; `db/migrations/0009_brain.sql` | **exact** — the `WHERE NOT k.draft AND k.status <> 'conflict'` clause is there, and the file's own header says *"the same WHERE clause `mcp-brain` applies"*. `0002_review_decisions.sql:24` does list `draft_settle` among the proposal kinds, as the designer notes | not started | **not** an owner flag on `knowledge_pages` — that file is `expose: route` precisely so the generic door cannot serve it unscoped. A sibling `knowledge_drafts.yaml`, also `expose: route`, served from `knowledge-routes.ts` behind the owner check, keeps the property | `seed/queries`, `apps/console` | **S** |
| **C68** | `knowledge_pages.yaml`; `knowledge-fold/run.ts` | **exact** — `area` is derived in SQL (`knowledge_pages.yaml:96`), there is no per-area description | **half of it already exists.** `knowledge_files.description` (added by `0009_brain.sql:11`, "derived: one-line frontmatter description") would hold an area index page's own sentence with **no migration**. What is missing is (a) a query that joins an area to its index page's description, and (b) something writing that frontmatter | one query; then the fold routine writing one `description:` per area index | `seed/queries`, `routines/knowledge-fold` | S for the read, M for the write |
| minor | `style.css:119–128` rooms glyph | **exact** — `:118` sets the `•` fallback and `:119–128` name ten views; `rooms` is not among them | cosmetic | one line | `apps/console` | S |
| minor | `settings-view.swift:553` | **exact** — `conventionalDirectory = "/tmp"`, presented as "Log folder" at `:535` with an Open in Finder button at `:539` | open; the code's own comment says it should stop assuming one shape once `metistry logs --json` reports paths | — | `apps/macos` | S |

**Summary of drift.** Nine citations into `apps/console/src/server.ts` moved by
100–200 lines (the file grew from ~1,100 to 1,483 across #240–#259) and one into
`app.js` moved by two. **No citation was wrong about the code it named.** Two
were overtaken by merges: C46/C47 are done, and C37 is now half-answered by a
query the designer did not know about. One (`dataviz/scripts/validate_palette.js`)
names a file this repository does not contain — §3.4.

---

## 2. Contradictions with merged decisions

Listed, not resolved. Each one needs the owner, and several need the designer in
the room.

### 2.1 Today top-level vs `daily-flow-spec.md` §10

`daily-flow-spec.md:1092` opens §10 with, in bold, **"No new top-level
section."** It then states the sidebar is *"settled at six rows plus Pinned
(`docs/product/app-ux-plan.md:614-624`)"* and that Today is **"one child —
Work ▸ Today, the fifth"**.

`screen-05-today.md` §13.1 moves Today out of Work to a top-level row (logged as
C30), and §14.1 then moves it **above Chat**, reversing §13.1's own "second, not
first" argument within the same document. C50 and C57 add Routines and remove
Resources.

The spec and the design now disagree about the number of rows (6 → 8), the
parent of Today, and the identity of the first row. `daily-flow-spec.md` is one
of the three documents `HANDOFF.md` §2 itself names as the current authority
(C26), so this is not a case of the design correcting a stale document — it is
two current authorities disagreeing.

### 2.2 Feed → Activity vs the shipped naming

Review decision 1 (ratified 2026-09-18) renames Feed to **Activity**. On main:
`apps/console/web/index.html:23` is `<button data-view="feed">Feed</button>`;
`style.css:119` keys the glyph off `data-view="feed"`; MetistryKit's type is
`ActivityFeed` with rows called `ActivityFeedRow` (`console-data.swift:118`,
`:155`); the query is `activity_feed.yaml`; and `app-ux-plan.md:257` still lists
*Chat · Feed · Work ▸ · Knowledge ▸ · Agents · Insights*.

So the wire and MetistryKit are already on *Activity* and the PWA and the plan
are on *Feed*. The rename is a user-facing label change, not a data change — but
`data-view="feed"` is also a test hook and a CSS selector.

### 2.3 "The assistant is never on Agents" (C52) vs what P3 and #235 shipped

Three merged things pull against C52:

1. **The CLI renders every agent.** `metistry agents list` and `GET /api/agents`
   return every registered principal including the internal one; `describeScope`
   (`access.ts:1116`) renders it as `the instance assistant · folders: the whole
   vault · …` — exactly the sentence shape a delegate gets, which is C52's
   complaint. P3 (#248) deliberately made that *one* renderer so no surface
   composes its own (`access.ts:1040–1049` names the four consumers).
2. **The assistant may ask** (#235, ruled 2026-09-19 B). `server.ts:1401–1405`
   records the reasoning: an internal row is no longer refused `request_access`,
   and an approval is recorded in `agent_grant_overrides` so it survives the
   re-sync. A principal that can ask for more has a scope that can be less.
3. The brief itself reconciles this — *"the asking mechanism stays meaningful
   only for an operator who deliberately configured it narrower"*
   (`dev-preview-round-e.md` §1.2). That is a real reconciliation, and it is
   worth saying plainly what it costs: **the roster filter is a view decision,
   not a model decision.** `describeScope` must keep rendering the triple for the
   assistant, because the CLI and the Needs You card both need it when
   `METISTRY_ASSISTANT_AREAS` has narrowed it. The Agents *screen* hides it. Two
   surfaces, one record, and the rule "compose a shared sentence once"
   (`design-system-amendments.md` §4) is what makes that safe.

### 2.4 "Resources" collides three ways

| Where | What it means |
| --- | --- |
| `screen-09-resources.md` | proxied external MCP servers |
| `packages/core/src/access.ts:492` | `Resource` — the closed union `may()` decides on: `tool · toolset · knowledge · query · project · action · console` |
| `access.ts:487` | `resources` is a `KnowledgeDoor` — MCP's own `resources/list`, whose refusal renders as an empty list (`:1005`-ish, the `case "resources"` branch) |
| MCP generally | `resources` is a protocol primitive with a defined meaning |

The design's "Resources" is none of the other three. Note also that the
permissions table's row label — the designer's "one line per resource" — is
*also* the word, and those rows are domain models (Work, Artifacts, Knowledge),
which is a fifth sense.

### 2.5 System button vs the Insights → Usage rename

Review decision 5 (ratified 2026-09-18) is **Insights → Usage**, with *Insights*
explicitly reserved for a later feature, and decision 17 keeps Usage at the
bottom of the navigation. Neither landed: `glossary.md` has **no `usage` noun**
(decision 5 said to add one), and `design-brief.md:143`, `design-system.md:93`,
`:499` and `app-ux-plan.md:173` all still say *Insights*.

The owner's 2026-09-22 stance is a third name and a different shape — a **System
button outside the tabbed UI**, details to come. So one surface currently has
three names (Insights · Usage · System) and two shapes (a nav row · a button
outside the nav), and the design branch's eight-row nav contains none of them.

### 2.6 C58's Read/Write rows vs the role + scope triple

**Is Read/Write expressible from `describeScope`?** Partly, and the gaps matter.

| Row the design draws | Read, from | Write, from |
| --- | --- | --- |
| Knowledge | `tier` + `areas` → `mayReadPath` / `titlesOnly` (`access.ts:662`, `:688`). Expressible | **not a grant at all.** `mayKnowledge`'s `write` door refuses on role first: `if (p.role !== "assistant") return no("forbidden", "role_required", …)`. An agent can never hold Knowledge Write, under any scope |
| Work | `projects` (`null` = every project) | `autonomy.detailed.task_update` |
| Artifacts | `projects` | `autonomy.detailed.comment` (the artifact half of `commentArgs`) |
| a room / comment | `projects` | `autonomy.detailed.comment` (the work half) |
| a tool | `uses` — **crew only**; `allowedTools()` returns `null` for every other role, meaning "no allowlist", not "none" | n/a |

Three consequences:

1. The table composes from **four** independent fields (`tier`/`areas`,
   `projects`, `autonomy.detailed`, `uses`), so "one line per resource" is a new
   computation, not a projection of the triple. It should live next to
   `describeScope` for the same reason `describeScope` exists.
2. **Absence is the denial reads differently per column.** An unlisted Knowledge
   Write row means *impossible for this role*; an unlisted Work Write row means
   *your autonomy table says deny*; an unlisted tool row means *not in this
   crew's `uses`*. The design's rule is right and the reasons are three
   different things. #259's `defaulted`/`clamped` distinction exists because
   blurring exactly this kind of thing hides the owner's own setting.
3. `null` on `projects` and on `areas` means **everything**, and the empty list
   means **nothing** — `describeScope` goes out of its way to say those
   differently in words (`access.ts:1123`, the `areas === null` branch). A
   table of ticks would collapse them unless the renderer carries the same care.

### 2.7 C59's "destructive defaults to Ask, may be On" vs the bridge contract

`CLAUDE.md`'s Packages section states, as a property every bridge conforms to:
*"preview-then-confirm on destructive tools"* — inherited by TypeScript bridges
from `core` and held against Swift bridges by the same conformance tests.

C59 (corrected 2026-09-22) says a destructive tool **defaults** to *Ask* and is
not forbidden from being *On*, on the argument that the wire already shows the
shape (`dispatch` defaults to `propose`). C61 says *Ask* **is**
preview-then-confirm.

Read together: a destructive tool set to *On* is a bridge not doing
preview-then-confirm. That is either (a) a per-instance override of a contract
property — which invariant 8's "misuse tests ship with the interface" makes a
testable, explicit thing rather than a silent one — or (b) a change to the
contract. The `dispatch` analogy does not settle it, because `dispatch`'s
default is a *policy* default and the bridge contract's preview is a *conformance
property* the conformance tests assert. Also relevant: the principle over all the
invariants is **enforce at the tool, never by prompting** — a proxied tool set to
*On* by a console control is still enforcement at the tool, so the question is
narrowly whether the contract admits the control at all.

### 2.8 `daily-flow-spec.md` §10's ten designer needs vs `screen-05-today.md`

| §10 asks for | `screen-05-today.md` | Disagreement |
| --- | --- | --- |
| 1. a task card carrying a reason, reorderable, order stored and authoritative | §13.2's item contract; §11 says *"drag order is stored — **where** is not specified anywhere I could find"* | agreed on the need, and **both** say the storage is unspecified (C29). Still open |
| 2. two visually distinct origins | §13.2 "provenance is carried the same way everywhere" | agreed |
| 3. carry-over chip escalating at 3 and 5 | §3 | agreed |
| 4. a capacity meter, minutes against `daily_capacity_min`, refusing nothing | §12.6 **replaces it** with three segments — committed · fits the gaps · does not fit — against total working minutes | a redesign, and it needs A8 (what `daily_capacity_min` counts) |
| 5. a "2 places" chip for a duplicate group | §3 | agreed; `vault_tasks.duplicate_of` exists |
| 6. the standup block: copy as plain text, **nothing that looks like a send button** | §6 | agreed |
| 7. four absences — no tasks, no calendar bridge, no `Me/profile.md` working days, no template | §7 lists four absences and one empty | agreed |
| 8. promotion is one control, confirmed, **one-way** | §6 | agreed |
| 9. a staleness stamp against `METISTRY_RECONCILE_INTERVAL_SEC` | §11 proposes `2 ×` that interval as the threshold | a number nobody has chosen |
| 10. complete is confirmed and undo-able, because it writes the user's file | §5 says completing is **not possible in this phase** | a phase disagreement, not a design one |
| — | §14.3's **day bar** (meetings, travel, focus as first-class time) | §10 has no calendar surface at all. This is the largest addition, and it is what A1/A2/B9/B10 block |
| — | §14.5 calendar help — the assistant proposing changes to the calendar | §10 names no calendar write. B10/B11 |

Also: **`POST /api/vault-tasks/:task_key/check`**, which `screen-05-today.md`
§10 lists as the source for completing, **does not exist on main.** The console's
route table is `/api/tasks/:id` and its verbs; there is no vault-task write path.
Consistent with §5's "the phase where it is not possible", and worth stating in
the data-source table rather than as a route that looks shipped.

### 2.9 The board's shape

`screen-06-board.md` draws **five** columns with Reported folded into Done
(C39). `docs/ops/board.md:34` is headed **"The six columns"**, `seed/queries/
board.yaml:90` orders six, and `console-data.swift:585` hard-codes
`columnOrder = ["backlog","assigned","in_progress","needs_you","done","reported"]`.
C38 was closed by ruling the label back to **Assigned**;
`console-data.swift:590`'s `label(for:)` still returns `"Addressed to"` with a
comment citing the 2026-09-17 ruling the 2026-09-20 one reversed.

### 2.10 The `D<n>` namespace is used twice for two different things

`daily-flow-spec.md:45–50` numbers its **decisions** D10–D15 (D13 is "eight
directives, one block form"; D14 is the `{{ prose }}` rule; D15 is the one filter
vocabulary). `screen-07`/`08`/`09` number their **developer requests** D1–D13.
`dev-preview-round-e.md` §4 then writes *"Granting a resource to a project or
team rather than to an agent (D13). Open."* — which a reader of this repo will
resolve to the directives decision. The design documents also cite the
daily-flow D-numbers correctly elsewhere (D14 in C65), so both namespaces are in
use inside one document set.

---

## 3. Repo hygiene — what merging the branch as-is would do

The branch is **not docs-only**. Of 49 changed files, four are product artifacts
and one is CI tooling.

### 3.1 CI: everything passes

Run on a real merge of `origin/design/round-0-plan-review` into `ebf3651`:

| Check | Result |
| --- | --- |
| `ops/scripts/check-path-case.sh` | `path-case: ok` |
| `node ops/scripts/prompt-lint.mjs` | clean (exit 0). It scans `seed/`, `skills/`, `plugins/` and `.claude/` only — `docs/**` is never linted, so markdown under `docs/product/design/` cannot fail it |
| `node ops/scripts/audit-limits.mjs` | clean |
| `node ops/scripts/fold-product-record.mjs --check` | `3 fragment(s), all well-formed` |
| `node ops/scripts/build-design-tokens.mjs --check` | `design tokens: ok (144 pairs checked)` |

`Claude outputs/` is already ignored on main (`.gitignore:62`); the branch adds
`__pycache__/` and `*.pyc` and nothing tracked matches either. Path case passes
because the allow-list regex in `check-path-case.sh` exempts the whole `docs/`
prefix, so `HANDOFF.md` and the TitleCase SVGs are fine by construction.

### 3.2 The token check passes **because the branch changes the checker**

`ops/scripts/build-design-tokens.mjs` is CI-path product tooling, and the branch
edits it:

```js
-const NON_TEXT = new Set(["focus-ring"]);
+const NON_TEXT = new Set(["focus-ring", "border-control", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);
```

Running **main's** checker against **the branch's** `tokens.json` reports
**11 pairs below the minimum**:

```
border-control on bg      (light) = 3.29:1   border-control on bg      (dark) = 3.80:1
border-control on surface (light) = 3.55:1   border-control on surface (dark) = 3.46:1
border-control on elevated(light) = 3.55:1   border-control on elevated(dark) = 3.00:1
border-control on sunken  (light) = 3.01:1   border-control on sunken  (dark) = 3.91:1
chart-1 on surface (dark) = 3.20:1   chart-4 on surface (light) = 3.93:1
chart-5 on surface (light) = 3.21:1
```

Every one of them is over 3:1 and under 4.5:1 — i.e. they are exactly the roles
the edit reclassifies as non-text. The reasoning in the new comment (WCAG 1.4.11:
a bar carries its value through an axis and a label, not through being readable
as type) is sound for `chart-*`, and `border-control`'s entire job is outlining a
control, which is the canonical 1.4.11 case. **The finding is not that the change
is wrong — it is that a change to a CI gate arrived inside a design branch**,
which `CLAUDE.md`'s "ask before" habit and "small commits with real messages"
both point away from. It wants its own commit and a line in the PR that says the
bar moved for seven roles.

Related: the designer's own instruction (`HANDOFF.md` §6) is *"`--check` covers
the declared pairs; the undeclared ones are on you"*. Round E checked ~330
undeclared pairs by hand. Review decision 19 ratified a `--check` extension
(contrast on painted grounds; every SVG hex must be in `tokens.json`). That
extension is **not in this branch** and would be the mechanical answer to the
hand pass.

### 3.3 `boards/*.py` — 14 Python files, and the 2026-08-29 ruling

**What they are.** Build tooling for the *design canvas*, not for the product.
`build.py` imports twelve board modules and writes `<canvas>/project/<Board>.dc.html`;
`lib.py` (3,584 lines) holds the components. They generate **`.dc.html` for the
canvas artifact**, not the `.svg` files committed under `docs/product/design/` —
those are separate outputs. Nothing in `pnpm-workspace.yaml` reaches them, no CI
step runs them, and no published package depends on them.

**The ruling.** `CLAUDE.md`: *"Collectors are TypeScript — no Python anywhere
(ruled 2026-08-29; Phase 0's stack had already gone zero-Python)."* Read
literally, "anywhere" covers this.

**The precedent.** Main already tracks **five** `.py` files —
`docs/poc/poc14-classifier/analyze.py`, `docs/poc/poc15-complexity/analyze.py`
and `run_haiku.py`, `docs/poc/poc16-local-scorer/poc16_analyze.py` and
`poc16_score.py`. So the ruling has already been read narrowly once: it governs
*what ships*, and one-off analysis under `docs/` has been exempt in practice.

**Why this is a bigger ask than the PoC scripts.** The boards are not one-off.
They are the reproduction path for every artboard, they are edited every round,
and `HANDOFF.md` says the assembly of a board *"is not recoverable from
`lib.py`"* — five boards already lost theirs, which makes the modules the only
copy. That is a maintenance obligation of exactly the kind `CLAUDE.md`'s
dependency rule exists to price.

**The two shapes, reported not decided:**

- *Ruling that design tooling under `docs/product/design/` is exempt*, with the
  exemption written into `CLAUDE.md` beside the ruling it qualifies, so the next
  reader does not have to infer it from the PoC files.
- *A TypeScript equivalent.* Cost: `lib.py` is 3,584 lines of HTML-string
  assembly with no library surface — a port is mechanical but large (**L**), and
  it would be thrown away if the design tooling stops being needed after the
  final round. It would also have to be done by whoever holds the canvas, since
  the output has to be verified against the artifact.

A third option worth naming only to reject it: leaving it undecided. The branch
has already added 14 Python files without a ruling, and the number grows every
round.

### 3.4 `dataviz/scripts/validate_palette.js` does not exist in this repository

Cited three times as the tool that found C54 and as a standing instruction —
*"Run `dataviz/scripts/validate_palette.js` on any new pair of marks"*
(`design-system-amendments.md` §1.3, `HANDOFF.md` §6, C54's evidence column).
There is no `dataviz/` directory on `origin/main` or on the design branch. It is
presumably a tool on the designer's own account. As written, the instruction is
unfollowable by anyone in this repo, and the ΔE floor of 15 it enforces has no
mechanical check here.

### 3.5 `boards/check-frames.mjs` wants `playwright`

`import { chromium } from 'playwright'`, with `npm i playwright` in its header
comment. `playwright` is in no `package.json` in the workspace and is not on
`CLAUDE.md`'s pre-approved list. As a documented manual step it costs nothing; as
a `devDependency` it is an "ask before adding a dependency" case. Flagging so it
does not arrive by accident.

### 3.6 The branch repaints the shipping product

`tokens.json` goes 1.1.0 → 2.6.2. **No role is removed** (checked
programmatically across all nine groups), so every existing call site in
`style.css` and `design-tokens.swift` stays valid — that is the handoff's
promise kept. But **28 roles are added and 18 existing values are repointed**,
and the generated artifacts are committed:

- `apps/console/web/tokens.css` (+222/-…) — the PWA's live palette
- `apps/macos/sources/kit/design-tokens.swift` (+152/-…) — the Mac app's

Light mode moves from cool grey to warm paper (`bg` `#f6f7f9` → `#f7f4ee`,
`surface` `#ffffff` → `#fffdf8`) and the accent moves from blue to teal
(`#2b5fd0` → `#125f6b` light, `#7ea9ff` → `#6ec9d6` dark), which also moves
`focus-ring`. Merging the branch changes what ships, in both apps, on the next
build. That is presumably intended — it is the brand round landing — but it is
not a docs merge and should not be reviewed as one.

---

## 4. What is safe to build before the final design

The test applied: **does it add a read or a data shape that the final design
cannot make wrong?** A query with no consumer is cheap to keep and cheap to
delete. A nav row is neither.

### 4.1 Safe — reads and data only, no nav, no IA

| # | What | Why it is safe | Effort | Note |
| --- | --- | --- | --- | --- |
| 1 | **`collector_health.yaml`** — per component: last ok, last failure, last error (C1/C48/C64) | pure read over `runs`, no migration. Four design rounds have asked for it and *is this current* is not a question any layout changes | **S** | `packages/core/src/failure.ts:84` already does the "failed since last success" half; this is the other half plus the ok timestamp. Two timestamps on a failure is a query shape, not a view decision |
| 2 | **Newest-fold resolution** (C65) | the body and the links already serve through `GET /api/knowledge/page` and `/links`; only "which one" is missing | **S** | Deliberately *not* a new read path — invariant 3 and the one-endpoint-per-operation ruling both point at a named query behind the existing knowledge route |
| 3 | **`knowledge_drafts.yaml`, `expose: route`, owner-only** (C66) | a second query, not a flag on `knowledge_pages`. The existing query's `expose: route` is load-bearing (its header says why) and must not be weakened | **S** | The decision row already exists: `0002_review_decisions.sql:24` lists `draft_settle`. Needs You and Knowledge answering the same item is a view concern, later |
| 4 | **Per-area description read** (C68) | `knowledge_files.description` exists since `0009_brain.sql:11`; the query joins a derived area to its index page's description | **S** | The *writing* of that sentence (the fold, or a sibling routine) is a behaviour change and belongs in phase B |
| 5 | **`display_name` on the routine manifest** (C55) | additive manifest field; `name` stays the handle, exactly as agents already separate `id` from `display_name` | **S** | Manifest schema is `packages/core`; CI validates manifests (invariant 5) |
| 6 | **Port `blocked_by_task` / `blocked_by_task_open` into `board.yaml`** (C37) | the join already exists in `day_work.yaml:107–108`; this is copying a proven `LEFT JOIN` | **S** | Two screens already draw the string |
| 7 | **`ok` on `activity_feed`'s projection** (C19) | additive column; the `WHERE ok = false` narrowing on `collector_run` is the separate half and can wait | **S** | Admitting successful collector rows into the feed *is* a view decision — do the column, not the filter |
| 8 | **Run detail's missing half** (§3.3 item 10) | see 4.2 below — a correction, and part of it is buildable | **S** | |

**Run history — a correction to the handoff.** `HANDOFF.md` §4 says §7's two open
questions stand, one of them *"whether a run's input is recoverable at all —
today it is not"*. That is no longer true. Migration `0016_compute_engine.sql:33`
added `assistant_sessions` with **`messages jsonb` — "the OpenAI-shaped message
array, system prompt excluded"** — and `runs.session_id` (`0001_init.sql:14`)
joins to it. `rollSession` sets `rolled_at` and does **not** delete the row
(`packages/core/src/session-roll.ts:47`). So:

- **recoverable today:** the session's message history for an assistant turn.
- **not recoverable:** the system prompt (excluded by design), and the exact
  slice of the array that was the input to run *N* specifically — the array is
  per-session and accumulates.
- **not applicable:** routine runs are model-free (invariant 4), so there is no
  prompt to read; what the owner wants there is the manifest's task prompt (D8),
  which does not exist yet.

What the app needs for the run-detail view that exists: `GET /api/runs/:id`
(`server.ts:222`, `:883`) and MetistryKit's `ConsoleAPI.run(_ id:)` are both
shipped, and `run_detail.yaml` returns provider, model, token and cache counts,
cost, `meta`, an exact tool-call join on `meta.turn_id` / `meta.message_id`, and
the shadow columns. **Nothing new is needed to draw the run-cost half.** The
prompt half needs one decision — see question Q6.

**Two that are safe as data but need an owner nod first:**

- **C45 as a stated rule.** The behaviour is already in the code
  (`server.ts:1376–1378`). Making it a *rule* means a misuse test per
  consequential interface, which is invariant 8's shape. Cheap; wants the nod
  because it constrains every future action path.
- **C28 `partial`.** No code needed to ratify. Two real instances exist
  (`knowledge_files.status = 'conflict'`, `vault_tasks.parse_warning`). Ratifying
  early is what stops the sixth screen inventing it again.
- **C59's defer-when-unattended.** The *behaviour* is settled in the design and
  it is a run-context flag, which is small. But it presupposes a proxied-tool
  ask path that does not exist, and it touches §2.7's contract question. Not
  safe yet.

### 4.2 Must wait

| What | Why |
| --- | --- |
| **Any nav change** | §2.1 is unresolved and C60 could remove a row entirely. Eight rows built now could be seven |
| **Today's placement** and whether it is a section at all | §2.1 |
| **Chat as a pane or rail** (C60) | explicitly "a direction, not a decision" |
| **Ask delivery** (push vs in-app dialog vs Needs You alone) | undecided by the designer's own §4 |
| **D13** — granting a resource to a project or team | open, and it is a scoping axis nothing drawn has |
| **Motion** (C16) | unruled; until then there is no animation in the product |
| **Settings ▸ Resources vs a resizable Settings** (C62/C5) | a genuine fork; see Q1 |
| **The proxied-server registry** (D9) and per-tool grants (D11) | the largest undrawn feature, and §2.7 is unresolved |
| **The permissions table as drawn** (C58) | §2.6 shows it composes from four fields with three different meanings of absence |
| **The day bar, travel, calendar writes** | A1/A2/B9/B10/B11, and two of those need rulings, not tickets |
| **Anything that renames `feed`** | §2.2 — it is a test hook and a CSS selector as well as a label |

---

## 5. Proposed sequencing, once the design is final

### Phase A — data and reads (no view changes)

Everything in §4.1. All eight items are **S**, none needs a migration, none has a
view dependency, and each can merge on its own. Total: roughly one focused batch.
Order within the phase does not matter except that C68's read should land before
anything writes area descriptions.

### Phase B — behaviour rules

| Item | Effort | Depends on |
| --- | --- | --- |
| C40 — Revise can only grant less (`underAreas(area, [asked])` at `server.ts:1390`) + misuse test | S | already ruled 2026-09-20 |
| C41 — carry the tier trade in the approval response | S | — |
| C42 — the escalation ceiling writes a `runs` row | S | — |
| C43 — `routine_run` in `activity_feed`, with a `routine` group | M | the `group` vocabulary is closed and read by three surfaces |
| D7 — `meta.outcome`: acted vs silent, written by each routine | S | ratify the outcome vocabulary first |
| D5/D6 — `acts:` on the manifest and `next_run_at` | M | `packages/core/src/schedule.ts` has the due-ness logic |
| The fold (or a sibling) writes one `description:` per area index | M | D14's `{{ prose }}` rule — the fold is the one template whose output the assistant owns, so an area index is **not** covered by it. Needs A5's ruling |
| C45 as a stated rule + per-interface misuse tests | S | an owner nod |
| `describePermissions()` beside `describeScope` | M | §2.6 settled |
| D2/D3/D8 — the routine's agent, task prompt and per-run grant | **L** | one feature; invariant 2 makes the manifest a human change |

### Phase C — views, by screen

MetistryKit data each screen needs, and whether it exists. Store methods cited
are on `ConsoleAPI` (`apps/macos/sources/kit/console-api.swift`) unless noted.

| Screen | Needs | Exists? | Effort |
| --- | --- | --- | --- |
| **Activity** (screen 2) | `activityFeed(...)` `:215`; `run(_:)` `:230` → `RunDetailReply` | **yes, both.** Missing only the `routine` group (phase B) and `ok` on the projection (phase A) | S once phase A/B land |
| **Needs You** (screen 3) | `requests(limit:since:)` `:241`; `answer(...)` `:252`; `answerMany(...)` `:268`; `RequestRow`/`AccessRequest` `console-data.swift:235`, `:361` | **yes.** The `access_request` card's model is already typed. Missing: the tier-trade flag (C41) and a vault tree under the asked prefix for the narrowing control | M |
| **Chat** (screen 1) | no store method — the console's `/message` and `GET /api/messages` are not on `ConsoleAPI` | **no** | M |
| **Capture** (screen 4) | `POST /capture` exists with `Idempotency-Key`; no `ConsoleAPI` method | **partly** | S |
| **Today** (screen 5) | a day query (`day_work.yaml` is the closest and is `expose: route`); `vault_tasks` has **no named query and no route**; `POST /api/vault-tasks/:key/check` **does not exist**; calendar fields (A1) absent | **mostly no.** This is the largest gap on any screen | **L** |
| **Board** (screen 6) | `board(project:limit:)` `:282`; `updateTask` `:291`; `claimTask`/`releaseTask`/`renewTask` `:302`–`:310`; `dispatchTask` `:319`; `Board.label(for:)` `console-data.swift:590` | **yes** — but six columns and the "Addressed to" label (§2.9) | S for the relabel, M for five columns |
| **Agents** (screen 7) | `agents()` `:340` → `AgentList`; `agentPresence(limit:)` `:347`; `setAutonomy` `:354`; `approveAgent` `:358`; `AgentRecord.scope` and `AgentRecord.actions` (`console-data.swift:929`, reading `scope.autonomy.detailed`) | **the permissions half is shipped** (#259). Missing: the agent definition file (D1), routine-granted reach (D2), which routines use it (D3), collector health (phase A), the escalation ceiling (C42) | M |
| **Routines** (screen 8) | nothing. No `routines()` method, no route, no query | **no** | M after phase B |
| **Resources** (screen 9) | nothing exists (D9, D11, D12) | **no** | **L** |
| **Knowledge** (screen 10) | `knowledgeSearch` `:406`; `knowledgePage(path:)` `:413`; `knowledgePages(...)` `:424`; `knowledgeLinks(...)` `:444` | **the reads are all there.** Add the four phase-A queries and the screen is drawable | M |

**The shape of the estimate.** Screens 2, 3, 6, 7 and 10 are mostly wiring
against methods that exist. Screens 5, 8 and 9 are new features with new data.
If the final design keeps the current split, the honest order is Activity →
Needs You → Knowledge → Agents → Board, then Routines, then Today, then
Resources.

---

## Open questions

Eight, in the order they unblock.

1. **Settings, or not Settings?** (C62/C5) A fixed 640×520 window
   (`settings-view.swift:47`) cannot hold a tool table at
   `accessibilityExtraExtraExtraLarge`. Engineering's read: **making Settings
   resizable is one line plus a layout pass on six panes**, and it is the
   cheaper of the two — but a resizable Settings window is less Mac, and
   Resources-as-its-own-window is a defensible answer. The designer asked for an
   early opinion; this is it, and it is the owner's call.
2. **Does the "System" button replace Insights/Usage entirely?** (§2.5) One
   surface has three names in three documents and none of them is in the
   eight-row nav. Whatever it is called, `glossary.md` needs the noun — decision
   5 asked for it a month ago.
3. **`boards/*.py` — exempt, or port?** (§3.3) Report, not decide: the ruling
   says no Python anywhere, the repo already tracks five PoC `.py` files, and
   this is 14 more that are edited every round. If exempt, the exemption should
   be written beside the ruling in `CLAUDE.md`.
4. **Does the bridge contract admit a destructive tool set to `On`?** (§2.7)
   Either it is a per-instance override with a misuse test, or the contract
   changes. The `dispatch` analogy does not settle it.
5. **Today: child of Work, or top-level, or first?** (§2.1) Three documents give
   three answers and one of them is `daily-flow-spec.md`, which `HANDOFF.md`
   itself names as current authority.
6. **Run detail: may `assistant_sessions.messages` be rendered to the owner?**
   The array is in Postgres and joinable (§4.1). It is the owner's own
   conversation, so P1 says it is data — but it is also the one place a
   redaction slip would show. A yes makes "read what the run was asked" a **S**,
   not a feature.
7. **Which `D<n>`?** (§2.10) Either the design's developer requests get a
   different prefix (R1…, or DR1…) or the daily-flow decisions do. Two
   namespaces, one spelling, in documents that cite each other.
8. **Ratify `partial`?** (C28) Two real instances, no code needed, and every
   round that passes without it is another screen inventing a fifth state
   locally.

---

*Not in scope and noticed anyway:* `packages/tasks/sql/schema.sql:71` and
`db/migrations/0001_init.sql:21` still disagree about whether `runs.ok` is
nullable (C20), which is exactly where an in-flight run would live — and
`devin-knowledge/run.ts:198` reads `WHERE … ok IS NULL` to find its own
in-flight row, so the nullable spelling is the one the code depends on.
