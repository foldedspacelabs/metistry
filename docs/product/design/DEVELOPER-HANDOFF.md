# Developer handoff — design round 0 (September 2026)

This is the build guide for everything the design round decided. It is a map, not a
replacement for the specs: each item names its ruling (C-number in
`review-00-plan.md`), the spec that details it, and the board that draws it.

**Branch:** `design/round-0-plan-review` (PR #263).
**Canvas:** the Metistry design canvas artifact (private to the owner; ask him to
share it). Every board is regenerated from `docs/product/design/boards/` —
`METISTRY_CANVAS=<dir> python3 build.py [board]`.

## 0. How to read the design

When two documents disagree, the later one in this list wins:

1. The ratified rows of `review-00-plan.md` (C1–C138) — each says *ruled*, *closed* or
   *open*.
2. `design-system-amendments.md` (rules added in rounds C–F).
3. The screen specs `screen-01` … `screen-19` and `components-01` … `components-03`.
4. `glossary.md`, then `design-system.md`, `design-brief.md`, `PRODUCT.md` (older; several
   of their words are superseded — see §3).

A superseded passage is either struck, bannered, or named in a later row. If a spec and a
board disagree, the spec wins; tell the designer.

## 1. What changed, in one page

| Area | Now | Rulings |
| --- | --- | --- |
| **Sidebar** | Needs You (only while something waits, with the one badge) · Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents · **Scheduled**, then Pinned. No toolbar bell on the Mac. | C57, C110, C113 |
| **Needs You** | A full list-and-detail view, not a panel. One request pattern (header · ask · context · body · answers) for twelve types, incl. **questions** (stepped, with free text) and **pull requests** (reviewed in Metistry, posted as the owner). A hub for Metis, agents and syncs. | C92, C96, C104–C110 |
| **Today** | One Morning Brief as the first state; ticking tasks in the app; Close the Day writes the vault, including a fenced section of the daily note. | C97–C103 |
| **Scheduled** | Two tabs: **Routines** (work Metis or an agent does; defaults tagged and resettable; Standup is its own routine) and **Syncs** (scheduled reads from one connection). Everything scheduled is visible and editable. | C111–C113 |
| **Connections** | One typed noun for anything outside Metistry — MCP server · Agent (A2A/ACP) · API · Feed · Files. Per-tool On · Ask · Off. Any connection can be offered to agents through Metistry's MCP proxy. Known services ask for named fields; custom ones for HTTP / Command / Path settings. | C114, C115, C118 |
| **Secrets & Variables** | Settings panes. Secrets: Keychain, per instance, `{{ secret.name }}`, sent only to listed hosts, never seen by a model. Variables: plain, `{{ variable.name }}`, usable in agent instructions. | C116, C117 |
| **Settings** | Instance (names the assistant, linked instances) · Services (Doctor first, per-service controls, keep-awake) · Compute · Updates (runtime update/rollback) · Account · Connections · Secrets · Variables · Live Capture · Sessions · Keyboard · Advanced. Fixed 840 × 600, panes scroll. | C62, C86, C123–C129 |
| **Compute** | One column: what Metis uses · Providers (one line each, switch, Test / gear / Remove) · Your Models (memory + disk, one search across providers, grouped by model with a line per place) · Spending limits (enforced). Agents pick their model in their definition. | C125, C128, C130–C133 |
| **Keyboard & VoiceOver** | Mac only; every shortcut is a menu item; shortcuts in any app off by default; a Spoken table per screen; Reduce Motion and largest text. | C119–C122, C127 |
| **States & flows** | First paint is the last data with a stale band; Undo for reversible acts, confirm naming the cost for irreversible ones; recording up to ten hours; no dead-end buttons. | C135–C138 |
| **PWA** | Tab bar, bell in the header, sheets; offline band and a rule per verb; no keyboard layer. | screen 18, C119 |

## 2. Build, by area

Each bullet is a thing to build or change. *Spec* and *board* point to the detail.

### 2.1 Navigation and shell
*Spec:* `design-system-amendments.md` (nav rule), `screen-03` §13.3. *Boards:* every Mac board.

- Sidebar in exactly this order: Needs You · Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents · Scheduled; then Pinned (C57, C113).
- **Needs You row** exists only while the pending count is above zero; it carries the product's only badge. Remove it on the next navigation after the count reaches zero, never while the owner is on it. Remove the Mac toolbar bell (C110). No count badges on other rows (C15).
- The assistant's configured name (default *Metis*) labels every attribution; "assistant" is never a label. Serve the name with the session (C88).
- Chat stays a sidebar row; C60 (Chat as a pane) is a direction only — do not build to it.

### 2.2 Today and the daily flow
*Spec:* `screen-05-today.md` §15, `daily-flow-spec.md`, `today-hub-requests.md`. *Board:* `Today-Hub`.

- **Ticking** is phase 1 (C98): checkboxes on Today, Board and card detail tick the task in its own file. No confirm; receipt names the file; Undo is a second write; a line edited meanwhile returns 409 (C99).
- **Morning Brief** is Today's first state. It *presents* the Standup routine's file (`Journal/Standup/<date>.md`) and never drafts it (C97 as revised by C111).
- **Close the Day** writes into the vault (C101): a schedule route (one field, 409-guarded, writes `⏳ <date>` or `#someday`), the daily-note section writer, and a close trigger on `plan-tomorrow` that writes `Journal/Plan/<tomorrow>.md`.
- **Daily note:** Metistry writes only between `<!-- metistry:day -->` markers. Broken markers stop the write and raise a request. Things owed to people are tickable tasks with a person facet (C102).
- Generated prose is allowed outside fold templates (brief, Next Up, calendar help) — attributed, marked written-not-retrieved, rateable, its cost in Usage (C103).
- Metis may move a meeting with other people after a warning naming who is told and the new time; owner-only meetings move without one. The calendar sends the update (C90).
- The do-date facet is labelled **Planned** in the UI; typed `do …` and stored `scheduled_for` are unchanged (C134).
- Open: where Today's drag order is stored (C29).

### 2.3 Needs You and requests
*Spec:* `screen-03-needs-you.md` §11–13, `components-01`. *Boards:* `NeedsYou-v4` (pattern, types, hub), `NeedsYou-v5` (the view, stepped questions), `PWA-NeedsYou`.

- **One request pattern**: header (type · who asked · source) · the ask · context (agent words on the wash, then retrieved refs as chips) · a body from a closed set (choices, diff, thread, before/after, preview, to-dos, excerpt) · answers.
- **Answers:** Approve is the only accent-filled button; Revise and Decline outlined; order Approve · Revise · Decline, then Later; Skip only in bulk. A filled destructive button only for irreversible acts (C92).
- **Twelve types:** question, pull request, access, action, meeting, review, note, improvement, report, invitation, task, message. `action` is shown as *action*, not *note* — change `seed/queries/pending_requests.yaml`, the morning-brief `requestType` and the glossary together (C80).
- **Questions**: several multiple-choice questions per request, stepped one at a time, a summary, then Send Answers. Every question ends in *Something else…*; every request has Revise; both stored as free text, never executed (C105).
- **Pull requests** (C106, C107): raised by agents and by the GitHub sync; approve / request changes / comment / reply in Metistry, posted as the owner through a **separate GitHub write credential** used only by owner routes, each checking the head SHA shown. The collector keeps its read-only token; no agent gains a GitHub verb. Add review-thread collection.
- **Hub rule** (C108): a sync raises a request only when the source names the owner; the request mirrors the source (`source {kind, external_ref, person}`, dedupe on `external_ref`) and clears when the source clears. Anything inferred is raised by Metis and says so.
- **Events become requests** (C96): budget stop and failed routine → `report`; expired credential → `access`; knowledge conflict → `review`. The originating screen still shows the event.
- `accept_with_changes` on access requests must refuse a widening (C40). Render `proposals.trust` beside the actor (C22). Failed consequential actions keep the request pending with the error (C45).
- Open: group id per session on `proposals` so a meeting arrives as one card; Accept All must not use the batch endpoint (C81). Rename report kind `decision` → `decided` (C104, recommendation).

### 2.4 Capture and the live bar
*Spec:* `screen-04-capture.md`, `screen-11-capture-bar.md`, `components-03` §4. *Boards:* `Capture`, `CaptureBar`, `Flows`.

- Capture composer mints an `Idempotency-Key` on Capture and reuses it on every retry; a replay renders as the same success (C24). The receipt shows id and path, never a classification (C23). Add an app value to `inbox.source` and send it (C25).
- Bar: the tail of the same conversation at 328px, *Open in Chat* past four lines (C72). No "cannot see" state (C71). Scrim floors 0.86 under text, 0.75 under marks only; no tertiary ink on thin glass (C74). The recording halo is the last allowed loop and holds still under reduced motion (C75).
- Meeting capture: `SCStreamConfiguration.capturesAudio` + `captureMicrophone` on macOS 15, second session below (C76). Jots anchor to (session id, offset) until the meeting note exists (C77).
- **Recording through a working day** (C137): reminder every 2 h, stop at 10 h; record sheet shows the estimate; warn at 10 GB free, stop at 5 GB; permission missing → ask, with Audio Only; window closed → audio continues; sleep → paused, gap marked; crash → saved up to the crash, one report. Budget ~150 MB/hour (compressed audio; screen as changed frames); transcript written incrementally; media deleted once the fold has read it.
- Transcripts kept 30 days from session end (C91). Sessions are archived read-only (system prompt as sent, tool calls and results), outside git; location is your call; the fold must run before expiry (C78).

### 2.5 Chat and Activity
*Specs:* `screen-01-chat.md`, `screen-02-activity.md`. *Boards:* `Chat`, `Activity`.

- Chat reply: a 2px `agent` rule in the gutter, no wash; `agent-quiet` wash is for agent text outside a transcript (C69). Waiting dots become the tool name once known; under reduced motion they hold flat (C16).
- Activity: return an ok/state field from `activity_feed.yaml` (C19, blocking); add `routine_run` with its own group and chip (C43); drop `work_history` from the title-case allow-list (C18).
- Feedback keyed by `prose_id` on every agent-prose surface (C33, open).

### 2.6 Work: Board, cards, projects, artifacts
*Specs:* `screen-06` · `screen-13` · `screen-14` · `screen-16`. *Boards:* `Board`, `CardDetail`, `Projects`, `Artifacts`, `States-Screens`.

- Five columns; the `blocked` column is **Blocked**, `assigned` is **Assigned**; Reported is a facet on Done cards (C2, C38, C39). Escalations are a footnote count in `degraded`, never red (C1, C36). Add `blocked_by_task` and `blocked_by_task_open` to `board.yaml` (C37, blocking).
- Every card click opens the detail popover; the thread is a section in it with *Open Room* (C84). No Rooms list; Board gets a *Has Thread* filter (C89).
- `work` gains a description column, editable by the owner (C85).
- Project modes read **Autonomous / Review**; a chosen Review takes weight, a budget-forced one the tint — the rollup must say why (C83, C94). Rename the per-area rollup **Areas** (C82, open).

### 2.7 Knowledge
*Spec:* `screen-10-knowledge.md`. *Board:* `Knowledge`.

- Per-sync last-ok time (`collector_health`) so freshness can be shown; failed rows show *last succeeded … · reason* (C48, C64, C95).
- Newest fold's body and wikilinks as a query (C65); an owner read of drafts (agents never see them) (C66); one-line area summaries written by the fold (C68).
- What Metis learns about the owner arrives as a proposal; accepting writes the owner's words to `Me/Working Style.md` or `Me/profile.md` (C79).

### 2.8 Agents and permissions
*Spec:* `screen-07-agents.md`. *Boards:* `Agents`, `Flows`.

- Permissions are one line per thing the agent reaches, Read and Write columns; anything not listed is not granted; one glyph marks a verb that asks first (C58). The words are **On · Ask · Off** everywhere (C93).
- *Ask* pauses an interactive agent (a Needs You request, web push) and defers in a routine, which finishes and reports what it skipped (C59).
- The console uses `effectiveActions`, and `effectiveActions` returns why each value is set (defaulted / clamped) (C46, C47).
- Metis's reach is not a grant; do not render it as one (C52).
- An agent's definition names its **model and where it runs in one dropdown**, and its effort, chosen from Settings › Compute, or *Same as Metis* (C128, C132).
- **New Agent** first asks the kind: a local agent (template or blank), connect an agent (A2A/ACP connection), or a tool with a token (Claude Code, Cursor, OpenCode). *Run Now* with nothing scheduled is dimmed with its reason (C138).
- Open: the `widenedGrants` tier trade (C41); whether the decline ceiling writes a row (C42).

### 2.9 Scheduled: routines and syncs
*Spec:* `screen-08-routines.md` §10–11. *Board:* `Scheduled`.

- Rename the nav row **Scheduled**; tabs **Routines** and **Syncs** (C113).
- Routines ordered by next occurrence with day bands and a *Throughout the day* band. Defaults are run by Metis, tagged **default**, fully editable, with **Reset to Default**; "built-in" is retired (C111). `inbox-drain` → *Inbox Sort*, `claude-usage` → *Usage Rollup*, both default routines (C113).
- New **Standup** routine: working days 6:00 AM, task + `Templates/Standup.md`, writes `Journal/Standup/<date>.md`; the brief reads it (C111). Tomorrow's Plan is also its own routine.
- Routine detail: schedule editor (weekday toggles, time, skip rule, next runs), the task in the owner's words, reads/writes/feeds, history with the latest run opened to its steps (durations, model call, write).
- A **sync** reads one connection, never writes back, holds no key (it names the connection's secret); cadence (5 min · 15 min · Hour · 6 hours) and *What reaches Needs You* toggles are editable (C112, C113). Move collector cadence and raise-rules from code to instance config.
- Routine display names in `routines/*/manifest.yaml` (C55, open).
- Suggestions about a routine arrive as **improvement** requests.

### 2.10 Connections and the proxy
*Spec:* `screen-09-resources.md` §10. *Board:* `Connections`.

- One list: status, name, type, used by, offered-to-agents mark. Resources, targets and sources are retired as UI words (C114).
- A connection's tools are grouped **Reads · Changes things · Starts an agent**, each On · Ask · Off. Seed from MCP annotations (`readOnlyHint` → Reads; otherwise Changes things); *Starts an agent* comes from the definition or the owner (C114).
- **Offer to agents through Metistry** — one switch. The proxy speaks MCP to agents and each connection's own protocol behind it; non-MCP types get generated tools (a feed: `list_items`, `get_item`, `search_items`); every call is grant-checked, has secrets filled in, and is logged in Activity (C115).
- **Configuring** (C118): known services show named fields plus *Extra headers and parameters*. Custom connections by how they're reached — **HTTP** (URL, query parameters, auth shortcut, headers, timeout/certificates/network), **Command** (command, arguments, folder, environment, host or container), **Path** (folder, patterns, watch). Values take text, secrets and variables; names are plain. *What it sends* previews the resolved request with secrets masked. Bridges' `transport: http | stdio` and `runs_on: host | container` are the HTTP and Command forms.
- Guards: a secret bound for a host outside its allowed list is flagged on its row and blocked in the preview until allowed; a secret typed into a URL is flagged.

### 2.11 Secrets and variables
*Spec:* `screen-19-secrets-variables.md`. *Board:* `Secrets`.

- Secrets in the Keychain, **per instance** (collapse `SECRET_SCOPES`' user scope). Never shown after save; Replace swaps. Per secret: allowed hosts, who may use it (On · Ask · Off per connection and agent), last used, expiry where the service reports it (C116).
- `{{ secret.name }}` replaces manifests' `env:NAME`. Filled on the way out; a model never sees a value; a local agent gets a granted secret as an environment variable; transcripts show the name. Redact on the way back (`core/redact.ts`).
- A failed or expired secret raises **one** request naming everything it stopped. Metistry's own secrets (database, bridges, owner door) are listed, rotate-only.
- Variables: plain values, `{{ variable.name }}`, usable anywhere including agent instructions; a value that looks like a key is caught at save with *Store as Secret* (C117).

### 2.12 Settings panes
*Spec:* `screen-15-settings.md` §5. *Boards:* `Settings`, `Settings-Panes`, `States-Settings`.

- Sidebar: Instance · Services · Compute · Updates; ACCESS Account · Connections · Secrets · Variables; CAPTURE Live Capture · Sessions; Keyboard · Advanced. Rename `SettingsModel.Section` accordingly (C86); window fixed at 840 × 600, every pane scrolls (C62).
- **Instance** (C123): The Assistant (Name, Mention, Mark, Instance ID) — the primary place the name is set, saved as a protected owner-door write to `identity.yaml`, shown in Activity; This instance (path, namespace, ports); Recent (8); Linked instances from `instances.yaml` (Link, Refresh, Remove).
- **Services** (C124): **Doctor** first (Run Doctor; each problem with the action that fixes it). Then the supervisor (Restart All, Stop All) and one row per service — Running · Backing off · Crash-looping · Stopped, uptime or reason, port, Restart · Stop · Log. The menu bar keeps its controls. **Keep this Mac Awake** with two sub-switches, disabled while off, both on by default, each with a warning tip: *Allow sleep on battery*, *Allow sleep when the lid is closed* — `keep_awake` becomes `{enabled, sleep_on_battery, sleep_lid_closed}` (C129).
- **Updates** (C126): the app's version and checks; the runtime with *Update Runtime*, *What's New*, and *Roll Back* to the kept previous version. Releases vs Git checkout lives in **Advanced**, with the developer override, versions and diagnostics.
- **Keyboard** (C127): one switch, *Shortcuts in any app* (off), the five shortcuts under it.

### 2.13 Compute and models
*Spec:* `screen-15-settings.md` §5.3. *Board:* `Settings-Panes`.

- **Metis uses**: one model dropdown and effort; no fallback (C132).
- **Providers**, one line each: switch (off = not searched, not offered), name, one tag (*Local*, *Cloud* or *Subscription*), an issue only if there is one, then Test, gear (base URL, key as a secret, headers, data policy), Remove (C130, C132). Provider keys are secret references, not a SecureField (C125). Providers gain `billing: token | subscription` (C128).
- **Your Models**: memory and disk bars; search across switched-on providers with **Refresh**; by default *On this Mac* (Load/Unload) then *Cloud* (price or *In your plan*, Remove). A model is written the same everywhere: **name** maker · provider · tag (C132).
- **Search** groups by model, one line per place — provider, tag, price per M tokens in/out or quantisation/size/fit (*Fits · Tight fit · Too large*) — with Add or Install; **Cheapest** marked; filters Local · Cloud · Subscription · Fits this Mac · Tools. Needs a model identity table mapping provider ids to one model; unmapped ids stay separate (C131).
- Move `assignments.tiers/crews` into agent definitions (C128).

### 2.14 Usage and spending limits
*Specs:* `screen-17-usage.md`, `screen-15` §5.3. *Boards:* `Usage`, `Settings-Panes`.

- Spending limits are **enforced** before every call — per day and month, for the instance and per provider — with Allow · Stop · Critical only. Stop pauses routines and raises one request. Subscriptions are limited by their plan's window. Remove the app's *recorded, not enforced* note (C133). *Raise* and the Usage link open Settings › Compute › Spending limits (C138).

### 2.15 Accessibility
*Spec:* `components-02-keyboard-voiceover.md`. *Boards:* `Keyboard`, `VoiceOver`.

- Mac only; the PWA adds no shortcuts (C119). Every shortcut is a menu item: **Go** (⌘0 Needs You while shown, ⌘1–⌘7, ⌘[ ⌘], ⌘K, ⌘F), **Capture**, **Item** (follows the selection), **Help › Keyboard Shortcuts** (⌘/). `.keyboardShortcut` on `CommandMenu`s; single-letter items only while a list has focus. ⌘9 retired; New Conversation is ⇧⌘N.
- Shortcuts in any app: off by default; Ask, Note, To-do, **Start Recording**, **Stop Recording** (suggested ⌃⌥⌘ A N T R S). Checked when set via `RegisterEventHotKey` (surface `eventHotKeyExistsErr`) and the symbolic-hotkeys domain; nothing registers until every row is clear (C120).
- VoiceOver per each spec's **Spoken** table: glyph-only controls say their name (and shortcut when set); meaningful marks say it in words as part of their row; charts speak one sentence with a table in the rotor; the badge announces a change once; landmarks sidebar/list/detail (C121).
- Reduce Motion: stepped questions cross-fade, the Needs You row appears without sliding, the recording mark holds still. Test at the largest macOS text size; panes grow longer, never wider (C122). Full Keyboard Access focus ring on every custom control.

### 2.16 States and flows
*Spec:* `components-03-states-and-flows.md`. *Boards:* `States-Screens`, `States-Settings`, `Flows`, `States`.

- **First paint** (C135): show the last data at once; past a screen's age limit a stale band says when it is from; placeholder rows only on a screen's very first load; a wait over one second says what it waits for. Failed actions keep the owner's work (a move reverts and says so; an unsaved edit stays in its field). Anything that fails three times stops retrying and raises one request.
- **Undo or confirm** (C136): reversible → act, 10-second Undo (Decline All, Keep Mine / Take the Fold's, moves); Esc in the agent editor keeps a draft. Irreversible → confirm naming the cost (Purge Now lists unfolded sessions and offers Fold First; Sign Out Everywhere lists devices; deleting a secret in use lists what stops).
- The per-screen state table (empty · waiting · stale · failed) is in `components-03` §2.
- An expired credential is `failed`, with both timestamps (C95).

### 2.17 PWA
*Spec:* `screen-18-pwa.md`. *Boards:* `PWA-*`.

- Tab bar with the bell in the header; sheets instead of popovers; the offline band and one rule per verb (queues · refuses with reason · not offered).
- Map all four states distinctly (C10). Replace the placeholder icons with the brand marks; 180px PNG `apple-touch-icon`; manifest `name: "Metistry"`, colours from tokens (C12, C13).
- Secrets, Variables, Live Capture and Keyboard are Mac-only settings.

### 2.18 Tokens, colour and type
*Specs:* `facets-and-colour.md`, `design-system-amendments.md`, `brand-kit.md`.

- Contrast is checked on the **ground actually painted**, including composited translucency and opacity (C7, C63, C70–C74). Disabled marks use a dimmer ink at full opacity, not opacity.
- Replace hardcoded fills with the quiet-fill tokens (C6). The accent is the pinned brand colour; do not map it to `controlAccentColor` (C11).
- `border` divides, `border-control` outlines controls; meaningful marks take ink tokens (C49). Two marks are told apart by weight, not two inks (C54).
- Facet order: priority · due · estimate · people · links · state; priority is never red (C31). Title Case for control labels (C3).
- Agent prose: SwiftUI `.serif` natively; on the web `Charter, Sitka, "Sitka Text", Constantia, Georgia, serif`, never `ui-serif` (C32, C35).

## 3. Words that changed

| Was | Now | Ruling |
| --- | --- | --- |
| Resources (Settings) | **Connections** | C114 |
| Targets, sources | **Connection** (Agent type) · **Sync** | C113, C114 |
| Routines (sidebar row) | **Scheduled** (tabs Routines · Syncs) | C113 |
| Built-in (routine) | **default**, run by Metis | C111 |
| Collector (in the UI) | **Sync**, or a default routine | C113 |
| Budgets | **Spending limits** | C130, C133 |
| Scheduled (do-date facet) | **Planned** | C134 |
| Assistant / AI / bot | the configured name, default **Metis** | C88 |
| Allow · Ask First · Never | **On · Ask · Off** | C93 |
| Auto / Supervised | **Autonomous / Review** | C94 |
| Needs You (board column) | **Blocked** | C2 |
| Addressed To | **Assigned** | C38, C39 |
| note (for `action` requests) | **action** | C80 |
| Connections (old Settings pane: sign-in, repo) | **Account** | C86 |
| By token (tag) | — (Cloud without Subscription means by the token) | C132 |
| ⌘9 (Needs You panel) | ⌘0 | C110, C119 |

`PRODUCT.md`, `design-brief.md`, `app-ux-plan.md` and `design-system.md` are the owner's and still use some old words; they were flagged, not edited.

## 4. Data, API and config changes — checklist

**Blocking the next drawings:** C19 (`activity_feed` ok/state) · C23 (capture receipt) · C37 (`blocked_by_task*`).

- [ ] `inbox.source` app value; composer `Idempotency-Key` (C24, C25)
- [ ] `activity_feed`: ok/state; `routine_run` branch (C19, C43)
- [ ] Reconcile `runs.ok` nullability (C20)
- [ ] `collector_health` — per-sync last-ok and reason (C48, C64, C95)
- [ ] `board.yaml`: `blocked_by_task`, `blocked_by_task_open`; column labels (C2, C37–C39)
- [ ] `work.description` (C85)
- [ ] `proposals` group id per session; jot anchors (session id, offset) (C77, C81)
- [ ] Requests: `source {kind, external_ref, person}`, dedupe; per-sync needs-you rules; `pull_request` kind; thread collection (C106, C108)
- [ ] GitHub owner-only write credential with head-SHA check (C107)
- [ ] `action` label in `pending_requests.yaml`, morning brief, glossary (C80)
- [ ] Event requests: budget stop, failed routine, expired credential, knowledge conflict (C96, C133)
- [ ] Free-text answers stored beyond `decision-block.ts` options (C105)
- [ ] `accept_with_changes` refuses widening (C40)
- [ ] `effectiveActions` with reasons; console uses it (C46, C47)
- [ ] Knowledge queries: newest fold, owner drafts, area summaries (C65, C66, C68)
- [ ] Session archive, 30-day retention, outside git (C78, C91)
- [ ] Routine display names; `standup` routine + template + journal path (C55, C111)
- [ ] Sync cadence and raise-rules as instance config; collectors → syncs bound to connections; `inbox-drain`, `claude-usage` → default routines (C112, C113)
- [ ] Vault routes: check (phase 1, 409), schedule, fenced daily-note writer, close trigger (C98, C99, C101, C102)
- [ ] Calendar-move action with attendee preview (C90)
- [ ] Assistant identity as an instance setting; `identity.yaml` protected write; `instances.yaml` management (C88, C123)
- [ ] `keep_awake` → `{enabled, sleep_on_battery, sleep_lid_closed}` (C129)
- [ ] Secrets: Keychain per instance, `{{ secret.name }}`, allowed hosts, grants, egress fill, redaction (C116); provider `auth.secret` → secret reference (C125)
- [ ] Variables store and `{{ variable.name }}` substitution (C117)
- [ ] Connections: type enum, tool groups, proxy with generated tools and per-call checks, HTTP/Command/Path config (C114, C115, C118)
- [ ] Compute: `assignments` → agent definitions; `billing`; provider enable; model identity table; catalogue refresh; no fallback (C128, C130–C132)
- [ ] Engine-enforced spending limits (C133)
- [ ] Recording budget and disk thresholds; incremental transcript; media deleted after fold (C137)
- [ ] `CommandMenu` shortcuts; `RegisterEventHotKey` + symbolic-hotkeys read (C119, C120)
- [ ] Services state and controls; runtime update/rollback UI; `SettingsModel.Section` rename (C86, C124, C126)
- [ ] `ICON_PNG` in `build-app.sh`; PWA icons and manifest; accent not mapped to `controlAccentColor`; token `--check` on painted grounds; quiet-fill tokens; light chart chroma (C6, C7, C9, C11, C13, C87)
- [ ] `prose_id` feedback; Today drag-order storage (C29, C33)
- [ ] Areas rename; rollup returns why a project is in review (C82, C83)

## 5. Still open

**For the developer:** C20, C25, C29, C33, C41 (grant tier trade), C42 (does the decline ceiling write a row?), C46, C47, C48/C64, C55, C65, C66, C68, C77, C78 (archive location), C81, C83, C106; PWA C10, C12, C13; C18.

**For the owner:** C60 (where Chat lives — do not build to it), C76 (capture sequencing), C82 (Areas rename), C104 (`decided`), C28 (a fifth state, *partial*), C87 (chart chroma).

## 6. Where things are

**Specs** (`docs/product/design/`): `screen-01-chat` · `02-activity` · `03-needs-you` · `04-capture` · `05-today` · `06-board` · `07-agents` · `08-routines` (Scheduled) · `09-resources` (Connections) · `10-knowledge` · `11-capture-bar` · `12-run-detail` · `13-projects` · `14-card-detail` · `15-settings` · `16-artifacts-and-rooms` · `17-usage` · `18-pwa` · `19-secrets-variables`; `components-01-states-and-request` · `02-keyboard-voiceover` · `03-states-and-flows`; `facets-and-colour`, `brand-kit`, `design-system-amendments`, `today-hub-requests`, `review-00-plan` (the log), `review-01-holistic`, `HANDOFF` (designer's notes). Plus `../daily-flow-spec.md` and `../glossary.md`.

**Canvas rows and boards**

| Row | Boards |
| --- | --- |
| Mac — the day | `Today-Hub`, `Chat`, `NeedsYou` (v3), `NeedsYou-v4`, `NeedsYou-v5`, `Activity`, `CaptureBar`, `Capture` |
| Mac — Work | `Board`, `CardDetail`, `Projects`, `Artifacts` |
| Mac — Knowledge, Agents, Scheduled | `Knowledge`, `Agents`, `Scheduled`, `RunDetail` |
| Mac — Settings and Usage | `Settings`, `Connections`, `Secrets`, `Usage`, `Settings-Panes` |
| PWA | `PWA-Shell`, `PWA-Today`, `PWA-NeedsYou`, `PWA-Work`, `PWA-More` |
| The system | `States`, `Request`, `Facets`, `Voice`, `Keyboard`, `VoiceOver`, `States-Screens`, `States-Settings`, `Flows` |
| Brand · Plugin | `Direction-C`, `Wordmark`, `Icon-App`, `Icon-Web`, `Colour`, `Kit` · `Plugin` |
| Archive | `Main`, `Direction-B`, `Theme`, `Today` (v5), `Item-Model`, `Routines` (v1), `Routines-v2`, `Resources` — superseded, kept for the record |

The generator: `docs/product/design/boards/` (`README.md` explains it). Archives are frozen copies in `boards/legacy/`; brand boards are not generated here.
