# Design round 0 — technical design and build plan

**Engineering's plan for building the final design** on
`design/round-0-plan-review` (PR #263, head `6f7a142`, 106 files, +20,254),
written against `origin/main` at `1d9aefb` (#262). The design branch's merge base
is `47c8db6` (#250, v0.11.0), so main is **27 commits** ahead of what the
designer read; every code citation below was re-checked at `1d9aefb` (§1.2).

This replaces the round-E preview review that lived at this path's predecessor
(`design-build-impact-2026-09-22.md`, now renamed; nothing linked to it, so no
pointer is left). That review was written against a design the owner called
preliminary; this one is written against the design the owner called final on
2026-09-25, and it treats every owner ruling in the design record as a ruling.

**How the design record is read.** `DEVELOPER-HANDOFF.md` §0 sets precedence and
this plan follows it: the ratified rows of `review-00-plan.md` (C1–C138) win,
then `design-system-amendments.md`, then the screen and component specs, then
`glossary.md`, `design-system.md`, `design-brief.md`, `PRODUCT.md`. Where two
design documents disagree, §1.4 names the one this plan builds to and why.

**One naming rule governs every section.** The design writes the assistant's
name, *Metis*, into labels. `CLAUDE.md` makes a hardcoded "Metis" in a path,
table, env var, package, class or function a bug; C88 agrees for the interface —
every label templates `identity.yaml`'s `name`, served by `GET /api/identity`
(`apps/console/src/server.ts:449`). Wherever this document writes *Metis*, the
code writes `assistant` and the screen writes the configured name.

---

## 0. Lead

**What the final design is.** A Mac app first, with the PWA as the away client
(native iPhone deferred). The sidebar is **eight rows — Today · Chat · Activity ·
Work ▸ (Board · Projects · Artifacts) · Knowledge ▸ · Agents · Scheduled — then
Pinned**, plus a ninth, **Needs You**, above Today *only while something is
waiting*, carrying the product's one badge (C57, C110, C113). The Mac toolbar
has two controls, **+** (capture) and the **Usage gauge**; there is no bell on
the Mac. The gauge is what the owner called the *System button* on 2026-09-22:
spend against enforced spending limits, a daily chart, where the money went, the
cache rate (screen 17, C133). **Needs You** is a full list-and-detail view — one
request pattern (header · ask · context · one body block · answers) over twelve
types, questions stepped one at a time, pull requests reviewed in the app and
posted as the owner, and a hub rule under which syncs raise requests only when
the source names the owner (C104–C110). **Today** opens as the **Morning
Brief**, carries **Next Up** before each meeting, ticks tasks in their own files,
and ends with **Close the Day**, which writes a fenced section of the owner's
daily note (C97–C103). **Scheduled** (Routines v2) shows every scheduled thing —
routines, including the defaults Metistry ships, all editable and resettable,
with **Standup** a routine of its own — and a **Syncs** tab for scheduled reads
from one connection (C111–C113). The **Capture Bar** is a floating glass rail on
a screen edge — Ask · Note · To-do · Record — whose chat is the same
conversation as the window's, recording up to ten hours (screen 11, C137).
**Settings** is a fixed 840 × 600 window with twelve scrolling panes — Instance ·
Services · Compute · Updates; Account · Connections · Secrets · Variables; Live
Capture · Sessions; Keyboard · Advanced (C62, C86, C123–C132). Everything
outside Metistry is one typed noun, a **Connection** (MCP · Agent · API · Feed ·
Files), whose tools are set **On · Ask · Off** and can be offered to agents
through Metistry's proxy; keys are **Secrets** in the Keychain written
`{{ secret.name }}`, shared values are **Variables** (C114–C118).

**What it changes about the product.** Metistry stops being a console with a
status window and becomes a place the owner lives in during the day: the Mac app
today has exactly one main-window destination, *Status*
(`apps/macos/sources/kit/root-view.swift:17`), and this design gives it eight
sections, a floating bar and a real Settings window. Three product rules move.
**One writer per file becomes one writer per region** in the owner's daily note
(C102). **Needs You becomes the hub** for everything that needs the owner,
including events that used to show only on their own screen (C96, C108). And
**the app becomes the owner's editor for configuration** — routines, connections,
secrets, identity, keep-awake — where main today keeps most of that to the CLI
and a text editor; the enforcement stays at the tool (protected paths written
through the reconciler as `user`), only the hand changes (§2b, K9).

**Total effort: ≈ 322 agent-days** (Phase 0 ≈ 12.5, A ≈ 146, B ≈ 17, C ≈ 120,
D ≈ 26; E unscoped), by analogy to shipped work and not measured — read it as
±30 %. A **first usable Mac app** (M1: shell, Needs You, Today, Chat, Activity,
Knowledge, Scheduled, Usage, capture composer) is ≈ 130 agent-days of that. With
parallel agents the **critical path is ≈ 45 agent-days plus one owner ruling**,
and it runs through the platform work, not the screens: Secrets v2 →
Connections P1 → the `connection_call` ruling and P2 → P3 → the Connections
pane (§3.7).

**Where this corrects the brief it was written from.** Compute is one column, not
a Metis/Local/Cloud split (C130 revised C128's tabs the same day); *Resources* is
now **Connections** (C114); the *Routines* row is **Scheduled** (C113); keep-awake
lives in **Settings ▸ Services**, not Instance (C124, C129); and "Scheduled" is a
main-window row, not a Settings pane.

---

## 1. Decisions ledger

One row per owner decision, from the round-00 answers (*Ratified — 2026-09-18*,
nineteen answers), the review-01 answers (*Ratified — 2026-09-23*, C88–C98), and
every C-row the log marks *ruled*, *closed* or *ratified* (through C138), plus the
owner rulings recorded inside screen specs. **Status** is against `1d9aefb`:

- **Done** — main already does it.
- **Partial** — part is on main; the rest is named.
- **Not started**.
- **CONTRADICTS Kn** — conflicts with a merged ruling or merged code; §1.3.
- **Open** — ruled as a direction, or waiting on a second decision.

Ticket ids point into §3.

### 1.1 The ledger

**Navigation and shell**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| N1 | Feed is **Activity** | review-00 Ratified 09-18 #1 | PWA label and `data-view` key; Mac view | Partial — MetistryKit already `ActivityFeed`; PWA still `data-view="feed"` (`apps/console/web/index.html:23`) |
| N2 | **work** is a noun; the section stays Work | #2 | glossary only | Done on the branch's glossary |
| N3 | Sidebar **Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents · Scheduled**, then Pinned; Today first | C30, C50, C57, C113 | Mac sidebar (C-1); PWA tab bar (D-1) | **CONTRADICTS K1** (accepted by the owner 2026-09-22) |
| N4 | **Needs You row** above Today, only while something waits; one badge; no Mac bell; ⌘0 | C110 (revising C109) | sidebar observes a pending count; row leaves on the next navigation after zero | Not started — Mac has no Needs You view; no count route |
| N5 | Usage leaves the sidebar: a **gauge** top-right beside **+** (the owner's "System button"); *Insights* reserved | #5, #17; brand-kit *Round B revised* 09-19; screen 17 | toolbar gauge + 400px popover | Not started (PWA *Dashboard* has spend tiles) |
| N6 | Chat as a persistent pane — **direction only** | C60 | nothing | Open — do not build |
| N7 | Window title is **Metistry**, never the section | brand-kit, ruled 09-19 | window chrome | Not started (Mac) |
| N8 | The assistant is labelled by **the configured name**; *assistant* is never a label; the name is set in Settings ▸ Instance | C88, C123 | every label templates `identity.name`; a protected write for `identity.yaml` | Partial — `GET /api/identity` serves it; `metistry identity` is read-only |
| N9 | Dock may carry the Needs You count; board escalations become a `footnote` count with a glyph | #11, C1, C36 | Dock badge; board header | Not started |
| N10 | Menu bar keeps its four SF Symbols; brand mark stays out | #14 | none | Done |
| N11 | **Metistry** for the name; `metistry` for binary, CLI, packages | #15 | PWA manifest `name` | Not started — `manifest.webmanifest` says `metistry` |
| N12 | Rooms: no list, no row; **Has Thread** filter; *Open Room* is a pane over Board | #4, C89 | drop PWA `rooms` nav; board thread count | Not started — PWA ships a Rooms view |

**Colour, type, motion**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| T1 | Quiet-fill roles and a destructive fill; CI checks the **painted** ground | #6 | repoint `color-mix()` at `style.css:224, 285–297` (C6); declare painted pairs | Partial — roles land with #263; call sites and the painted-ground check do not |
| T2 | A `stale` role, an age pattern, the P5 amendment | #7 | tokens + a stale band component (C-1) | Partial — role on the branch |
| T3 | **Accent pinned**; `controlAccentColor` drives only Apple's own controls | #8, C11 | Swift generator must not map `accent` to the system accent | Not started — guard it in P0-3 |
| T4 | A chart palette, charts only | #9 | `chart-1…5`, judged at 3:1 via `NON_TEXT` | Done on the branch (the checker change, §2l) |
| T5 | The `--check` extension ships in the token PR | #19 | painted-ground pairs + every SVG hex is a token | Not started — **not in #263** (P0-3) |
| T6 | `ICON_PNG` may be added to `build-app.sh` | #16, C9 | one variable, generator as fallback | Not started (`ops/release/build-app.sh:130`) |
| T7 | Motion only where it carries information words cannot; a closed list of two (waiting dots, recording breath); both hold still under Reduce Motion | C16, C75 | Chat and bar only | Not started (no Mac views) |
| T8 | Agent prose: a 2px `agent` rule in a transcript, the wash everywhere else | C69 | one prose component (C-1) | Not started |
| T9 | Serif for agent prose: SwiftUI `.serif`; web `Charter, Sitka, "Sitka Text", Constantia, Georgia, serif` | C32, C35 | tokens `type.$meta.serif` | Partial — on the branch |
| T10 | Contrast is checked on the ground actually painted; disabled marks use a dimmer ink, not opacity; `border-control` outlines controls; two marks differ by weight; glass floors 0.86 / 0.75 | C49, C54, C63, C70, C73, C74 | component rules (C-1, C-15) | Not started |
| T11 | Light chart chroma toward 0.10 | C87 | token values | Open — the token owner's |
| T12 | HIG title case; values verbatim; **12-hour clocks** | amendments §8.1, #12 | one formatter in MetistryKit (`WireTime` parses, does not format) | Not started |

**Needs You and requests**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| R1 | Answers **Approve · Revise · Decline**, then Later; **Skip only in bulk**; Approve is the one accent fill | C92 (closing C14) | the UI verb → wire decision table (§2f) | **CONTRADICTS K2** |
| R2 | `action` reads **action**, not *note* | C80 | `pending_requests.yaml:79`, `routines/morning-brief/run.ts:60–72`, glossary | Not started |
| R3 | One request pattern; a **closed set of bodies** (choices · diff · thread · before and after · preview · to-dos · excerpt); a new type is a row, not a card; **twelve types** | screen 3 §12.2, amendments §9 | `payload.body.kind` validated in core (P0-8) | Not started |
| R4 | **Questions**: several per request, pick one / pick any, each ending *Something else…*; Revise is free text; answers stored as free text, never executed | C105; screen 3 §12 rulings 09-25 | decision block v2; per-question answers | Partial — chat settles a question in free text (`server.ts:625–635`, `decision = 'answered'`); one question only |
| R5 | Questions **step one at a time**; a single question sends on choice | screen 3 §13.2 | view (C-2) | Not started |
| R6 | **Pull requests** reviewed in Metistry, posted as the owner, from agents and from GitHub's own review requests | C106, C107; screen 3 §12 rulings 09-25 | `pull_request` kind; thread collection; owner PR doors with a separate write credential checking head SHA | Not started — `prs_for_review` exists; the collector's PAT is read-only (`collectors/github-state/run.ts:1–6`) |
| R7 | **Hub rule**: a sync raises a request only when the source names the owner; the request mirrors the source and clears with it; inferred asks are Metis's and say so | C108 | `source {kind, external_ref, person}`, dedupe, `resolved_at_source` | Not started |
| R8 | Owner events become requests: budget stop → question; failed routine → report; expired credential → access; knowledge conflict → review | C96 | four raise paths | Partial — budget stop is already a two-option question (`apps/assistant/src/budgets.ts`); sync-conflict copies are `report` rows (`apps/reconciler/src/indexer.ts:286–302`) |
| R9 | Revise on an access request can **only grant less** | C40 (ruled 09-20) | refuse a widening at `accept_with_changes` | Not started — `server.ts:1389–1390` still checks shape only |
| R10 | A failed consequential operation **leaves the request pending** | C45 | a rule plus a misuse test per door | Done in behaviour (`server.ts:1376–1378`, `docs/ops/actions.md`); not stated per door |
| R11 | Needs You is a **list-and-detail view**; the phone keeps its sheet | C109 → C110 | Mac view | Not started |
| R12 | A meeting arrives as **one card**; Accept All is one approval per item, in order | C81; screen 3 §10.3 | `proposals.group_id` | Not started — Open for the developer (C81) |
| R13 | Report kind `decision` → `decided` | C104 | `requests_create` schema | Open — recommendation, owner's |
| R14 | Render `proposals.trust` beside the actor, neutral | C22, amendments §8.3 | view | Not started |
| R15 | No snoozed count in the header | C21 | none | Done (removed from the design) |

**Today and the daily flow**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| D1 | **One Morning Brief**, Today's first state; writes a machine-owned file | C97 (review-01 #10) | `Journal/Brief/<date>.md` | Not started — `morning-brief` sends a message and writes no file |
| D2 | **Standup** and **Tomorrow's Plan** are routines of their own; the brief *presents* the standup file | C111 (revising C97) | a `standup` routine; the brief reads `Journal/Standup/<date>.md` | Not started — no `routines/standup/` |
| D3 | **Ticking** tasks is phase 1, on Today, Board and card detail | C98 (review-01 #11) | `POST /api/vault-tasks/:task_key/check` | Not started |
| D4 | **No confirm** on a tick: one click, a receipt naming the file, Undo; a line edited meanwhile is refused (409) | C99 | the door's 409 | Not started |
| D5 | **Close the Day writes the vault**: the daily note's section, a date on each deferred line, tomorrow's plan now | C101 | schedule door; section writer; close trigger on `plan-tomorrow` | Not started; **CONTRADICTS K6** on the token spelling |
| D6 | **One writer per region** in the daily note, between `<!-- metistry:day -->` markers; broken markers stop the write and raise a request; owed items are tasks | C102 | reconciler section operation | **CONTRADICTS K5** |
| D7 | Generated prose allowed outside fold templates — attributed, *written, not retrieved*, rateable, costed | C103 (closing A5) | template gate names Brief and Standup | Not started |
| D8 | Metis may move a meeting with other people **after a warning** naming who is told and the new time; owner-only meetings move without one; the calendar sends the update | C90 (review-01 #3) | eventkit `move_event` with an attendee preview | Not started — eventkit exposes `create_event` and `create_reminder` only |
| D9 | The do-date reads **Planned**; typed `do …` and `scheduled_for` unchanged | C134 | labels | Not started |
| D10 | **Next Up** from T–30, **Slipping** as a saved view, three predictions a page | review-01 §5 (all adopted); screen 5 §15 | Today route + calendar fields | Not started — A1 is partial: events carry `id`, `location`, `calendar`, attendee **names** (`packages/mcp-eventkit/helper/ek-helper.swift:58–60`), not emails, organizer, notes or series |
| D11 | Where Today's drag order lives | C29 | a table | Open for the developer — decided in §2a (`today_order`) |

**Scheduled — Routines v2**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| S1 | **Scheduled** row with tabs **Routines** and **Syncs** | C113 (revising C112 and C50) | nav; `GET /api/scheduled` | Not started |
| S2 | Every scheduled thing is **visible and editable**; defaults tagged **default**, run by Metis, **Reset to Default**; *built-in* retired | C111, C112 | an instance overlay over product manifests | Not started — schedules live only in product manifests read at console start (`apps/console/src/main.ts:292–295`) |
| S3 | Sync cadence (5 min · 15 min · Hour · 6 hours) and *What reaches Needs You* move from code to instance config | C112, C113 | overlay + collector `needs_you:` rules | Not started — cadence is `schedule:` in `collectors/*/manifest.yaml` |
| S4 | `inbox-drain` → **Inbox Sort**, `claude-usage` → **Usage Rollup**, both default routines | C113 | display names; presented as routines | Not started |
| S5 | Routine **display names** | C55 | `display_name` on the manifest | Not started — `name` is the slug in all five |
| S6 | An agent is a capability; a routine is an **assignment** (agent + task, appended) | HANDOFF §3, amendments §5 | routine `agent`, `task`, per-run grants (D2, D3, D8 requests) | Not started |
| S7 | Routine runs are an **Activity** group of their own | C43 (ruled 09-20) | `activity_feed.yaml` | Not started — the runs branch admits seven kinds, not `routine_run` (`activity_feed.yaml:81–82`) |
| S8 | Metis's suggestions about a routine arrive as **improvement** requests; Approve writes the change | screen 8 §10.4 | improvement → overlay write | Not started |

**Connections, secrets, variables, permissions**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| P1 | **Connection** is the one noun: MCP server · Agent (A2A, ACP) · API · Feed · Files; *resource*, *target*, *source* retired | C114 (after C56, C57) | a connection registry | Not started |
| P2 | Per tool, grouped **Reads · Changes things · Starts an agent**, each **On · Ask · Off**; seeded from MCP `readOnlyHint` | C114, C93 | tool policy on the connection | Not started |
| P3 | **Offer to agents through Metistry** — one switch; the proxy speaks MCP to agents and generates tools for non-MCP types; every call grant-checked, secrets filled, logged | C115 | proxy + generated tools | Not started |
| P4 | Known services ask for named fields; custom ones by **HTTP / Command / Path**; *What it sends* preview; host guards | C118 | the app edits connection files | Not started; supersedes #258 §4.13 (**K9**) |
| P5 | **Ask** = pause when interactive, defer and report when unattended; a destructive tool **defaults** to Ask and may be set On | C59, C61 | run-context bit; defer path | **CONTRADICTS K4** |
| P6 | **Secrets**: Keychain, **per instance**, `{{ secret.name }}`, *Sent only to* hosts, *Who may use it*; never seen by a model; one request per failed secret | C116 | a secrets policy file + egress fill | **CONTRADICTS K7** |
| P7 | **Variables**: plain `{{ variable.name }}`, usable in agent instructions; key-shaped values caught at save | C117 | a variables file + resolver | Partial conflict — **K8** |
| P8 | Permissions are **one table** (Resource × Read × Write); **absence is the denial**; one glyph for Ask | C58, C93 | `describePermissions()` beside `describeScope` | Not started |
| P9 | Metis is **not on Agents**; its reach is not a grant | C52 | a roster filter | Partial — **K3** |
| P10 | A project **holds permissions**; members inherit them | screen 13, owner ruling 09-22 (D13) | project grants with *via project* provenance | Not started |
| P11 | Effective actions carry their reason (set · defaulted · clamped) | C46, C47 | — | **Done** (#259, `packages/core/src/actions.ts:170–220`) — the PWA still recomputes (D-3) |

**Agents**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| A1 | An agent's **model, where it runs and effort** are set in its definition; `assignments.tiers/crews` move to agent definitions | C128, C132 | crew manifest `model:` takes a provider/model ref | Partial — crews name `haiku · sonnet · opus` (`manifest.ts` `CREW_MODELS`) and compute has `assignments.crews`; **K12** on tiers |
| A2 | **New Agent** asks the kind first; **Run Now** with nothing scheduled is dimmed with its reason | C138 | chooser; reason | Not started |
| A3 | Esc in the agent editor **keeps a draft** | C136 | view | Not started |
| A4 | The definition is edited as the owner's hand; Metis may never write it | screen 7 §3.1, invariant 2 | a write door for `.metistry/agents/**` | Not started (no read or write route) |
| A5 | The escalation ceiling is visible on Agents | C42 | a `runs` row when the ceiling refuses | Not started — the refusal writes no row (`packages/mcp-brain/src/access.ts:86, :133`) |
| A6 | Approve on access states the tier trade | C41 | carry the prior tier in the answer | Partial — documented at `apps/console/src/agents.ts:600–616`; not in the payload |

**Settings**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| G1 | Settings is a sidebar window, **fixed 840 × 600**, every pane scrolls; the old *Connections* pane is **Account** | C62 (closed 09-23), C86 | `SettingsView` → `NavigationSplitView`; `SettingsModel.Section` re-cut | Not started — `.frame(width: 640, height: 520)` (`settings-view.swift:47`), seven tabs (`settings-model.swift:54–89`) |
| G2 | **Instance**: The Assistant (Name, Mention, Mark, ID), This instance, Recent (8), Linked instances | C123 | identity write; instances UI | Partial — `metistry instances add\|remove\|refresh` exist |
| G3 | **Services**: Doctor first (each problem with its fix), supervisor, per-service Restart · Stop · Log, When it runs | C124 | doctor JSON gains an action per problem | Partial — `metistry doctor\|restart\|stop\|start\|logs` exist; doctor reads supervisor state over the control socket (`packages/cli/src/doctor.ts:996`) |
| G4 | **Keep this Mac Awake** with *Allow sleep on battery* and *Allow sleep when the lid is closed*, both on by default | C129 | `keep_awake` → `{enabled, sleep_on_battery, sleep_lid_closed}` | **CONTRADICTS K10** |
| G5 | **Updates**: runtime Update and **Roll Back**; Releases vs Git checkout in Advanced | C126 | UI over existing verbs | Partial — `metistry update --rollback` exists |
| G6 | **Keyboard**: one switch, *Shortcuts in any app*, off; five shortcuts under it | C127, C120 | `RegisterEventHotKey` + conflict check | Not started |
| G7 | **Compute is one column**: Metis uses (one dropdown, effort, **no fallback**) · Providers (switch, one tag, Test, gear, Remove) · Your Models (memory + disk, one search grouped by model) · Spending limits | C130, C131, C132 (revising C125, C128) | provider `enabled`, `billing`; model identity table; catalogue search | Partial — providers, models list/install/load/unload/test exist; a fallback list is already refused (`packages/core/src/compute.ts:107`); **K12** |
| G8 | Provider keys are **secret references** | C125 | `auth.secret` → `{{ secret.x }}` | Not started — `auth.secret: UPPER_SNAKE` |
| G9 | Spending limits **enforced** per day and month, instance and provider; Allow · Stop · Critical only | C133 | copy only | **Done in the engine** (`apps/assistant/src/budgets.ts`, routine preflight `apps/console/src/main.ts:300–304`) — **K14** stale copy |
| G10 | **Sessions**: kept **30 days**, outside git, read-only, the fold runs before expiry; *Let Metis learn*; Purge Now | C78, C91 | session archive + retention | Not started — `assistant_sessions` is a replay cache, trimmed (`apps/assistant/src/sessions.ts:1–14`) |
| G11 | **Live Capture** pane; bar placement; what Metis keeps | screen 11 §8 | bar prefs; purge | Not started |

**Work, artifacts, projects**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| W1 | Five columns; **Blocked**; **Assigned**; Reported is a facet on Done | C2, C38 (closed 09-20), C39 | `board.yaml` column order, labels | Not started — six columns and *Addressed to* (`console-data.swift:585–593`) |
| W2 | Board carries **blocked by task** and its open state | C37 | port the join | Not started — `day_work.yaml:107–108` already computes both |
| W3 | Every card click opens the **detail popover**; the thread is a section in it | C84 | view | Not started |
| W4 | `work` gains a **description**, set by the creator, editable by the owner | C85 | migration 0026 | Not started |
| W5 | Project modes **Autonomous / Review**; chosen Review takes weight, budget-forced takes the tint; the rollup says why | C83, C94 | view | **Done in data** — `GET /api/projects` returns the last mode change and who made it (`apps/console/src/projects.ts:30, 53–61`) |
| W6 | Artifact threads sit **in the margin** beside their lines | screen 16, owner ruling 09-23 | view | Not started (routes exist) |
| W7 | The per-area rollup is renamed **Areas** | C82 | query + two surfaces | Open — owner's |

**Knowledge**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| K-1 | Knowledge leads with **the fold**, then *Needs your eye*, then **Areas** described in a line, then one sources line | screen 10 (owner's intent 09-22) | three reads | Not started — the page body and links already serve (`knowledge-routes.ts:226, :308`) |
| K-2 | Freshness per sync; a failure carries **two timestamps**; an expired credential is **failed** | C48, C64, C95 | `collector_health` | Not started — the data is in `runs` (`collector_run`, `ok`) |
| K-3 | What Metis learns about the owner arrives as a **proposal**; Approve writes the owner's words to `Me/` | C79 | session fold | Not started |
| K-4 | A fifth state, **partial** | C28 | a state + token | Open — owner's |

**Capture and the bar**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| C1 | The receipt is the id and the path, never a classification | C23 | none | **Done** — `POST /capture` returns `{id, path, sha256}` (`server.ts:550–579`) |
| C2 | The composer mints an `Idempotency-Key` and reuses it on retry | C24 | client | Partial — server honours it; the Mac transport can send it; no composer |
| C3 | Captures from the apps carry their own source | C25 | `source: "app"` | Not started — hardcoded `"http"` (`server.ts:576`); **no migration needed**, `inbox.source` has no CHECK |
| C4 | The bar is present while the bridge is installed, on an edge the owner picks (never top or bottom), and its chat **is the window's conversation** | screen 11, owner rulings 09-22 | `NSPanel` | Not started |
| C5 | A meeting **is a window, its sound and your voice**; *Audio only* stays | C76 | `SCStream` + `captureMicrophone` | Not started; **sequencing Open** — owner's |
| C6 | Jots anchor to (session id, offset) until the note exists | C77 | proposal rewrite of anchors | Not started |
| C7 | The bar may not say *Metis cannot see*; hearing and seeing are separate acts | C71 | copy + UI | Not started |
| C8 | The bar shows the tail at **328px** with *Open in Chat* past four lines | C72 | view | Not started |
| C9 | Recording up to **10 hours**: reminders every 2 h, disk watch, gaps marked, crash saved; ~150 MB/hour; media deleted after the fold | C137 | bridge lifecycle | Not started; **K11** |
| C10 | Transcripts kept **30 days** from session end | C91 | retention | Not started |

**Keyboard, VoiceOver, states**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| X1 | Mac only; every shortcut a menu item (Go ⌘0–⌘7, Capture, Item, Help ⌘/); ⌘9 retired; New Conversation ⇧⌘N | C119 | `CommandMenu`s | Not started — no `CommandMenu` in the app |
| X2 | Shortcuts in any app off by default; conflict-checked when set | C120 | Carbon hot keys | Not started |
| X3 | A **Spoken** table per screen; glyph controls speak their name; charts speak one sentence with a rotor table | C121 | accessibility labels | Not started — six `accessibilityLabel`s in the whole Swift tree |
| X4 | Reduce Motion and the largest text size are part of the pass | C122 | test matrix | Not started |
| X5 | **First paint** is the last data with a stale band; waits over 1 s say what they wait for; three failures raise one request | C135 | shared component; runner streak | Partial — the runner's failure streak exists (`apps/console/src/runner.ts`) |
| X6 | **Undo** when reversible (10 s), **confirm naming the cost** when not | C136 | client delay; confirms | Not started |
| X7 | No dead-end buttons (New Agent, Run Now, Raise) | C138 | links | Not started |

**PWA and process**

| # | Decision | Recorded | What it changes in code | Main today |
| --- | --- | --- | --- | --- |
| Q1 | PWA is a release feature: Today first, phone first; **bottom tab bar Today · Chat · Work · Knowledge · More** with + and the bell in the header; native iPhone deferred | screen 18 rulings 09-24; review-01 R2.1 | PWA shell | Not started — eleven-button strip (`index.html:23–33`) |
| Q2 | Offline: one rule per verb (queues · refuses · not offered) | screen 18 §4 | service worker outbox | Not started — `sw.js` has no offline cache |
| Q3 | Secrets, Variables, Live Capture and Keyboard are Mac-only | screen 18 §5 | PWA Settings list | — |
| Q4 | Python is exempt for design tooling under `docs/product/design/` | owner 09-22 | none | **Done** (`CLAUDE.md:97–101`) |
| Q5 | Designing ahead of the wire is allowed; every gap is logged | HANDOFF §1, 09-20 | none | — |
| Q6 | Additional top-level nav sections are accepted | owner 09-22 | — | Done (ruling) |

### 1.2 Citations re-verified against `1d9aefb`

Every code citation in the C-log and the screen specs was opened. **None was
wrong about the code it named.** Drift and overtaken premises:

| C | Cited | At `1d9aefb` |
| --- | --- | --- |
| C10 | `app.js:431` | `:433`, unchanged |
| C18 | `app.js` allow-list | `:1446`, `work_history` still in it |
| C20 | `0001_init.sql:21` NOT NULL vs `schema.sql:71` nullable | **premise overtaken** — `0002_review_decisions.sql` runs `ALTER TABLE runs ALTER COLUMN ok DROP NOT NULL`; the migrated column *is* nullable and matches `schema.sql`. Not a live contradiction |
| C21 | `server.ts:777` | `:968` (list), `:983` (the snooze `WHERE`) |
| C23, C24, C25 | `server.ts:428, 435, 454` | `:550, :554/579, :576` |
| C25 | "a vocabulary change with a migration behind it" | **no migration** — `inbox.source` is free text (0001 comment only; no CHECK in 0001–0025) |
| C40 | `server.ts:1389` | exact; still unfixed |
| C43 | `plan-tomorrow/run.ts:71` | `:71` is `PLAN_DIR`; the `routine_run` write is at `:381–392` |
| C80 | `pending_requests.yaml:72–81` | `:79`; `morning-brief/run.ts:60–72` |
| C83 | "needs the rollup to return why" | **done** — `projects.ts:30, 53–61` |
| C86 | `settings-model.swift:55–89` | `:54–89` |
| C105 | `server.ts:630` | `:625–635` |
| C133 | "the app says *recorded, not enforced*" | true — `compute-model.swift:451`, `compute-facts.swift:191`, and the CLI help (`packages/cli/src/main.ts`, `compute` block: "Nothing dials a provider or enforces a budget yet") — all stale; the engine enforces |
| screen 1 §3c, §8 | "no endpoint serves `rules.yaml` tiers"; "`GET /api/knowledge/page` does not exist" | **both overtaken** — `GET /api/commands` returns the live tier map (`server.ts:900`); the page route exists (`knowledge-routes.ts:226`) |
| today-hub A1 | "events carry only title, start, end" | **partly overtaken** — `id, location, calendar, attendees` (names) are returned |
| #253 §7(3) | `full_disk_access` blocked by the enum | **overtaken** — it is in `tccGrant` (`packages/core/src/manifest.ts:30–36`); what is missing is `microphone`, `audio_capture`, `screen_recording` |
| #262 §0(5) | "Needs You has no deadline at all — nothing expires" | **wrong** — `morning-brief` expires every pending row after 14 days (`routines/morning-brief/run.ts:15, :251–255`); see K15 |
| design-system amendments §1.3, HANDOFF §6 | `dataviz/scripts/validate_palette.js` | **not in this repository** — a designer-side tool |

### 1.3 Contradictions with merged rulings and merged code

Reported, not routed around. Each names both sides and what this plan builds;
the ones marked **owner** are in §4.

| K | The design says | The merged side says | Resolution in this plan |
| --- | --- | --- | --- |
| **K1** | Eight rows, Today first and top-level, a conditional ninth (C30, C50, C57, C110, C113) | `daily-flow-spec.md` §10: "**No new top-level section**… Work ▸ Today, the fifth"; D19; `app-ux-plan.md` six sections; `design-system.md` P6 | **Resolved by the owner** (2026-09-22, additional top-level sections accepted). The branch banners daily-flow §10 and D19. Build the design |
| **K2** | Three answers + Later; Skip bulk-only; Approve makes the suggested task (components-01 §2.4) | `docs/ops/reply-feedback.md` "**The Needs You queue's six verbs**" (normative); glossary on main "six answers"; the branch's own glossary still offers *Approve as Work* | Build C92. P0-4 rewrites `reply-feedback.md` to the table in §2f. **Components-01's "Decline without a reason sends what Skip sent" is not built**: it would make revoking an enrolment depend on whether text was typed; Decline is always `deny` (§4 Q10) |
| **K3** | Metis is not on Agents (C52) | #235 (09-19 ruling B) lets the internal principal `request_access`; `describeScope` renders it as a role + scope triple | A **view filter**, not a model change: the roster hides the internal principal; the CLI and the access card keep the triple, which is needed when `METISTRY_ASSISTANT_AREAS` narrows it |
| **K4** | A destructive tool may be set **On** (C59, C61) | `CLAUDE.md` Packages: every bridge does "**preview-then-confirm on destructive tools**", held by conformance tests | **Owner.** Engineering reading: the contract holds for *bridges*; a proxied connection tool is not a bridge, and its On/Ask/Off is the owner's per-tool policy in a protected file. Needs one sentence in `CLAUDE.md`, which is the owner's file |
| **K5** | Metistry writes the daily note between markers (C102) | `daily-flow-spec.md` §5.1 one writer per file; #255 "Me/ and the user's journal are refused at the tool for every non-user principal" (`isUserOwnedPath`, `apps/reconciler/src/paths.ts:231–240`) | **Resolved by the owner's C102**, and built so the rule is still enforced at the tool: a reconciler **section operation** is the only way a non-user principal touches `Journal/<date>.md`, and it proves the bytes outside the markers unchanged (§2c, A-14) |
| **K6** | Deferring writes `⏳ <date>` or `#someday` (C101) | daily-flow D2/D3 and `packages/core/src/task-line.ts:1–8`: the parser **reads** Tasks-plugin emoji but **emits exactly one form**, English trailing tokens | Write `do <date>` through `formatTaskLine`, and add a `someday` token to the grammar. Same meaning, the file's own spelling. Designer to re-label |
| **K7** | Secrets are **per instance only**; collapse `SECRET_SCOPES`' user scope (C116) | `packages/cli/src/secrets.ts:72–83`: provider, AWS and Devin keys are **user-scoped** on purpose — "shared by every instance on this Mac" (and `docs/ops/compute.md`) | C116 is the owner's later ruling and wins. Cost stated: a second instance re-enters every provider key; P6 includes a one-time copy of user-scoped items into each instance. Confirm (§4 Q3) |
| **K8** | Variables hold `standup_time`, `timezone` (screen 19, C117) | `Me/profile.md` is the home of those facts, *discovered, never assumed* (daily-flow §6.6, owner ruling Q4) | Profile facts stay in `Me/profile.md`; Variables holds values that are not profile facts. The Variables pane may show profile facts read-through. **Owner** (§4 Q4) |
| **K9** | The app configures connections, routines, secrets, identity (C111, C118, C123) | #258 §4.13: "no route creates, edits or deletes a connector… no in-app policy editor"; `apps/reconciler/src/paths.ts:100–135`: the console may write exactly two protected paths, "nothing may grow it without a product change" | #258 was a recommendation; the owner's design supersedes it. The **one-door rule** in §2b decides each write: Mac-only settings go through a CLI verb (owner caller class, all protected paths); writes both clients need go through a console door, and `CALLER_AUTHORITY` grows by **one** path (`.metistry/scheduled.yaml`) |
| **K10** | *Allow sleep when the lid is closed* is a switch; off keeps a closed laptop awake (C129) | `packages/core/src/power.ts` `LID_CLOSED_NOT_AVAILABLE`: no user-space process can hold a lid-closed Mac awake; the owner's 2026-09-19 note, "**lid close must always sleep**"; `always_lid_closed` is accepted and behaves as `always` | Build the switch, and its *off* state says, in place, that it takes an administrator change Metistry will not make — C71's own rule (a capability claim is a state claim). **Owner** (§4 Q2) |
| **K11** | Recording keeps compressed audio (~150 MB/h) **until the fold reads it** (C137) | The design's own screen 11 §8: "*audio — never kept*"; #253 §4(a)5: frames transcribed and dropped | Two design statements disagree; C137 is later. Build C137, and screen 11 §8's copy must change. **Owner** (§4 Q7) |
| **K12** | Metis uses **one model**; `assignments.tiers/crews` move to agent definitions (C128, C132) | Invariant 4; `rules.yaml` tiers the router picks; `assignments.tiers` including `routine`, and `assignments.intent` (#257, PoC-20) | Crews move. Router tiers are not agents and cannot move into a definition: *Metis uses* is `assignments.default`; tier assignments stay in `compute.yaml` behind an Advanced disclosure the design does not draw. **Owner** (§4 Q1) |
| **K13** | Standup runs working days at **6:00 AM** (C111) | daily-flow §7: `standup-draft` runs "within the hour before `standup_time`, `standup_days` only" | Build C111; `standup_time` still drives the brief's Standup section and the Next Up card |
| **K14** | Limits are enforced (C133) | Main's own copy says they are not | Main contradicts itself; the engine is right. Fix the copy (P0-5) |
| **K15** | Mirror requests clear only when the source clears (C108); events are requests (C96) | `morning-brief` expires **every** pending row after 14 days (`run.ts:251–255`) | Rows with a `source` are exempt from the blanket expiry (A-10) |
| **K16** | Invitations are answered Accept · Maybe · Decline in Metistry (screen 3 §12.7) | EventKit is the only calendar path, and as far as this reviewer knows it exposes **no public API to respond to an invitation** (participant status is read-only) — **unverified here; verify before building** | Build *Open in Calendar* until a calendar connection with an RSVP API exists. **Owner + designer** (§4 Q9) |
| **K17** | *Draft Reply* opens a draft in Mail (screen 3 §12.7) | D17: the Mail bridge is **read-only** and allowlisted | Open a compose window through the app (the owner's hand, no bridge write). §4 Q9 |
| **K18** | Rename report kind `decision` → `decided` (C104) | `requests_create` is a published tool schema external agents call (`packages/mcp-brain/src/report.ts:11`) | If ruled, accept both spellings for one release (additive) |
| **K19** | HANDOFF §3 "Work's children are Board · Projects · Artifacts · Rooms"; the daily-flow and design-system banners say *Routines*; the branch glossary says the gauge sits "beside the bell" | C89 (no Rooms), C113 (*Scheduled*), C110 (no Mac bell) | Stale sentences in the designer's own record; build the rulings |

### 1.4 The designer's edits to merged specs, and what each supersedes

`git diff origin/main...origin/design/round-0-plan-review` on files outside
`docs/product/design/`:

| File | Change | Supersedes a merged ruling? |
| --- | --- | --- |
| `daily-flow-spec.md` | D19 struck: "Today is the first sidebar row (C30, C57)" | **Yes** — D19; owner-accepted (K1) |
| | field table: *scheduled* "Shown as **Planned** in the app (C134)" | No — a label; storage unchanged |
| | §5.1 ownership table gains `Journal/<date>.md` — **only its `metistry:day` section** — writer `morning-brief` and the owner's close | **Yes** — §5.1's one writer per file for that file (K5) |
| | §10 banner: eight rows incl. *Routines*; Feed is Activity; Rooms not a Work child; plan and standup as sections of the Morning Brief; Approve · Revise · Decline | **Yes** — §10's six rows. The banner is itself stale twice: the row is *Scheduled* (C113), and C111 made plan and standup routines of their own |
| | *not bannered:* §6.2's "prose only in fold templates" (C103), §6.6 profile facts vs Variables (K8), §7 standup timing (K13) | — |
| `design-brief.md` | one blockquote superseding the Settings row (screen 15's twelve panes) | **Yes** — the Settings section list (C86, C123). **Formatting fault:** the `>` line sits *inside* the screens table, so every row after it renders as text. Designer or owner to fix; not edited here |
| `design-system.md` | a supersession banner (nine rows) and eleven inline notes; ⌘9 → ⌘0 and ⌘1–⌘6 → ⌘0–⌘7 edited **in the text** at §3.18 and §6 | **Yes** — P6, §2.6, P1 in a transcript, P10, §3.9, §3.10–3.12, §3.18, the keyboard line. Note: `DEVELOPER-HANDOFF.md` §3 says the owner's files were "flagged, not edited"; this one and `design-brief.md` were edited |
| `glossary.md` | rewritten: a **Metis** entry; **twelve** request types; **three answers** + Later, Skip in bulk; tickable tasks; rooms; Autonomous / Review; access as one table; **Planned**, **Routine**, **Connection**, **Sync**, **Secret**, **Variable**, **Usage**; *routines* and *folds* leave the "words you will not see" list | **Yes** — the 2026-09-09 glossary, each change backed by a C-row. `metistry-build-plan.md` §0 "carries the same table" and is now out of step (not edited here — owner's file). Internal fault: it keeps *Approve as Work* as an offer (K2) and "the gauge beside the bell" (K19) |
| `.gitignore` | `__pycache__/`, `*.pyc` | No — follows the Python exemption |
| `ops/scripts/build-design-tokens.mjs` | `NON_TEXT` gains `border-control` and `chart-1…5` | **A CI gate change** inside a design branch; sound under WCAG 1.4.11 (§2l) |
| `apps/console/web/tokens.css`, `apps/macos/sources/kit/design-tokens.swift` | regenerated at tokens 2.6.2 | Repaints both shipping apps (§2l) |

### 1.5 Where the design disagrees with itself — the reading this plan builds

| Topic | Disagreement | Built to |
| --- | --- | --- |
| Revise | amendments §9 "Revise is always free text" vs screen 3 §10.1/§12.2 access Revise = a narrowing control | Access: `accept_with_changes {area}` (narrower only, C40). Every other type: `accept_with_changes {feedback}` |
| Dismiss / Not Mine | amendments §8.1 bans *Dismiss* on a request; screen 3 §12.2 gives `report` *Dismiss* and `message` *Not Mine* | Built as drawn in §12 (newer, type-specific); both send `skip` |
| Approve as Work | components-01 §2.4 folds it into Approve; branch glossary still offers it | components-01 (higher precedence): Approve sends `accept_as_work` when `payload.suggested_work` exists |
| Projects empty state | screen 13 "no New Project"; components-03 *No projects yet · New Project* | screen 13 (projects appear on first use); the empty state links to Board |
| Tomorrow's Plan time | screen 8 §10.1 "7 PM (or when the day is closed)" vs `plan-tomorrow`'s profile-driven evening gate | 7 PM default in the overlay, the close trigger (C101) earlier, the profile gate kept as a guard |

---

## 2. Technical design, by layer

### (a) Data model

**Migrations — additive, numbered from 0026** (0025 is `agent_role`). Each runs
under `metistry update`'s advisory lock and twice in CI.

| # | File | What | Durability (D6) |
| --- | --- | --- | --- |
| 0026 | `work_description.sql` | `work.description text` (C85), length capped in `packages/tasks` | durable where the owner wrote it |
| 0027 | `proposal_group_and_source.sql` | `proposals.group_id text` (C81), `proposals.source jsonb` `{kind, external_ref, person}` (C108), `CREATE UNIQUE INDEX … ON proposals ((source->>'kind'), (source->>'external_ref')) WHERE decision = 'pending' AND source IS NOT NULL`. New decision value `resolved_at_source` needs no DDL (`decision` is free text) | durable |
| 0028 | `today_order.sql` | `today_order (day date, task_key text, position int, PRIMARY KEY (day, task_key))` (C29) — app state, never the markdown (B4's reading, kept by C101) | durable (the owner's hand; small) |
| 0029 | `meeting_refs.sql` | `vault_meeting_refs (event_id, path)` and `people_emails (email, path)`, both derived by the reconciler's walk from frontmatter (A3, A4) | derived |
| 0030 | `session_archive.sql` | `session_archive (id, session_id uuid, thread, turn_id, ts, system_prompt text, messages jsonb, tool_calls jsonb, folded_at, expires_at)` (C78, C91) | **ephemeral by design** — 30-day, lost on `down -v` like trend lines |
| 0031 | `prose_feedback.sql` | `prose_feedback (prose_id text UNIQUE, rating smallint CHECK (rating IN (-1,1)), note, ts)` (C33, B7) — a sibling of `reply_feedback`, not a rewrite | durable |
| 0032 | `project_grants.sql` | `projects.grants jsonb` — knowledge areas every member inherits (D13 ruling) | durable |

**Session archive — the location call C78 left to the developer.** In Postgres,
not a file cache under `.metistry/`: the engine already writes
`assistant_sessions` there, and a file cache needs a filesystem the compose shape
does not give the engine (invariant 7). Rejected: the owner's lean to
`.metistry/state/` files — portable only in the launchd shape. Retention is a
purge routine keyed on `expires_at`; the session fold (A-25) reads rows with
`folded_at IS NULL` first, so nothing expires unread while the fold is healthy.

**No migration needed** for: `inbox.source = 'app'` (C25); `runs.kind` values
`connection_call`, `config_write`, `access_ceiling` (free text, 0001);
`runs.meta.outcome` (D7); new proposal kinds (`pull_request`, `question`,
`invitation`, `task`, `message` — `kind` is free text, 0022's comment).

**Configuration files — git is the record (invariant 1), protected (§4.7):**

| File | Holds | Written by |
| --- | --- | --- |
| `.metistry/scheduled.yaml` *(new)* | per routine: `display_name`, `schedule` (`{days, at, tz}` or `every`), `paused`, `task`, `agent`, `grants`; per sync: `every`, `paused`, `raise` toggles | console doors (one new `CALLER_AUTHORITY` path) — needed by both clients |
| `.metistry/connections/<name>.yaml` *(new)* | type, how it is reached (HTTP / Command / Path), tool policy, *offer* switch, secret and variable references | CLI verbs (Mac-only) |
| `.metistry/secrets.yaml` *(new)* | secret **names** → Keychain item, *Sent only to* hosts, *Who may use it*, expiry; **never a value** | CLI verbs (Mac-only) |
| `.metistry/variables.yaml` *(new)* | name → plain value | CLI verbs (Mac-only) |
| `.metistry/identity.yaml` | name, mention, mark | new `metistry identity set` (Mac-only) |
| `.metistry/deployment.yaml` | `keep_awake` gains the object form; the four values stay valid | `metistry deployment set-keep-awake` (extended) |
| `.metistry/compute.yaml` | providers gain `enabled`, `billing: token \| subscription`; `auth.secret` accepts `{{ secret.x }}` | existing CLI and console doors |
| `.metistry/agents/<area>/<id>.md` | a crew's definition; `model:` accepts `provider/model` | new `metistry agents define` (Mac-only) |
| `seed/model-identities.yaml` *(new, product data)* | provider model id → one model identity (C131), instance-overlayable | product releases |

**Vault paths.** `Journal/Brief/` joins `JOURNAL_MACHINE_DIRS`
(`packages/core/src/instance-layout.ts`) and the seed; `Templates/Brief.md` is
seeded; `Templates/Daily.md` gains the `<!-- metistry:day -->` markers (C102
"the daily-note template may place the markers").

**Each screen's data, and whether it exists**

| Screen | Data | Exists? |
| --- | --- | --- |
| Needs You | `GET /api/proposals` (+cursor), `POST /api/proposals/:id`, `/batch`; count; group; source | list/answer/batch **yes**; count, group, source, question v2 **no** |
| Today | `vault_tasks_query`, `day_work`, `pending_requests`, eventkit `GET /events`, brief/standup/plan files | queries **yes** (in-process only); no route; `today_order`, check/schedule/close **no** |
| Chat | `GET /api/messages`, `POST /message` (with `tier`), feedback, `GET /api/commands` tiers, `runs` per turn | **yes**; turn progress query, cancel **no** |
| Activity | `activity_feed`, `GET /api/runs/:id` | **yes**; `ok`, `routine`, `turn_id`, `config_write` **no** |
| Knowledge | search, page, pages, links | **yes**; fold, drafts, areas, freshness **no** |
| Agents | `agent_presence`, `GET /api/agents` (+ `scope.autonomy.detailed`), grants/autonomy/revoke/rotate/approve | **yes**; permissions table, definition, ceiling **no** |
| Scheduled | product manifests, `runs` | **no** route; overlay, history, next-run **no** |
| Board / Card / Projects | `board`, `board_projects`, `rooms`, task routes, `GET /api/projects`, `PUT /api/projects/:slug` | **yes**; blocked-by, thread count, five columns, description **no** |
| Artifacts / rooms | artifact routes, `/api/work/:id/thread`, `/comments`, resolve | **yes** |
| Run detail | `run_detail` | cost half **yes**; conversation (archive) **no** |
| Usage | `spend`, `cache_report`, `aws_costs_daily`, `GET /api/compute` | **yes**; per-actor split **no** |
| Settings | `metistry` verbs; `/api/compute*` | partly (§2h) |
| Capture Bar | live-capture bridge | **no** |

**New named queries** (invariant 3 — every new read is a named query run by
`packages/queries`; `expose: route` wherever the owner's route is the only door,
so the generic door cannot hand an agent with `queries: true` the owner's data):

| Query | Params | `expose` | Serves |
| --- | --- | --- | --- |
| `pending_count` | — | route | `GET /api/needs-you/count` → `{waiting, oldest_ts}`; the Needs You row and Dock badge |
| `collector_health` | `component` (text, "") | route | per sync: `last_ok_at`, `last_failed_at`, `last_error`, `streak` — two timestamps (C64) |
| `knowledge_fold_latest` | `date` (text, "") | route | newest `Journal/Fold/*.md` path + its outgoing links (C65) |
| `knowledge_drafts` | `limit`, `offset` | route | owner-only drafts (C66); a sibling of `knowledge_pages`, whose `WHERE` stays (it protects agents) |
| `knowledge_areas` | — | route | area → index `description` (0009), file count, last change, *named by the fold* (C68) |
| `vault_task_by_key` | `task_key` | route | the one row the check and schedule doors act on |
| `today_order` | `day` | route | Today's stored order |
| `routine_history` | `component`, `limit` | route | runs with `meta.outcome`, cost, steps by `meta.run_id` |
| `turn_progress` | `turn_id` | route | the running tool names for Chat's waiting states — no stream needed |
| `spend_by_actor` | `days` | generic | Usage's *Where it went* (chat · routines · agents) |
| `session_detail` | `session_id`, `turn_id` | route | Run detail's conversation |
| `people_by_email` | `email` | route | Next Up attendees → person pages, never guessed (A4) |
| `connection_calls` | `connection`, `principal`, `since`, `ok` | route | Connections' *Used by* and audit (#258 §4.9) |

**Modified:** `board` (+`blocked_by_task`, `blocked_by_task_open`, `thread_count`,
five columns, `reported` as a flag); `activity_feed` (+`ok`, `routine_run` in a
`routine` group with silent ticks excluded, `turn_id` param, `config_write` in
`run`); `pending_requests` (the request type table from core, `source`,
`group_id`). **Pre-existing gap, not widened:** `GET /api/proposals` reads
`proposals` with inline SQL (`server.ts:968–990`); new reads do not follow it.

### (b) Console: routes and doors

**The one-door rule.** Every owner write has exactly one door (ruled 2026-09-19,
one endpoint per operation), chosen by who needs it:

- **Mac-only settings → a `metistry` CLI verb.** The app already shells the CLI
  (`command-runner.swift`, `metistry-cli.swift`); the CLI writes protected paths
  through the reconciler with the **owner** caller class, which may write every
  protected path (`apps/reconciler/src/paths.ts:132–135`). No console growth.
- **Writes both clients need → a console door**, reached by the PWA directly and
  by the Mac app through `metistry console call`. A door that writes a protected
  path adds that path to `CALLER_AUTHORITY.console` — a product change, one line,
  with its misuse test. This plan adds **one**: `.metistry/scheduled.yaml`.

Every console door sits behind the existing management gate —
`may(principalOf(auth), "act", {kind: "console", door: "console_management", route})`
(`server.ts:800`) — which admits the `user` principal (passkey session or the
local owner token) and nothing else, and every new route joins the enumerated
refusal list so an agent bearer gets the uniform 403. **Misuse tests shipped with
each door** extend `console-routes.integration.test.ts`'s four cases (401 with no
credential; 403 for an agent bearer; 403 for the capture owner token; the local
owner token reaches it) plus the door's own.

**New read routes** (owner-only; each reads named queries, the vault bridge or a
bridge):

| Route | Reads |
| --- | --- |
| `GET /api/needs-you/count` | `pending_count` |
| `GET /api/today?date=` | `vault_tasks_query` (today preset), `day_work`, `today_order`, eventkit `GET /events`, brief/standup/plan paths and their existence |
| `GET /api/vault-tasks?where=` | `vault_tasks_query` via `compileTaskFilter` (All mode; Slipping · Owed · Waiting on Others) |
| `GET /api/knowledge/fold`, `/drafts`, `/areas` | the three knowledge queries (+ the page body through the vault bridge) |
| `GET /api/scheduled`, `GET /api/scheduled/routines/:name`, `GET /api/scheduled/syncs/:name` | manifests ⊕ `scheduled.yaml`, next occurrences from core, `routine_history`, `collector_health` |
| `GET /api/turns/:turn_id/progress` | `turn_progress` |
| `GET /api/sessions/:id` | `session_detail` |
| `GET /api/agents/:id/definition` | `.metistry/agents/<area>/<id>.md` from the instance dir (as `crews.ts` already reads it) |
| `GET /api/agents` *(extended)* | + `permissions` rows from `describePermissions()` |
| `GET /api/connections`, `GET /api/connections/:name` | connection files + `check()` + `connection_calls` |

**The owner's doors — invariant 10's enumerated set, as this design grows it**

| Door | Route | Service it opens onto | Writes | Guard | Audit | Misuse tests beyond the four |
| --- | --- | --- | --- | --- | --- | --- |
| Tick | `POST /api/vault-tasks/:task_key/check` `{checked, seen_text}` | core `task-line` + vault bridge write as `user` with `expected_sha256` | two tokens on one line (`[x]` + `done <date>`; the reverse for Undo) | 409 `stale` with the current line | `runs` `task_check` | a body cannot supply text; bytes outside the two tokens unchanged; a changed line is refused; a key whose note is not vault content is refused |
| Defer | `POST /api/vault-tasks/:task_key/schedule` `{do \| someday, seen_text}` | same | `do <date>` or `someday` (K6) | 409 | `task_schedule` | as above |
| Order | `PUT /api/today/order` `{day, keys[]}` | `today_order` | Postgres only | keys must be today's | — | unknown keys refused; no vault write possible |
| Close | `POST /api/today/close` `{day, line?}` | the reconciler **section operation** as `user` + enqueue `plan-tomorrow` | the daily note's section only | markers missing → no write, a `note` request | `day_close` | bytes outside the markers unchanged |
| Meeting note | `POST /api/meetings/:event_id/note` | render `Templates/Meeting.md`, vault write as `user` (A2) | one new note, or `existing: true` | one per `event_id` | `meeting_note` | second call returns the first path |
| Move a meeting | `POST /api/calendar/events/:id/move` preview → confirm | eventkit `move_event` | the calendar | attendee list in the preview; confirm token single-use | `calendar_move` | a confirm without the owner-door token is refused at the bridge for events with other attendees (B10 enforced at the tool) |
| Resolve a conflict | `POST /api/knowledge/conflicts/resolve` `{path, keep, seen_sha}` | vault bridge write as `user` | one note | 409 | `conflict_resolve` | cannot name a path not in `conflict` |
| Routine edit | `PUT /api/scheduled/routines/:name` | `scheduled.yaml` through the reconciler as `user` | one protected file | schema-validated in core | `config_write` | an unknown key refused; `task` may not carry `{{ secret. }}` |
| Reset to Default | `DELETE /api/scheduled/routines/:name` | same | removes the entry | — | `config_write` | only overlay entries; a product manifest is never touched |
| Run Now | `POST /api/scheduled/routines/:name/run` | the runner's existing tick for one component | a `routine_run` | budget preflight applies | `routine_run` | a paused routine refused with the reason |
| Sync edit / Sync Now | `PUT`, `POST …/syncs/:name(/run)` | same file / the collector | as above | cadence in the closed set | as above | cadence outside 5 min · 15 min · 1 h · 6 h refused |
| Answer v2 | `POST /api/proposals/:id` *(extended)* | existing triage | per-question answers; Revise on questions | `if_unchanged` | existing | a question answer outside its options without `other` is refused; free text never executed |
| PR review | `POST /api/github/pulls/:owner/:repo/:number/review`, `…/threads/:id/reply`, `…/threads/:id/resolve` | a new owner-only GitHub write client with the `github_write` secret | GitHub | **head SHA must equal the one shown** | `pr_review` | refused without the SHA; no agent credential reaches it; the collector's read-only PAT unchanged |
| Description | `PATCH /api/tasks/:id` *(extended)* | `TasksService.update` | `work.description` | existing | `task_op` | an agent may set it at create, never edit it |
| Prose rating | `POST\|DELETE /api/prose/:id/feedback` | `prose_feedback` | Postgres | — | — | unknown ids refused |

**ACTION_KINDS — the agent-proposable set — stay at four** (`dispatch`,
`task_update`, `comment`, `capture`) through Phases 0–C. None of the doors
above is agent-reachable. One candidate is named and not built until the owner
rules: **`connection_call`**, the door an **Ask** tool needs so that Approve
runs the call (#258 §4.7; A-37). Its args are closed to `{connection, tool,
args, confirm_token}`, its effective mode is never `allow` in P2, and the set of
reachable (connection, tool) pairs is enumerated by the owner's hand in a
protected file.

**Not a door:** request deadlines. The design ratifies none; #262's `due_at`
(its Q3) stays open (§4). The existing 14-day auto-expiry is a routine's write,
kept, with mirrors exempt (K15).

### (c) Routines v2 — Scheduled

**Model.** A routine stays code in the product (`routines/<name>/run.ts` + its
manifest) and gains an **instance overlay** in `.metistry/scheduled.yaml`: the
manifest is the default, the overlay is the owner's change, **Reset to Default**
deletes the overlay entry. A user-defined routine (New Routine) is an overlay
entry naming an `agent` and a `task` with no product code: the generic
**agent-routine runner** composes the agent's definition + the task (appended,
never replacing), grants the run its `grants` for the run only, and enqueues one
crew run — the shape `knowledge-fold` already uses for Metis.

**The scheduler gains a time of day.** Today every schedule is an interval
(`scheduleToSeconds`; "the runner has no time of day"), and `@hourly` routines
gate themselves. The design's schedule editor is weekday toggles + a time + a
skip rule, and syncs are one of four intervals. So `schedule` becomes a closed
shape — `{days: [mon…sun], at: ["HH:MM"], tz}` or `{every: 5m|15m|1h|6h}` — with
a hand-rolled next-occurrence function in `packages/core/src/schedule.ts` (about a
hundred lines over `Intl`, with the DST cases tested). Cron strings in product
manifests stay accepted for one release. Rejected: a cron dependency — the
editor cannot produce cron's full language, and a parser for a language nobody
writes is maintenance for nothing.

**Defaults, as the design lists them:** Standup 6:00 AM working days · Morning
Brief 6:02 · Tomorrow's Plan 7 PM or on close · Knowledge Fold 10 PM · Reply
Review 11 PM · Weekly Review Sunday 6 PM · Inbox Sort every 5 min · Usage Rollup
hourly. `inbox-drain` and `claude-usage` remain collectors in code; their
manifests gain `display_name` and `presented_as: routine`. `Me/profile.md`'s
working days still gate the daily routines, so an owner with no profile still
gets nothing guessed.

**Outcome.** Every routine writes `meta.outcome` — `acted`, `silent`, or
`skipped:<reason>` (D7). Activity shows `acted` and absent-state skips, never a
silent tick; Scheduled's history shows all three.

**What the day's routines write — one writer per file, one per region (C102):**

| File | Writer (principal) | How | Notes |
| --- | --- | --- | --- |
| `Journal/Standup/<date>.md` | the assistant, `source: standup` | routine renders the skeleton from `Templates/Standup.md`; **one** assistant turn fills the prose slots and writes via `knowledge_write` — the fold's pattern (`routines/knowledge-fold/run.ts:24–42`) | invariant 4 holds: the routine calls no model |
| `Journal/Brief/<date>.md` | the assistant, `source: morning-brief` | same pattern; the **same single turn** also writes the Next Up line for each of the day's meetings | one generated turn a day, costed in Usage (C103, A5's option 2). Rejected: a turn per card — unbounded |
| `Journal/<date>.md`, between `<!-- metistry:day -->` markers | `morning-brief` at 6:02 (model-free: plan + meetings), `user` on Close the Day | reconciler **section operation** | generated prose never enters the owner's own note |
| a deferred task's own line | `user` | the Defer door | 409-guarded |
| a ticked task's own line | `user` | the Tick door | 409-guarded |
| `Journal/Plan/<tomorrow>.md` | `plan-tomorrow` | existing; triggered by Close, re-rendered by a second close | — |
| people pages (owed) | proposals from the fold | C79 | the owner's Approve writes |

**The section operation, enforced at the tool.** `POST /vault/section`
`{path, marker, body, principal, expected_outer_sha}` on the reconciler. It
refuses unless the path is `Journal/<date>.md`, the file holds exactly one
well-formed marker pair, and the bytes outside the markers hash to
`expected_outer_sha`; it replaces only the bytes between the markers (appending
`## Today · Metistry` with markers the first time, C102). `writeAllowed` keeps
refusing every other non-user write to the file. A missing or broken marker is
`section_missing`; the caller raises a `note` request and writes nothing.

**Improvement requests about a routine** (screen 8 §10.4) carry a
before-and-after of the overlay entry; Approve writes it through the Routine
edit door as `user`.

### (d) Connections — settling what the answers settle

**Settled by the owner's answers:** one noun and five types (C114); per-tool
On · Ask · Off grouped Reads · Changes things · Starts an agent, seeded from
`readOnlyHint` (C114); one *Offer to agents* switch and a proxy that generates
tools for non-MCP types (C115); configuration by known fields or HTTP / Command
/ Path, with a masked *What it sends* and host guards (C118); secrets filled at
egress, never seen by a model (C116); the permissions table is where a
connection is **granted** and the Connections pane is where it is **defined**
(screen 7 §10, C58).

**D11 — where a per-tool grant lives.** Settled by the design as two facts in two
places, which is what #258 §6.8(2) asked: **the tool's mode** (On · Ask · Off) is
a property of the connection, in its file; **which agents may reach the
connection** is a line in each agent's own grants, where that role's grants
already live (the registry for connected agents, the `scope:` of a crew's
definition, the project for members). Rejected: #258 §4.8's `scope.crews` on the
connection — a second place to answer *who may use this*, which C58 and D11 both
rule out.

**Internal noun: `connection`.** The code follows C114 — `type: connection`
manifests, `.metistry/connections/`, `metistry connections`,
`runs.kind = connection_call`. #258 §4.1 chose `connector` to avoid the outbound
`metistry connect` and the old Settings pane; the pane is renamed Account (C86),
and C114 joined resources, targets and sources into this one word, so a
different code word would re-split what the ruling joined. `metistry connect`
stays a verb about agents connecting in.

**Build, in #258's three phases, re-cut for the final design:**

- **P1 (A-36) — read-only.** Manifest schema; a pooled stdio/HTTP MCP client under
  the supervisor behind the egress allowlist; tools `on | off` for Reads only; a
  **lazy pair** on `/mcp` (`connections_list`, `connections_call`) — eager
  namespacing would put `mcp-brain` 3,244–3,964 tokens past a 776-token headroom
  (#258 §4.6), and the pair moves `COUNT_ACKNOWLEDGED` from 26 to 28, an owner
  decision; `runs` rows; `check()` into doctor; the CLI; the read routes.
- **P2 (A-37) — Ask.** Preview-then-confirm on the connection path; the
  `connection_call` action kind (owner ruling); C59's defer-and-report with an
  `interactive` bit carried in `_meta` beside `turn_id`; per-tool rate limits
  counted from `runs`; response redaction; misuse tests.
- **P3 (A-38) — the rest of the noun.** HTTP with auth shortcuts and OAuth;
  generated tools for API, Feed and Files; **targets become Agent-type
  connections** (Devin, local crews) behind an adapter so dispatch is unchanged;
  **collectors become syncs** bound to a connection and its secret.

**The GitHub write credential** (C107) is a connection of type API with its own
secret, used only by the PR review doors; the `github-state` sync keeps its
read-only PAT.

### (e) The Capture Bar

**Two pieces**, as #253 proposed and screen 11 drew: a Swift TCC bridge
`packages/mcp-live-capture` (`runs_on: host`, `transport: http`,
`degrades: absent`, **no `exposes:` entry that starts a session** — invariant 9
by absence), and the bar, a non-activating `NSPanel` in `apps/macos`.

**Phase A, audio only, needs:**

1. **The manifest TCC enum** (`packages/core/src/manifest.ts:30–36`) gains
   `microphone` and `audio_capture`; `screen_recording` joins only when the screen
   act is scheduled. `full_disk_access` is already there. A closed set CI
   enforces, so this is the owner's nod.
2. The helper: a Core Audio **process tap** scoped by bundle id, microphone
   capture, `SpeechTranscriber` on macOS 26 (whisper.cpp below, +3–4 days and a
   binary to maintain — #253 §2.5), a transcript written as it goes, and C137's
   lifecycle — reminders every two hours, stop at ten, warn at 10 GB free and stop
   at 5 GB, sleep pauses and marks the gap, a crash saves up to the crash and
   raises one report.
3. Stable signing and `NS*UsageDescription` keys, copied from `ek-helper`
   (owner-hand: the Developer ID).
4. The end of a meeting: transcript → `POST /capture` with an `Idempotency-Key`;
   the meeting proposal group (C81) with notes, to-dos and the transcript; jots
   rewritten from (session id, offset) to the note's path on Approve (C77).
5. The **`private` compute tier** (#253 open (e)): while a session runs the bar's
   Ask resolves only to an `on_machine` provider, refused at
   `metistry compute assign` — enforced at the verb.
6. Misuse tests: a tap scoped to app X yields no audio from app Y; the hard stop
   fires; nothing reaches the vault without an Approve; the bridge refuses a
   start from any credential but the owner's.

**The screen act** (C76) is `SCStreamConfiguration.capturesAudio` +
`captureMicrophone` on macOS 15 (a second session below), one filter-construction
path in the helper, and the display glyph on the rail whenever a picture is
taken. Its order against audio-only is the owner's (§4 Q6).

**The bar itself** (C-15): the rail (Ask · Note · To-do · Record), glass at the
measured floors (0.86 under text, 0.75 under marks, no tertiary ink), the one
breath, Note and To-do as `POST /capture` with a timestamp, Ask as the tail of
the same thread (`GET /api/messages?thread=default`) at 328px with *Open in
Chat*, Record's sheet (Screen · Window · Audio only; two toggles).

### (f) Needs You — the hub

**Which rows it shows.** Every `proposals` row with `decision = 'pending'` and
`snoozed_until` in the past or null — exactly today's queue. **The sidebar row's
query** is `pending_count` (`SELECT count(*), min(ts) … WHERE decision =
'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())`), polled on the
Mac through the console session (§2i) and pushed as the Dock badge. The row
appears when the count is above zero and leaves **on the next navigation** after
it reaches zero — a client rule, never while the owner is on it.

**One type table in core** (P0-8), read by the console, `pending_requests`, the
morning brief and both clients, replacing the two copies of the kind → word
mapping that exist today:

| UI type | Stored kind | Body | Primary | Revise | Decline | Built |
| --- | --- | --- | --- | --- | --- | --- |
| question | `decision` (v2 shape) | choices | Send Answers → per-question answers | `accept_with_changes` + text | `deny` | A-11 |
| pull request | `pull_request` *(new)* | diff · thread | Approve / Reply → PR door | Request Changes → PR door (text required) | — | A-39 |
| access | `access_request`, `grant_elevation`, credential failure *(new source)* | before and after | `allow` | `accept_with_changes {area}` (narrower only) | `deny` | exists; A-9, A-22 |
| action | `action` (+ `connection_call` in P2) | preview (the payload, shown) | `allow` | `accept_with_changes` | `deny` | exists |
| meeting | `group_id` over note + to-do + transcript rows | to-dos | Accept All = one `allow` per row, in order | `accept_with_changes` | Decline All = one `deny` per row, after a 10 s client-held Undo | A-10, C-15 |
| review | `review`; knowledge conflict *(new)* | before and after · preview | `allow` / Keep Mine | Take the Other | `deny` | exists; A-22, A-23 |
| note | `knowledge`, `draft_settle` | preview | `allow` | `accept_with_changes` | `deny` | exists |
| improvement | `improvement` (+ routine suggestions) | before and after | `allow` | `accept_with_changes` | `deny` | exists; B-8 |
| report | `report`; failed routine *(new)* | excerpt | its act (Try Again, Reconnect) | — | Dismiss → `skip` | exists; A-22 |
| invitation | `invitation` *(new, calendar sync)* | preview | Accept | Maybe | Decline | **blocked** (K16) |
| task | `task` *(new, tracker sync)* | excerpt | Add to Today | — | Delegate | **blocked** on a tracker sync |
| message | `message` *(new, Metis from Mail)* | excerpt + reason | Draft Reply | — | Not Mine → `skip` | **blocked** on the Mail bridge (K17) |

**The four-or-six answer reconciliation**, as one table (P0-4 writes it into
`docs/ops/reply-feedback.md`):

| The owner presses | Wire | Where |
| --- | --- | --- |
| Approve | `allow`, or `accept_as_work` when `payload.suggested_work` is present | every card |
| Revise | `accept_with_changes` + `feedback` (access: + `area`, narrower only) | every card |
| Decline | `deny` — **always**, with its per-kind consequences | every card |
| Later | `snoozed_until` | every card |
| Skip | `deny` + `SKIP_FEEDBACK` | bulk list only (≤ 100, "on this page") |
| an option / *Something else…* | the option, or `other` + text | questions |
| (source cleared it) | `resolved_at_source` | mirrors only; never an owner verb |
| (14 days pass) | `expired` | rows without a `source` |

**Deadlines** are not ratified — see §2b. **Stale requests** (amendments §9): a
request whose subject changed while open returns `409 stale` and sends nothing —
generalised from `if_unchanged` to a subject fingerprint per type (PR head SHA,
task line text, work row `updated_at`) in B-7.

### (g) Usage and the gauge — the System button

**What exists:** `spend` (`seed/queries/spend.yaml` — day, provider, model, tier,
crew; `cache_ttl: 0`, the same query the engine's guard reads), `cache_report`,
`claude_usage_daily`, `aws_costs_daily`, and `GET /api/compute`'s budgets — all
reachable today, the first four through the generic door. **Enforcement exists**
(G9). **What is missing:** `spend_by_actor` for *Where it went*, the gauge's
three states computed from budgets and `spend` in the client, and the stale
copy (K14). **`route-report`** (`seed/queries/route_report.yaml`,
`metistry compute route-report`) is not in the final design — the owner's
"run metrics" reduced to the cache rate line; it stays a CLI verb. **Raise**
opens Settings ▸ Compute ▸ Spending limits (C138), which also lists each
project's daily budget (screen 18 §5; `PUT /api/projects/:slug` exists).

### (h) Settings panes

| Pane | Sections | Door that exists | Missing |
| --- | --- | --- | --- |
| **Instance** | The Assistant; This instance; Recent (8); Linked instances | `metistry identity` (read), `metistry instances list\|add\|remove\|refresh`, `GET /api/identity`, `GET /api/instances` | `metistry identity set --name --mention --mark`; a `config_write` row so it shows in Activity (A-29) |
| **Services** | Doctor (problem → fix); supervisor (Restart All, Stop All); per service state · uptime · port · Restart · Stop · Log; When it runs (Start at Login, Background, Keep Awake) | `metistry doctor --json`, `restart\|stop\|start\|logs`, `down`, supervisor status over its socket, `deployment set-keep-awake`, login item | an `action` per doctor problem; `uptime`; the keep-awake object (A-30, A-31) |
| **Compute** | Metis uses · Providers · Your Models · Spending limits | `/api/compute`, `/models`, `/assign`, `/budget`, `/providers/test`; `metistry compute …` | provider `enabled` and `billing`; secret-reference keys; catalogue search grouped by model (C131) with Refresh; disk bar (A-32, A-33) |
| **Updates** | This app; Metistry runtime (Update, What's New, Roll Back) | Sparkle (`apps/macos/sources/app/updater.swift`); `metistry update [--rollback]`, `metistry version --json` | *What's New* from the release notes; UI |
| **Account** | Console sign-in; instance repository; devices, Sign Out Everywhere | `console whoami`, `connect-repo`, `GET /api/devices`, device revoke | UI rename |
| **Connections** | list · detail · add (known / HTTP / Command / Path) · tools · offer · used by | — | all of §2d |
| **Secrets** | list; value (Replace); Sent only to; Who may use it | `metistry secrets list\|mint\|sync\|purge` | `secrets.yaml`, per-instance scope, `set\|replace\|remove\|hosts\|grant` (A-34) |
| **Variables** | name · value · used in | — | A-35 |
| **Live Capture** | the bar switch, placement, permissions read-through, what is kept, Purge | — | C-15 |
| **Sessions** | keep 30 days, *Let Metis learn*, Purge Now (count) | — | A-24 |
| **Keyboard** | *Shortcuts in any app* (off) + five recorders | — | C-16 |
| **Advanced** | Runtime from (Releases · Git), command, product folder, developer override, versions, diagnostics (logs, passkeys) | exists in today's Advanced tab | moves Doctor out |

**C62, resizability:** closed by the design — fixed **840 × 600**, a 200px sidebar
and a 640px pane, every pane in a vertical `ScrollView`; `settings-view.swift:47`
changes from `640 × 520` and `TabView` becomes a `NavigationSplitView` sidebar.
Acceptance: every pane at the largest macOS text size grows longer and never
wider.

**PWA Settings** (screen 18: "a grouped list") — this plan scopes the phone to
**read** every pane it shows, and **write** only what already has a console door:
Compute budgets and project budgets, Account devices. Confirm (§4 Q8).

### (i) MetistryKit — the store, per screen

**The transport first.** Every authenticated call is one `metistry console call`
process (`console-api.swift:1–48`): a Node start and a Keychain lookup per
request — unmeasured here, but hundreds of milliseconds is the right order. The
PWA polls Chat at 1–2.5 s and Activity and Board at 10 s (`app.js:153–179,
1540–1545`); a Mac app that spawns a process per poll per view will not hold
that. **P0-7 adds `metistry console session --stdio`**: one long-lived CLI child
speaking newline-delimited JSON requests and responses, so the owner token still
never enters the app's process — the property the app is built on — and
`ConsoleCallTransport` gets a second implementation behind the same seam.
Rejected: a URLSession client holding the token — it breaks the documented rule
and the source-scan test. **P0-6** makes `console call --json` print the error
body on ≥ 400, which the 409 stale repaint and the Tick door need
(`console-api.swift:33–40` names this gap).

| Screen | `ConsoleAPI` methods that exist | To add |
| --- | --- | --- |
| Shell | `identity()`, `whoami()`, `commands()` | `needsYouCount()` |
| Needs You | `requests(limit:since:)`, `answer(…)`, `answerMany(…)` | question v2 answers; `prReview(…)`, `prReply(…)`, `prResolve(…)`; conflict body decoding |
| Today | `knowledgePage(path:)` | `today(date:)`, `vaultTasks(where:)`, `checkTask(…)`, `scheduleTask(…)`, `setDayOrder(…)`, `closeDay(…)`, `meetingNote(eventId:)`, `moveEvent(preview:/confirm:)` |
| Chat | `commands()`, `compute()` | `messages(limit:since:)`, `send(text:thread:tier:)`, `feedback(…)`, `proseFeedback(…)`, `turnProgress(…)` |
| Activity | `activityFeed(…)`, `run(_:)` | — (fields only) |
| Knowledge | `knowledgeSearch`, `knowledgePage`, `knowledgePages`, `knowledgeLinks` | `knowledgeFold(date:)`, `knowledgeDrafts()`, `knowledgeAreas()`, `resolveConflict(…)`, `collectorHealth()` |
| Agents | `agents()`, `agentPresence(limit:)`, `setAutonomy`, `approveAgent` | `setGrants`, `revoke`, `rotate`, `agentDefinition(id:)` (read); the write is a CLI verb |
| Scheduled | — | `scheduled()`, `routine(name:)`, `updateRoutine`, `resetRoutine`, `runRoutine`, `updateSync`, `runSync` |
| Board · Card | `board`, `updateTask`, `claimTask`, `releaseTask`, `renewTask`, `dispatchTask`, `rooms` | `roomThread`, `roomPost`, `roomResolve` (routes exist); `description` on `TaskPatch` |
| Projects | — | `projects()`, `updateProject(…)` (routes exist) |
| Artifacts | — | `artifacts()`, `artifact(id:)`, versions, file, diff, comments, resolve (routes exist) |
| Run detail | `run(_:)` | `session(id:)` |
| Usage | `compute()` | `namedQuery(_:params:)` for `spend`, `spend_by_actor`, `cache_report`, `aws_costs_daily` |
| Capture | transport supports `Idempotency-Key` | `capture(note:attachments:idempotencyKey:)` |
| Settings | `compute()`, `assignCompute`, `setComputeBudget`, `testComputeProvider` | CLI-runner wrappers for identity, instances, doctor, services, keep-awake, update, secrets, variables, connections, agents define |

### (j) The PWA — screen 18

**Renav to the same IA:** a bottom tab bar Today · Chat · Work · Knowledge ·
More, + and the bell in the header (the phone keeps the bell, C110), sheets for
the bell, Capture, Usage and threads; pushes for cards, rooms, agents and More
rows; at 900px the Mac layout (the breakpoint exists, `style.css:131`). Work's
children are a segmented control; no Rooms tab. Glyphs replace the emoji
(`style.css:119–128`).

**What `app.js` must stop recomputing:** the effective actions table —
`ACTION_KINDS`, `LEVEL_CEILING`, `ACTION_DEFAULTS` and `effectiveActions()` are
re-implemented at `app.js:752–770` and used at `:818` and `:893`; read
`scope.autonomy.detailed` from `GET /api/agents` instead (#259 exists to end
exactly this). Also: collapse of `degraded`/`absent` into `failed` (`:433`, C10);
`work_history` in the title-case allow-list (`:1446`, C18); `color-mix()`
literals instead of quiet-fill tokens (C6); the request type words (from the core
table, P0-8).

**Offline:** `sw.js` gains an offline shell and an **outbox** for captures and
ticks — replayed with `Idempotency-Key` and the Tick door's 409; answering,
moving, Run Now and grants are not offered offline; Chat send is refused with the
reason; one band says *Can't reach Metistry*.

**Install and push:** `manifest.webmanifest` `name: "Metistry"`, colours per
scheme from tokens, PNG icons and a 180px `apple-touch-icon` (C13); enrollment
and push flows without `window.alert`; ask for notifications the first time
something reaches Needs You.

### (k) Accessibility — build acceptance criteria (C119–C122)

Every Mac view ticket in Phase C is accepted only when all of these hold:

1. **Every shortcut is a menu item** — Go (⌘0 Needs You while shown, ⌘1 Today …
   ⌘7 Scheduled, ⌘[ ⌘], ⌘K, ⌘F), Capture (⌘N and the any-app five), Item
   (follows the selection: ↩, ⌘O, A R D L, Space, M, ⇧⌘P, ⌘R, ⌥⌘P), View
   (⌥⌘T, ⌃⌘S), Help ▸ Keyboard Shortcuts ⌘/. `.keyboardShortcut` on
   `CommandMenu`s; single-letter keys only while a list has focus; ⌘9 unbound;
   New Conversation ⇧⌘N.
2. **Shortcuts in any app** register nothing until switched on and every row is
   clear; a taken shortcut surfaces `eventHotKeyExistsErr`; a system one is read
   from the symbolic-hotkeys domain.
3. **The screen's Spoken table** (components-02 §3 and each spec) is implemented
   verbatim: glyph-only controls speak their name (and shortcut when set);
   meaningful marks speak in their row's label; charts speak one sentence with a
   rotor table; the badge announces a change once; landmarks are sidebar, list,
   detail, and the capture bar; each detail section is a heading.
4. **Reduce Motion:** stepped questions cross-fade; the Needs You row appears
   without sliding; the waiting dots hold flat; the recording mark holds still.
5. **Largest macOS text size:** no pane clips; Settings panes grow longer, never
   wider.
6. **Full Keyboard Access:** the accent focus ring (3px, 50 %) on every custom
   control.
7. **An automated check** per view: a SwiftUI accessibility snapshot test that
   fails on an unlabeled button, so the six-label state of today cannot recur.

The PWA adds **no** shortcuts (C119) and keeps the browser's text size and
`:focus-visible`.

### (l) The token pipeline, and what merging #263 does

**Trial merge**, run on 2026-09-25 in a scratch worktree: `origin/main`
(`1d9aefb`) + `origin/design/round-0-plan-review` (`6f7a142`) — **automatic, no
conflicts**, 106 files.

| Check (CI's own commands) | Result |
| --- | --- |
| `ops/scripts/check-path-case.sh` | `path-case: ok` (exit 0) |
| `node ops/scripts/prompt-lint.mjs` | exit 0 |
| `node ops/scripts/audit-limits.mjs` | exit 0 |
| `node ops/scripts/fold-product-record.mjs --check` | `3 fragment(s), all well-formed` |
| `node --test 'ops/scripts/test/*.test.mjs'` | 51 pass, 0 fail |
| `node ops/scripts/build-design-tokens.mjs --check` (the branch's script) | `design tokens: ok (144 pairs checked)` |
| **main's** `build-design-tokens.mjs --check` on the branch's `tokens.json` | **exit 1** — 11 pairs below the minimum: `border-control` on `bg` 3.29/3.80, `surface` 3.55/3.46, `elevated` 3.55/**3.00**, `sunken` **3.01**/3.91 (light/dark); `chart-1` on `surface` dark 3.20; `chart-4` light 3.93; `chart-5` light 3.21 |
| `swift build --package-path apps/macos` | `Build complete!` |
| `swift test --package-path apps/macos` | 232 tests in 2 suites passed |

Not run: `pnpm typecheck`, `pnpm test` and the migration step — the branch
touches no TypeScript, SQL or seed, and the one test that reads a changed
artifact (`apps/console/test/pwa.integration.test.ts:65`) asserts
`--mt-color-bg`, which the regenerated `tokens.css` still defines.

**The checker change.** The branch passes CI *because* it moves `border-control`
and `chart-1…5` into `NON_TEXT` (3:1, WCAG 1.4.11) from the 4.5:1 text bar. The
judgement is sound — an outline and a chart mark are non-text graphics — but it
is a CI gate change arriving in a design branch; it wants its own commit message
line when #263 merges, and it leaves **two zero-margin pairs**:
`border-control` on dark `elevated` at exactly 3.00:1 and on light `sunken` at
3.01:1. Anything that moves either token needs a full re-check.

**What merging #263 changes in the shipping apps.** tokens 1.1.0 → **2.6.2**;
**28 roles added, 0 removed**, so every call site in `style.css` and
`design-tokens.swift` still compiles and renders; **18 values repointed** — light
mode goes from cool grey to warm paper (`bg` `#f6f7f9` → `#f7f4ee`, `surface`
`#ffffff` → `#fffdf8`, the text inks warm), and the **accent goes from blue to
teal** (`#2b5fd0` → `#125f6b` light, `#7ea9ff` → `#6ec9d6` dark), which moves
`focus-ring` with it. Dark grounds are unchanged. So the PWA and the Mac app
change colour on their next build, and three hardcoded values fall out of step
until P0-2: `manifest.webmanifest` and `index.html` still carry `#f6f7f9` as
theme colour, and `apps/console/web/icon.svg` is still the old dark-mode pair.
Two roles land unused: `affirmative`/`on-affirmative` (C92 retired the green
Approve) — keep or drop in P0-3.

**Not in #263 though ratified:** decision 19's `--check` extension (painted
grounds; every SVG hex is a token) and decision 16's `ICON_PNG` — both P0.

---

## 3. Build plan

**Effort key** (agent-days of focused work including tests and review fixes; by
analogy, ±30 %): **S** ≤ 1 · **M** 2–3 · **L** 4–6 · **XL** 8–12. Totals use
1 / 2.5 / 5 / 10. **Who:** *Agent* — buildable by an agent once its
dependencies land; *Owner: …* — needs a ruling or the owner's hand first.

### 3.1 Phase 0 — land the design and unblock everything (≈ 12.5)

| ID | Title | Files | Tests (misuse in bold) | Size | Deps | Who |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | Merge #263 | 106 files | CI green (trial, §2l); the merge message names the `NON_TEXT` change | S | — | Owner (merge, per the 09-22 ruling) |
| P0-2 | PWA manifest name, colours per scheme, PNG + 180px `apple-touch-icon`, brand `icon.svg`; `ICON_PNG` in `build-app.sh` | `apps/console/web/{manifest.webmanifest,index.html,icon.svg}`, `ops/release/build-app.sh` | pwa integration asserts name, colours, PNG | S | P0-1 | Agent |
| P0-3 | Decision 19's `--check` extension: painted-ground pairs, every design SVG hex is a token; `accent` never mapped to `controlAccentColor`; `affirmative` kept or dropped | `ops/scripts/build-design-tokens.mjs`, `tokens.json`, tests | script tests with a stray hex and an undeclared painted pair | M | P0-1 | Agent |
| P0-4 | Answer-set reconciliation in `docs/ops/reply-feedback.md`; glossary fixes (K2, K19) | docs | — | S | P0-1 | Agent; owner nod on Decline (§4 Q10) |
| P0-5 | Stale "not enforced" copy (K14) | `compute-model.swift:451`, `compute-facts.swift:191`, `packages/cli/src/main.ts` | snapshot of the new copy | S | — | Agent |
| P0-6 | `console call --json` prints the error body on ≥ 400 | `packages/cli/src/main.ts`, `console-api.swift` | CLI prints `reason`/`proposal` on 409; Swift decodes it | S | — | Agent |
| P0-7 | `metistry console session --stdio` + a MetistryKit transport over it; measure `console call` first | `packages/cli/src/console-client.ts`, `apps/macos/sources/kit/console-api.swift` | **refuses a non-loopback console; never prints the token; responses matched by id; the Swift source scan still passes** | M | P0-6 | Agent |
| P0-8 | The request type table in core (kind → type, body, primary, decisions); `pending_requests` and `morning-brief` read it; `action` reads action (C80) | `packages/core/src/requests.ts`, `seed/queries/pending_requests.yaml`, `routines/morning-brief/run.ts` | every stored kind maps; an unknown kind renders `excerpt` | M | P0-1 | Agent |

### 3.2 Phase A — data, queries and doors, no views (≈ 146)

*Core* rows feed M1; *platform* rows can run in parallel.

| ID | Title | Files | Tests (misuse in bold) | Size | Deps | Who |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | `work.description` (0026) through `TasksService`, tasks tools | `db/migrations`, `packages/tasks`, `packages/mcp-brain` | migration twice; **an agent may set it on create and never edit it** | M | — | Agent |
| A-2 | `board`: blocked-by (port from `day_work`), `thread_count`, five columns, labels; `docs/ops/board.md` | `seed/queries/board.yaml`, `console-data.swift:585–593`, `app.js` | seed-query test for the five columns | M | — | Agent |
| A-3 | `activity_feed`: `ok`, `routine` group, `turn_id`, `config_write`; drop `work_history` from the allow-list | `seed/queries/activity_feed.yaml`, `app.js:1446` | a silent tick has no row | M | A-4 | Agent |
| A-4 | `meta.outcome` in every routine and the runner (D7) | `routines/*`, `apps/console/src/runner.ts` | three outcomes recorded | S | — | Agent |
| A-5 | `collector_health` (two timestamps, streak) | `seed/queries` | a failing sync shows last-ok and last-error | S | — | Agent |
| A-6 | Knowledge reads: fold, drafts (owner-only), areas + routes | `seed/queries`, `knowledge-routes.ts` | **drafts never reachable at the generic door or `/mcp`** | M | — | Agent |
| A-7 | Captures from the apps carry `source: app` | `server.ts:576` | an agent bearer still records its own source | S | — | Agent |
| A-8 | `pending_count` + `GET /api/needs-you/count` | `seed/queries`, `server.ts` | the four route cases | S | — | Agent |
| A-9 | Access hardening: C40 refuse widening, C41 prior tier, C42 ceiling row | `server.ts:1380–1400`, `agents.ts:616`, `packages/mcp-brain/src/access.ts` | **a Revise naming a wider or sibling area is refused and nothing is written** | M | — | Agent |
| A-10 | 0027 group and source; `resolved_at_source`; mirrors exempt from the 14-day expiry | `db/migrations`, `routines/morning-brief/run.ts:251` | dedupe on `external_ref`; a mirror is not expired | M | P0-8 | Agent |
| A-11 | Questions v2: decision block v2 (hand-rolled, bounded), `requests_create` kind `question` for agents (no new tool — the brain stays at 26), per-question answers, Revise on questions; `decided` alias if C104 is ruled | `packages/core/src/decision-block.ts`, `packages/mcp-brain/src/report.ts`, `server.ts` | **an answer outside the options without `other` is refused; free text never executes; the tool-surface budget holds** | L | P0-8 | Agent |
| A-12 | Tick door (C98, C99) | `server.ts` (+ a vault-task route module), `packages/core/src/task-line.ts`, `seed/queries` | **byte-diff: only the two tokens change; 409 on a changed line; agent and capture tokens refused** | M | P0-6 | Agent |
| A-13 | Defer door, `do <date>` and a `someday` token (K6) | same + `task-filter.ts` | 409; round-trips through the parser | M | A-12 | Agent |
| A-14 | Reconciler section operation (C102) | `apps/reconciler/src/{server,paths,vault}.ts` | **bytes outside the markers are identical after every write; two marker pairs, one marker, or a marker inside a code block → `section_missing`; a non-user principal cannot write the note any other way** | L | — | Agent |
| A-15 | `GET /api/today`, `GET /api/vault-tasks`, `today_order` (0028) + order door | `server.ts`, `seed/queries`, `db/migrations` | order keys limited to the day's tasks | L | A-12 | Agent |
| A-16 | Calendar fields (attendee email and status, organizer, owner-only notes, series), `people_emails` and `vault_meeting_refs` (0029), meeting-note door (A2) | `packages/mcp-eventkit/helper/ek-helper.swift`, `apps/reconciler`, `server.ts` | **notes never reach an agent**; unmatched attendees render as names | L | — | Agent; Owner: re-sign `ek-helper` |
| A-17 | `move_event` with an attendee preview; the move door (C90) | `packages/mcp-eventkit`, `server.ts` | **a confirm without the owner token is refused for events with other attendees** | M | A-16 | Agent; Owner: re-sign |
| A-18 | `scheduled.yaml` schema; `display_name` (C55); collector `needs_you:` rules; the time-of-day scheduler; `CALLER_AUTHORITY` + one path | `packages/core/src/{schedule,manifest}.ts`, `apps/console/src/runner.ts`, `apps/reconciler/src/paths.ts` | DST and TZ cases; **the console still cannot write any other protected path** | L | — | Agent |
| A-19 | Scheduled routes and doors (read, edit, reset, run; syncs) | `server.ts`, `seed/queries/routine_history.yaml` | the four route cases; **a product manifest is never written** | M | A-18 | Agent |
| A-20a | `standup` default routine (skeleton + one turn) | `routines/standup/`, `seed/vault/Templates/Standup.md` | writes nothing without working days | M | A-18 | Agent |
| A-20b | Morning Brief rewrite: `Journal/Brief/<date>.md` with Next Up lines (one turn), the model-free daily-note section, `Journal/Brief` in `JOURNAL_MACHINE_DIRS`, prose legal in Brief and Standup (C103) | `routines/morning-brief/`, `packages/core/src/instance-layout.ts`, template gate | **no generated text is written between the markers** | L | A-14, A-20a | Agent |
| A-20c | `plan-tomorrow` close trigger and the 7 PM default | `routines/plan-tomorrow/` | a second close re-renders | S | A-18 | Agent |
| A-21 | Close the Day door | `server.ts` | markers missing → a `note` request and no write | M | A-14, A-13 | Agent |
| A-22 | Events → requests: failed routine (report, two timestamps), failed secret (one access request naming dependents), knowledge conflict (review), three strikes (C135) | `apps/console/src/runner.ts`, `apps/reconciler/src/indexer.ts` | one request per signature, deduped | M | A-10 | Agent |
| A-23 | Conflict resolve door | `server.ts`, reconciler | **cannot name a path not in `conflict`** | M | A-22 | Agent |
| A-24 | Session archive (0030), retention, `GET /api/sessions/:id` | `apps/assistant`, `db/migrations` | **tool arguments and results redacted with `core/redact.ts`; expired rows unreadable** | L | — | Agent |
| A-25 | Session fold (C79): proposals for lessons, preferences, profile facts; Approve writes `Me/` as `user` | `routines/session-fold/` | **nothing reaches `Me/` without an Approve** | L | A-24 | Agent; Owner: review the fold prompt |
| A-26 | `prose_feedback` (0031) and prose ids | `db/migrations`, `server.ts`, routines | unknown id refused | M | A-20b | Agent |
| A-27 | `describePermissions()`; definition read route; `metistry agents define`; `model:` as a provider/model ref | `packages/core/src/access.ts`, `packages/cli`, `crews.ts` | **Knowledge Write never appears for a non-assistant role; `null` vs `[]` render differently** | L | — | Agent |
| A-28 | Project grants (0032), inherited with *via project* provenance | `db/migrations`, `projects.ts`, `access.ts` | **a member's effective reach = own ∪ project; revoking the project removes it** | M | A-27 | Agent |
| A-29 | `metistry identity set`; reconciler `config_write` rows on every protected write | `packages/cli/src/identity.ts`, `apps/reconciler` | invalid identity refused | M | — | Agent |
| A-30 | `keep_awake` object form + the legacy four; lid-closed honesty (K10) | `packages/core/src/{deployment,power}.ts`, CLI | old values still load | M | — | Agent; Owner: K10 |
| A-31 | Doctor `action` per problem; supervisor uptime | `packages/cli/src/doctor.ts`, `apps/watchdog` | — | S | — | Agent |
| A-32 | Compute: `enabled`, `billing`, `seed/model-identities.yaml`, catalogue search with Refresh | `packages/core/src/compute.ts`, `packages/cli/src/compute.ts`, `compute-routes.ts` | unmapped ids stay separate rows | L | — | Agent; Owner: K12 |
| A-33 | Spending limits: project budgets in the pane's data, subscription windows | `compute-routes.ts`, `packages/core/src/budget.ts` | — | M | A-32 | Agent |
| A-34 | Secrets v2: `secrets.yaml`, `{{ secret.x }}` with host checks at egress and redaction back, per-instance scope with a one-time copy, CLI | `packages/cli/src/secrets.ts`, `packages/core/src/{egress,redact}.ts`, manifests | **a secret bound for an unlisted host is blocked; a secret in a URL is flagged; a model never receives a value** | XL | — | Agent; Owner: K7 |
| A-35 | Variables | `packages/core`, CLI | a key-shaped value is refused as a variable | M | — | Agent; Owner: K8 |
| A-36 | Connections P1 (read-only, lazy pair) | `packages/connections` (new), `packages/mcp-brain`, CLI, routes | **an unlisted tool is refused before dialling; the agent's bearer is never forwarded** | XL | A-34 | Agent; Owner: 26 → 28 tools |
| A-37 | Connections P2 (Ask, `connection_call`, defer-and-report) | `packages/core/src/actions.ts`, console | **an approved call runs the server-built payload, never the client's** | L | A-36 | Owner: §4.7 ruling |
| A-38 | Connections P3 (HTTP/OAuth, generated tools, targets and syncs as connections) | many | OAuth flow cannot be started by the assistant | XL | A-37 | Agent |
| A-39 | GitHub PR requests and review doors (C106–C108) | `collectors/github-state`, `server.ts` | **refused without the head SHA shown; no agent reaches the write client** | L | A-10, A-34 | Agent; Owner: a write PAT |

### 3.3 Phase B — behaviour rules (≈ 17)

**Stalls and request deadlines from #262 are not in this phase**: the owner's
answers do not ratify them (its Q1 and Q3 are open, §4).

| ID | Title | Files | Tests (misuse in bold) | Size | Deps | Who |
| --- | --- | --- | --- | --- | --- | --- |
| B-1 | C45 as a rule | `apps/console/test/*`; a note proposed for `design-system.md` (the owner's file) | **per consequential door: a refusal leaves the row pending with `payload.error`, nothing half-applied** | M | Phase A doors | Agent |
| B-2 | C59 defer-and-report for unattended runs (proposed actions, later connection calls) | `packages/mcp-brain`, `apps/assistant`, routines | **an unattended Ask never blocks and never runs; the run's output names what it skipped** | M | A-37 | Agent |
| B-3 | Mirrors clear with their source; one subject, one card | collectors, `server.ts` | a source change resolves the mirror with a receipt | M | A-10, A-39 | Agent |
| B-4 | Three strikes raise one request and stop | `apps/console/src/runner.ts` | one request per signature per window | S | A-22 | Agent |
| B-5 | A Stop limit pauses routines and raises one request | `apps/console/src/main.ts`, `apps/assistant/src/budgets.ts` | a paused routine says why | S | — | Agent |
| B-6 | A failed secret raises one request naming everything it stopped | `packages/cli/src/secrets.ts`, runner | one request, not one per dependent | M | A-34 | Agent |
| B-7 | Stale requests: a subject fingerprint per type → `409 stale`, nothing sent | `server.ts`, `packages/core/src/requests.ts` | **a PR whose head moved, a task line edited, a work row moved: each refused, nothing sent** | M | A-10 | Agent |
| B-8 | Routine improvement proposals; Approve writes the overlay | the `reply-review` pattern, `server.ts` | **nothing is written before Approve** | M | A-19 | Agent |

### 3.4 Phase C — views, Mac first, in dependency order (≈ 120)

Each ticket's tests are the §2k criteria, store tests against recorded fixtures
(`tests/kit/console-api-tests.swift`'s seam), and its screen's row of the state
table (components-03 §2). Views live in `apps/macos/sources/kit/` as
`<screen>-view.swift` beside a `<screen>-model.swift` store — the shape
`settings-view.swift` and `compute-view.swift` already use.

| ID | Title | Files | Tests beyond the standard set (misuse in bold) | Size | Deps | Who |
| --- | --- | --- | --- | --- | --- | --- |
| C-1 | Shell: sidebar (eight rows + the conditional Needs You row), toolbar (+, gauge), window title, `CommandMenu`s, the assistant name, first paint and stale band; shared components — agent prose, agent chip, facet row, permissions table, request body blocks, the four states | `root-view.swift`, `app-model.swift`, a new `components/` | the row leaves only on the next navigation after zero; no label says *assistant* | XL | P0-7, A-8 | Agent |
| C-2 | Needs You: list and detail, filters by type and From, the twelve types by body block, stepped questions, bulk list, partial-success band, 409 repaint, Accept All in order | `needs-you-view.swift`, `console-data.swift` | **bulk never offers Approve; decisions disabled while unreachable (O3)** | XL | C-1, A-10, A-11 | Agent |
| C-3 | Today: Morning Brief, Next Up, the spine and NOW, the day bar, ticking with receipt and Undo, Close the Day, All and Slipping with the `where:` box, drag order, calendar help with the move warning | `today-view.swift` | **a tick on a changed line shows the current line and writes nothing** | XL | C-1, A-15, A-20b, A-21 | Agent |
| C-4 | Chat: capped column, 2px rule, tool strip from `turn_progress`, waiting states, prompt cards v2, tier/model/effort picker, preview pane, New Conversation | `chat-view.swift` | the viewport never moves on an arriving reply (P9) | L | C-1 | Agent |
| C-5 | Activity: bands, eight chips, held-new pill, turn groups, routine rows | `activity-view.swift` | new rows are held, never inserted | M | C-1, A-3 | Agent |
| C-6 | Knowledge: the fold, Needs your eye, conflict resolve, Areas, the sources line, a page with its links | `knowledge-view.swift` | *freshness unknown* until `collector_health` answers | L | C-1, A-6, A-23 | Agent |
| C-7 | Agents: roster, local detail (definition editor, Esc keeps a draft, permissions, model dropdown, routines, runs), connected detail (ceiling, revoke cascade), New Agent chooser | `agents-view.swift` | **the internal principal never appears on the roster; a widening confirms with `autonomyWidenings`' own strings** | L | C-1, A-27 | Agent |
| C-8 | Scheduled: day-banded occurrences, the week axis, routine detail (schedule editor, task, reads and writes, history steps, Reset), syncs | `scheduled-view.swift` | a silent tick is not an occurrence row | L | C-1, A-19 | Agent |
| C-9a | Board and card detail: five columns, one route per drop, Has Thread, the popover for work rows and markdown tasks, description | `board-view.swift`, `card-detail-view.swift` | **no drop target the service would refuse** | L | C-1, A-2, A-1 | Agent |
| C-9b | Projects: list, detail, mode by weight or tint, confirmations | `projects-view.swift` | a chosen Review is never tinted | M | C-1 | Agent |
| C-10 | Artifacts and rooms: version rail, margin threads with collision layout, compare, the room pane over Board | `artifacts-view.swift` | a thread on a changed line stays on its version | L | C-1 | Agent |
| C-11 | Run detail: the conversation from the archive, the side column, what Metis took | `run-detail-view.swift` | an expired session still shows cost and tool calls (R2.7) | M | A-24 | Agent |
| C-12 | Settings window: re-cut (840 × 600, sidebar, scroll); Instance, Services, Updates, Account, Keyboard, Advanced (L); Compute (L); Connections (XL); Secrets and Variables (M); Live Capture and Sessions (M) | `settings-view.swift`, `settings-model.swift`, `compute-view.swift`, new panes | **a secret value is never rendered after save; a secret headed for an unlisted host blocks the preview** | 25 | A-29…A-36 | Agent |
| C-13 | Usage popover and gauge | `usage-view.swift` | no projection is drawn (P5) | M | C-1 | Agent |
| C-14 | Capture composer (+): drafts kept on Esc, key reuse, receipt, queued | `capture-view.swift` | **a retry reuses the key; a replay renders as the same capture** | M | C-1, A-7 | Agent |
| C-15 | Capture Bar: live-capture bridge phase A (XL) and the bar (L); the screen act (+L) when sequenced | `packages/mcp-live-capture/`, `capture-bar-panel.swift` | §2e's misuse tests | 20 (+5) | C-4, A-24 | Owner: C76 sequencing, macOS version, signing, a real meeting |
| C-16 | Any-app hot keys with conflict checks; the accessibility audit | `hotkeys.swift` | nothing registers while any row conflicts | M | C-1 | Agent |

### 3.5 Phase D — the PWA (≈ 26)

| ID | Title | Files | Tests (misuse in bold) | Size | Deps | Who |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | Shell: tab bar, header + and bell, sheets, 600–899px and ≥ 900px layouts, glyphs for emoji | `apps/console/web/{index.html,style.css,app.js}` | pwa integration: five tabs, no badge on a tab | L | Phase A reads | Agent |
| D-2 | Views to the IA: Today, Needs You sheet (select, swipe, stepped questions), Work segmented, Knowledge, More | `app.js`, split per view | **a card with Before and after cannot be swiped** | XL | D-1 | Agent |
| D-3 | Stop recomputing (§2j): `scope.autonomy.detailed`, four states, allow-list; then quiet fills, serif stack, 12-hour times | `app.js:433, 752–770, 1446`, `style.css` | the PWA and the CLI print the same effective table | M | P0-1 for the token half only | Agent — **the first half can start now** |
| D-4 | Offline shell and outbox (captures, ticks) | `apps/console/web/sw.js` | **answers, moves, Run Now and grants are never queued** | L | A-12 | Agent |
| D-5 | Push and enrollment without `alert()`; install sheet | `app.js` | a notification carries type and title only, never a secret | M | — | Agent |
| D-6 | Compute ▸ Budgets (instance and project) | `app.js` | — | S | A-33 | Agent |

### 3.6 Phase E — native iPhone

Deferred by the owner (review-01 R2.1; the PWA was reopened on 2026-09-24,
the native app was not). MetistryKit is already multiplatform in intent; a plan
is written when the owner reopens it. Not estimated.

### 3.7 Totals and the critical path

| Phase | Agent-days |
| --- | --- |
| 0 | 12.5 |
| A | 146 (core ≈ 73.5; platform ≈ 72.5 — A-16, A-17, A-24…A-26, A-28, A-32…A-39) |
| B | 17 |
| C | 120 (+5 if the screen act is scheduled) |
| D | 26 |
| **Total** | **≈ 322** (±30 %) |

**M1 — a Mac app the owner can live in:** P0 + A-2…A-15, A-18…A-23 + B-1, B-4,
B-5 + C-1…C-6, C-8, C-13, C-14 ≈ **130 agent-days**.

**Critical path, with parallel agents:** A-34 Secrets (10) → A-36 Connections P1
(10) → A-37 P2 (5, after the owner's §4.7 ruling) → A-38 P3 (10) → C-12's
Connections pane (10) ≈ **45 agent-days, plus however long the §4.7 ruling
takes**. Beside it: the Today chain, A-18 → A-20a → A-20b → A-21 (≈ 15) with
C-1 in parallel (≈ 14.5 after P0-7), then C-3 (10) — ≈ 25; and the Needs You
chain, P0-1 → P0-8 → A-10 → A-11 (≈ 11) meeting C-1, then C-2 (10) — ≈ 25.
**What can start before #263 merges:** P0-5, P0-6, P0-7, A-1, A-4, A-5, A-9,
A-12, A-14, A-24 and the first half of D-3 — none depends on a design word that
could still change.

---

## 4. What needs the owner

**Rulings still open after the answers.** C60 (Chat as a pane — do not build);
C76 (capture sequencing); C82 (Areas rename); C104 (`decided`); C28 (*partial*);
C87 (chart chroma); #253 (e) the `private` compute tier; #258 §4.7
(`connection_call`) and the tool count 26 → 28; #262 Q1 (does a stall ever act)
and Q3 (the stall and request-deadline numbers); K4 (a sentence in `CLAUDE.md`'s
bridge contract, which is the owner's file).

**Only the owner can:** merge #263 (or say who does); re-sign `ek-helper` and
sign the live-capture helper with the Developer ID; grant TCC on the Mac; mint a
GitHub write token for PR reviews; say which macOS the second-instance Mac runs
(it decides `SpeechTranscriber` vs whisper.cpp); record a real meeting to test
capture against; share the design canvas with whoever builds the views (boards
are private to the owner's account); approve moving `COUNT_ACKNOWLEDGED`.
**No new dependency is planned** — the scheduler is hand-rolled and the MCP
client half of `@modelcontextprotocol/sdk` is pre-approved.

**Open questions for the owner and the designer (ten):**

1. **Router tiers (K12).** C132 gives Metis one model. The router still picks
   tiers (`fast`, `deep`, `routine`, and the `intent` tier #257 just shipped).
   Keep tier assignments in `compute.yaml` behind an undrawn Advanced disclosure,
   or retire per-tier models?
2. **The lid (K10).** Keep *Allow sleep when the lid is closed* as a switch whose
   off state says it needs an administrator change, or remove it — given
   2026-09-19's "lid close must always sleep"?
3. **Secrets scope (K7).** Confirm per-instance only, knowing a second instance
   re-enters every provider key; or keep a *Shared on this Mac* group?
4. **Variables vs `Me/profile.md` (K8).** Are `standup_time` and `timezone`
   variables, or profile facts the Variables pane shows read-through?
5. **Ask on a connection (#258 §4.7).** Is `connection_call` a fifth action kind —
   the only way Approve can run an Ask call — and may `mcp-brain` go from 26 to 28
   tools for the lazy pair?
6. **Capture order (C76).** Audio only first (no screen grant, per-process scope)
   or Window + audio + microphone first (the meeting as the owner defined it)?
7. **Recording media (K11).** Is audio kept until the fold reads it (C137), or
   never kept (screen 11 §8)?
8. **The phone's Settings.** This plan makes PWA Settings read-only except
   budgets and devices. Which other panes must write from the phone?
9. **Invitations and Mail (K16, K17).** If EventKit cannot answer an invitation,
   is *Open in Calendar* acceptable until a calendar connection exists; and is
   *Draft Reply* a compose window the owner sends, rather than a draft written
   into Mail?
10. **Decline (K2).** Decline always sends `deny` with its consequences — an
    enrolment Decline revokes, typed reason or not. Confirm, and rule C104
    (`decided`) and C82 (Areas) while the request vocabulary is open.
