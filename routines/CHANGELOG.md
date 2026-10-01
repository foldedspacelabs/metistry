# @metistry-apps/routines

## 0.16.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.16.1

## 0.16.0

### Minor Changes

- eadd0df: **A recording's retention and re-review (T8-4).** The recorder helper keeps a session's audio (and frames) until its transcript is ingested plus 7 days, never more than 30 days after it ended, and deletes this Mac's transcript copy at 30 days once delivered — on its own hourly clock, so the ceiling needs no console. The bridge gains `recording_review` (`GET /recording/review`, its third tool): a span of kept audio re-transcribed at the careful setting, answered as text with timestamps rebuilt field by field, never audio; after deletion it says when and why, and that the transcript remains. It joins core's `CREW_NEVER_TOOLS`. `POST /recording/retention` (bridge token, not a tool) takes the console's ingestion report, clamped to the delivery and to now; `POST /recording/purge` is Purge Now on the control credential. A Window / Screen session's frames (`screen.mp4`) go with its audio, and a span after a sleep is read from the file that holds it (`app-2.m4a`…), placed by when it was created.
  
  **Transcripts are filed at `Journal/Transcripts/<date>-<session>.md`** (Q29, X-73 folded in): an owner credential's transcript capture is placed there, create-only, in the owner's name, and records its `capture_sessions` row (migration 0033). `Journal/Transcripts/` is outside every default read grant — core's `underAreas` and mcp-brain's SQL `areaFilter` say the same thing. A capture can be placed at an exact path (`captureToInbox`'s `place`). The console serves `GET /api/recordings/:id` (owner reach) through the route-only `recording_state` query, and the hourly `recording-retention` routine rebuilds rows from the vault, records ingestion from the transcript's proposals, reports it to the Mac, and deletes a transcript on its 30th day as a commit in the owner's name, clearing its words from the inbox row and proposal. The crashed-recording report says where the transcript is saved.

### Patch Changes

- Updated dependencies [5a6ad9e]
- Updated dependencies [822a0c7]
- Updated dependencies [eadd0df]
- Updated dependencies [e6f16eb]
- Updated dependencies [0ff5643]
- Updated dependencies [f6a8e5d]
- Updated dependencies [cbfb1a9]
- Updated dependencies [7b979ef]
  - @foldedspacelabs/metistry-core@0.16.0

## 0.15.1

### Patch Changes

- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

## 0.15.0

### Minor Changes

- e2adbe2: The session fold (T3-10, C79): what the assistant learns about the owner arrives as a request. The new hourly `session-fold` routine reads the owner's chat turns not yet folded — quiet for an hour, before they expire — and enqueues ONE assistant turn (thread `session-fold`, tier `routine`) asking for preferences, lessons and profile facts in a ```learned block. The next pass reads the answer back and checks it model-free: a closed set of kinds, only turns the fold showed, a quote found verbatim in what the owner typed (a preference is written as the owner's own span), and profile values in `Me/profile.md`'s exact shape. What survives becomes at most one `improvement` request per file — `Me/Working Style.md` (under `## Preferences` / `## Lessons`) or `Me/profile.md` (one key set, provably) — with the whole-file before and after the console's existing `Me/` Approve path writes as `user`, refused stale. A later harvest supersedes a waiting request with both sets of lines; a declined line is never proposed again; a machine's turn is folded unread; a failed or abandoned fold turn loses nothing. The routine reads `Me/` and never writes it. `foldPass` and `foldSource` are exported for a Fold First.

### Patch Changes

- 86d9b8f: **Mirrors and secret failures (T4-23, R7).** One subject is one card with every
  asker on it: a raise that lands on a waiting mirror raised by someone else is
  appended once to `payload.also_asked` ({source_agent, trust, at, title?, event?,
  context?}), so an agent's `requests_create` kind `pull_request` and the GitHub
  sync's review request for the same PR are one card naming both, in either order
  (the sync now joins an agent's waiting card too). A source change resolves its
  mirror **with a receipt**: `resolveAtSource(db, source, receipt?)` writes
  `payload.cleared = {what, where}` — *You approved it on GitHub*, *Merged on
  GitHub*, *Completed in Linear*, *GITHUB_TOKEN is set again* — which rides on the
  `409 already_decided` a late answer gets and in Activity's detail. A raise may
  not carry `also_asked` or `cleared` itself. The GitHub sync's *An issue is
  assigned to you* rule now raises: one `task` mirror per open issue assigned to
  the token's login, once per assignment, cleared when it closes or is
  reassigned. A missing secret's one request now names its **dependents** —
  every scheduled component whose manifest requires it, due this tick or not —
  as `payload.dependents`, a `used_by` line and the before list. The weekly
  review no longer counts `resolved_at_source` rows as the owner's decisions; it
  notes them apart.
- f4b7c13: Ruling 8 (X-10): **a report is acknowledged, and an agent reads back its answer.**
  A report that names no act is now answered **Acknowledge** beside Dismiss
  (`decision: "acknowledge"`, stored `acknowledged` — core's `ACKNOWLEDGED`,
  `ACKNOWLEDGE_ANSWER`); it carries no words and fires nothing, and
  knowledge-fold reads an acknowledged report the way it reads an approved note.
  A report that names its act (an event's Try Again, Raise) keeps it. And a
  `requests_create` replay — the same `idempotency_key`, or the same title
  within 24 hours — now returns `answer` beside the existing id: core's
  `readBackOf` reading of where the owner's answer stands (`pending`,
  `answered` with each question's answer, `acknowledged`, `revised` or
  `declined` with the owner's words, `dismissed`, `expired`, `closed`).
  mcp-brain's `readBack` keys the lookup and the read on the calling agent
  alone, so another agent's request is never found. No tool was added.
- 962911f: Ruling 15 (X-15): Run Now on Tomorrow's Plan no longer stays silent after the
  23:00 run has already settled the date. Only the scheduled pass asks whether
  an earlier non-close row already settled a target date — a close never asked,
  and now Run Now doesn't either, so it always re-renders `Journal/Plan/<tomorrow>.md`
  when the owner asks for it by hand, same as closing the day twice.
- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.14.1

## 0.14.0

### Minor Changes

- ac377ed: The Morning Brief (T3-6; plan §2.13, §2.5; C97, C102, C103, C111). At 07:00 on
  a working day `morning-brief` renders `Templates/Brief.md` (seeded) into
  `Journal/Brief/<date>.md` as principal `morning-brief` — the standup embedded
  by reference, today's timed meetings under **Next Up**, what is waiting on you
  — writes the daily note's `metistry:day` section model-free through
  `POST /vault/section` (never creating the note; broken markers raise one
  `note` request), and enqueues ONE assistant turn for the file's prose slots.
  File and section are one commit: the runner now hands every run its
  `ctx.runId`. The chat message stays, opening with the file.
  
  **C103 — prose outside fold templates.** Core's `PROSE_SOURCES`
  (`knowledge-fold`, `standup`, `morning-brief`) is where `{{ prose }}` renders a
  slot; every other writer still gets the refusal note, now `PROSE_REFUSAL`. New
  `prose-slots.ts`: `fillProseSlots` accepts a change to a pending slot's line —
  one line of prose, no block, no comment — and nothing else, and marks each
  filled line `<!-- metistry:written N -->`. `JOURNAL_MACHINE_DIRS` gains
  `Brief`; `JOURNAL_ROUTINE_DIRS` / `journalRoutineOf` name the routine that owns
  each folder it writes. `CalendarEvent` gains `attendees`.
  
  **`knowledge_write` in a routine's own folder** (`Journal/Brief/`,
  `Journal/Standup/`, `Journal/Plan/`) now does exactly one thing: fill the
  pending prose slots of a file the routine wrote, in the routine's name with the
  reply's turn. A create there, `Journal/Plan/` at all, a file the routine does
  not own, a stale hash, or any other changed byte is refused — before this, the
  assistant could create a file in those folders and pre-empt the routine's own.
  
  The Standup enqueues the same one turn when its template has `prose` (the
  seeded one has none). The console's vault client gains `section`, surfacing
  `section_missing` by code. `metistry templates check` knows `Brief.md` renders
  as `morning-brief`.
- ece2585: **Tomorrow's Plan after the fold (T3-7).** `plan-tomorrow` now ends with a
  `## Tonight's fold` section: a link to tonight's `Journal/Fold/<date>.md` and
  its `decisions:` frontmatter as a list, verbatim and model-free (newlines
  collapse, a leading `[` is escaped so no decision can become a task line).
  The working-day guard records `skipped:not_a_working_eve` (was
  `not_a_working_day`) — Sunday to Thursday evenings plan the next working day,
  Friday and Saturday are skipped. `PlanCtx.closedDay` is Close the Day's early
  render (T2-8): it plans the day after the day closed, never asks whether the
  date is settled, and records `meta.trigger: "close"`; every row now carries
  `meta.trigger` (`close | schedule | manual`), and only a non-close row settles
  a date — so a second close re-renders, the 23:00 run supersedes the early
  render under compare-and-swap, and a second scheduled pass stays silent.
  The instance zone is `METISTRY_TZ` only (then `Me/profile.md`'s `timezone`),
  never `TZ`.
- 0cba4a2: **The Standup routine (T3-5).** `routines/standup` renders `Templates/Standup.md` (or the path its `template` config names) into `Journal/Standup/<date>.md` on working days at 08:00 — its own reserved subfolder, written through the reconciler as principal `standup`, so the file says `source: standup`. Model-free: `prose` is not legal in a standup render until C103 (T3-6). It never overwrites a file it does not own (`skipped:user_owned`), writes a morning once (`meta.standup_for`), dates a late run from its slot, and writes nothing without working days in `Me/profile.md` — the runner does not start it, and a Run Now records `skipped:no_working_days` itself. `skip_without_calendar_event` (off by default) skips a day whose calendar has no standup; a calendar that cannot be asked never causes a skip. Its row landing is the `routine.status {name: "standup"}` that swaps Today's placeholder for the file. `routines.standup` in `.metistry/scheduled.yaml` (T3-4's move) now applies to it. The seeded `Templates/Standup.md`'s Yesterday list asks for `status = done` — without it the list was always empty, because a task query scopes to open tasks by default — and `metistry templates check` knows the template's writer as `standup`.

### Patch Changes

- 5855540: **`metistry update` seeds the templates the vault lacks (W2 checkpoint D1).** A template a release adds (`Templates/Brief.md`) reached only a fresh `init`, so an upgraded vault's Morning Brief skipped every morning with `skipped:template_missing` and doctor stayed ok. `update` now has a **templates** step after the lock: each `seed/vault/Templates/*.md` absent from the vault is copied — through the reconciler as `user`, create-only (`expected_sha256: ""`), else directly — and a file that is there is never touched; a second run copies nothing. `writeProtected` gains `createOnly`. Doctor's schedule row for a routine whose last run recorded `skipped:template_missing` is degraded, names the template and offers `metistry update`. The Morning Brief raises one `report` request for a missing template, as it does for an unreadable one, deduped per template while one is pending.
- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [ac377ed]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0

## 0.13.0

### Minor Changes

- c0bb21e: C82's rename: the per-area work rollup (`work` grouped by area — open / in progress / blocked / closed this week) is now **Areas**, not Projects, so it never reads as the same thing as the per-project rollup with modes, budgets and a cap. The seed gains `areas_overview` (identical SQL to `projects_overview`, which stays loaded as an alias for one release); the dashboard's Work ▸ Projects sheet now labels the two panels Projects and Areas, and the morning brief's section is `📂 Areas:`.
- 3d2e818: **Groups and sources (T1-8, migration 0027).** A request can now mirror something that lives elsewhere: `proposals.source` holds `{kind, external_ref, person}`, and a unique partial index over the pending rows makes one subject one row — `raiseMirror` (core) inserts with the matching `ON CONFLICT … DO NOTHING` and returns the waiting row's id on a second raise, so two raises for one PR make one row. `resolveAtSource` closes a pending mirror as `decision = 'resolved_at_source'` when its source changes, and matches nothing without a `source`. A `proposals_source_shape` CHECK refuses a source without a non-empty `kind` and `external_ref`, which would otherwise dodge both the dedupe and the expiry. `proposals.group_id` is the card several rows are answered as (a meeting's Accept All). The morning brief's 14-day expiry now skips every row with a `source` — a mirror never expires. The `pending_requests` named query returns `source` and `group_id`.
- bd29463: **Live changes: `GET /api/events` is served.** Migration `0035_event_notify.sql` adds `metistry_notify()` and an `AFTER INSERT OR UPDATE` trigger on `runs`, `proposals`, `work`, `inbox`, `artifact_comments`, `outbound_messages` and `agents` that notifies `{table, op, id}` and nothing else (a no-op update is silent; an agent's heartbeat is throttled to one a minute). The console holds one `LISTEN`, gathers a burst for 250 ms, maps it to the catalogue's typed events and streams them as Server-Sent Events to the owner — a passkey session or the local owner token; an agent bearer and the capture token get the uniform `403`. Every payload passes a guard before it is numbered: exactly its type's fields, each an id, a name, a state or a count. `Last-Event-ID` replays exactly the missed events from a ring of the last 1,000 (or ten minutes), or sends `resync`; a dropped `LISTEN` reconnects by itself and sends `resync`; the credential is re-checked at every 20 s heartbeat; `METISTRY_EVENTS_MAX_STREAMS` (32) caps open streams with a `429`. `GET /api/identity` advertises `events` only while the route is served and the hub is wired.
  
  The daily **Update Check** routine (`routines/update-check/`) asks the release feed for the newest release and, when it is newer than the running console, writes the row the console streams as `release.available {version}`; an unreachable feed is a `skipped:` row, never an alert. `@foldedspacelabs/metistry-core`: `GET /api/events` is `served` in the client API table.
- c38dc4e: **Registries, not lists (§2.7).** Collectors, routines, targets, provider
  templates and connection types load through `Registry` — built from
  manifests, never from a list in code. Core adds `REGISTRY_KINDS` (the closed
  list of kinds, and what an extension may do with each), `loadKind`,
  `kindSources`, `extensionsDirFor`/`extensionsDirFromEnv`, `describeExtensions`,
  and `unitCode`/`joinCode`: a collector's or routine's code is found in its own
  package **by name**, so an extension may replace a product unit's manifest but
  never supplies code, and one naming no product unit is skipped with the reason.
  A new `provider` manifest kind (`type: provider` and a `provider:` block that is
  `providerSchema` itself) turns `seed/compute-templates/<name>.yaml` into
  `seed/compute-templates/<name>/manifest.yaml`; `COMPUTE_TEMPLATES` and
  `parseTemplate` are gone — `computeTemplates()` is the registry, and
  `readTemplate` takes `{ seedDir, instanceDir }`. `collectors` and `routines`
  arrays are replaced by `loadCollectors`/`loadRoutines` and
  `collectorCode`/`routineCode`; the console's `loadSchedules` takes loaded units,
  `TargetRegistry.load(sources)` skips a bad manifest instead of throwing, and the
  watchdog's `loadScheduled` reads the same registries. Every product manifest
  now carries `schema: 1`. New verb: `metistry extensions list | add | remove`
  (M15) — data-only, owner's hand, refused when its registry would skip the unit.
  Doctor gains a `registries` row. **Upgrade note:** an owner's
  `.metistry/targets/<name>/manifest.yaml` overlay without `schema: 1` is now
  skipped (the product's target is in force) until the line is added.
- 06c854e: **The scheduler: routines run once, at their time.** Core implements the
  next-occurrence function F-4 froze (`nextOccurrence`, hand-rolled over `Intl`,
  Temporal's `compatible` rule on both daylight-saving nights) and the runner's
  question `dueOccurrence` — the latest slot owed since the last run, so slots
  missed while the Mac slept coalesce into one run. A time of day is read in the
  schedule's `tz`, then `Me/profile.md`'s `timezone`, then `METISTRY_TZ` — never
  `TZ`, which both deployment shapes default to UTC — and with none is refused
  `no_timezone`. Manifests now validate `schedule:` against §2.5's closed shape
  (cron strings still accepted for one release), and the five routines carry
  §2.5's defaults: Morning Brief working days 07:00, Knowledge Fold 21:00,
  Tomorrow's Plan `eve_of_working_days` 23:00, Reply Review 23:00, Weekly
  Review Sunday 18:00. The console's runner reads each manifest ⊕
  `.metistry/scheduled.yaml` on every tick — schedule and pause by name; an
  entry it cannot apply, or a file that does not validate, HOLDS what it names
  rather than falling back to defaults — reads `timezone` / `working_days` from
  `Me/profile.md` through the vault bridge, stamps each run with the slot it is
  for (`meta.scheduled_for`, `ctx.scheduledFor`, `ctx.timeZone`), and records a
  schedule it cannot place once a day as `skipped:<reason>`. `knowledge-fold`
  and `plan-tomorrow` drop their hourly clock gates (`plan-tomorrow` keeps its
  working-day guard) and date a late run from its slot. `metistry doctor` and
  the watchdog bound a time of day by the widest gap of its week
  (`longestGapSeconds`), and doctor reports a refused schedule as `absent` in
  the runner's own words.
- a1f1113: The session archive is written (T3-9). The engine appends every finished turn — chat and machine-enqueued alike — to `session_archive`: the system prompt as sent, the messages that turn added, and each tool call with its arguments and result, all through `core/redact.ts` inside the store itself (`apps/assistant/src/archive.ts`), with `expires_at` 30 days out and `folded_at` NULL (the session fold's queue). The turn handle is minted by the drain before the call, so the in-flight `runs` row, every tool call's `_meta` and the archived row share one `turn_id`; the turn row also carries `meta.session_id`. A failed archive write never fails a turn — it lands in the run's notes. The new `session-purge` routine (daily) deletes what has expired and anything older than its `retention_days` (Scheduled config, 1–30, default 30; anything else is refused with the field named). `POST /api/sessions/purge` (reach `local`, served) is Purge Now: without `confirm: true` it deletes nothing and names the sessions not yet folded; with it, it deletes every archived turn up to the preview's `as_of`, audited.

### Patch Changes

- 4cba65a: **Profile facts and the standup move (T3-4).** `Me/profile.md` is read in one place: core's `profileFacts` (the two facts a schedule follows), `profileFrontmatter` and `profileWeekdays`, which `plan-tomorrow`'s guard and the console's runner now use too; `resolveScheduleDays` gives a schedule's days with their origin, and a profile with no working days is refused `no_working_days`, never guessed. `standup_days`/`standup_time` move to the Standup routine: the console reads them once into `routines.standup.schedule` in `.metistry/scheduled.yaml` (as `user`; refused until the console holds that authority, T3-2) and raises one *Tidy Me/profile.md* request with the before and after. Approving it writes exactly the "after" as `user`, and is refused `409 stale` if the file changed since; Decline leaves the lines, ignored, and `metistry doctor` names them in one info line (an ok row may now carry `meta.info`). `lastMirror` (core) says whether a subject was ever raised. The seeded profile drops the two keys.
- a927e61: **The overlay: `scheduled.yaml` checked against the manifests, every field
  resolved with its origin.** Routine and collector manifests gain
  `display_name`, `config` (fields from a closed five kinds — text, path,
  number, boolean, choice — each with a default of its kind), and, for a
  collector, `needs_you` (its Needs You rules) and `presents_as`. Core's
  `entryProblems` / `checkScheduled` check each entry against its manifest —
  its section, its config keys and values, its raise rules — and the runner
  HOLDS a component whose entry does not fit, rather than ignoring the change;
  `resolveScheduled` resolves every routine and sync over manifest ⊕
  `Me/profile.md` ⊕ `scheduled.yaml` into `Sourced` fields (*default* · *from
  your profile* · *yours*) with the next run. The reconciler admits
  `.metistry/scheduled.yaml` as the console's third protected door — and still
  no other. Every collector moves to §2.5's closed shape (no shipped cron
  string is left); Inbox Sort (`inbox-drain`, every 5 min) and Usage Rollup
  (`claude-usage`, hourly) present as routines; GitHub declares
  `review_requested` and `assigned`. Manifest errors now name a bad record key
  by its rule rather than "Invalid key in record".
- b0c61f8: The daily Update Check now declares its `display_name` (*Update Check*) and a time-of-day schedule — every day at 06:00 in your zone — in the same closed shape as every other routine, so Scheduled lists it and the runner fires it once a day at that time.
- Updated dependencies [152022a]
- Updated dependencies [942372e]
- Updated dependencies [95fb504]
- Updated dependencies [df37d39]
- Updated dependencies [3d2e818]
- Updated dependencies [4451f77]
- Updated dependencies [3a1ff8c]
- Updated dependencies [6592f91]
- Updated dependencies [bf33ee1]
- Updated dependencies [bd29463]
- Updated dependencies [9ac7949]
- Updated dependencies [3f9d719]
- Updated dependencies [4cba65a]
- Updated dependencies [be25ade]
- Updated dependencies [c38dc4e]
- Updated dependencies [a927e61]
- Updated dependencies [06c854e]
- Updated dependencies [ec21783]
- Updated dependencies [a1f1113]
- Updated dependencies [24a9ddb]
- Updated dependencies [8c9dde6]
- Updated dependencies [8217e01]
- Updated dependencies [37f0ed2]
- Updated dependencies [5e8f8d1]
  - @foldedspacelabs/metistry-core@0.13.0

## 0.12.0

### Patch Changes

- d930fba: **One request type table, in core — and `action` reads *action*.** Every
  request in Needs You is a `proposals` row with a free-text `kind`; the owner
  reads one of twelve types instead (`docs/product/glossary.md`).
  `packages/core/src/requests.ts` is now the only place that says which: stored
  kind → type, the type's body from the closed set (choices · diff · thread ·
  before and after · preview · to-dos · excerpt), its primary verb, Revise and
  Decline, and the decisions each stores (`describeRequest`). It replaces the
  two copies that had drifted — the CASE in `pending_requests` and the morning
  brief's own map, both of which called an agent's `action` a *note* (C80).
  
  The brief imports the table. The query cannot import TypeScript, so it
  carries the table's `requestWordSql()` rendering verbatim, and the console's
  seed-query tests refuse any other text, run the query over every stored kind
  against the table, and read every `INSERT INTO proposals` in the product so a
  new writer cannot add a kind the table does not map. A kind the table does
  not know reads as a *report* drawn as an excerpt with Dismiss its only answer
  — never as the raw kind, and never with an Approve whose meaning nobody
  reviewed. `pending_requests`' title fallback now says the owner's word too
  (*note request*, not *knowledge request*).
- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [c69abc3]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0

## 0.11.0

### Minor Changes

- 6b0d6d7: **Tomorrow's plan is written for you, from your own template.** The daily
  flow's `plan-tomorrow` (`docs/product/daily-flow-spec.md` §5.1, §7; ticket
  P1-7): once an evening, the routine renders `Templates/Plan.md` — a markdown
  file in your vault, which you edit in Obsidian like any other note — into
  `Journal/Plan/<tomorrow>.md`, written through the reconciler's bridge as
  `principal: plan-tomorrow`. Tomorrow's events, the tasks the template asked
  for in the order it asked for, what an agent is waiting on you for, what is
  waiting in your queue, and your own prioritisation prose included verbatim.
  
  **No model is in it, at any tier.** The ordering is a field list in the
  template; your prioritisation *rule* is prose the plan includes for you to
  read, not something a model is asked to apply (invariant 4). The manifest
  declares no engine, so the runner never even asks whether one is configured.
  
  **It writes exactly one file, and never a note you own** (§5.1's one writer
  per file). A plan file whose frontmatter `source:` is not this routine's —
  including one with no `source:` at all, which is yours — is left exactly as it
  is and the run says so. A recurring rule is *listed* for tomorrow
  (`- Water the plants — every week, due 2026-09-22`) with no checkbox and no
  `^mt-` anchor: no routine writes a task line into a note you own (D4), which
  the engine enforces from the render's `source` and the routine refuses again
  before writing. Re-running an evening replaces the same file under
  compare-and-swap; nothing is appended, and there is never a second one.
  
  **The gate is `Me/`, and it degrades honestly.** `@hourly` with the decision
  in the routine, for the reason the fold gives — the runner has no time of day.
  It plans after the day end `Me/profile.md` states (`working_hours:`), on the
  eve of a day `working_days:` names, once per target day. No `working_days` and
  **nothing is written at all**: the run records `no_working_days` rather than
  guessing Monday-to-Friday. No `working_hours` and the plan is written from
  19:00 local *and says so*, in one visible line, because a default nobody chose
  should not be invisible. No calendar bridge, no query store, a `where:` the
  filter vocabulary refuses — each renders one `> ⚠️ metistry: …` line naming
  the template and the line number, and the plan still lands: a day with no plan
  because the calendar was down is the worst possible outcome.
  
  One `runs` row per target date carries what happened — `wrote`,
  `no_working_days`, `not_a_working_day`, `template_missing`,
  `template_unreadable` or `user_owned` — so `metistry doctor`, the morning
  brief and `docs/ops/automation.md`'s SQL all read the same ledger, and an
  hourly routine still files one row a night.
  
  The console now hands routines the named-query store and the vault bridge it
  already built for the server, so every row the plan shows arrives through a
  named query and no component grows a second read path into Postgres
  (invariant 3).

### Patch Changes

- 4581845: **The fold has its own file; your daily note is yours.** Ticket P1-9 of
  `docs/product/daily-flow-spec.md` §5.1: the evening fold now writes
  `Journal/Fold/<date>.md`, `source: knowledge-fold`, and never
  `Journal/<date>.md` — that file has always been the user's own daily note,
  and no fold turn touches it again.
  
  When `Templates/Fold.md` reads, the routine renders it itself — every
  directive but `{{ prose }}`, the one legal only there (D14) — and hands the
  skeleton plus the still-open prose slots to the SAME assistant turn it
  already enqueues; the assistant's whole job is filling the numbered slots and
  writing the result back verbatim. When there is no template yet (a missing
  `Templates/Fold.md`, or no vault reader wired into the routine — §6.4's
  `template_missing`), the fold falls back to the pre-template freeform note,
  at the SAME new path, with a visible reason on the turn rather than losing
  the night's fold or writing nothing at all.
  
  `seed/assistant-prompt.md`'s Fold section (shipped by
  `@foldedspacelabs/metistry-cli`, stamped into every instance by `metistry
  init`/`update`) is updated to match: it names the new path, states plainly
  that `Journal/<date>.md` is never a fold write target, and describes both
  shapes the enqueued turn may hand it — a skeleton to fill or a freeform note
  to compose.
- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [9c9da4a]
- Updated dependencies [1bf5c76]
- Updated dependencies [b6586de]
- Updated dependencies [579662f]
- Updated dependencies [57ceb02]
- Updated dependencies [45b64df]
- Updated dependencies [9ec30d5]
- Updated dependencies [7f9ceb7]
- Updated dependencies [23cc47f]
  - @foldedspacelabs/metistry-core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [ad73f5a]
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.9.1

## 0.9.0

### Minor Changes

- dade46d: **Shadow mode: try a model on your real turns without ever answering with
  it.** The bake-off's stage 2, as configuration. An optional block on the
  default assignment —
  `shadow: { model: llamaserver/qwen3.6-35b-a3b, fraction: 0.1 }` — has the
  engine re-run one turn in ten on a candidate model *after* the real answer has
  been delivered and its session saved, and put both transcripts plus an
  agreement number on that turn's `runs` row. The candidate's answer is never
  returned as the turn's, is never a session, and has no path to the console or
  the phone.
  
  **Its tool calls are stubbed record-only, by construction rather than by
  instruction.** The shadow gets the same tool *list* the real run saw; every
  call is written down and none is performed. A call the real run made
  identically (same name, same arguments, byte for byte) is handed the real run's
  own result, so the candidate's next step is judged against the same facts;
  anything else gets one fixed `(recorded, not executed: …)` string. The stub
  host closes over a list of names and a map of strings — no MCP client, no URL,
  no token — so there is no object in scope it could execute a call against, and
  a shadow of a turn that wrote to the vault cannot write to the vault twice.
  
  **Agreement is deterministic and says what it is:** the mean of "same tool
  calls in the same order" and token Jaccard over the two final answers. No model
  scores it, so it cannot drift and the stored row re-scores to the same number.
  The *rubric* score stays `packages/eval`'s, on the owner's fixtures — the
  engine leaves a typed hook for it instead of inventing a second scorer.
  
  **A shadow is a turn, so it is budgeted like one.** It asks the same pre-call
  gate with the candidate's own provider and `critical: false`, so `stop` and
  `critical_only` skip the experiment while the interactive turn they let through
  keeps its answer; its spend is its own `runs` row of kind `shadow` carrying the
  provider that was actually paid, which is what makes per-provider budgets
  honest with no change to the `spend` query. Nothing it does can cost the turn:
  a candidate that is down, an unset credential or a failed write lands as a note
  on the row, never as a failed reply.
  
  Additive migration `0020` adds `shadow_provider`, `shadow_model`,
  `shadow_transcript`, `shadow_agreement` and `shadow_cost_usd` to `runs`
  (rollback: drop the five columns and `runs_shadow_ts_idx`). New named query
  `seed/queries/shadow_agreement.yaml` reports agreement, tool-sequence match,
  answer similarity, cost and failures per candidate over the last N shadowed
  turns; the weekly review's System section carries one line per candidate and
  omits it when nothing is being shadowed. `compute.yaml`'s schema refuses a
  `shadow:` block with no `fraction`, a fraction outside 0..1, a candidate this
  file does not declare, a candidate that is the assigned model itself, and the
  block on a tier or crew — each naming the field. `docs/ops/compute.md` gains
  "Shadow mode".

### Patch Changes

- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1

## 0.8.0

### Minor Changes

- d21f953: **The product no longer ships a claude.ai-login path or the Claude Agent SDK;
  compute is configured in `compute.yaml`.** One engine remains — the
  OpenAI-compatible loop — and Claude is reached through OpenRouter like any
  other cloud model (owner's decision, `docs/plan-refresh-2026-09-13.md` C2/C3).
  `@anthropic-ai/claude-agent-sdk` leaves every `package.json` and the lockfile;
  `engine-sdk.ts`, the `anthropic` engine kind and `CLAUDE_CODE_OAUTH_TOKEN` are
  gone from the engine, the CLI's env allowlist and secret table, the plists,
  `docker-compose.yml`, `.env.example` and the docs. Version bumps are `minor`
  across the fixed set rather than `major` because fixed mode moves every package
  together and a major here would say something about packages this does not
  touch; the behaviour change is stated here, in `docs/ops/compute.md` and in
  `docs/ops/assistant-tools.md` ("Running without an engine").
  
  **"Is there an engine" is now one seam over two facts.** `engineStatus(compute,
  env)` in `packages/core/src/compute.ts` replaces `engineCredentialPresent(env)`:
  an engine is an `assignments.default` *and* the key its provider names in
  `providers.<name>.auth.secret`. `metistry up` (whether the assistant is a
  supervisor child), `metistry doctor` (the `assistant` row), the routine
  runner's preflight (`requires.engine`) and — through the supervisor's child
  list — the watchdog all read it, so they cannot disagree; each refusal names
  the missing half and the verb that fixes it. `makeEngine` throws a named
  `NoEngineError` for a turn nothing assigns rather than inventing one, and the
  drain never starts: an install with no assignment behaves exactly as #145 made
  it, with captures, tasks, search and the console running and queued turns
  waiting. **Both deployment shapes now run engine-less** — `docker-compose.yml`
  no longer interpolates a credential as required.
  
  **The engine's credential has no fixed name.** `ASSISTANT_ENV_KEYS` becomes
  `assistantEnvKeys(compute)`: the static keys plus exactly the secrets this
  install's `compute.yaml` declares, so it stays an allowlist while the variable
  it admits is whatever the file names. A provider key in the operator's shell
  that the file does not name still cannot reach the engine. The sandbox
  profile's documented host list is derived the same way (`engineHosts`) instead
  of naming one vendor; what is actually enforced is unchanged and restated —
  the loop's only outbound call is `<base_url>/chat/completions` on the assigned
  provider.
  
  **The Mac app's step 7 becomes Compute.** Pick a template (OpenRouter,
  OpenCode Zen, LM Studio, Ollama, bundled local), name a model, paste the key
  into a secure field, and the app runs `metistry compute providers add --from
  … --json` with the key on the child's **stdin** — the one exception to the
  app's empty-stdin rule, and why `CommandRunner` grew a `standardInput`
  parameter — then `metistry compute assign default <provider/model> --json`.
  The property holding the key is cleared before the process runs, and tests
  assert the key is in no argument of any call. "Skip: no engine yet" is a real
  choice with its consequence on screen. Settings' "Claude Token" row becomes
  **Compute**, rendering `metistry compute show --json`: the default assignment,
  each provider, and whether the key each one *names* is present — never a
  value.
  
  `collectors/claude-usage` is **kept**, unchanged in behaviour: it is a local
  rollup of `runs` needing no credential, so it degrades to nothing on an
  engine-less install; its `claude.*` metric names are data existing installs
  already carry and renaming them would be a migration with no reader benefit.
  Its copy, `seed/queries/claude_usage_daily.yaml`'s description and the weekly
  review's monthly block stop describing a plan's headroom and describe what the
  provider billed.

### Patch Changes

- 26df04d: **The Feed is a timeline, and a capture is on it the instant it lands.** The
  `activity_feed` query gains an `inbox` branch, so a note taken on the phone
  shows up immediately wearing its own status (`new` = still waiting on the
  drain) rather than appearing five minutes later as a proposal — the loop's one
  accidental latency. Every row now carries a coarse `group` (capture, proposal,
  decision, run, work, message) decided in the SQL, which the panel renders as
  filter chips; `since` pulls only what is new, and a decision event says what
  you answered, not just that something was answered. Still read-only.
  
  **Approve as Work.** A `knowledge` or `report` proposal whose payload carries
  `suggested_work` shows one extra answer, and the click inserts the `work` row,
  links it as `proposals.work_id` and allows the proposal. `inbox-drain` sets the
  suggestion deterministically — frontmatter `kind: todo|task`, a leading
  `@task` / `todo:` / `- [ ]`, or the `todo` verdict its rules already reached;
  **no model**, and the Apple FM tier's `has_action` is deliberately not an
  input. Nothing auto-creates: §4.12 holds because a human clicked. The row is
  born owner-less and unclaimed, so any agent may take it, and the insert is
  keyed on the proposal id so a double-tap cannot make two.
  
  **A decision is an answer to the row you were shown.** `POST
  /api/proposals/:id` accepts `if_unchanged: {seen_at}`; if the proposal moved
  after that — payload rewritten, its linked work row touched, a message in that
  row's room — nothing is decided and a `409` comes back carrying
  `reason: "stale"` and the current row, in the same envelope `already decided`
  already used.
  
  **Later and Skip** (migration `0019`, one nullable `snoozed_until`). *Later* is
  a snooze: the row stays pending, leaves Needs You and the morning brief, and
  comes back on its own (`METISTRY_SNOOZE_HOURS`, default 3) — it never ends a
  proposal. *Skip* declines with nothing to say and fires none of Decline's
  per-kind consequences: skipping an enrolment request does **not** revoke the
  agent, and its fixed `skipped` marker is excluded from every path that carries
  a decline's words anywhere. `POST /api/proposals/batch` applies `later`, `skip`
  or `deny` to many rows, all-or-nothing **per row** with a result for each; the
  queue gains multi-select and the keys `l` and `s`.
- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
  - @foldedspacelabs/metistry-core@0.8.0

## 0.7.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0

## 0.6.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.6.0

## 0.5.0

### Patch Changes

- @foldedspacelabs/metistry-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-core@0.4.0

## 0.3.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
