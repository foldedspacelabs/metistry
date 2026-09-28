# @metistry-apps/macos

## 0.14.2

### Patch Changes

- 6cde714: **The app no longer hangs while a Chat turn is working, and opening Activity, Needs You or Today no longer resizes the window.** Chat serialised its reads by looping until the tick in flight was cleared; awaiting a tick that had already finished returns without suspending, so the loop could spin on the main actor forever — the window stopped answering at 100 % CPU the first time the Chat screen saw a working turn, after a send, or whenever two reads overlapped. Each read now waits once for the one before it. Separately, Activity told the window it needed at least 1,117 pt of height (its chips wrapped a character per line at no width) — over 3,000 pt with the console unreachable — so opening it grew the window or slid its content off the top; Needs You (878–1,078 pt) and Today (1,127–1,841 pt) did the same. All three screens now leave the window's minimum to the shell.

## 0.14.1

## 0.14.0

### Minor Changes

- 8c5a871: **Activity on the Mac (T6-3).** The Activity row now opens the timeline: time bands (*Just now*, *Earlier today*, …), one glyph column, and who did it — the assistant by its configured name, an agent in its hue, anything else neutral. Eight chips (All and the query's seven groups) beside the window, agent and project controls. New rows are held behind a *↓ 12 new* pill and never inserted under the reader. A reply's tool calls fold under its turn, which reads its model, time, cost and tokens from its run and, opened, fetches every call by `turn_id`. A routine that wrote a file carries the spark and opens the prose; one that could not run is drawn absent, not failed. Failure is drawn on the glyph only, from `ok`. Empty, filtered-empty and failed are three different panels. `ActivityStore.activityFeed` gains a `turnID` parameter.
- 3feeb6f: **The capture composer on the Mac (T5-5).** The toolbar's + and ⌘N now open the composer: one field (`note…`), **Capture** (⌘↩) and a receipt line. It does not wait for the console — ⌘↩ moves the words into a pending capture (*capturing… you can close this*) and closing cancels nothing — and Esc closes it keeping the draft until it is sent. Each capture mints one `Idempotency-Key` when Capture is pressed and every resend carries it, so a reply lost after the write replays as the same capture with the same id: *captured → inbox #418 · Inbox/….md*, the id and path the console returned. A capture that gets no answer is queued (*queued — will send when the instance is reachable*) and resent on a backoff, when the composer opens, and as soon as the console is heard from again; a refusal shows the console's words, puts the text back in the field and offers Retry with the same key. An instance switch returns unsent words to the field rather than sending them to the other instance. Text only: attachments and live capture wait for the designer's action bar (#253).
- f8f9b4b: **Chat on the Mac (T6-2).** The Chat row opens the conversation as screen 1 draws it: one capped column (620pt at the reply's 16pt, growing with the text size) centred so a resize never rewraps a line; the owner's turns on `accent-quiet`, the assistant's with a 2px `agent` rule in the gutter (C69); day separators; 12-hour times. The transcript is `GET /api/messages?limit=30`, merged by direction and id. A turn's state is its own message's `status`. Its tool strip is joined exactly — the recent `turn` runs, read once for the `meta.message_id` the drain stamps, then `GET /api/turns/:turn_id/progress` — never by adjacency or time; `▸ 4 tools · 6.2s · $0.031` on `sunken`, open by itself only when a call failed. Waiting shows the dots, then the running tool with its count and seconds, then *nothing back for 62s* on `degraded-quiet`; the dots hold flat under Reduce Motion (C16). A reply that arrives while the reader is scrolled up never moves the viewport: it is announced once and waits behind *↓ New Reply* (P9). Send is a decision (O3) — off while unreachable with the gate's sentence, and a send that fails stays as *Not sent* with Try Again; Stop is drawn and off, saying the console has no cancel route. The tier chip pins a tier from `GET /api/commands` for this turn or the conversation and sends it as `tier`; ⇧⌘N resets it. A reply's pending question is Needs You's own card inside the turn; its `[[wikilinks]]` are chips that open the page in a pane beside the column, or a sheet when the window is narrow. Tapbacks: the two thumbs and the right-click menu, Bad with an optional note. The sidebar's Chat row carries a dot while a turn works.
- 339d465: **Live events on the Mac (T5-7).** The app holds one subscription to `GET /api/events` per instance (`ConsoleSession.events`, `LiveEvents`) over the `console session` child, and hands each event to the readers of the store it names — the catalogue's "the client refetches" column as `EventTopic`s. A `SectionModel` built with topics is marked due by exactly its events; `needs_you.changed`'s count drives the Needs You row, the badge and the Dock directly (announced once per change). While the stream is live those readers stop polling on their clocks (a five-minute check stays, for a snooze coming due); while it is down they poll as before, and it reopens on a 3 s → 1 min backoff with `Last-Event-ID`. A `resync`, an unreadable frame or a subscription with nothing to resume from marks every reader due. `metistry console session --stdio` now passes on the console's cursor — the id-only frame a fresh subscriber gets first — as `{id, event: {id}}`; it was dropped, so a stream that was quiet from the start could not resume.
- 0771fee: **Needs You: the bodies (T5-4b).** A request's detail is one card, drawn from the reading the server serves on every `GET /api/proposals` row (`request`, X-5) — the Mac keeps no kind → word map of its own, and a row from a console that predates it reads as core's unknown kind: a report with Dismiss. `RequestReading` fills the one body block the type draws from the payload — `payload.body` field for field where a producer sends it, else the fields each producer actually writes — and says `partial` when a block cannot be filled rather than inventing it. The answers are the type's own (`RequestAnswering`): the primary verb filled, Revise and Decline outlined, Later as a glyph that says *Later, L*; a decision goes through `POST /api/proposals/:id` with `if_unchanged.seen_at`, a door onto another system through `RequestDoorHandling` (none wired in this build, each control saying so). Questions step one at a time with a segmented bar and end on Your Answers with Edit and Send Answers (⌘↩); one question sends on the choice; *Something else…* sends the owner's words; `allow_other: false` is honoured. A `409 stale` sends nothing, repaints the row the refusal carries, keeps the owner's words and says so; `409 already_decided` shows the winner; any other refusal — C40's wider-than-asked, a C45 consequence — is shown verbatim and the card stays answerable; `payload.error` draws as failed with its reason. Access Revise composes `<asked>/<folder>` so it cannot name a wider or sibling area, and the receipt states the tier trade from `prior_tier`. A meeting's Accept All and Decline All are held ten seconds behind Undo, then sent one per part in order, and a partial result reads *4 of 5 accepted* with why. `RequestCards` keeps one card per request so the detail and the Item menu (`itemActions`) act on the same one. `RequestRow` decodes `request` and `source`; `AnsweredGrant` decodes `prior_tier`; `RequestAnswer.answers` carries per-question answers; `MetistryGlyph` gains Approve's check and Decline's cross; `ChoicesBody` takes `allowsOther`.
- a28793b: **Needs You on the Mac: the list (T5-4a).** The Needs You row now opens a list and a detail: one line per request — the type's word as the console gives it (X-5's `request`, so a stored kind is never shown), what it asks, who asked (the configured name for the assistant, an agent's id, or the source a mirror lives in, with `external` / `you` as a neutral chip) and how old it is — grouped *Today* and *Earlier*, newest first, filtered by type (only the types present, with counts) and by **From** (Everyone · the assistant · Agents · each source present). One selected request is drawn beside the list; its body and answers arrive with T5-4b. Selecting several — ⌘-click, ⇧-click, ⇧↑↓, ⌘A or *Select All on This Page*, capped at the batch's 100 — gives the bulk list: **Later · Skip · Decline**, never Approve (`BulkVerb` cannot express one), with Decline's one reason given once. The batch's result is a band above the list — *2 of 3 declined*, what happened to the rest, the still-pending row kept selected and **Retry** re-sending exactly it. While the console is unreachable every verb, Retry and the Item menu's L and D are disabled with the reason under them, and nothing is sent. `RequestRow` reads `request` and `source` off each row.
- 9dcc405: **Project grants inherited (T4-7).** A crew's or external agent's effective reach is now its own grant ∪ the own grant (0032) of every project its row lists — core's new `inheritGrants` (the widest tier; its own areas first, then each project area its own do not cover; `queries` if any holds it), with the added reach reported as `via`. The console's door resolves it per request (`authenticateAgent` reads the membership and the projects' grants in one statement) and never writes it into the agent's row, so leaving a project removes what it gave on the next request. `resolveActor` takes `projectGrants` (`listProjectGrants`) and the permissions table marks each inherited entry with the new provenance `{kind: "project", project}` — *via project <slug>* in `permissionRowText`, the console's panel and MetistryKit (`PermissionProvenance.project`). A project's stored grant is re-checked fail closed; the assistant inherits nothing.
- fce1f33: Questions v2 and both report names (T2-3). **A request can ask several
  questions** (1–5, each pick one or pick any, 2–8 options, and — unless it says
  `other: no` — ending in *Something else…*): the assistant's ```` ```decision ````
  block grows a `question:` / `pick:` / `other:` grammar beside v1's (core's
  `parseDecisionBlock`, still hand-rolled and bounded), and every agent asks the
  same way through `requests_create` kind `question` with `questions` — no new
  tool; the brain's eager surface grows 64 tokens (4,267 → 4,331) and stays at 26
  tools. **Answers are stored per question**: `POST /api/proposals/:id
  {decision: "answers", answers: [{choices, other?}, …]}` is checked against the
  questions as stored (`checkAnswers`) and settles the row `answered`, with
  `payload.answers` and the answers' words in `feedback`; free text is `other`
  and never executes. Revise on a question is `accept_with_changes`. v1's wire —
  the option itself as `decision` — still answers a one-question request.
  **`decideProposal` reads F-5's table** (`describeRequest(kind, payload).decisions`)
  instead of building its own list: a report is Dismissed (`skip`) and can no
  longer be approved, revised or declined; Skip on one row is only a type's own
  Decline (Dismiss, Not Mine) — elsewhere it is the batch's (K2). `GET
  /api/proposals` serves a question's `request.questions`. **`decided`** is the
  report kind for a decision made (C104); `decision` is accepted and stored as
  `decided`. The PWA draws each type's own answers from the table, and a
  question's questions as its body. MetistryKit sends Send Answers
  (`RequestAnswer.answers`).
- 2a34dfe: **Today's spine on the Mac (T6-1a).** Under the top, the day is one time-ordered column: meetings at their time, your rows in the gaps between them in your order (a focus block is a place for rows; a row too long for any gap left is shown under *Doesn't fit*, never refused), a NOW rule pinned under the header, and the morning folded to one line above it — *Earlier today — 3 done · 1 meeting · 2 carried forward* — so the page opens at now. With no meeting on the day it is the plain list. The Board's rows on the day carry the board glyph and no checkbox. Drag a row, or Move Up / Move Down, and the whole order is stored (`PUT /api/today/order`); a refusal puts the rows back and says so. One click ticks with a receipt and Undo, and Edit ▸ Undo; a line changed in Obsidian shows as it now stands and nothing is written. The header's day bar measures Meetings · Travel · Focus Blocked · Tasks That Fit · Doesn't Fit against `working_hours`, speaks one sentence and carries its table. **Today / All** (⌥⌘T): All is the vault's open lines through the `where:` box, copyable, with the parser's own words on a refusal (⌘F focuses it); *Waiting on Others* is `where: waiting`, and *Slipping* and *Owed* are drawn dimmed with why until the language can say them. Estimates read `task_size_minutes` from `Me/profile.md`.
- 307dbbc: **Today's top on the Mac (T6-1b).** The Today row now opens the day. The Morning Brief is its first state — one serif paragraph with the configured name and *written, not retrieved*, the Standup collapsed with Copy Standup — and folds to its first sentence on the next open. From thirty minutes before a meeting, Next Up shows who is in it, what you owe them (tickable), the brief's line for it, Open Notes, Record (dimmed until the capture bar) and Draft the Agenda. When no focus block is left, calendar help offers one move, and a meeting with other people in it warns first, naming who the calendar will tell and the new time. From thirty minutes before the working day ends, Close the Day: done, still open and owed lines each with Tomorrow · This Week · Someday, tomorrow's shape, a line for tomorrow, and a folded *Day closed at…* line — or, when the daily note's markers are broken, the request, never a success.
- 8f85ece: **Usage on the Mac: the gauge's popover (T5-6, screen 17).** The toolbar gauge now opens Usage, 400 points wide: *This month* — the amount, *of $60 this month*, a meter and *$1.84 today · 8 days left*, and at a limit what the engine is doing about it (*Compute stopped at the $60 monthly spending limit* for Stop; Critical only and Allow say theirs) with **Raise**; *Each day* — one bar per day from the 1st to today, the peak on the heading, hover for a day's amount, one spoken sentence with the table in the rotor; *Where it went* — who spent this month, highest first (the chat turns read *Chat*); one line each for the cache rate, AWS this month (*not compute*) and the calls with no price (*count as $0*); then **Spending Limits in Settings**. Raise and that link open Settings on Compute. Nothing projects where the month is heading. The popover reads `GET /api/compute` — the gauge's own read — and the `spend`, `spend_by_actor` and `aws_costs_daily` named queries (three new `UsageStore` methods, with recorded fixtures); it opens on the last answer and keeps it when a refresh fails. The gauge speaks *37% of the daily spending limit* — C130's word, not *budget*.

### Patch Changes

- 2fc0ef0: **Compute (T4-18): provider keys are this instance's secrets, providers gain a
  switch and billing, and the catalogue is searched by model.**
  
  - `compute.yaml`'s `auth.secret` is a reference: `{{ secret.<name> }}` (one of
    this instance's secrets), `env:<NAME>` (an install variable), or — so every
    older file loads — the bare `<NAME>`. A pasted key still cannot match any of
    them. Core gains `credentialOf`, `providerCredential`, `credentialEnvNames`,
    `credentialFromEnv` and `providerSecretNames`; the reference spelling moved
    to a leaf module (`secret-ref.ts`, re-exported by `secrets.ts`) so
    `compute.ts` can read it without a load-time cycle.
  - A service reads a key from its environment, never the Keychain:
    `{{ secret.x }}` arrives as `METISTRY_SECRET_X` (core's `secretDeliveryVar`),
    which `metistry secrets sync --to env` now writes for every secret the
    providers reference, from this instance's item only; `metistry up`'s engine
    allowlist passes exactly those names. For one release a `*_api_key` secret is
    also read from the `METISTRY_<NAME>` line T4-3 filled, so `migrate-scope`
    rewriting the reference cannot cut a running engine off.
  - `metistry compute providers add` stores the key through `secrets set`'s own
    code — this instance's Keychain account, recorded in `secrets.yaml` sent only
    to the provider's host — and writes the reference. The `openrouter` template
    references `{{ secret.openrouter_api_key }}`. Nothing in `metistry compute`
    reads or writes the retired per-user account any more. `--secret` takes a
    secret's name; the old UPPER_SNAKE spelling is refused with the name it
    became.
  - Providers gain `enabled` (off = neither searched nor offered; an assignment
    naming a switched-off provider is refused by the schema) and `billing:
    token | subscription` (off this machine only). The report carries `enabled`,
    `billing`, `tag` (`local` · `cloud` · `subscription`), `secret_kind`,
    `secret_name` and presence from this instance's account.
  - `seed/model-identities.yaml` and core's `groupCatalogue`: provider model id →
    one model, overlaid by key by the instance's `.metistry/model-identities.yaml`
    (a new `INSTANCE_LAYOUT.modelIdentities`). An id it cannot map stays its own
    row under its provider.
  - New verbs: `compute providers set <name> [--enabled on|off] [--billing …]
    [--base-url …] [--secret …]`, `compute models search [<query>]`,
    `compute unassign <tier|crew:name>`. New owner routes:
    `GET /api/compute/catalogue[?q=&provider=&refresh=true]` (listings kept
    15 minutes in memory; `refresh` re-reads them) and
    `POST /api/compute/unassign {tier|crew}`; MetistryKit's `UsageStore` gains
    `computeCatalogue` and `unassignCompute`.
  - `migrate-scope` now rewrites `compute.yaml`'s `auth.secret` (its schema reads
    references), and still counts a rewritten reference's original as this
    instance's, so reruns stay idempotent and `purge-shared` can find it.
    `METISTRY_SECRET_*` is never taken for a retired shared-scope original.
  - `fetchModels` keeps what a listing says beyond the id (name, context,
    per-million price, tools) as `details`.

## 0.13.0

### Minor Changes

- 152022a: **Actors, resolved (T4-6).** Core implements the actor model F-2 froze: `resolveActor` composes the assistant, a crew or an external agent from its registry row, manifest, `identity.yaml` and `compute.yaml`; `describePermissions()` (beside `describeScope`) draws the permissions table — Resource × Read × Write, provenance per entry — by asking `may()` for every tool, so a line is a door that says yes; and `TOOL_PERMISSION_CELLS` encodes docs/ops/actors.md's tool→cell table beside `RULED_TOOLS`, with an enumeration test that parses the document. A crew's `model:` is now a compute reference (`<provider>/<model-id>`) or `same_as_assistant`; the legacy `haiku | sonnet | opus` resolve through `assignments.crews` for one release, and the crew runner resolves all three with the rule the actor states (`resolveCrewAssignment`). The console carries `permissions` on every `GET /api/agents` row, serves `GET /api/agents/:id/definition` (definition, compute, limits — read-only), and `POST /api/agents` refuses `kind: internal` before anything is written. `metistry agents list` prints the table and `metistry agents define <id>` (M12) edits a crew's prompt, model, effort and description, validated the way the console reads the file and refused when stale (`--if-sha256`). MetistryKit decodes the rows into the shared `PermissionRow` wire types and prints them with `PermissionRowText` — the CLI, the console and the Mac print one table.
- 090e821: **The Mac window's shell (T5-2).** The sidebar is the eight rows — Today · Chat · Activity · Work ▸ (Board · Projects · Artifacts) · Knowledge · Agents · Scheduled — with **Needs You** above them only while something waits, and Pinned below. The Needs You row carries the product's one badge (nothing at zero, the number to 99, then `99+`), the Dock carries the same label, and the row leaves only on the next navigation after the count reaches zero — never while the owner is on it (C110). The toolbar holds the brand mark, **+** (New Capture, ⌘N — dimmed until the composer lands) and the **Usage gauge** (three states from the instance's spend against its spending limits); the window's title is *Metistry* on every screen. Every shortcut is a menu item (C119): Go (⌘0 while Needs You is shown, ⌘1–⌘7, ⌘[ ⌘], ⌘K, ⌘F), Capture, Item, View, File ▸ New Conversation ⇧⌘N and Help ▸ Keyboard Shortcuts ⌘/, all from one `ShellCommand` table; single-letter items carry their key only while a list has focus. Labels template the configured name from `GET /api/identity` and never say "assistant". The doctor panel moved from the sidebar to its own window (Window ▸ Status). Each view is covered by an accessibility test that walks the real tree VoiceOver reads.
- f5c60e3: **The Mac app holds its stores, and O3 is enforced at the transport for every route (T5-1).** `AppModel.console` is a `ConsoleSession` per instance: one lazily started `metistry console session --stdio` child, `ReachabilityGate` in front of it, the fourteen §2.16 stores over the gate, the Phase-A `InstanceStore` over the same stores, and `CLIManagementRunner` for §2.2's verbs. The gate records the newest answer as the console's reachability — reported, never inferred — and while it is unreachable refuses every decision before it is sent, in components-01 §1.3's sentence; reads always go, and the appends O3 allows (capture, tick, defer, a rating) go too. `SectionModel` is one screen section over a store read (first load, stale-not-blank, `refreshIfDue`, `invalidate()` for live events) and is dropped on an instance switch together with any answer still in flight. `CLIManagementRunner` runs a `ManagementCommand` as one `metistry` invocation — the planned argument array is exactly what runs, a value rides stdin, a command cannot name its own `--product-dir` — and is not behind the gate, so M5 can restart a console that is down. Fixed: `ConsoleAPI.dispatchTask` now takes a `TaskDispatch` and sends the `brief` the route requires (it could only ever get a 400), `Room` reads `thread_id`, `artifact_id` and `version_id` as the text ids the console sends (every room's id was 0), and `GET /api/runs/export` over the session transport returns its NDJSON rows instead of one quoted string with no cursor (a non-JSON body now arrives as its bytes; a one-row export pretty-printed by the `console call` fallback reads as that row). A new test drives every store method through the production wiring — session child, gate, stores — against the fixtures.
- 98ad6d0: **The shared components every Mac screen draws with (T5-3).** `sources/kit/components/`: agent prose — the 2px gutter rule in a transcript, the `agent-quiet` wash everywhere else, the serif body, the configured name with the spark, *written, not retrieved*, and Good/Bad on anything with a `prose_id`; the agent chip, which prints the configured name for the `assistant` principal and never the id; the facet row in the one order (Priority · Due · Planned · Estimate · People · Links · State), priority as weight, an overdue Due escalating into the one state tint, at most three chips with the rest folded into `+N` and still spoken, states read from `row_flags`; the permissions table over F-2's `PermissionRow` (absence is the denial, the ask glyph, provenance in the cell, stacked at the accessibility sizes), with every mode word in `PermissionWords` — the CLI's *Allow · Ask First · Never* pending the owner's wording ruling — and the CLI's effective-action line word for word; the seven request body blocks of `REQUEST_BODIES` (choices ending in *Something else…*, a collapsed diff, a thread, before-and-after leading with the change, preview, proposed to-dos, an excerpt with both timestamps); the panel states, `partial`, the O3 fact note; the stale pill and band and `FirstPaint` (placeholders only on a first load, a wait over a second says what it waits for, a failed refresh stays on screen as stale); `UndoWindow` (ten seconds) and `CostConfirmation`, which cannot be built without a named cost and the act's own verb; and `ClockTime`, 12-hour everywhere. Each component is a presentation value and a view that draws it; `tests/kit/snapshots/` holds a text baseline per component in light, dark and the largest text, and the tests check every ink against the ground it is painted on, every control's VoiceOver words, and that every drawing grows longer, never wider. `metistryFont` makes the largest text real on the Mac, where SwiftUI ignores `dynamicTypeSize`.
- 5e8f8d1: A work row says what it is about (T1-1, C85). Migration `0026_work_description.sql` adds `work.description` (nullable text, durable). `TasksService.create` takes `description` and `update` takes it on the board arm, capped at `DESCRIPTION_MAX` (2,000 characters); blank is stored as none, and `Task.description` is `null` when nobody wrote one. `tasks_create` accepts it. `tasks_update` has no `description` key, so an agent sets a description at create and never edits it. The owner edits it with `PATCH /api/tasks/:id {"description": …}`, without a claim; `null` or blank clears it, and it cannot ride with a holder status. Every task route's `task`, the `board` query's rows and MetistryKit's `BoardCard` carry it; `TaskPatch` gains `description` and `TaskPatch.describing(_:)`.

### Patch Changes

- 2275d5d: **The activity query (T1-3).** `activity_feed` returns `ok` on every row:
  `false` where a run failed, `true` where it did not, and `null` where the
  source cannot fail. Failure is now a column instead of English inside
  `detail`. Routines are in the feed as a seventh group, `routine` (C43). A
  `routine_run` row appears once it has settled, dated by when it did. Its
  failure comes from `ok`/`error`, because a failed run carries no
  `meta.outcome` (T1-4), and its skip or what it wrote comes from
  `meta.outcome`. A `silent` tick is never a row. A new `turn_id` param returns
  every call one reply made. A request closed because its source changed reads
  *resolved at its source — nobody decided it here*, not *you decided
  resolved_at_source*. The PWA's chips are eight (Routines added), and the glyph
  takes `failed` from `ok`. MetistryKit's `ActivityFeedRow` decodes `ok`.
- 2434a18: The Compute pane's refusal reads the CLI's own reason again. Most `metistry compute …` verbs answer a failure by returning a pretty-printed `--json` object on stdout (`{"ok": false, …, "detail": "<why>"}`) rather than throwing, and the pane's fallback — "the last line of stdout" — was the closing `}` of that object, not the reason. `CLIDegradation.refusalMessage` (`cli-facts.swift`) now reads the trailing JSON first (an `error.message`/`error.code` envelope, or the bare `detail`/`error` string these verbs print) before falling back to the last non-empty line of stderr, then of stdout; `ComputeModel.refusal` and the wizard's `ComputeStepModel.reason` both call it, so a provider test, a model install/load and the wizard's step 7 all show the same thing.

## 0.12.0

### Minor Changes

- 0f4892f: `metistry console session --stdio`: `console call` held open as one long-lived child. The local owner token is resolved once and never printed (every output line is redacted against it); a non-loopback console or a missing token is refused before a line is read. Each JSON request line gets exactly one terminal line matched by id; `stream: true` on `GET /api/events` writes `{id, event}` frames until `{id, cancel: true}`. The Mac app's `SessionConsoleCallTransport` runs every console request through it (~1.5 ms each instead of ~141 ms for a process per request), fails in-flight calls when the child dies and restarts it on the next call, and falls back to `console call` on a CLI that predates the verb. `ConsoleErrorEnvelope.details` now keeps a 409's `reason` and the row as it stands.
- 2bcd356: **MetistryKit's store interface, and a fixture for every route it reads (F-7).** `sources/kit/stores/` declares one protocol per domain — Needs You, Today, Chat, Activity, Knowledge, Agents, Scheduled, Work, Artifacts, Usage, Settings, Capture, Events, Vault — with one method per row of the client API table, each naming its route; `ConsoleStores` implements all of them over any `ConsoleCallTransport`, and the event stream over `ConsoleEventTransport`, which `SessionConsoleCallTransport` already satisfies. `ManagementRunner` freezes §2.2's CLI verbs (a `ManagementCommand` can only hold one of them) and `LiveCaptureClient` the local recording bridge. `apps/console/scripts/record-client-fixtures.mjs` records one JSON per served route from a scratch console (in-process server, the scratch database, a `metistry init` temp instance, every outbound call faked) into `apps/macos/tests/kit/fixtures/`; the routes frozen ahead of their tickets carry hand-written contract fixtures the recorder holds their tickets to. Swift tests drive every store method against its fixture — the exact request the console accepted, and the reply it gave — and build a view with no console running; a console test holds the fixtures to the table.

### Patch Changes

- 5652446: **The design tokens drop `affirmative` / `on-affirmative`, and the token check now reads the colours that are actually painted.** Neither role has had a caller since Approve became the one accent fill (C92), so `--mt-color-affirmative` and `MetistryColorRole.affirmative` are gone from the generated CSS and Swift. `node ops/scripts/build-design-tokens.mjs --check` now also fails on a web CSS rule that paints an undeclared ink/ground pair, a hex colour in the web CSS or the design SVGs that is not a token, a quiet fill its own ink does not declare, and anything that maps the pinned accent to the system accent.
- c69abc3: **The owner can now see WHY an action's mode is what it is, not just what it is.** `effectiveActions()` resolved the (kind → mode) table but dropped the reason, so `metistry agents autonomy`, the console's registry panel and MetistryKit each had to recompute it to say whether a mode was set, defaulted, or clamped to the level's ceiling — and clamped is the one case where the owner's own setting is being overridden. Core adds `effectiveActionsDetailed()` beside it (`effectiveActions` is now a projection of it, so the two cannot drift), and every surface reads that one function instead: `metistry agents autonomy` marks each row set / dimmed-default / clamped-with-ceiling and says the modes as **Allow · Ask First · Never**; `GET /api/agents`'s `scope.autonomy` carries a `detailed` table beside the plain one, so a console never re-derives it; MetistryKit's `AgentRecord` decodes the same table into `actionsDetailed`.

## 0.11.0

## 0.10.0

### Patch Changes

- 975221b: **`metistry up` (and `update`) now writes a `metistry` shim, so there is
  finally something to run `metistry` BY NAME against.** A release install has
  no Homebrew formula and no npm global, so nothing ever put `metistry` on
  `PATH` — the only way to run one was the owner's own hand-written wrapper.
  `up`/`update` write a small, idempotent POSIX script to
  `<instance>/.metistry/state/cli/metistry` (mode `0755`) that already knows
  this install's product dir and instance dir, and re-resolves which of
  `current/` (a release) or the bare product dir holds the CLI, and which
  `node` to run it with, on every invocation — so a release flip or a freshly
  bundled runtime needs no re-write. `state/cli/` rather than `state/bin/`:
  the launchd shape's `state/bin/Metistry` is already the supervisor's own
  program-identity symlink, and macOS's default case-insensitive volume would
  make that the same directory entry as `state/bin/metistry` — a sibling
  directory avoids the collision outright. `writeCliShim` also leaves alone
  anything already sitting at the path that is not a symlink-free plain file
  recognisably its own — a foreign file is noted, never overwritten.
  
  `up` never puts it on `PATH` itself (invariant 2 — that is the operator's
  own hand): it prints the one `ln -s … ~/.local/bin/metistry` line that
  would, and `metistry doctor` gains an informational `cli on PATH` row
  (`ok`/`absent`, never a finding that fails the exit code) carrying the same
  line as its remediation.
  
  The Mac app's `RuntimeLocator` now also searches `~/.local/bin` and the
  active instance's own `.metistry/state/cli` when looking for a `metistry`
  on `PATH`, so it finds an install even before anyone has linked anything.

## 0.9.1

### Patch Changes

- 05e2e5b: **The vault's page list, through a named query — the third knowledge door,
  and the only one that is not a proxy.** `GET /api/knowledge/pages?area=&prefix=&limit=&offset=`,
  which #197 deferred because `seed/queries/` carried nothing to run. No
  migration: `0009_brain.sql` already added `title`, `description` and `draft`,
  and `0001` has `path`, `mtime`, `status`.
  
  **Which door a thing comes out of is settled by the schema, not by taste.** A
  page's bytes and a search ranking are not derived state — there is no column
  holding a note body — so those go to the reconciler's bridge. A page LIST *is*
  derived: `knowledge_files` is the reconciler's own index, rebuilt from the
  vault by a walk. So invariant 3 sends it through
  `seed/queries/knowledge_pages.yaml`, executed by `packages/queries`, and the
  route holds **no SQL of its own** — one that reached for `pool.query` would be
  a second read path into state.
  
  **Two filters that mean what they mean everywhere else.** There is no area
  column, and there did not need to be: everywhere in the system an "area" is a
  vault prefix (`Areas/Fsl`, which the agent registry validates and `underAreas`
  matches), so `area` is derived — the first two segments under `Areas/` at any
  depth, the top segment elsewhere, and `null` for a vault-root file like
  `now.md`, which is an answer rather than a gap. `prefix` is **segment-wise**,
  the same semantics an area grant has: `Areas/Health` covers `Areas/Health/…`
  and never `Areas/Healthcare/…`, because a substring match is how a prefix
  filter leaks. Ordered by `path`, which is the primary key, so `offset` walks a
  total order and no row ties or jumps between windows.
  
  **What no parameter can turn on.** Drafts are excluded by the same clause
  `mcp-brain` applies at every tier, so the owner's list and an agent's index
  cannot disagree about what a draft is; an unsettled `conflict` row is excluded
  because its title and mtime are not facts yet. And the route's own scope
  filter runs over the query's rows — the same `canSee` the search and page
  routes use — so a row in the index that is not vault CONTENT never reaches a
  client, the owner's included. The query is overlayable per instance (D4); the
  filter is not, which is why both hold the line. A row whose `path` is not a
  string is dropped rather than passed: a list entry whose scope cannot be
  decided is not a list entry.
  
  **There is no `total`, on purpose.** A count over the unscoped filter is
  precisely the "directory listing of what was filtered" the knowledge routes
  refuse to publish — a narrowed principal would learn how many pages it cannot
  see. Callers page until a window comes back shorter than `limit`. For the same
  reason a filter pointing outside the scope answers an empty `200` rather than
  a `400`: refusing `prefix=.metistry` by name would say which prefixes exist.
  Only the filter's shape is validated.
  
  MetistryKit gains the matching `knowledgePages` method, the
  `KnowledgePageList` / `KnowledgePageEntry` shapes and a `pages` store section
  beside `knowledge` — two sections, because browsing the vault and searching it
  are two questions and a search must not blank the list you were reading.
  
  The list is ordered by `path COLLATE "C"` — byte order, explicitly, rather
  than the database's own locale. A glibc locale collation ignores punctuation
  at the primary level, so `Areas/Health/sleep.md` sorts before
  `Areas/Healthcare/…` on one cluster and after it on another: same rows, same
  query, two different windows, and a client paging with `offset` would see a
  page twice or not at all depending on which machine the database was
  initialised on. CI (Linux) and the owner's Mac disagreeing is how it was
  found.
- dc4ce91: **The vault's link graph, through a named query — the fourth knowledge door
  and the last piece §6.1 left open.** `GET
  /api/knowledge/links?path=&limit=&offset=`, over
  `seed/queries/knowledge_page_links.yaml`. No migration: `0001_init.sql` has
  `knowledge_links (from_path, to_path, kind)` with the primary key on all
  three and an index on `to_path`, so both directions are one indexed lookup.
  The graph is derived state — the reconciler parses it out of the notes on
  every walk and re-resolves a note's edges whenever the note or the path set
  moves — so invariant 3 sends it through `packages/queries` and the route
  holds no SQL of its own.
  
  **One list, keyed by the other end.** `direction` is a column (`outgoing` =
  this page links there; `incoming` = that page links here) and `path` is
  always the far side of the edge. That is not a presentation choice: it is
  what lets one predicate decide every row. Two arrays would be two chances to
  filter them unevenly, and the filter is the point — **both ends are scoped**.
  The `path` parameter is checked before anything runs (a path the caller may
  not see gets the `404` a missing page gets: "this page has four backlinks" is
  a fact about a page), and every row goes through the same `canSee`. A page
  inside a grant that links *out* of it, and a page outside a grant that links
  *in*, both come back dropped rather than listed.
  
  **Never in the list:** an edge whose other end is a draft or an unsettled
  `conflict`, at either end and at every tier — the same rule the page list
  applies, so a draft cannot be discovered through the graph after being hidden
  from the list. Dropped rather than blanked, because a row saying "there is
  something here you may not see" is the disclosure the rule exists to prevent.
  **An unresolved wikilink stays**, marked `resolved: false` with a title
  derived from its own path: a note not written yet is how a vault gets
  written, and Obsidian renders it rather than hiding it.
  
  Ordered outgoing first, then by path in byte order (`COLLATE "C"`), then by
  `kind` — the link table's primary key read the other way round, so the order
  is total and `limit`/`offset` cannot repeat or skip an edge. The same target
  reached as a wikilink and as an embed is **two edges**, which is why the
  client's row identity is the triple and not the path. No `total`, for the
  page list's reason. The query is `expose: route`, so `/api/q/knowledge_page_links`
  answers the `404` an unknown name gets.
  
  MetistryKit gains `knowledgeLinks(path:limit:offset:)`, the
  `KnowledgePageLinkList` / `KnowledgePageLink` shapes with `outgoing` and
  `incoming` as views of the one list, and `isLastPage`/`nextOffset` beside the
  page list's.

## 0.9.0

### Minor Changes

- b2e9416: **The Mac app gains a typed client and a store for everything the owner
  surface offers, and the token still never enters the app's own process.**
  Phase A's non-visual half (`docs/product/app-ux-plan.md` §6): `ConsoleAPI`,
  `InstanceStore`, the wire shapes, and the sidebar's pins. No views, so nothing
  on screen changed yet.
  
  **One authenticated surface, and it is still the CLI.** `docs/ops/mac-app.md`
  wrote the condition for this before the code existed — "adding it is a CLI
  change first: a `metistry console call <METHOD> <path>` keeps the token out of
  this process entirely, which a token-printing verb would not" — and
  `docs/ops/cli.md` ruled what to do once that verb shipped: "the app … use[s] it
  rather than a second HTTP client". So every request is one `metistry console
  call`, a request body goes on **stdin** rather than argv, and the local owner
  token stays where the CLI found it. `console-sign-in-tests.swift`'s source scan
  — one file uses `URLSession`, no file sets a credential header, no file names a
  keychain API, no file opens a file — passes unchanged with the whole data layer
  in, which is the point: the guard was not relaxed to make room for this.
  
  **Refusals keep the words of the thing that refused.** `ConsoleError` decodes
  the standard envelope and adds two cases the CLI door has and HTTP does not —
  this install's CLI predating the verb, and no token or a non-loopback console,
  each carrying the CLI's own sentence because it already names the fix. A `401`
  is **unreachable** and a `403` is not: the console answered, and one route
  declined this credential. `namedField(among:)` attributes a refusal to a field
  the caller already sent, because the envelope is `{code, message}` and names
  its field in prose — nothing is inferred from a sentence's shape.
  
  **The store reports; it never infers.** Four states — loading, loaded, failed,
  stale — with the console's own `as_of` beside the value, and a failed refresh
  over data already on screen goes *stale and keeps it* rather than blanking a
  working pane. A background refresh is a flag rather than a fifth state, so
  there is nothing for a view to turn into a spinner (P2). And
  `allowsDecisions` is O3 in one place: while a section is unreachable, every
  decision, drag and dispatch refuses **before sending**, in a sentence.
  
  **Both reconnect cursors, and they are not the same mechanism.** The feed's
  `since` is an inclusive timestamp that de-duplicates on `(ref, ts, kind)`; the
  request queue's is an opaque cursor whose page is *everything that changed*, so
  a row answered on the phone leaves the queue instead of lingering in it.
  
  **Pins are per instance.** Project, board, page, saved search or agent, in the
  order they were dragged, filed in app preferences under
  `pinnedItems.<instance_id>` — so the same app against a second instance never
  shows the first one's sidebar, and an instance with no id yet holds them in
  memory rather than under a shared key. Nothing about pinning reaches the
  instance repo, Postgres or the vault.
  
  Fifty new tests against an in-process stub console — every shape decoded from
  hand-written fixtures, the envelope read back through the CLI's own stderr
  render, `401` vs `403`, both cursor folds, every store transition and the pins'
  round trip — with no network and no subprocess, so they run in `swift test` on
  CI as they stand.
  
  One limitation, named rather than worked around: `console call` puts the
  envelope on stderr for a `>= 400` and does not print the body, so a conflict
  `409`'s `reason`, `decision` and row do not survive. Phase A reads nothing that
  needs them; the queue's `if_unchanged` repaint does, and the fix is one line in
  the CLI rather than a second HTTP client in Swift.

## 0.8.1

## 0.8.0

### Minor Changes

- 342590b: **Settings → Compute, and the local model server in the menu bar.** The Mac app
  gains a seventh Settings pane over `metistry compute …` — providers (add from a
  template with the API key on **stdin**, test, remove, a non-ZDR badge on
  anything off this machine that claims no zero data retention), assignments
  (`default`, each tier, each `crew:<name>` — a model picker fed by `compute
  models list --provider`, effort as a segmented control), budgets (the
  instance's and each provider's: daily, monthly, `allow|stop|critical_only`), and
  a local-models section reading doctor's `local:lmstudio|ollama|llamaserver|applefm`
  rows with install, load/unload and a RAM figure labelled an estimate. Every
  control is one `metistry compute` verb with `--json`; the pane persists nothing
  (`compute.yaml` is the record) and re-reads on open. The add-a-provider sheet is
  the **wizard's own step 7 model**, so the key's single path to a child process's
  stdin is still one function. `assistant: absent` is shown where it can be acted
  on, quoting doctor's remediation, with one button — or none, where nothing one
  click could do would fix it.
  
  Two menu-bar changes come with it: the supervisor's children (`llamaserver`) are
  listed under **Services** with the same Restart · Stop · Start · View Log,
  because `metistry restart llamaserver` is the same four verbs a launchd job
  gets; and the `apple-fm` bridge row reads `serves foundation-model` once
  `compute.yaml` declares a provider that dials it.
  
  No CLI change was needed — every verb already had `--json`. One reader-side
  fact did: these verbs narrate through the same stream the JSON goes to, so the
  app now reads the **trailing** object out of prose-then-JSON stdout, in one
  place with a test. `applefm` joined the app's template list, which the CLI had
  had since the Apple FM provider landed.
- a4e106b: **The one background item is the app's now, and has a switch.** The Mac app
  registers the install's supervisor through `SMAppService.agent(plistName:
  "com.foldedspacelabs.metistry.plist")`, from the plist sealed inside
  `Contents/Library/LaunchAgents` — so System Settings › General › Login Items
  shows **one** row, "Metistry", with the agent nested under the app and
  attributed to Folded Space Labs, instead of a background item listed beside it
  that only a terminal could turn off. Settings → Services gains **"Run Metistry
  in the background"** beside the existing "Start Metistry at login", each with
  prose saying which is which: one opens a window, the other runs Postgres, the
  console, the reconciler, the assistant and any configured bridge.
  `requiresApproval` reads as ON with a button that opens Login Items, the status
  is always re-read from macOS after a write, and a `swift build` executable —
  which has no bundled agent — says so and points at the terminal path. Wizard
  step 5 passes `--register-via app` when the build carries an agent, and
  registers it *after* `up` has written the config and launcher file it reads.
  
  **The two registrars can no longer fight.** A terminal install still bootstraps
  the same-named agent itself. `metistry up` now asks launchd who owns
  `com.foldedspacelabs.metistry` before installing anything — the plist path and
  program `launchctl print` reports, which is live state rather than a marker
  file that goes stale when the app is deleted — and leaves an app-registered one
  alone, in one printed line, while still writing everything else that agent
  depends on. `metistry doctor` reports the owner on the supervisor's row
  (`meta.registrar`, `meta.registered_from`, and the probe text the app renders).
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

## 0.7.1

## 0.7.0

### Minor Changes

- 1ec60dc: The Mac app signs in to the local console without a ceremony, and never holds
  the token.
  
  - **"Signed in as owner (local token)"** in the Status header, Settings →
    Connections and beside the console row in the menu bar, from one
    `metistry console whoami --json` per launch and per instance switch. Five
    states, each with the CLI's own words and, where there is one, the exact
    command: signed in · this CLI has no `console whoami` (update it) · no local
    owner token (`metistry secrets sync --to env`, then restart the console) ·
    the console did not answer · 401, with **which** of the loopback rule and a
    stale value is likelier for this install's deployment shape.
  - **One client, and the authenticated half of it is the CLI.** The app does not
    read the login Keychain, does not open `<instance>/state/.env`, and sends no
    `Authorization` header anywhere — a test walks `apps/macos/sources` and
    asserts each of those rather than trusting a comment. The four HTTP routes it
    speaks are the console's public bootstrap ones and nothing else. It therefore
    cannot yet make any authenticated console call except `whoami`, and the doc
    says so: that is a CLI change first.
  - **Wizard step 6 is optional and reframed** — "your Mac is signed in
    automatically; enrol a passkey only for browsers and your phone" — with the
    enrolment-code path kept intact for those, and the `ASAuthorization` probe
    moved out of the main flow to Settings → Advanced, where a diagnostic
    belongs. A successful whoami satisfies the step; so does an enrolled passkey,
    because it is the same door.

## 0.6.0

### Minor Changes

- f343d67: The Mac app finishes its first run. All seven wizard steps now do something:
  step 1 installs the bundled runtime to a writable product directory, step 5 sets
  the deployment shape after showing you what it would do, step 6 enrols a passkey
  or says precisely why this install's origin cannot host a native one, and step 7
  guides the Claude sign-in in a real terminal and watches for the token to land.
  Settings gains a working "Start at login", and shows the instance id, the
  assistant's name, the versions and the secret list by asking the CLI rather than
  by reading its files.
