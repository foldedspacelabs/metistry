# @metistry-apps/console

## 0.14.2

### Patch Changes

- Updated dependencies [5fae5ae]
- Updated dependencies [38b481b]
- Updated dependencies [7d19782]
  - @foldedspacelabs/metistry-cli@0.14.2
  - @metistry-apps/collectors@0.14.2
  - @foldedspacelabs/metistry-artifacts@0.14.2
  - @foldedspacelabs/metistry-connections@0.14.2
  - @foldedspacelabs/metistry-core@0.14.2
  - @foldedspacelabs/metistry-mcp-brain@0.14.2
  - @foldedspacelabs/metistry-queries@0.14.2
  - @foldedspacelabs/metistry-tasks@0.14.2
  - @metistry-apps/routines@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [b80fa8e]
- Updated dependencies [4fec374]
  - @foldedspacelabs/metistry-cli@0.14.1
  - @metistry-apps/collectors@0.14.1
  - @foldedspacelabs/metistry-artifacts@0.14.1
  - @foldedspacelabs/metistry-connections@0.14.1
  - @foldedspacelabs/metistry-core@0.14.1
  - @foldedspacelabs/metistry-mcp-brain@0.14.1
  - @foldedspacelabs/metistry-queries@0.14.1
  - @foldedspacelabs/metistry-tasks@0.14.1
  - @metistry-apps/routines@0.14.1

## 0.14.0

### Minor Changes

- d92ea0c: **Calendar fields and the meeting note (T2-11).** The eventkit helper's
  `list_events` now reads each event's participants (name, address, answer, role,
  kind, whether it is the owner), organizer, iCalendar UID and recurrence, and
  the window it read; the invite body only when a request asks for it, which the
  bridge never does. `GET /events` keeps every existing field (`attendees` is
  still the list of names) and adds `event_id` — one occurrence: the identifier,
  plus the occurrence's original date when the event recurs — `series_id`,
  `ical_uid`, `participants`, `organizer`, `self_status` and `window`; it never
  carries `notes`, even from a helper that sends them. **The helper's binary
  changed: rebuild and re-sign it (`build:helper`), restart the calendar service,
  and re-grant Calendar if macOS asks.**
  
  Migration `0034_calendar_events.sql` adds `calendar_events` (one row per
  occurrence, every source, no invite-body column) and `sync_state`, both
  derived. A new sync, `eventkit-calendar` (every 5 min, today and the next two
  weeks, connection `eventkit`), fills it and removes a meeting cancelled inside
  the window. Two route-only named queries read it: `day_events` (one day in the
  owner's zone, every source, each attendee's one People page or none, the
  meeting note) and `calendar_event` (one event by id).
  `POST /api/meetings/:event_id/note` is served: it renders the owner's
  `Templates/Meeting.md` as `user` into `Journal/Meetings/<date>-<topic>.md` with
  `event_id:` in the frontmatter, once per event — every later call answers the
  first note's path.
- f01606b: **Close the Day (T2-8).** `POST /api/today/close {day, line?}` writes the daily note's `metistry:day` section through the reconciler's section operation as `user` — when the day closed, what was done, what moved and to when, and the owner's line for tomorrow, facts only and written whole on every close — then enqueues `plan-tomorrow` with the day it closed (`closedDay`, the routine's close shape from T3-7), one pass at a time, recorded as a `routine_run` with `meta.trigger: "close"`. The note is scanned with core's `scanNoteSection` before anything is sent: markers deleted, doubled or quoted in code are `409 section_missing` with the reason, nothing is written into the note, one `note` request (kind `knowledge`, from `console`) says why and is brought up to date rather than stacked on a second close, and the plan is still made. A `day` that is not today in `METISTRY_TZ` is `409 stale`; a missing `Journal/<day>.md` is `404` (the door never creates the owner's note). The console's vault client gains `section()` over `POST /vault/section` and now passes `section_missing` (and `local_only`) through as themselves instead of `not_available`. New named query `day_close` (`expose: route`): done from the index's `done_on` plus the Tick door's own record, moved from the Defer door's record, which now stores `to` (the day or `someday`) on its audit row. Core marks the route served. The seeded `Templates/Daily.md` places the markers under `## Today · Metistry`; existing instances keep their own template (the first close appends the heading and markers to a note that has none).
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
- 851e08a: **Connections P1: the files, the pooled client, `metistry connections` and the
  read routes (plan §2.6, M13, T4-8a).** A new package,
  `@foldedspacelabs/metistry-connections`, reads `.metistry/connections/<name>.yaml`
  against the connection-type registry — `ok`, `absent` (provider not installed;
  nothing deleted) or `failed`, never fatal — and adds four rules to F-3's
  schema: no key-shaped literal anywhere a value is typed, no `{{ secret.x }}` in a
  URL, on a command line or in a path. Its `ConnectionPool` holds one MCP client
  per connection (stdio or Streamable HTTP), and refuses before dialling a tool
  the file does not list, one at Never, one at Ask First without an approval, and
  a call whose arguments carry the caller's own bearer; a command gets only the
  environment its file names, never the host process's; every HTTP request goes
  through core's `guardedFetch` with `connection:<name>` as the grantee and is
  pinned to the connection's origin (no redirect followed); every answer is
  redacted. `checkConnection` is its `check()` (ok · degraded · absent · failed).
  The CLI adds `metistry connections list|show|add|set|policy|remove|test`
  (protected writes through the reconciler; `add` dials once and applies the
  owner's Q15 defaults) and one doctor row per connection, never `failed`. The
  console serves `GET /api/connections` and `GET /api/connections/:name` to the
  owner — names, never values, and no dial. Core adds
  `INSTANCE_LAYOUT.connectionsDir`.
- 23b963a: Events become requests (T2-9, C96). **A failed routine** raises one `report`
  per error signature, carrying when it last ran cleanly and when it failed and
  a *Try Again* act; it clears as `resolved_at_source` the next time the routine
  succeeds. **A missing secret** — a `requires.env` variable or the engine's
  `auth.secret` — raises one request of the new stored kind `secret_failure`
  (read as access) naming every component it stopped, cleared once the variable
  is set. **A sync conflict copy** is now a `review` holding both versions (the
  note as it stands and the copy, with their hashes) instead of a path-only
  report, and clears when the copy is gone. All three are core mirrors: one row
  per subject while it waits, and an answer is not asked again until what it was
  about has recovered. The runner takes `requests` (default `runnerRequests`
  over its own db; `null` raises none).
- ed7f5c2: **File history (T10-4): `GET /api/knowledge/history`, `GET /api/knowledge/version`,
  and the reconciler's `GET /vault/show`.** F-1's two frozen rows are served. History
  is a note's commits, newest first, followed across renames — each naming the file
  as it was called then, what the commit did to it, and the committer's
  `Brain-Source:`/`Metistry-Run:`/`Metistry-Turn:` trailers (T10-1) as provenance.
  Version is the note's bytes at one commit, from the bridge's new `GET /vault/show`
  (`git cat-file blob`, base64 on the bridge). Both are the owner's alone and notes
  only: a protected or non-vault path is refused at the console and again at the
  bridge, for either bearer, and a `sha` that is not 7–64 hex characters is refused
  at both before it can reach git's argv; a commit not on the vault's branch is
  `404`. `GET /vault/log` gains the trailers on every entry and, with a path,
  `path` and `change` — additive. Both fixtures are re-recorded from their contract
  shape (a superset of it).
- ea2e876: **Restore a file (T10-5): `POST /api/knowledge/restore {path, sha, seen_sha}`.** F-1's
  frozen row is served. The door never writes: it raises one Needs You request — an
  improvement drawn as a before and after (the note now, the note at `sha`) — and
  answers `202` with the request as `GET /api/proposals` serves it, so Knowledge can
  show it inline. Only Approve restores: the version's bytes, re-read from the
  bridge's `GET /vault/show` and checked against what the request showed, are written
  back as `user` — a new commit, *Restore <path> to <date>* — compare-and-swap on the
  file as the request showed it. `seen_sha` is the file's content hash as rendered
  (`""` for a note that is gone); a file that moved is `409 stale` at the raise and
  again at Approve (nothing written, the request still waiting). Notes only — a
  protected or non-vault path is refused for the owner too — and the owner's alone:
  every other principal is refused in the route, and Approve restores only a request
  this console raised whose `source` (`restore:<path>@<sha>`, one per note and
  commit) names the same path and commit; a restore-shaped payload on any other row
  restores nothing and is never read as a prompt improvement. `POST /api/proposals/:id`
  answers with `restored`, and its decision SELECT now carries `source` (additive).
- 50a455d: **Linear: the connection and its sync (plan §2.6, §4 Q22, T4-24).** The
  product ships its first `tracker` connection type, `seed/connection-types/linear/`
  — a personal API key, sent as `Authorization: <API_KEY>` to
  `https://api.linear.app` and nowhere else, capability `read`.
  `@foldedspacelabs/metistry-connections` adds what a sync opens to read a
  builtin provider's connection (`openSyncHttp`, `instanceSyncOpener`): the
  connection `scheduled.yaml` names, else the one its provider's sync reads; a
  `fetch` pinned to the provider's origin that follows no redirect; every
  request through core's `guardedFetch` as `connection:<name>`, the key filled
  only for a host on its *Sent only to* list; and the `linear` provider's
  read-only GraphQL client (a document that is not a `query` is refused before
  it leaves). *Used by* now names the sync a provider declares. The new `linear`
  collector reconciles the issues assigned to the owner into `work`
  (`external_ref linear:<KEY>`, state, priority and url in `meta`), closes the
  ones that leave with why, and raises one `task` mirror per assigned issue that
  clears at source; `addIssueToToday` captures `- [ ] <title> do <today>
  linear:<KEY>` through the capture service, idempotent per issue. The console
  hands collectors the opener; `metistry secrets sync --to env` delivers a
  sync-read connection's secrets as `METISTRY_SECRET_<NAME>`.
- 0dd4ccb: **Meeting refs and people emails (T1-10).** Migration `0029_meeting_refs.sql`
  adds two derived tables, `vault_meeting_refs (event_id, path)` and
  `people_emails (email, path)`. The reconciler's walk fills them from a meeting
  note's frontmatter `event_id:` (notes under `Journal/Meetings/`, the user's
  directory at the tool) and from a People page's `email:` (one address or a
  list, trimmed, `mailto:` dropped, lowercased; only pages the user owns), and
  rebuilds both whole every cycle. `POST /reconcile` reports `meeting_refs` and
  `people_emails`. The new named query `people_by_email` (`expose: route`)
  returns the one People page that claims an address, and nothing when none or
  more than one does: an unmatched attendee never resolves to a page.
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
- 9dcc405: **Project grants inherited (T4-7).** A crew's or external agent's effective reach is now its own grant ∪ the own grant (0032) of every project its row lists — core's new `inheritGrants` (the widest tier; its own areas first, then each project area its own do not cover; `queries` if any holds it), with the added reach reported as `via`. The console's door resolves it per request (`authenticateAgent` reads the membership and the projects' grants in one statement) and never writes it into the agent's row, so leaving a project removes what it gave on the next request. `resolveActor` takes `projectGrants` (`listProjectGrants`) and the permissions table marks each inherited entry with the new provenance `{kind: "project", project}` — *via project <slug>* in `permissionRowText`, the console's panel and MetistryKit (`PermissionProvenance.project`). A project's stored grant is re-checked fail closed; the assistant inherits nothing.
- fcfbadf: **Project grants table (T1-13).** `PUT /api/projects/:slug` takes a `grants`
  field — `{tier, areas, queries?}`, migration `0032_project_grants.sql` — a
  project's own read grant, validated by the identical `validateGrants` an
  agent's own `PUT /api/agents/:id/grants` already uses (external rules: the
  bare vault is refused, and every area must be vault CONTENT — `.metistry/`,
  `Artifacts/…` and a traversal are refused). Nothing reads the column yet: a
  member's effective reach unioning its own grants with its projects', "via
  project" provenance, is T4-7.
- cf9f564: The PWA hears changes as they happen (T7-7, design-build-plan §2.20). One
  `EventSource` on `GET /api/events` while signed in — only when `GET
  /api/identity` lists the `events` capability — and the view on screen
  refetches through its own route when an event names it: `needs_you.changed`
  repaints the bell from the count it carries and refetches the Needs You list;
  `message.new` and `turn.progress` the chat; `work.changed` the board, rooms and
  Today; and so on through the catalogue (`web/live.js` `viewsFor`). A burst
  refetches each view once, never under a field being typed in, and not behind a
  hidden page. The browser's own reconnect resumes with `Last-Event-ID`; a stream
  it gave up on reopens after a backoff and reloads what is visible, as `resync`
  does. The chat, Activity, Board and count polls are now the fallback only:
  their timers run while the stream is down and none runs while it is up. The
  stream's state is on `<body data-stream>` for the offline band. Today gains
  `refresh()` — the day and the rail again, without starting a new look.
- 7b1ef93: The PWA's Today and Needs You (T7-3a, screen 18 §2–§3), each in its own
  module (`web/today.js`, `web/needs-you.js`, sharing `web/lib.js`) instead of
  inside `app.js`. **Today** is one column in the Mac's order: the Morning Brief
  (or its folded line) with the Standup collapsed and Copy Standup, Next Up from
  30 minutes before a meeting, then the spine — past items folded above a Now
  rule, meetings at their time, the day's tasks and work in the owner's order in
  the gap before the next one — and the rail last: Agents and Since You Last
  Looked. It reads `GET /api/today` (T2-7) and writes only through the Tick and
  Defer doors, with the line's text as seen and an `Idempotency-Key`; a `409
  stale` shows the line as it stands. The interim last-24h tiles and review list
  leave Today. **Needs You** draws each request with its type's own answers from
  `request` — the primary, Revise, Decline outlined in the neutral surface
  (never red; the inline `#7a3b3b` is gone), then Later; Select switches to a
  compact list where swipe right approves and swipe left declines, and a card
  with Before and after opens instead of swiping; questions step one at a time
  with Send Answers; from 600px the list pushes the card, side by side at 900px.
- 6bbe2c5: The PWA's Work, Knowledge and More ▸ Agents (T7-3b, screen 18 §5), each in its
  own module (`web/work.js`, `web/knowledge.js`, `web/more.js`) instead of inside
  `app.js`. **Board** is one column at a time on a phone, picked by chips that
  carry each column's count; from 600px the columns snap side by side, and at
  900px it is the Mac's board, drags and all. **Every tap opens the card**
  (C84), pushed full-screen with its description, where it is, who holds it and
  its room — a push from the card. A drag becomes **Move to…**: an action sheet
  listing every other column, where a move the service would accept is a button
  saying what it does and one it would refuse is listed disabled with the reason
  (Done and Release are offered only on a card you hold — the holder arm would
  refuse them anywhere else). **Projects** rows carry the mode chip in the
  glossary's words (Autonomous · Review · Review · over budget) and the day's
  spend bar; the kill switch is on the pushed project. An **artifact's
  comments** become counts on their highlighted lines, opening a sheet with
  reply and Resolve. **Knowledge** replaces the placeholder: the fold, then Needs
  Your Eye (drafts), then Areas, with search; an area pushes its pages and a page
  its note and links. **More ▸ Agents** groups Yours and Connected; an agent's
  permissions are one row per resource with Read and Write lines, its actions in
  Allow · Ask First · Never, and Edit Permissions opens the grants form.
  Registering an agent and rotating its token (reach `local`) are no longer
  offered on the phone — they are defined on the Mac. `md.js` gains
  `renderMarkdownBlocks` (each block with its source lines).
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
- 406bacb: Resolve a conflict (T2-10, plan §2.11). `POST /api/knowledge/conflicts/resolve
  {path, keep, seen_sha}` is served: the owner keeps the note as it stands
  (`mine`) or takes the sync tool's copy (`theirs`), written as `user` through
  the reconciler's new `POST /vault/conflicts/resolve`, for a copy the index has
  in `conflict` and nothing else. `seen_sha` is the side being given up, as the
  review showed it; a mismatch, or a path not in conflict, is `409 stale` with
  the conflict as it stands (`null` when there is none). The side given up is
  committed before it is discarded, so history keeps it after the client's
  ten-second Undo (C136); a settle refused for any other reason is written on the
  conflict's review as `payload.error` (C45). The review clears at its source and
  the copy's index row goes at once. The reconcile sweep now commits the deletion
  of a conflict copy that history holds. Core gains `knowledgeConflictSource`
  (and its two constants), the conflict mirror's subject, which the console and
  the reconciler now share.
- 448857f: The router's policy, in shadow (T9-2, docs/ops/dynamic-router.md §2–§5). An
  optional `rules.yaml` `policy:` block — the owner's table over the features,
  first match wins — picks an operation from a closed vocabulary
  (`ROUTE_OPERATIONS`: `answer`, `fast_path:<query>`, `retrieve:knowledge`,
  `retrieve:queries`, `delegate:<crew>`, `tools`) and a tier from the owner's
  allow-list, inside the owner's caps. Core gains `router-policy.ts`:
  `validateRoutePolicy` (every load-time refusal names its field; `mode: serve`
  is refused until T9-4), the pure `decide()`, `boundDecision()` (the session
  rule and the registries, at run time), the planner's closed `COMPLEXITY`
  classes, and `scoreRouteFeatures` — `intent` and `complexity` on the one
  on-machine scorer (`assignments.intent`), only when a row reads them,
  concurrently, each inside the consultation's deadline. `scoreChoice` moves
  from the collectors into core (`score-choice.ts`) with its off-machine refusal
  intact, and `completeJson` resolves through the same `resolveOnMachineCall`.
  The console wires the table as `routePolicy`: every fall-through and override
  is consulted after the 202 and recorded on the `route` row with the features
  it read; the served route is unchanged. Fixes T9-1's answer check, which
  refused every `fast_path:<query>` choice as garbage.
- 7028e37: **The Scheduled doors (T3-3).** F-1's eleven Scheduled rows are served:
  `GET /api/scheduled` lists every routine and sync with each field's origin
  (`default` · `profile` · `yours`), its next and last run, the **default** tag and
  why a component is held; `GET …/{routines,syncs}/:name` adds its history (the
  `routine_history` query, now covering a sync's `collector_run` rows and marking
  Run Now by `trigger`). The owner sets a routine's schedule, pauses and resumes it,
  resets it to default, and sets a sync's cadence, pause and raise toggles — each one
  edit of `.metistry/scheduled.yaml` through the reconciler as `user`, comments kept,
  validated against the closed schema and the component's manifest before it is
  written, never a manifest and never an invalid file. A New Routine's actor, task and
  read-only per-run grants are reach `local` (`403 local_only` for a passkey session).
  Run Now runs one component through the runner under the owner's pause and the
  preflight, budget included. The runner now hands each run its resolved config
  (`ctx.config`). Core exports `timeOfDayFields`. All eleven fixtures are re-recorded
  (a superset of their contract shapes).
- 66ef5c7: Stale requests (T2-14). A card never acts on something the owner didn't see:
  every row `GET /api/proposals` serves carries `subject` — `{basis,
  fingerprint}` of what the request is about as it stands (a pull request's head
  SHA, a task's line text, the work row's `updated_at`; core's
  `requestSubjectOf`) — and `POST /api/proposals/:id` with
  `if_unchanged.subject` refuses an answer whose subject has moved: `409 stale`,
  before any consequence runs, nothing written on the row, the row repainted in
  the body. Opt-in like `seen_at`; the PWA sends it on every single-row answer.
  With a subject, `seen_at` no longer counts the work row, so a render's `ts` is
  not refused forever once the work row has moved since the row was raised.
- 440d0d1: Three strikes and a Stop limit (T3-12, C135, C133). **A component that fails
  three times in a row stops** — `DEFAULT_MAX_STREAK` is now 3
  (`METISTRY_RUNNER_MAX_STREAK` still overrides it; `metistry doctor` reads the
  same default) — and raises ONE Needs You `report` per (component, error
  signature) per streak: a routine's waiting failure report is turned into the
  stop (`title` *stopped after 3 failures*, plus `stopped: {failures, limit,
  since, at}`) rather than joined by a second row, and a collector raises its
  stop as `collector-failed:<name>#<signature>`. Both clear at their source on
  the next clean run. **A Stop limit** that pauses routines raises ONE `report`
  per budget window (`budget-stop:<scope>:<window>:<stamp>@<limit>`), naming
  every routine it paused, with *Raise* — cleared once the budget no longer
  stops them. Core's `budgetMiss` now returns the `BudgetMiss` it hit (a
  `PreflightMiss` with `hit`); the runner's requests seam gains
  `collectorSucceeded`, `componentStopped`, `budgetStopped` and `budgetResumed`.
- 61d9546: **Today's routes (T2-7).** `GET /api/today?date=` composes one day from four route-only named queries — `vault_tasks_query` under Today's preset (the open lines owed on or before the day, `due <= <date> or do <= <date>`, then the lines ticked on it; `#someday` lines leave the open list), `day_work` (waiting on you, blocked, due, overdue, closed on the day), `today_order` and `day_events` — plus the paths of the day's brief, standup and plan, `null` until written. `GET /api/vault-tasks?where=&order=&limit=&offset=` compiles any filter with `compileTaskFilter` over the whole vault and answers `400` with the parser's own refusal, naming the token, for anything outside the grammar. `PUT /api/today/order {date, task_keys}` replaces one day's drag order in one statement and refuses — `400`, naming them, nothing written — any key `GET /api/today` does not serve for that date. The day is `METISTRY_TZ`'s, never `TZ`'s (UTC when unset). All three are owner-only (`session · local_owner`); core's client-API table marks them served. `vault_tasks_query`'s `places` is now a number (it was a bigint string).
- 935901e: **Roll back (T10-6): `metistry vault rollback`, `POST /api/vault/rollback` and the
  reconciler's `POST /vault/revert`.** History is preserved, always: a rollback is ONE
  new commit, made as `user`, that undoes a commit (`git revert`), puts every path back
  as it was at a moment (`--to <date>`), or puts one file back (`--file`, before its
  last change or `--to` a moment) — computed off the working tree with `merge-tree`
  and a scratch index, applied by `merge --ff-only`, never a reset or a force. Undo is
  rolling back that commit. A re-walk and the push policy follow.
  
  Every rollback waits for Approve in Needs You. The route (F-1's frozen row, now
  served; reach `local`, so a passkey session is `403 local_only`) asks the reconciler
  for a preview and raises one request carrying it — the commits it undoes, the files
  it puts back; Approve runs the revert pinned to the previewed history and held to
  the previewed change set (`409 stale` otherwise). The reconciler refuses the revert
  for any principal but `user`, from either bearer. Configuration — every
  `.metistry/` path, `CLAUDE.md`, `README.md` — is left as it is and named
  (`skipped_config`) unless `include_config`, which a real revert admits only from the
  owner-class bearer: `metistry vault rollback --include-config` raises the request,
  waits for Approve and makes the change itself (`--request <id>` resumes the wait).
  `POST /api/proposals/:id` answers a rollback with `rolled_back`; its decision SELECT
  now carries `source` (additive, as T10-5's). `Git` takes an `indexFile` option (a
  scratch `GIT_INDEX_FILE`), and the committer a `holdHistory` hold.

### Patch Changes

- 211b408: **Connections through the proxy: the lazy pair (T4-8b).** `/mcp` gains `connections_list` and `connections_call` — the one way an agent reaches the owner's connections (plan §2.6, C115). `connections_list` names the connections lent to the caller and the tools it may call without dialling anything; `connections_list { connection }` fetches those tools' own definitions on demand, so no upstream tool is ever on the eager surface. `connections_call` runs one through an injected `ConnectionsProxy` (the host's pooled client): secrets filled only at egress, the caller's bearer handed over solely so a call carrying it is refused, the answer redacted and sanitized. This release runs a connection's Reads set to Allow; Never and unlisted tools are "no such tool", Ask First and Changes things are refused with the reason. Every call — refusals included — is one `runs` row of kind `connection_call`, read back by the new route-only `connection_calls` named query.
  
  Core: `Resource` gains `{kind: "connection", door, name, offered}` and `may()` decides it (`mayConnection`): the assistant reaches every connection; an agent needs the connection offered to agents **and** named in `scope.connections`; a crew needs that **and** the new `connections` tool group in `uses`. A miss hides as "no such connection" (new reason `connection_required`). `RULED_TOOLS` and `TOOL_PERMISSION_CELLS` carry the two tools. The eager count moves 26 → 28 with its reason beside `COUNT_ACKNOWLEDGED` in `ops/scripts/check-tool-surface.mjs`; the assistant's `BRAIN_TOOLS` follows the manifest.
- 9fe2e7e: **`POST /api/knowledge/restore`'s 202 serves the proposal as `GET /api/proposals` does (W2 checkpoint D2).** Its `proposal` now carries `subject` (null — no work row behind a restore), the same served shape rollback's 202 already answered with; the recorded fixture is re-recorded.
- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [50a455d]
- Updated dependencies [339d465]
- Updated dependencies [ac377ed]
- Updated dependencies [ece2585]
- Updated dependencies [9dcc405]
- Updated dependencies [fcfbadf]
- Updated dependencies [fce1f33]
- Updated dependencies [406bacb]
- Updated dependencies [448857f]
- Updated dependencies [7028e37]
- Updated dependencies [66ef5c7]
- Updated dependencies [0cba4a2]
- Updated dependencies [440d0d1]
- Updated dependencies [61d9546]
- Updated dependencies [5855540]
- Updated dependencies [935901e]
  - @foldedspacelabs/metistry-core@0.14.0
  - @metistry-apps/collectors@0.14.0
  - @foldedspacelabs/metistry-cli@0.14.0
  - @foldedspacelabs/metistry-mcp-brain@0.14.0
  - @foldedspacelabs/metistry-connections@0.14.0
  - @metistry-apps/routines@0.14.0
  - @foldedspacelabs/metistry-artifacts@0.14.0
  - @foldedspacelabs/metistry-tasks@0.14.0
  - @foldedspacelabs/metistry-queries@0.14.0

## 0.13.0

### Minor Changes

- 42021b1: Access hardening (T2-2). **Revise on an access request can only grant less**
  (C40): `accept_with_changes {area}` is refused with a `400` unless the area is
  the one asked for or a folder under it, and the refusal writes nothing — no
  grant, no override, no `payload.error`; it carries `asked`. **The answer
  carries the prior tier** (C41): `granted.prior_tier` on the response and on
  `payload.granted`. **The escalation ceiling leaves a record** (C42):
  `request_access`'s third ask after two declines writes a `runs` row of kind
  `access_ceiling` (exported as `ACCESS_CEILING_KIND`, with `AccessCeilingMeta`),
  and `GET /api/agents` lists them as `access_ceilings`, grouped per (agent,
  area), until the agent holds the area or is revoked.
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
- 152022a: **Actors, resolved (T4-6).** Core implements the actor model F-2 froze: `resolveActor` composes the assistant, a crew or an external agent from its registry row, manifest, `identity.yaml` and `compute.yaml`; `describePermissions()` (beside `describeScope`) draws the permissions table — Resource × Read × Write, provenance per entry — by asking `may()` for every tool, so a line is a door that says yes; and `TOOL_PERMISSION_CELLS` encodes docs/ops/actors.md's tool→cell table beside `RULED_TOOLS`, with an enumeration test that parses the document. A crew's `model:` is now a compute reference (`<provider>/<model-id>`) or `same_as_assistant`; the legacy `haiku | sonnet | opus` resolve through `assignments.crews` for one release, and the crew runner resolves all three with the rule the actor states (`resolveCrewAssignment`). The console carries `permissions` on every `GET /api/agents` row, serves `GET /api/agents/:id/definition` (definition, compute, limits — read-only), and `POST /api/agents` refuses `kind: internal` before anything is written. `metistry agents list` prints the table and `metistry agents define <id>` (M12) edits a crew's prompt, model, effort and description, validated the way the console reads the file and refused when stale (`--if-sha256`). MetistryKit decodes the rows into the shared `PermissionRow` wire types and prints them with `PermissionRowText` — the CLI, the console and the Mac print one table.
- c0bb21e: C82's rename: the per-area work rollup (`work` grouped by area — open / in progress / blocked / closed this week) is now **Areas**, not Projects, so it never reads as the same thing as the per-project rollup with modes, budgets and a cap. The seed gains `areas_overview` (identical SQL to `projects_overview`, which stays loaded as an alias for one release); the dashboard's Work ▸ Projects sheet now labels the two panels Projects and Areas, and the morning brief's section is `📂 Areas:`.
- 8d71dfc: The board has five columns (T1-2). `board.yaml`'s `column` is `backlog`,
  `assigned`, `in_progress`, `blocked` or `done`, and each label is the word its
  value says: Assigned (no longer "Addressed to") and Blocked. **`needs_you` is
  now `blocked`** and the `reported` column is gone. A Done card whose crew
  reported back carries `reported: true` instead. Each card also gains
  `thread_count`, the message count of its room, and `blocked_by`,
  `blocked_by_task` and `blocked_by_task_open`, the human todo it waits on,
  ported from `day_work`. `board_projects` counts the same five columns.
  `board` is now `expose: route`, because `blocked_by_task` is a line of the
  owner's own notes. The owner still reads it at `GET /api/q/board`. An agent's
  `queries_run` and the capture owner token get the unknown-query answer.
- 942372e: **Captures from the apps (T2-1): `POST /capture` records `source: "app"` for
  an owner credential.** A passkey session or the local owner token — the Mac
  app and the PWA, never a request field — is now distinguished from the
  Shortcut's `owner_token` and an agent bearer, both of which keep `"http"` as
  before (the bridge's own `capture` tool still records `"mcp"`). Activity can
  now tell the owner's own captures apart. F-1's frozen row is served; its
  fixture (`apps/macos/tests/kit/fixtures/post-capture.json`) is re-recorded.
- 95fb504: The Defer door: `POST /api/vault-tasks/:task_key/schedule {do | someday, seen_text, path?}` writes one `do <date>` or one `someday` on one line of the owner's note through the vault bridge as `user`, with the note's hash — the English spelling `formatTaskLine` emits, never a Tasks-plugin glyph (K6). It is the Tick door's discipline throughout: the line found in the note by the walk's own key, `409 stale` with the line as it stands when the text moved or the line was ticked, dropped or already deferred so, refusals before any read for `.metistry/`, dot-directories and `Artifacts/`, and `Idempotency-Key` replays. A line whose day is a `⏳` or a Dataview `scheduled::` is refused rather than given a second day. Core gains `setTaskScheduled` (proved by re-parsing its own output), the `someday` token in the task grammar (`ParsedTaskLine.someday`, `SOMEDAY_TOKEN`) and a `someday` flag in the filter vocabulary; migration `0036_vault_tasks_someday.sql` adds the derived `vault_tasks.someday` column, which the reconciler's walk writes and `vault_tasks_query` filters and flags on.
- bf33ee1: The owner's three knowledge reads (T1-6): `GET /api/knowledge/fold?date=` (the newest `Journal/Fold/YYYY-MM-DD.md` on or before a day — newest by the date in its name — and its outgoing links, a link to a draft or conflict dropped), `GET /api/knowledge/drafts?limit=&offset=` (every `status: draft` note, never a conflict) and `GET /api/knowledge/areas` (each area's `<area>/README.md` description, settled page count, last change, and whether the newest fold names it). Each is a new `expose: route` named query — `knowledge_fold_latest`, `knowledge_drafts`, `knowledge_areas` — and each route refuses every principal but the owner itself, before any SQL runs, so a draft is never reachable at the generic `/api/q/<name>` door or through `/mcp`. Core marks the three client-API rows served.
- bd29463: **Live changes: `GET /api/events` is served.** Migration `0035_event_notify.sql` adds `metistry_notify()` and an `AFTER INSERT OR UPDATE` trigger on `runs`, `proposals`, `work`, `inbox`, `artifact_comments`, `outbound_messages` and `agents` that notifies `{table, op, id}` and nothing else (a no-op update is silent; an agent's heartbeat is throttled to one a minute). The console holds one `LISTEN`, gathers a burst for 250 ms, maps it to the catalogue's typed events and streams them as Server-Sent Events to the owner — a passkey session or the local owner token; an agent bearer and the capture token get the uniform `403`. Every payload passes a guard before it is numbered: exactly its type's fields, each an id, a name, a state or a count. `Last-Event-ID` replays exactly the missed events from a ring of the last 1,000 (or ten minutes), or sends `resync`; a dropped `LISTEN` reconnects by itself and sends `resync`; the credential is re-checked at every 20 s heartbeat; `METISTRY_EVENTS_MAX_STREAMS` (32) caps open streams with a `429`. `GET /api/identity` advertises `events` only while the route is served and the hub is wired.
  
  The daily **Update Check** routine (`routines/update-check/`) asks the release feed for the newest release and, when it is newer than the running console, writes the row the console streams as `release.available {version}`; an unreachable feed is a `skipped:` row, never an alert. `@foldedspacelabs/metistry-core`: `GET /api/events` is `served` in the client API table.
- 9ac7949: **The Needs You count (T1-7): `GET /api/needs-you/count`.** F-1's frozen row
  is served — `{waiting, oldest_ts, as_of}` through the new `pending_count`
  named query (`expose: route`), the same pending-and-not-snoozed filter `GET
  /api/proposals` applies, so the sidebar row and the Dock badge can never
  disagree with the queue's own length. Always exactly one row; a snoozed
  proposal (`later`) is not counted, same as the queue it mirrors. Owner reach
  only — the capture owner token is refused `403`, not served as if the route
  did not exist.
- 3f9d719: **Per-instance secrets (plan §2.14).** A secret is an owner-chosen lowercase
  name, a value in the login Keychain under service `metistry:secret:<name>`
  and account `<instance_id>` — one instance, one account, no shared scope —
  and a policy in `.metistry/secrets.yaml`: the hosts it is sent only to, who
  may use it (On · Ask · Off per connection and actor), and an expiry. It is
  referenced as `{{ secret.name }}`.
  
  `@foldedspacelabs/metistry-core` adds the store and its contract:
  `InstanceSecrets` (bound to one `instance_id`; nothing on it takes an
  account), the `KeychainBackend` seam and `memoryKeychain()` for tests,
  `secretService`/`secretAccount`, the strict `secrets.yaml` schema
  (`parseSecretsFile`, `secretGrant`), the resolver (`fillSecretRefs`, all or
  nothing; `parseSecretReference`, with `env:NAME` for one release),
  `describeSecrets` over a presence-only probe, and `INSTANCE_LAYOUT.secrets`.
  
  `@foldedspacelabs/metistry-cli` adds `metistry secrets set | replace | remove
  | hosts | grant` and `list --named`: the value on stdin into this instance's
  Keychain account, the policy through the reconciler as the owner.
  `sync | mint | list | purge` are unchanged, except that `purge` now also
  deletes the instance's named items. `securityKeychain`/`securityPresence`
  drive `security` for the new store; `Keychain` delegates to them with the
  same argv.
  
  `@metistry-apps/console` serves `GET /api/secrets` (reach owner): names,
  hosts, grants, expiry, presence and last used — never a value; the console
  holds a presence probe and nothing that can read an item. *Last used* comes
  from the new `secret_last_used` named query (`expose: route`) over
  `runs.meta.secrets`.
- 4cba65a: **Profile facts and the standup move (T3-4).** `Me/profile.md` is read in one place: core's `profileFacts` (the two facts a schedule follows), `profileFrontmatter` and `profileWeekdays`, which `plan-tomorrow`'s guard and the console's runner now use too; `resolveScheduleDays` gives a schedule's days with their origin, and a profile with no working days is refused `no_working_days`, never guessed. `standup_days`/`standup_time` move to the Standup routine: the console reads them once into `routines.standup.schedule` in `.metistry/scheduled.yaml` (as `user`; refused until the console holds that authority, T3-2) and raises one *Tidy Me/profile.md* request with the before and after. Approving it writes exactly the "after" as `user`, and is refused `409 stale` if the file changed since; Decline leaves the lines, ignored, and `metistry doctor` names them in one info line (an ok row may now carry `meta.info`). `lastMirror` (core) says whether a subject was ever raised. The seeded profile drops the two keys.
- be25ade: **Prose feedback (T1-12; B7 of `today-hub-requests.md`).** A 👍/👎 on any
  piece of generated prose that is not a chat reply — a meeting briefing, Next
  Up's one line, a revision explanation. `POST|DELETE /api/prose/:id/feedback`
  (session · local_owner only, exactly like a reply's rating) keys `:id` on a
  `runs.id` rather than minting a second id scheme: every model turn already
  logs one row there, so it is the one id already stable wherever prose is
  produced. `prose_feedback` (migration `0031_prose_feedback.sql`) is a sibling
  of `reply_feedback`, not a widening of it — one upsert per `runs` row,
  revisable, deletable, durable. `reply_feedback` and
  `POST|DELETE /api/messages/:id/feedback` are unchanged.
- 5ad6f93: The PWA reads F-5's request type table (X-5). `GET /api/proposals` now carries
  `request` on every row — core's `describeRequest`: type, word, body, answers,
  decisions — additively, beside the stored columns. The PWA draws the word it
  is served and its local `REQUEST_TYPE` / `TYPE_LABEL` copies are gone, so a
  kind the table does not know reads as a report rather than its stored kind.
  Skip is bulk-only (K2): no row offers it; it stays on the selection bar and
  its `s` shortcut.
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
- b5ed326: The route record, in shadow (T9-1, docs/ops/dynamic-router.md §6). Every
  `POST /message` the console routes now writes one `runs` row of kind `route`
  AFTER the 202: the served kind, the cheap features (`words`, `attachments`,
  `thread_turns`, `recent_failures`, `reask` — never the text), and what a local
  policy would have chosen beside what the rules served. No policy ships yet, so
  every consultation reads `absent`; the seam (`routePolicy` on the console's
  config) is consulted under a 400 ms deadline, and a policy that answers,
  throws or never resolves leaves the served route, the 202 body and the reply
  byte-identical. New named query `route_features` (`expose: route`) supplies the
  thread facts. `route_report` gains the fifth kind `policy` (0 until T9-4) and
  the `policy_*` rows; `metistry compute route-report` renders them under the
  baseline's verdict and carries them as `policy` in `--json`.
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
- 49579af: The session archive table (migration `0030_session_archive.sql`, ephemeral — a
  30-day cache in Postgres, lost on `docker compose down -v`): one row per turn
  of every session, chat included — the system prompt as sent, the messages,
  and the tool calls with arguments and results, redacted (the writer is
  T3-9). The seed gains `session_detail` (`expose: route`): a session's turns
  in full, oldest first, filterable to one `turn_id`, with expired rows never
  returned — Run detail's conversation (`GET /api/sessions/:id`, T2-17).
- a1f1113: The session archive is written (T3-9). The engine appends every finished turn — chat and machine-enqueued alike — to `session_archive`: the system prompt as sent, the messages that turn added, and each tool call with its arguments and result, all through `core/redact.ts` inside the store itself (`apps/assistant/src/archive.ts`), with `expires_at` 30 days out and `folded_at` NULL (the session fold's queue). The turn handle is minted by the drain before the call, so the in-flight `runs` row, every tool call's `_meta` and the archived row share one `turn_id`; the turn row also carries `meta.session_id`. A failed archive write never fails a turn — it lands in the run's notes. The new `session-purge` routine (daily) deletes what has expired and anything older than its `retention_days` (Scheduled config, 1–30, default 30; anything else is refused with the field named). `POST /api/sessions/purge` (reach `local`, served) is Purge Now: without `confirm: true` it deletes nothing and names the sessions not yet folded; with it, it deletes every archived turn up to the preview's `as_of`, audited.
- 24a9ddb: The Tick door: `POST /api/vault-tasks/:task_key/check {checked, seen_text, path?}` writes exactly `[x]` and `done <date>` on one line of the owner's note through the vault bridge as `user`, with the note's hash — and Undo (`checked: false`) is the same door, the reverse. The line is found in the note by the reconciler's own key, judged against the text the client rendered (`409 stale` with the line as it stands), and refused before anything is read when its note is not a knowledge note (`.metistry/`, a dot-directory, `Artifacts/`). `Idempotency-Key` replays the first answer. Core gains `setTaskChecked` (the one edit, proved by re-parsing its own output), `taskLinesOf` / `locateTaskLine` (the walk's keying, held to `extractTasks` by a test), `replaceLine`, `taskHashKey` and `TASK_KEY_RE`; the seed gains the `vault_task_by_key` named query (`expose: route`).
- 8c9dde6: **Turn progress and sessions (T2-17): `GET /api/turns/:turn_id/progress`,
  `GET /api/sessions/:id`.** F-1's two frozen rows are served. The first reads
  `turn_progress` — every tool call one assistant turn has made so far, oldest
  first; a blank or unknown `turn_id` is `calls: []`, never a refusal. The
  second reads `session_detail` — one row per turn of an archived session,
  oldest first, narrowed to one turn with `?turn_id=`; a session that has
  never existed, expired, or been purged answers `404`. Both fixtures
  (`get-api-turns-turn_id-progress.json`, `get-api-sessions-id.json`) are
  re-recorded from their hand-written contract shape.
- 8217e01: **Variables (plan §2.14, M14).** Plain shared values in
  `.metistry/variables.yaml`, referenced as `{{ variable.name }}` in connection
  files and agents' instructions. Core adds `parseVariablesFile`,
  `fillVariableRefs` (all or nothing, one pass, `{{ secret.x }}` left for the
  egress fill), `describeVariables` and the refusals: a key-shaped value (*Store
  as Secret*), a secret's name, a value that templates, and — ruling 2 — a
  schedule or a time, by name or by value. They hold at the parse, so a
  hand-edited file carrying one does not load anywhere, and a refusal names the
  variable, never the value. The CLI adds `metistry variables set|unset|list`
  (set also refuses a value equal to one of the instance's own secrets); the
  console serves `GET /api/variables` — name, value, read by, used in — to the
  owner. `INSTANCE_LAYOUT.variables` and redact's `isSecretKeyName` are new.
- 37f0ed2: **The vault's sync policy and status (T10-2, plan §2.21).** `deployment.yaml` gains a `vault:` block — `push: after_commit | manual | {every: N}`, `pull: {every: N}` (1m…24h; no pull "never"), default after_commit and 5m — merged per key over the D4 overlay (core's `vault-sync.ts`). The reconciler schedules the committer's sync (T10-3) on it and re-reads the file when it changes: after_commit pushes after a flush that made commits and retries only what is unpushed, every N pushes on the interval when something is unpushed, manual never pushes; pull integrates every N; a standing conflict stops scheduled pushes. The committer already records push, pull and conflict; the schedule adds `commit` — one `vault_sync` run per flush that made commits, `meta.state = commit` — so `vault.sync` fires for all four states. The bridge serves `GET /vault/status`; the console serves it to the owner as `GET /api/vault/status`, strictly parsed. `metistry vault settings [--push …] [--pull …] [--yes]` shows and writes the policy (M18, a protected write through the reconciler as `user`), and doctor gains a *vault sync* row (ahead, behind, last push, conflict). `METISTRY_PUSH_SCHEDULE` still overrides `push` for this release, and says so everywhere it applies; `.env.example` no longer sets it.
- 5e8f8d1: A work row says what it is about (T1-1, C85). Migration `0026_work_description.sql` adds `work.description` (nullable text, durable). `TasksService.create` takes `description` and `update` takes it on the board arm, capped at `DESCRIPTION_MAX` (2,000 characters); blank is stored as none, and `Task.description` is `null` when nobody wrote one. `tasks_create` accepts it. `tasks_update` has no `description` key, so an agent sets a description at create and never edits it. The owner edits it with `PATCH /api/tasks/:id {"description": …}`, without a claim; `null` or blank clears it, and it cannot ride with a holder status. Every task route's `task`, the `board` query's rows and MetistryKit's `BoardCard` carry it; `TaskPatch` gains `description` and `TaskPatch.describing(_:)`.

### Patch Changes

- 88e890d: C45 at every consequential door of `POST /api/proposals/:id`: an answer whose
  consequence is refused or fails — the improvement overlay write, an action's
  service call, Approve as Work's `work` row, an enrolment's approval, an access
  request's grants write — leaves the request pending with `payload.error =
  {code, message, decision, at}`. Before, only the action path wrote the error;
  the others left the row pending but silent, and approving an enrolment whose
  agent had been revoked settled it `approve` while letting nobody in (now a
  `404` that stays pending). A consequence that throws stores `internal` with no
  detail. `apps/console/test/c45.integration.test.ts` tests every door.
- 3d2e818: **Groups and sources (T1-8, migration 0027).** A request can now mirror something that lives elsewhere: `proposals.source` holds `{kind, external_ref, person}`, and a unique partial index over the pending rows makes one subject one row — `raiseMirror` (core) inserts with the matching `ON CONFLICT … DO NOTHING` and returns the waiting row's id on a second raise, so two raises for one PR make one row. `resolveAtSource` closes a pending mirror as `decision = 'resolved_at_source'` when its source changes, and matches nothing without a `source`. A `proposals_source_shape` CHECK refuses a source without a non-empty `kind` and `external_ref`, which would otherwise dodge both the dedupe and the expiry. `proposals.group_id` is the card several rows are answered as (a meeting's Accept All). The morning brief's 14-day expiry now skips every row with a `source` — a mirror never expires. The `pending_requests` named query returns `source` and `group_id`.
- 3a1ff8c: **The assistant's identity is the owner's to change, and every protected write is on the record (T2-16).** `metistry identity set [--name] [--mention] [--mark] [--dry-run] [--json]` (M10) changes `.metistry/identity.yaml` through the protected write — the reconciler as `user`, with the owner bearer. Every field is validated before anything is read or sent (a one-line name of at most 40 characters with no `{{`/`}}`, an `@kebab` mention, a single-glyph mark), the edited text is read back before it goes, and a refusal writes nothing. Only the changed lines are rewritten, so comments and `voice: >` keep every byte. The mark is the file's existing `icon:` key; a new name brings its mention along when the mention was the one `init` derived. The reconciler now records every protected-path write, delete and rename it accepts as a finished `config_write` run (`meta {path, op, from?, caller, principal, message}`), whichever door made it, and `activity_feed` shows those rows in the `run` group with the principal as actor — so a rename appears in Activity. The fixture recorder seeds one, and `get-api-q-activity_feed.json` is re-recorded.
- 1141155: **The PWA has the shell screen 18 drew: five tabs, + and the bell in the header, and sheets.** Under 900px the eleven-button emoji strip is gone. In its place are five tabs (Today · Chat · Work · Knowledge · More), drawn with the design's glyphs, and none of them ever carries a badge. The Needs You count lives on the bell in the header, which opens Needs You as a sheet. + opens Capture as a sheet. From 600px a usage gauge joins them and opens Usage. Work's children (Board · Projects · Artifacts) are a segmented control. Activity (the feed's name since N1), Agents, Usage and Settings sit under More, and each More row pushes with a back button. A large title collapses into the header as you scroll. From 600px content is capped at the reading measure, sheets become centred dialogs, and the board's columns scroll sideways and snap. At 900px the PWA takes the Mac's layout: a toolbar, the sidebar in the Mac's order, and the Needs You row carrying the count instead of the bell, present only while something waits (C110). The old dashboard is split across its new homes: Today (the last 24 hours and reviews), Work ▸ Projects and the Usage sheet. The app now boots after every declaration, which fixes the home tab not painting on first load.
- Updated dependencies [42021b1]
- Updated dependencies [2275d5d]
- Updated dependencies [152022a]
- Updated dependencies [c0bb21e]
- Updated dependencies [8d71dfc]
- Updated dependencies [942372e]
- Updated dependencies [732039b]
- Updated dependencies [95fb504]
- Updated dependencies [b89bb73]
- Updated dependencies [df37d39]
- Updated dependencies [3d2e818]
- Updated dependencies [4451f77]
- Updated dependencies [3a1ff8c]
- Updated dependencies [6592f91]
- Updated dependencies [bf33ee1]
- Updated dependencies [bd29463]
- Updated dependencies [ff95350]
- Updated dependencies [9ac7949]
- Updated dependencies [739564d]
- Updated dependencies [3f9d719]
- Updated dependencies [4cba65a]
- Updated dependencies [be25ade]
- Updated dependencies [c38dc4e]
- Updated dependencies [b5ed326]
- Updated dependencies [a927e61]
- Updated dependencies [06c854e]
- Updated dependencies [ed8f802]
- Updated dependencies [ec21783]
- Updated dependencies [49579af]
- Updated dependencies [a1f1113]
- Updated dependencies [24a9ddb]
- Updated dependencies [8c9dde6]
- Updated dependencies [b0c61f8]
- Updated dependencies [8217e01]
- Updated dependencies [37f0ed2]
- Updated dependencies [336778b]
- Updated dependencies [5e8f8d1]
  - @foldedspacelabs/metistry-mcp-brain@0.13.0
  - @foldedspacelabs/metistry-cli@0.13.0
  - @foldedspacelabs/metistry-core@0.13.0
  - @metistry-apps/routines@0.13.0
  - @metistry-apps/collectors@0.13.0
  - @foldedspacelabs/metistry-tasks@0.13.0
  - @foldedspacelabs/metistry-artifacts@0.13.0
  - @foldedspacelabs/metistry-queries@0.13.0

## 0.12.0

### Minor Changes

- 7bf6db6: **The client API, version 1 — one contract for every client, as data and as a
  document.** `@foldedspacelabs/metistry-core` exports the route table
  (`CLIENT_API`: method, path, reach, principals, idempotency, `409` reasons,
  cursor, and whether it is served yet — 120 rows: every route the console
  serves, and every route §2.1 of the design plan freezes ahead of its ticket) with `matchRoute`, `servedRoute` and `noRouteMessage`; the live-changes
  catalogue (`EVENT_CATALOGUE`, the payload types in `EventPayloads`, every
  event's reach `owner`); `API_VERSION` and the `Metistry-API-Version` header
  name; and `events` joins the `CAPABILITIES` vocabulary.
  
  The console answers `api_version: 1` in `GET /health` and `GET /api/identity`
  and the version header on every response. It reads the table before it
  dispatches anything to the owner: a route the table does not list as served is
  a `404` that names the routes beside it, so a handler cannot become an
  undocumented door and a route frozen ahead of its ticket stays unserved until
  it lands. `docs/ops/client-api.md` is the contract in words (it replaces
  `docs/ops/console-api.md`, now a pointer); a conformance test holds the table
  to the server — every served row reaches a handler, nothing unlisted is
  served, each row admits exactly the credentials it records — and a document
  test holds the table to the document line for line.
- 2bcd356: **MetistryKit's store interface, and a fixture for every route it reads (F-7).** `sources/kit/stores/` declares one protocol per domain — Needs You, Today, Chat, Activity, Knowledge, Agents, Scheduled, Work, Artifacts, Usage, Settings, Capture, Events, Vault — with one method per row of the client API table, each naming its route; `ConsoleStores` implements all of them over any `ConsoleCallTransport`, and the event stream over `ConsoleEventTransport`, which `SessionConsoleCallTransport` already satisfies. `ManagementRunner` freezes §2.2's CLI verbs (a `ManagementCommand` can only hold one of them) and `LiveCaptureClient` the local recording bridge. `apps/console/scripts/record-client-fixtures.mjs` records one JSON per served route from a scratch console (in-process server, the scratch database, a `metistry init` temp instance, every outbound call faked) into `apps/macos/tests/kit/fixtures/`; the routes frozen ahead of their tickets carry hand-written contract fixtures the recorder holds their tickets to. Swift tests drive every store method against its fixture — the exact request the console accepted, and the reply it gave — and build a view with no console running; a console test holds the fixtures to the table.
- 56be405: **The reach gate: minting an agent bearer is the owner on this Mac.** The
  console reads reach `local` off the client API table and enforces it before
  any handler runs: a `local` route admits the local owner token from a loopback
  peer and nothing else, and a passkey session — even one from `127.0.0.1` — is
  refused `403 local_only` with a message naming the route and the Mac app, and
  audited. `POST /api/agents` and `POST /api/agents/:id/rotate` are now `local`:
  a new credential is a boundary change. The local owner token from any other
  peer is the uniform `401` it always was; the capture owner token and agent
  bearers keep their uniform `403 forbidden`. `metistry connect` mints through
  the local owner token and is unaffected; the legacy PWA's agent panel can no
  longer register or rotate an agent.
  
  `@foldedspacelabs/metistry-core` adds the `local_only` error code (`403`),
  `isLocalRoute` and `localOnlyMessage`. The client API conformance test now
  checks every row's reach for every credential kind.

### Patch Changes

- 5652446: **The design tokens drop `affirmative` / `on-affirmative`, and the token check now reads the colours that are actually painted.** Neither role has had a caller since Approve became the one accent fill (C92), so `--mt-color-affirmative` and `MetistryColorRole.affirmative` are gone from the generated CSS and Swift. `node ops/scripts/build-design-tokens.mjs --check` now also fails on a web CSS rule that paints an undeclared ink/ground pair, a hex colour in the web CSS or the design SVGs that is not a token, a quiet fill its own ink does not declare, and anything that maps the pinned accent to the system accent.
- c69abc3: **The owner can now see WHY an action's mode is what it is, not just what it is.** `effectiveActions()` resolved the (kind → mode) table but dropped the reason, so `metistry agents autonomy`, the console's registry panel and MetistryKit each had to recompute it to say whether a mode was set, defaulted, or clamped to the level's ceiling — and clamped is the one case where the owner's own setting is being overridden. Core adds `effectiveActionsDetailed()` beside it (`effectiveActions` is now a projection of it, so the two cannot drift), and every surface reads that one function instead: `metistry agents autonomy` marks each row set / dimmed-default / clamped-with-ceiling and says the modes as **Allow · Ask First · Never**; `GET /api/agents`'s `scope.autonomy` carries a `detailed` table beside the plain one, so a console never re-derives it; MetistryKit's `AgentRecord` decodes the same table into `actionsDetailed`.
- 3c966aa: **Captures the rules cannot place are triaged by intent, locally, with the
  decision in `rules.yaml`.** `scoreChoice()` lands beside `completeJson()` —
  same provider resolution, same money rule, different request fields — and
  `inbox-drain` gains a third tier between its rules and its JSON-schema tier:
  one scored answer token over the closed intent enum, on-device, with a
  confidence. The model supplies a fact; a table in the collector and a threshold
  in the owner's own `.metistry/rules.yaml` decide what happens about it. Every
  verdict lands on the proposal and in a `runs` row, including the discarded
  ones. Both halves must be configured — a model in `compute.yaml`, a threshold
  in `rules.yaml` — and with either missing the drain is byte-identical to the
  build before this existed, which is a test rather than a promise.
  `metistry-eval intents` scores the owner's own labelled messages and **fits**
  the threshold to the pre-registered bar instead of anybody choosing one.
- 851bef1: **The PWA stops recomputing what the server already resolved.** The Agents panel prints the effective action table from `scope.autonomy.detailed` — the same table, in the same words, as `metistry agents autonomy` — instead of a local copy of the defaults, ceilings and clamp. The status list keeps all four check states apart: `degraded` is its own amber and `absent` reads *not configured* in grey, never *failed*, under a one-line summary. A task's own title is no longer title-cased on the feed; every tinted fill is its declared `*-quiet` token; agent prose is set in the tokens' serif stack; and every clock time is 12-hour with AM/PM, whatever the device's locale.
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
- 82edf6f: **`metistry compute route-report` — where your messages actually go, as one
  command.** PoC-20 phase 0's baseline
  (`docs/research/2026-09-21-intent-classification-tier.md` §5.2): the share of
  real messages the deterministic router placed as `/note`, as a `fast_path`
  answer, as an explicit tier override, or that fell through to the default
  model tier — and, among the fall-throughs, their length and their commonest
  opening words, which is the shortlist to write new `fast_path` rules from.
  The verdict is the research's own exit rule with your number in it:
  fall-through under ~40 % and the answer is an extra regex, not a classifier.
  
  A new seed query, `route_report`, is the one read path into it (invariant 3);
  `GET /api/q/route_report` answers the same rows. It is counts only — no
  message text, no thread, no vault path, and an opening word is kept only when
  it is a plain word or a `/command` — so it is safe on the generic door. The
  command calls no model, dials no provider and writes nothing.
- Updated dependencies [2080ce5]
- Updated dependencies [7bf6db6]
- Updated dependencies [ac8a137]
- Updated dependencies [d60074f]
- Updated dependencies [0f4892f]
- Updated dependencies [95129a8]
- Updated dependencies [c69abc3]
- Updated dependencies [9c9eee6]
- Updated dependencies [3c966aa]
- Updated dependencies [aafc41a]
- Updated dependencies [1edc2f7]
- Updated dependencies [56be405]
- Updated dependencies [d930fba]
- Updated dependencies [82edf6f]
- Updated dependencies [73977f8]
- Updated dependencies [a8ccdfc]
- Updated dependencies [87fc443]
  - @foldedspacelabs/metistry-core@0.12.0
  - @foldedspacelabs/metistry-cli@0.12.0
  - @metistry-apps/collectors@0.12.0
  - @foldedspacelabs/metistry-mcp-brain@0.12.0
  - @metistry-apps/routines@0.12.0
  - @foldedspacelabs/metistry-artifacts@0.12.0
  - @foldedspacelabs/metistry-tasks@0.12.0
  - @foldedspacelabs/metistry-queries@0.12.0

## 0.11.0

### Minor Changes

- 4f43f9c: **Access requests, after the owner read them: you see everything, an agent may
  escalate once, and the assistant may ask.** Three rulings of 2026-09-19 on the
  `request_access` loop.
  
  **Your own access is never narrowed by a rule about agents.** The area
  validator that refuses `Artifacts/…` is now `validAgentAreaGrant` — the
  prefix shape plus "an agent read path would actually serve it" — and
  `validAreaPrefix` is the shape alone. The refusal is typed where an agent's
  grant is typed (the grants form, `request_access`), because an `Artifacts/`
  grant is inert: every knowledge read path refuses it, so it reads in the
  registry like access and gives none. Your own artifacts are untouched and
  still `GET /api/artifacts`, over the real vault; and where the knowledge door
  cannot serve one — it reads the index, which has never walked `Artifacts/` —
  it now points you at the door that has the bytes instead of saying "no such
  page". An agent asking for the same path still gets the one uniform sentence,
  byte for byte the same as for a path that is not there.
  
  **A decline is told to the agent, and it may escalate exactly once.** Asking
  again for an area you declined no longer files a second identical row and no
  longer vanishes into a dedupe: the tool answers with the decision you gave —
  declined, when, your note — and offers `escalate: true` with a fuller reason.
  That writes ONE new proposal flagged `escalated` with the prior id on it, and
  Needs You renders *asked again after a decline*. Decline that too and the area
  is closed at the tool: a third ask is refused with "ask the owner directly".
  One open ask per (agent, area) throughout, and the flag comes off the record
  rather than the caller's word for it. Enforced at the tool, not prompted.
  
  **The assistant may ask now.** It was refused because `ensureInternalAgent`
  replaces an internal row's grants from `METISTRY_ASSISTANT_AREAS` at every
  console start, so an approval would have been silently undone. Approving an
  `access_request` for an internal row now also records the area in
  `agent_grant_overrides` (migration 0023, additive), which `ensureInternalAgent`
  merges on top of the configured areas on the way in. Configuration stays the
  floor; the approval survives the restart; revoking the credential clears its
  approvals. A crew is still refused at the decision — its scope is a manifest
  file, and that is an edit, not a grant.
  
  Cost on the surface every agent pays: 40 definition tokens for the escalation
  (one optional boolean and a clause), 4,224 → **4,264** against the 5,000 line.
  The tool count is unchanged at 26.

### Patch Changes

- 4a778f9: **One decision function.** P0 and P1 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, commissioned
  by the owner's "can we simplify the grant/access controls surface and make it
  more consistent?" and approved 2026-09-20. **No behaviour change**, held by a
  golden test rather than by care: every refusal's `(code, message)` is asserted
  byte-identical to `origin/main`.
  
  **P0 — the move.** `canSeeUnder`, `underAreas`, `validKnowledgePath`,
  `areaOf`, `SCOPE_REQUIRED` and `scopeRequired` leave
  `packages/mcp-brain/src/knowledge.ts`; `canSee`, `grantedScope`,
  `OWNER_SCOPE`, `NO_SCOPE`, `filterHits` and `filterPages` leave
  `apps/console/src/knowledge-routes.ts`. Both now live in
  `packages/core/src/access.ts` and both files re-export them — mcp-brain's with
  a `@deprecated` note, for one release. The console's authorization rules were
  being served out of one BRIDGE's package (§2.9); a second bridge would have
  had to import a sibling bridge to get them.
  
  **P1 — `may(principal, verb, resource): Decision`.** Every door in §1.4 asks
  it: `/mcp`'s knowledge, queries, tasks, action and crew tools; the console's
  agent 403, its management gate, `GET /api/q/<name>` and `/api/knowledge/*`.
  Each check that used to live in a handler is now a case in one table that
  returns the same code and the same sentence it returned before — so the file
  reads as a catalogue of the five dialects §2.5 found, which is the point:
  unifying them is one reviewable diff here instead of fourteen strings in
  eleven files.
  
  A refusal carries a closed `reason` (`scope_required`, `tier_required`,
  `queries_required`, `role_required`, `autonomy_required`,
  `membership_required`, `not_member`, plus `not_exposed` for the route-only
  query and `not_knowledge` for a path that is not vault content) and, where a
  remedy already existed in prose, a machine-readable `needs`: the area a
  `request_access` would name, or the autonomy entry the user would raise. The
  wire envelope is unchanged — `error.code` and `expose` are exactly what they
  were (invariant 8).
  
  **Storage does not move**: registry rows for external agents, the environment
  for the instance's own assistant, the manifest for a crew. `may()` decides and
  never writes; every widening still goes through the console's one grants door
  and its one audit row (invariant 2), and the `Role × Verb × Resource` table is
  CODE in `core`, never loadable from a file (invariant 10).
  
  **Two tests ship with it.** `packages/core/test/access.golden.json` is the
  committed catalogue of every `(code, reason, message, needs)` a door can
  answer with, each entry carrying the wording it had at `origin/main` and the
  `file:line` it was read off. `packages/mcp-brain/test/may-surface.test.ts`
  walks all 27 tools × the five roles asserting every pair is decided, that no
  tool is usable by nobody, and — by a grep over the package's source — that
  `kind ===` / `tier ===` appears in exactly one file, the credential →
  principal mapping.
  
  `role: "crew"` exists and nothing produces it yet: `authenticateAgent` still
  collapses a crew's row to `external`, which is P2's job. The owner is still
  decided by the rules rather than short-circuited (P4). Neither is changed
  here.
- 1bf5c76: **A crew's toolset is enforced at the door.** P2 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
  2026-09-20. **One behaviour change, and it is the point of the phase** — read
  the next paragraph before you upgrade an install that runs crews.
  
  **What changes for a running crew.** A crew names TOOL GROUPS in its manifest
  (`uses:`), and until now that list was applied by the process that dispatched
  the run: `apps/assistant/src/tools.ts` filtered `tools/list` and refused an
  unlisted call with the text `"mcp__brain__tasks_comment" is not in this run's
  tool list`. `/mcp` had never heard of `uses` — `AgentPrincipal` carried no
  such field — so the door admitted those calls. Five of the eight groups
  (`rooms`, `artifacts`, `tasks`, `capture`, `requests`) had no server-side gate
  at all; the only thing holding them was a `Set.has` in another process. Now
  the console resolves a crew's `uses` from the manifest it loaded, attaches it
  to the principal at authentication, and the door refuses anything outside it
  before the tool body runs:
  
  ```json
  { "error": { "code": "forbidden",
               "message": "tasks_comment is not in this crew's toolset — writer holds knowledge, requests (`uses:` in its manifest, a protected path in the user's hand: docs/ops/crews.md). Report what you needed instead of retrying." } }
  ```
  
  One `runs` row on the crew's own id, the uniform envelope, `reason:
  not_in_uses` in `may()`'s decision. The runner's client-side list stays as
  **defence in depth** — the model is still not offered a tool it cannot use —
  but it is no longer the control, and the comment at that filter says so.
  CLAUDE.md's rule over all the others is "enforce at the tool, never by
  prompting"; a filter in the caller is neither.
  
  **`crew` is a real role.** `agents.kind` has stored three values since Phase 5
  (`crews.ts` writes `'crew'`) while the console collapsed anything not
  `internal` to `external` at authentication, so a crew reached `/mcp`
  indistinguishable from a foreign agent (§2.3). `authenticateAgent` now passes
  the row's own kind through, `principalOf` maps it to the `crew` role that
  `may()` has had a table for since P1, and three things follow: the toolset
  gate above, a `crew` that can no longer reach `request_access` at the door
  (it is a never-tool, so it is in no group), and a `source` on the principal
  that is the crew's manifest rather than a fourth prose reconstruction of
  "your scope is configuration, not a grant".
  
  **Migration `0025_agent_role.sql`** (additive; rollback note in the file): a
  CHECK holding `agents.kind` to the three values it already stores, and a
  nullable `grant_source` column recording which of the three places a row's
  grants came from — `registry` (the owner's hand), `environment` (`.env`,
  replaced at every console start), `manifest` (a crew's `scope:`). NULL on
  existing rows and read as `registry`. Nothing decides on it: `may()` never
  reads it.
  
  **Nothing else moved.** Every other refusal is byte-identical — the golden
  catalogue (`packages/core/test/access.golden.json`) asserts it entry by entry,
  and the one changed entry carries both what the caller used to say and what
  the door says now, so the behaviour change is a reviewable diff rather than a
  sentence in a PR. Misuse tests ship with it (invariant 8): a crew bearer
  refused a non-`uses` tool at `/mcp` with no client filter in the loop, a crew
  whose manifest cannot be read holding NO tools rather than all of them, an
  external agent unable to become a crew through a body or a header, and the
  CHECK refusing a fourth kind.
- 0718a30: **The fold gets the vault reader, so `Templates/Fold.md` renders.** A wiring
  gap between #246 and #247: the runner's `ComponentCtx` grew `queries` and
  `vault` for `plan-tomorrow`, but `knowledge-fold`'s `FoldCtx` reads the
  template through `reader`, a field `ComponentCtx` never carried — so every
  fold on every instance took the pre-template fallback note regardless of
  whether `Templates/Fold.md` was stamped.
  
  `apps/console/src/runner.ts` gains `routineCapabilities`, the one place
  `ComponentCtx`'s `queries`, `vault` and `reader` are built from what
  `main.ts` already has, and `ComponentCtx` itself now carries `reader`.
  `vaultReader` — the `VaultReadable` → `TemplateReader` adapter — moves from
  `plan-tomorrow/run.ts` to a shared `routines/vault-reader.ts` so the runner
  builds the exact adapter `plan-tomorrow` already trusted, rather than a
  second implementation of "a refusal reads as absent" (§6.4). No behaviour
  changes for an instance without the reconciler bridge configured, or without
  `Templates/Fold.md` in its vault — both still take the documented fallback.
- b6586de: **One vocabulary, one renderer, and the owner is never refused their own
  vault.** P3 and P4 of
  `docs/research/2026-09-19-grants-and-access-simplified.md` §4, approved
  2026-09-20. P4 carries the **owner-visible change** below; P3 changes what
  refusals SAY, not what they decide.
  
  **P3 — one wording per reason.** §2.5 found five dialects across fourteen
  refusal sites. `REFUSAL` in `packages/core/src/access.ts` is now one sentence
  per `reason`, built in one place: the shape is one per reason, the facts in it
  are substituted. So `queries_list` and `queries_run` refuse in the same words,
  `knowledge_write` and `agents_delegate` give the same "belongs to the instance
  assistant alone" sentence, and a tier miss names the tier the tool needs and
  the tier the credential holds — in the console's own words for them (`none` /
  `titles` / `folders`).
  
  Silence became a type rather than an accident at a call site: `tell: "hide"`
  is the refusal deliberately identical to "there is nothing here", it carries
  no `needs`, and `formatRefusal` drops its `reason` on the way out. Four things
  hide — a row outside your projects, a route-only query, the console's uniform
  403, and a knowledge path you may not even list (the 2026-09-19 boundary: an
  area is named only for a page whose existence you can already see).
  
  New in `core`: `describeScope(principal)` (the triple: role · access ·
  extras), `formatRefusal(decision)` (the §3.2 envelope), `classify(path)`,
  `notKnowledge(path)`, `TIER_LABEL`, `ROLE_LABEL`, `sourceLabel`,
  `RULED_TOOLS`, `NO_SUCH_PAGE`, and `tell` on `Refusal`. **Removed**:
  `scopeAsPrincipal` (the P0 seam P4 deletes — `/api/knowledge/*` takes the
  principal now), and the three refusal-string constants it replaces
  (`NOT_A_VAULT_PATH`, `NOT_KNOWLEDGE`, `ARTIFACTS_SIGNPOST`).
  
  **P4 — the owner is refused nothing.** "The owner should always have access to
  everything" (ruled 2026-09-19) is a short-circuit at the top of `may()`, with
  no exception clause below it. Safe only because `classify()` splits what a
  path IS from what anyone may do with it: `Artifacts/` and `.metistry/` are not
  knowledge paths, so the rule never has to be weakened to keep an agent out of
  the machinery.
  
  Two owner-visible changes, and they are the two §2.6 found:
  
  - **`GET /api/q/<name>` serves the owner a route-exposed query.** The filter
    `expose: route` protects is a filter on what an AGENT may see of the vault;
    the owner's scope is the whole vault. The capture owner token is NOT the
    owner and is refused byte for byte, which is the credential that rule was
    always about.
  - **`GET /api/knowledge/page` and `/links` classify instead of refusing.** The
    owner's `Artifacts/` and `.metistry/` answer `400` with
    `reason: "not_knowledge"` and `needs.door` naming the route that has the
    bytes (`GET /api/artifacts`, or "the file itself"), where they used to
    answer `404`. **No door serves `.metistry/state/.env` as a page, and not one
    byte of it crosses here** — the classification is the whole answer.
  
  **Agents gain nothing from P4.** Every agent, crew and assistant refusal is
  byte-identical to what it answered before, which the golden file asserts entry
  by entry: the four `changed` entries under P4 are all `who: "owner"`.
  
  **Surfaces.** `metistry agents list` is new (P3 §2.10 — the CLI rendered
  grants not at all). `GET /api/agents` carries each row's rendered `scope` and
  `grant_source`; an `access_request` payload carries `current_scope`. The
  console's Agents panel and Needs You card print what they are sent instead of
  holding spellings of their own. Tool descriptions moved onto the same words
  and got smaller: brain's definition tokens 4264 → 4255 against a >5000 budget.
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
- 57ceb02: **`request_access`: an agent asks for the area it was refused, and the owner
  grants it in Needs You.** Ruled 2026-09-19, the upgrade path proposed in
  #216 and refined in #221. Tier `index` could already see that a page exists,
  be refused its content, and be told which area would unlock it — and then had
  nowhere to put that. The only mechanism was a free-text `requests_create`
  report and a hope.
  
  Now the refusal names a tool: `request_access {area, reason}` writes ONE
  `proposals` row of kind `access_request` with the ask, the reason and what the
  credential holds today, deduplicated on `(agent, area)` while it is pending
  (migration 0022's partial unique index, so a retry storm is one row). It
  **grants nothing** — it is a row. Every tier may ask, `none` included (and
  since the follow-up ruling below, every principal, the assistant included).
  The area is validated at the tool with the same rule the grants validator
  uses, so a crafted prefix (`..`, `.metistry/`, `Artifacts/`, lowercase, the
  bare vault) never reaches a proposal, let alone a grant.
  
  The owner answers it with the three answers every request already takes.
  **Approve calls `writeGrants` — the same function `PUT /api/agents/:id/grants`
  calls**, with the same `validateGrants` and the same `agent_admin` audit row,
  `via: triage`; **Revise** grants a narrower prefix instead (`{area}` on the
  existing triage route); **Decline**, Later and Skip grant nothing. The
  console's mutating surface gains no verb and no route (invariant 10): this
  kind is a new branch onto a service that already existed. It widens by exactly
  the prefix asked for — never `queries`, never a second area, never one already
  covered — and a revoked agent cannot be granted anything: revoking settles its
  pending asks as `deny`.
  
  `packages/core` gains `validAreaPrefix` / `AREA_PREFIX_RE` /
  `AREA_PREFIX_REFUSAL`, lifted out of the console so both doors refuse the same
  strings in the same sentence, and `validAgentAreaGrant` — the same shape plus
  "a read path would actually serve it", which is what refuses `Artifacts/…` on
  an AGENT's grant (it was always an inert grant; every read path ignores it).
  
  Cost on the surface every agent pays: 189 definition tokens, taking the eager
  `tools/list` from 4,035 to **4,224** against the 5,000 line — still smaller
  than the 4,979 it carried a week ago with one tool fewer. The tool COUNT
  ceiling in `ops/scripts/check-tool-surface.mjs` moved 25 → 26 deliberately,
  with the reasoning written beside the number; the tool after this one fails
  that check again.
- 45b64df: **`@monthly` is runnable.** The manifest schema's cron regex already admitted
  it, but `scheduleToSeconds` did not — a manifest declaring `@monthly` would
  validate, pass CI, and then throw the first time the runner tried to schedule
  it. It is now 30 days, the same fixed-interval approximation `@weekly`
  already makes (this is an interval scheduler, not a calendar one).
  
  **An unparseable schedule no longer takes the runner down.** The console's
  `loadSchedules` had no error handling at all: one manifest it could not read,
  validate, or schedule threw out of the function and stopped every OTHER
  collector and routine from starting too. It now skips that one component and
  logs why (naming the manifest file to fix), so a single bad manifest —
  shipped or instance-authored — costs one component, not the console.
- 9ec30d5: **One filter vocabulary, one query — and now literally one object.** The
  parser that reads `where: "due <= today or overdue"` and the query it compiles
  into were built in parallel and agreed on almost none of their names:
  `due_from` against `due_on_or_before`, `combine` against `match_any`, a
  comma-separated `flags` string against seven booleans, `sort1` against
  `order_1`. Every one of those is a hard `unknown param` the first time a
  template renders, because the query runner refuses an undeclared parameter
  rather than ignoring it — so the failure would have landed on an evening plan
  rather than in a test.
  
  `seed/queries/vault_tasks_query.yaml` now declares exactly
  `TASK_FILTER_PARAM_SPEC`, and a test asserts the two are equal field for
  field, so neither side can move without the other. There is no longer a
  third copy of the shape anywhere: the manifest is a transcription of the
  parser's own published declaration, and the parser is canonical because it is
  the half three consumers import and typecheck against.
  
  `TaskFilterParams` gains the four **context** params the query needs and a
  `where:` line can never reach — `today` (the day *overdue* and *carried* are
  measured against, resolved where the timezone is known rather than in SQL),
  `me` (your own person page, for *assigned to me*), `path_prefix` (the
  caller's scope) and `offset` — so the contract is one object rather than two
  that can disagree. `path_prefix` and `status` **scope**: `or` widens the
  predicate, never the scope, so no filter anyone writes can reach a ticked
  line or a path outside what the caller was allowed to see.
  
  Three meanings were pinned while the two halves were reconciled, because they
  had been described two ways: *recurring* is an **instance** of a rule, never
  the rule line (a rule is not a task, and no row here can be one); *carried* is
  "it was owed on an earlier day", which is the number the app's chip shows,
  while how long a line has been **sitting** is its own separate column; and
  every nullable field compares under an explicit "no" rather than a NULL, so
  asking for `size l` can never quietly return every task with no size at all.
- 80bbc16: **The tasks in your notes become readable state, and nothing about them is
  stored.** The first two tickets of the daily flow's Phase 1
  (`docs/product/daily-flow-spec.md` §1.5, §6.2, P1-3 and P1-5): the index the
  reconciler will fill, and the five named queries everything downstream reads
  it through.
  
  **Migration 0024, and every column in it is derived.** `vault_tasks` and
  `vault_task_refs` hold one row per `- [ ] …` line and per block-anchored
  reference to one. Drop the database, let one walk run, and both come back
  from the markdown that produced them — which is the point: a todo lives on
  the line you typed it on, and this is a projection of that line, never a
  second copy of it with its own opinion. The spec numbers the file 0023;
  0023 had gone to `agent_grant_overrides` while the spec was being written,
  so it is 0024 and nothing else changes. Additive throughout, and the
  rollback is two `DROP TABLE`s.
  
  Two constraints are deliberately **not** there, and the reason is the same
  one: a derived table that can refuse to be rebuilt is not derived. There is
  no unique index on `task_key` or `anchor` — without an anchor a key is
  per-file by construction, so the same sentence in two notes is the same key
  in both, which is a duplicate the index must hold two rows for rather than
  fail on — and no foreign key on `work_id`, because a vanished work row must
  not be able to fail the walk that rebuilds your own tasks.
  
  **One filter vocabulary, one query.** `vault_tasks_query` is what the
  template directive's `where:`/`order:`, the app's filter chips and the
  plugin's suggester all compile into — as bind parameters, never as SQL text.
  Inclusive date bounds per field, priority bounds, exact slugs, one
  comma-separated flag set, and `combine` for how the clauses join. Where the
  fixed shape cannot express a predicate — one that mixes "and" and "or" at
  different depths — the parser refuses it with a visible note rather than
  quietly returning an approximation, because a wrong list is worse than a
  warning. Beside it: `vault_tasks_recurring` (the rule lines, which are never
  themselves tasks), `day_work` (work for a day with a `blocked_by` human todo
  resolved beside each row — it surfaces and never gates, so no agent is ever
  stalled by a typo in a note), `pending_requests` (the Needs You queue as a
  read path, honouring a `later` and returning handles rather than payloads),
  and `task_ageing` (the measure).
  
  **Four of the five are route-only, and the fifth is generic on purpose.**
  Their rows carry vault paths and the text of lines you typed, so they are
  reachable only through an endpoint that filters every row through the
  caller's scope — the generic query door and the assistant's `queries_run`
  answer their names with the same refusal an unknown name gets. `task_ageing`
  is counts only: it groups by source *kind* so a `meeting:<path>` can never
  put a path into an aggregate, and it takes no caller-supplied filter to
  probe the tree with. That is what lets the assistant read the measure
  without a new tool — the brain bridge stays at 26, exactly where it was.
- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [9c9da4a]
- Updated dependencies [1bf5c76]
- Updated dependencies [4581845]
- Updated dependencies [a0c1d02]
- Updated dependencies [5cc302d]
- Updated dependencies [b6586de]
- Updated dependencies [6b0d6d7]
- Updated dependencies [baf33c2]
- Updated dependencies [579662f]
- Updated dependencies [57ceb02]
- Updated dependencies [45b64df]
- Updated dependencies [9ec30d5]
- Updated dependencies [7f9ceb7]
- Updated dependencies [23cc47f]
  - @foldedspacelabs/metistry-core@0.11.0
  - @foldedspacelabs/metistry-mcp-brain@0.11.0
  - @foldedspacelabs/metistry-cli@0.11.0
  - @metistry-apps/routines@0.11.0
  - @metistry-apps/collectors@0.11.0
  - @foldedspacelabs/metistry-artifacts@0.11.0
  - @foldedspacelabs/metistry-tasks@0.11.0
  - @foldedspacelabs/metistry-queries@0.11.0

## 0.10.0

### Patch Changes

- 8fc0e5e: **One scope rule for every knowledge read, on both doors.** `expose: route`
  closed the console's generic `GET /api/q/<name>` over the page list and the
  link graph and left the other generic door open: `queries_run` on the `/mcp`
  mount ran any named query for any holder of a `queries: true` grant. That
  grant is a separate axis from the knowledge tier, so it was a way past the
  tiers entirely — an agent at tier `none`, which `knowledge_search` will not
  tell a single title, could page the whole vault index and the whole wikilink
  graph; a `tier: areas` agent could read the titles of every area it was never
  granted. Ruled 2026-09-19: *"all queries including /mcp should be scoped and
  follow the same token based enforcements."*
  
  **`queries_run` honours `expose`.** It asks the same `QueryStore.exposure(name)`
  the console asks and refuses a route-backed query with the **unknown-query
  refusal, byte for byte** — same code, same `no such query: <name>` — and
  `queries_list` does not name one, because a list that named a query the runner
  refuses would publish the route-only set in the same breath. Read off the
  manifests, never matched against a list in the server (invariant 5).
  
  **The scoped door beside it is `knowledge_list`**, which runs the SAME two
  named queries through `packages/queries` and filters them with the same
  function the console's routes use. `links_for: <path>` lists one page's links
  in both directions out of `knowledge_page_links`, with **both ends** of every
  edge scoped — a backlink cannot report that a note exists in an area the
  caller was never granted — and needs an `areas` grant covering the page,
  because a backlink names a note. Without a vault bridge the listing comes from
  the reconciler's index (`knowledge_pages`) instead of the tool being
  `not_available`, and every entry carries path, title and one-line description
  — never content, at any tier. It rides `knowledge_list`'s existing definition
  rather than arriving as a new tool pair because the eager `tools/list` budget
  now sits within 80 characters of the 5k line a new tool would have to buy with
  `discovery: lazy` (`packages/mcp-brain/test/brain.test.ts`).
  
  **That function is now singular.** `canSeeUnder(path, areas)` lifts into
  `packages/mcp-brain/src/knowledge.ts`, beside the `underAreas` it always
  called and the `isVaultPath` core always owned; `apps/console`'s `canSee` is a
  rename over it, and `knowledgeScope` gains `canList` — the same question asked
  about a TITLE rather than content. Tier `index` may be told a page exists
  anywhere in the index (that is the discovery the tier is for: an agent finds
  `Areas/Health/sleep.md` so it can ask you for the area that holds it) and may
  read none of it; tier `areas` lists and reads its prefixes; tier `none` gets
  nothing and is told "not granted", never "not found". The same lift hardened
  `knowledge_list`'s bridge branch, which applied no vault-path rule at all: a
  tier `index` browse of the vault root listed `.metistry/`, `.obsidian/`,
  `Artifacts/` and the root `CLAUDE.md` — machinery, and not knowledge for the
  owner either.
- Updated dependencies [7782cf4]
- Updated dependencies [afc2679]
- Updated dependencies [975221b]
- Updated dependencies [ad73f5a]
- Updated dependencies [8fc0e5e]
- Updated dependencies [0171bc0]
- Updated dependencies [7782cf4]
- Updated dependencies [fe6669c]
  - @foldedspacelabs/metistry-mcp-brain@0.10.0
  - @foldedspacelabs/metistry-cli@0.10.0
  - @foldedspacelabs/metistry-core@0.10.0
  - @metistry-apps/collectors@0.10.0
  - @foldedspacelabs/metistry-artifacts@0.10.0
  - @foldedspacelabs/metistry-tasks@0.10.0
  - @metistry-apps/routines@0.10.0
  - @foldedspacelabs/metistry-queries@0.10.0

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
- 6b3d645: **One endpoint per necessary operation: the generic door closes over
  route-backed queries, and the page list's scope comes from the credential.**
  `GET /api/knowledge/pages` filters every row through `canSee` — and
  `GET /api/q/knowledge_pages` served the same rows with no filter at all, to
  anyone who could reach the generic door. That included the capture owner
  token, which is a `403` on `/api/knowledge/*` and has always been admitted on
  `/api/q/<name>`: a credential that may not use the scoped route could read the
  whole unscoped vault index by name, from any address. A filter with a second
  way in is not a filter.
  
  **The close is a manifest field, not a list in a server** (invariant 5).
  `packages/queries` gains one optional key on a query manifest — `expose:
  generic | route`, defaulting to `generic`, so every query written before this
  means exactly what it meant — and `QueryStore.exposure(name)` reads it back.
  `knowledge_pages.yaml` declares `expose: route`; `GET /api/q/<name>` asks the
  store and refuses anything that is not `generic` with the **unknown-query
  refusal, byte for byte**: same code, same status, same absent message, so the
  door is not an oracle for which route-only queries a build has. An unknown
  value in the field is a load-time `invalid_spec`, never a silent fall back to
  the permissive default. The dedicated route still runs the query through the
  same `QueryStore` — the door closed, not the read path.
  
  **The scope is now derived from the principal.** The `knowledgeRoutes` call
  site passed the constant `OWNER_SCOPE`; it passes `knowledgeScopeOf(auth)` —
  session / local owner to the whole vault, a principal carrying grants to
  `grantedScope`, anything else to nothing. `grantedScope` reproduces
  `mcp-brain`'s `knowledgeScope(principal).canRead` (`tier === "areas" &&
  underAreas(path, areas)`, against that package's own `underAreas`) rather than
  renaming its fields: that shape's `prefixes` is `null` for tiers `none` and
  `index`, meaning "no restriction on the TITLES those tiers browse", and `null`
  here means every vault path's CONTENT — the rename would have handed the two
  tiers that may not read a page the owner's own scope. Agent bearers keep their
  uniform `403` on `/api/knowledge/*` and reach knowledge on `/mcp`, so the
  grant path is exercised by tests today; it is real code so that the filter a
  narrower console principal needs is not invented at a call site later.
- Updated dependencies [1155dd9]
- Updated dependencies [847a5ba]
- Updated dependencies [6b3d645]
  - @foldedspacelabs/metistry-cli@0.9.1
  - @foldedspacelabs/metistry-queries@0.9.1
  - @foldedspacelabs/metistry-mcp-brain@0.9.1
  - @metistry-apps/collectors@0.9.1
  - @foldedspacelabs/metistry-artifacts@0.9.1
  - @foldedspacelabs/metistry-core@0.9.1
  - @foldedspacelabs/metistry-tasks@0.9.1
  - @metistry-apps/routines@0.9.1

## 0.9.0

### Minor Changes

- e9074d2: **The console grows the routes the app plan needs, so compute and knowledge
  stop being Mac-only.** Nine new endpoints on the existing owner auth, the
  existing error envelope and the existing `degrades: absent` rule, each with
  its misuse tests (invariant 8).
  
  `/api/compute*` is five of the `metistry compute` verbs over HTTP: `GET
  /api/compute` (the `compute show --json` report, plus both budget windows
  folded from the `spend` named query and a `writable` flag), `GET
  /api/compute/models`, `POST /api/compute/assign`, `POST /api/compute/budget`,
  `POST /api/compute/providers/test`. They call the **same exported functions
  the CLI verbs call** — the same YAML-document edit so comments and
  hand-written blocks survive, the same re-validation of the result before
  anything is written, the same write through the reconciler as `user`
  (invariant 2) — so a refusal reads identically on both doors because it is the
  same refusal. `providers add` and `providers remove` are deliberately absent:
  they take a key, and a key goes on stdin into the login Keychain, so adding or
  removing a provider stays CLI/app-only and `secret_present` is the only thing
  a secret contributes to a response. These are the owner's **configuration**,
  not invariant-10 "actions" — `user` principal only, no `propose_action` kind,
  no autonomy level that reaches them.
  
  Two guards worth naming. The console refuses to write a `compute.yaml` it is
  not reading: if the `METISTRY_COMPUTE_FILES` overlay ends somewhere other than
  `<instance>/.metistry/compute.yaml`, the write is refused with both paths
  named, because unguarded it would find nothing at the path it opens, start
  from a bare header and deliver a four-line file over the real one. And the
  whole surface degrades absent: the compose shape gives the console no instance
  mount by design, so there every compute route answers 503 naming
  `METISTRY_INSTANCE_DIR` while `metistry compute` keeps working.
  
  `GET /api/knowledge/search` and `GET /api/knowledge/page` are the owner's read
  path into their own vault — a thin proxy onto the reconciler's
  `/vault/search` (three modes, snippets, and `degraded` reaching the client
  rather than being swallowed) and `/vault/read`. The console has held a vault
  reader and searcher since Phase 6 and wired them only into `mcp-brain`, so
  knowledge was reachable by an agent over MCP and by nothing the owner holds.
  The proxy also **narrows what the bridge serves**: `/vault/read` is confined
  to the instance repo and stops there, because the protected-path writes go
  through it, so the route adds core's `isVaultPath` and `.metistry/`,
  `Artifacts/` and the root `CLAUDE.md` are not reachable as knowledge from any
  client. A refusal answers 404, not 403, so "refused" and "absent" are
  indistinguishable from outside. `GET /api/knowledge/pages` is deliberately not
  here: the page list is derived state and belongs in a named query over
  `knowledge_files`, which `seed/queries/` does not carry yet.
  
  `GET /api/commands` is the composer's list, **generated** from the instance's
  own `rules.yaml` and the agent registry — `/note`, the deep alias under
  whatever name that instance gives it, `/model`, and one command per
  `fast_path` rule whose pattern spells one unambiguously. A rule that is a
  sentence rather than a command yields nothing, on purpose. Each entry carries
  the tier it routes to and, for a fast path, the named query whose own
  description is the menu's line. The PWA's static `COMMANDS` array — a
  placeholder marked with an expiry since it was written — is deleted, and an
  integration test routes every command the endpoint offers back through
  `route()` so the menu and the router cannot drift.
  
  `GET /api/runs/:id` is the activity feed's drill-down into a `runs:<id>` ref,
  through a new `run_detail` named query: provider, model, token and cache
  counts, cost, the tool calls the same reply made (joined exactly on
  `meta.turn_id` or `meta.message_id`, never a time window) and the shadow
  agreement measure where the turn was shadowed — the measure, not the two
  transcripts.
- f57b3b0: **The instance directory is the Obsidian vault.** Open the folder `metistry
  init` made and your notes are right there — `Journal/`, `Me/`, `Inbox/`,
  `now.md` — with nothing of the machinery in the way. Everything that is not
  knowledge moved into `.metistry/`: identity, rules, compute, the config
  directories, the lock, and the derived `state/` that holds Postgres, the
  `.env` and downloaded models. Obsidian ignores dot-prefixed folders, which is
  the whole reason for the dot — the vault root and the install's own files can
  finally be the same directory without one of them cluttering the other.
  
  Vault paths lose their prefix with it: a note is `Areas/Fsl/Drey.md`, a
  capture is `Inbox/…`, and a read grant covering everything is spelled `/`.
  
  **The protected set became a place rather than a list.** Anything under
  `.metistry/` is the user's hand alone — except `.metistry/state/`, which is
  derived and nobody's record — plus the root `CLAUDE.md` and `README.md`.
  That is one rule the reconciler enforces at the tool, instead of seven
  filenames each component had to remember. Neither those two root files nor
  `Artifacts/` are indexed as knowledge: your instructions and your bundles are
  yours to read, not search results.
  
  This ships the layout for NEW instances. An existing instance keeps working
  unchanged and `metistry doctor` now says which shape it is in; the verb that
  moves one is the next change.

### Patch Changes

- c1f512e: **The assistant now uses your `identity.yaml` on the launchd shape, instead
  of the seed identity that ships with the product.** Every `*_FILES` overlay
  default resolved its instance half relative to the process's working
  directory, and every launchd job's working directory is the product
  checkout — so `.metistry/identity.yaml`, `rules.yaml` and `compute.yaml`
  named the product's own directory, found nothing, and the engine ran on the
  seed. `METISTRY_INSTANCE_DIR` was not in the engine's environment allowlist
  either, so it could not have resolved them itself.
  
  Fixed at the root: `metistry up` puts `METISTRY_INSTANCE_DIR` and
  `METISTRY_SEED_DIR` in every child's environment (the plists' env dicts and
  the supervisor's child specs alike), and core's `overlayFiles` resolves every
  default against the instance directory through `resolveInstanceLayout` — so
  it finds the file whether the instance has run `metistry migrate-layout` or
  not. The assistant, the console and the reconciler all read their overlays
  through it, which also means the console's router and the engine can no
  longer disagree about which `rules.yaml` is in force.
  
  The engine **refuses to start** when neither `METISTRY_INSTANCE_DIR` nor
  `METISTRY_IDENTITY_FILES` is set, rather than answering under the seed's
  name. `ops/sandbox/assistant.sb` grants read on the four config files by
  name (never on the directory holding them, which on an unmigrated instance
  is the vault root), so the reads the overlay now performs are permitted and
  nothing else in the instance is.
  
  Also: `metistry update --version <x.y.z>` was ignored — `version` was listed
  as a boolean flag, so the value never arrived and the latest release was
  installed instead. And in git mode `update` wrote the **pre-pull** version
  into `metistry.lock`; the version is now read from the checkout after the
  pull, so a run that fast-forwards onto a new release pins that release.
- 76f82a2: **An instance that has not run `metistry migrate-layout` is read again.**
  `db/migrations/0021` recorded that "a legacy instance keeps working unchanged
  until the verb runs". Verified against a clone of a real pre-ruling instance,
  it did not: #193 moved every path to `.metistry/` and every reader spelled the
  new one, so `metistry compute show` reported no providers while the instance's
  `compute.yaml` declared one, `metistry identity` exited 1 on an instance whose
  `identity.yaml` was right there, `metistry version` omitted the pin, `doctor`
  read `shape compose` off a `deployment.yaml` it never opened and probed the
  wrong half of the install, `metistry secrets`/`console`/`connect` could not
  find `state/.env` at all — which on a launchd install means every rendered
  plist's `__ENV_FILE__` points at a file that does not exist — and `up` would
  have `initdb`'d a second, empty Postgres cluster at `.metistry/state/pg`
  beside the live one.
  
  Two of the breaks were safety, not convenience. The §4.7 protected set became
  the `.metistry/` PLACE, which took the legacy machinery at the instance root
  out of it: on a legacy instance the assistant could write `identity.yaml`,
  `rules.yaml`, `metistry.lock`, `queries/` and `instance-migrations/` through
  `brain-commit` (invariant 2). And the knowledge walk, which now starts at the
  instance root, indexed those same files plus every byte of the gitignored
  `state/` — a Postgres cluster included — as notes.
  
  `resolveInstanceLayout(instanceDir)` in core is the fix: one `detectLayout`
  read, then the right relative-path table (`LEGACY_INSTANCE_LAYOUT` mirrors
  `INSTANCE_LAYOUT` key for key), with `instanceFile()` / `instanceStatePath()`
  as the reader's one-line call. Every reader goes through it — identity,
  rules, compute, deployment, the lock, the peer registry, `.env`, the Postgres
  data and socket dirs, the supervisor's config/socket/bin, `ports.yaml`, the
  models dir, the assistant's state dir, `doctor`'s compute overlay, the
  console's identity/peers/inbox, and the reconciler's inbox prefix (whose SQL
  predicate must match migration 0015's partial index on a legacy instance, not
  0021's). Writers are untouched: `instancePath`/`metistryPath` still spell the
  flat layout, because there is one layout to write and two to read.
  `isProtectedPath` and `isVaultPath` cover the legacy root names
  unconditionally — they receive a path and no instance directory, and the set
  is strictly safer on a flat instance, which has no business holding lowercase
  machinery at its root.
  
  `metistry update` now **refuses** to pin a version past 0.8.x onto a legacy
  instance, before it fetches, builds or migrates anything, printing the
  `migrate-layout` line to run; `--allow-legacy` overrides. Regression tests run
  one fixture in both shapes through the same readers, so a reader that resolves
  only one of them fails.
- Updated dependencies [c1f512e]
- Updated dependencies [e9074d2]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
- Updated dependencies [ce521a6]
  - @foldedspacelabs/metistry-cli@0.9.0
  - @foldedspacelabs/metistry-core@0.9.0
  - @metistry-apps/routines@0.9.0
  - @foldedspacelabs/metistry-mcp-brain@0.9.0
  - @metistry-apps/collectors@0.9.0
  - @foldedspacelabs/metistry-artifacts@0.9.0
  - @foldedspacelabs/metistry-tasks@0.9.0
  - @foldedspacelabs/metistry-queries@0.9.0

## 0.8.1

### Patch Changes

- @metistry-apps/collectors@0.8.1
  - @foldedspacelabs/metistry-artifacts@0.8.1
  - @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-mcp-brain@0.8.1
  - @foldedspacelabs/metistry-queries@0.8.1
  - @foldedspacelabs/metistry-tasks@0.8.1
  - @metistry-apps/routines@0.8.1

## 0.8.0

### Minor Changes

- 6aa64c2: **Approve now does something on an `action`.** `action` was a word in the
  console's view map that nothing emitted; it is now a request kind carrying a
  **closed** `payload.action = {kind, args}` — exactly four kinds
  (`dispatch`, `task_update`, `comment`, `capture`), held in `packages/core` as
  data plus a zod schema each, so an unknown kind or an unnamed argument is a
  `400` naming the field. Allowing one runs it through the *same service call the
  owner's own click makes* (`dispatch()`, `TasksService.update()`,
  `workComment()`, `captureToInbox()`), as the `user` principal, with the
  proposal's `source_agent` recorded as `on_behalf_of` and the result written
  back to `payload.result`. A refusal leaves the row **pending** carrying the
  error — and nothing is half-applied, because one action is one service call.
  No sending, no git, no shell, no grants: every kind is a door onto something
  the console could already do, never a new power (taskuary review ADOPT 6).
  
  **Autonomy levels, and widening is now allowed — by your hand only** (A3 /
  OPEN-2). `agents.autonomy` gains `{level: observe | propose |
  act_within_scope, actions: {<kind>: allow | propose | deny}}` beside the §4.21
  narrowing keys, so one record answers both "how much room" and "which action".
  The level is a **ceiling** and the per-kind entry the value — the effective
  mode is the lower of the two, which is what makes "it only ever runs on its own
  at `act_within_scope`" arithmetic rather than a rule that could be forgotten.
  Defaults: everything `deny` at `observe` (**and with no level at all**, so this
  release widens nobody), everything `propose` at `propose`, and
  `comment`/`capture`/`task_update` `allow` at `act_within_scope` while
  `dispatch` stays `propose` — off-machine is a human decision by default. A
  change that raises anything is admitted only through `PUT
  /api/agents/:id/autonomy` (the `user` principal) and the new `metistry agents
  autonomy <id> --level … --allow <kind>`; every other caller is narrowing-only
  by default, and every raise writes a `runs` row `agent_admin` /
  `autonomy_widened` plus one Needs You alert, so a raised bar is never silent.
  
  **`propose_action` in mcp-brain**, in its own crew grant group `actions` (the
  same opt-in rule `rooms` follows). It answers `executed` or `pending`; a denied
  kind is a `forbidden` envelope naming `autonomy.actions.<kind>`. Registration
  is **lazy by credential**: an agent whose table admits nothing is not offered
  the tool, which is every agent until you set a level — so the eager definition
  surface stays at 25 tools / ~4.9k tokens for everyone, and an opted-in
  principal carries 26 knowingly. Deferring on the credential costs none of the
  +1 discovery turn a meta-tool index would.
  
  Needs You renders an action's kind, argument preview, reason and result; the
  Agents panel shows each agent's level and resolved table with widen/narrow
  controls. `docs/ops/actions.md` is the whole design.
- 26ffe39: **Instances can name each other, and an agent can be named across them** —
  the five registry ideas worth borrowing from Google's SAM agent mesh
  (`docs/research/2026-09-13-google-sam-review.md`), built as endpoints and a
  config file rather than as a mesh: no Go daemon, no control plane, no second
  credential class, no second policy language.
  
  - **Capability advertisement.** `GET /api/identity` — the one
    unauthenticated read — now carries `capabilities`: coarse tool *group*
    names (`artifacts`, `capture`, `dispatch`, `knowledge`, `queries`,
    `tasks`), derived from what the console actually has wired, so a phone
    switcher or a peer can name what an instance offers before sign-in. Never
    a tool name, never a count, never an origin; the full `tools/list` stays
    behind an agent token at `/mcp`.
  - **Approve-before-enroll.** An agent created with `remote: true` starts
    **pending**: its token is minted (the console shows one exactly once) and
    authenticates nothing — `/mcp` and `/capture` answer the same uniform 401
    an unknown token gets, `last_seen_at` is not even bumped — until the owner
    approves it from the Needs You queue or with
    `POST /api/agents/<id>/approve`. `metistry connect <tool> --remote` sets
    the flag; loopback tools stay immediate. Denying revokes.
  - **Instance-qualified agent identity.** `agent:<name>@<instance_id>` in
    `packages/core` (`qualifyAgentId`), minted at the boundaries an id
    actually crosses. Storage keeps the bare name; nothing is rewritten.
  - **A peer registry.** `instances.yaml` in the instance repo — a §4.7
    protected path — with `metistry instances list|add <origin>|remove|refresh`.
    `add` asks that origin who it is and records what it answers; rows are
    keyed by `instance_id`, because an origin can move. `GET /api/instances`
    serves it to the app and the phone.
  - **A `runs` audit export.** `metistry runs export [--since] [--until]
    [--component]` streams the ledger as NDJSON through
    `GET /api/runs/export`, so two instances' timelines merge. Redacted,
    resumable by the cursor on every line, and never a truncated export that
    looks complete.
  
  New: `docs/ops/instances.md`; `docs/ops/console-api.md` and
  `docs/ops/cli.md` grew the sections. Migration `0017_agent_enrollment.sql`
  is additive and defaults to today's behaviour.
- 70f6580: **Apple Foundation Models is now a compute provider, and `inbox-drain` calls
  it through the same wire as everything else.** The `apple-fm` bridge grows
  `GET /v1/models` and `POST /v1/chat/completions` on its existing loopback
  listener, under the same bearer as every other bridge route — with
  `response_format: json_schema` translated per request into Apple's
  `DynamicGenerationSchema`, real token counts from the model's own tokenizer,
  and a `400` that names the field when a schema or prompt would not fit the
  4096-token window. `metistry compute providers add --from applefm` writes the
  provider; discovery and `metistry doctor` gain a `local:applefm` row.
  
  `inbox-drain` no longer reaches the bridge's private `/classify` route. It
  declares `uses_model: applefm/foundation-model` in its manifest and goes
  through `completeJson()`, which enforces the rule that a collector may only
  call an on-machine, cost-0 provider — CI checks the shipped default, and the
  call itself throws rather than spending. **Upgrading:** run `metistry compute
  providers add --from applefm` (with
  `--base-url http://host.docker.internal:7810/v1` in the container shape) to
  keep the model tier; without it the drain is deterministic, which is a
  supported install and which `metistry doctor` reports.
- f27e0af: **The board moves things now** — phase 3 of
  `docs/research/2026-09-12-hermes-agent-review.md`, built on the rule that
  keeps invariant 8 honest: *the board offers no drop the service would refuse.*
  
  - **`packages/tasks` — the three gaps the note found, closed additively.**
    `UpdateInput.status` was `Exclude<TaskStatus, 'open'>`, so **unblock was
    unreachable by anything in the system**; it now accepts `open` from
    `blocked` only, and hands the row back the way `release()` does. `owner`
    can be set and cleared after create (with `title` and `project`, the other
    two fields a card carries but could not change). `heartbeat` takes a
    `note` that lands on `history` — and a renew *without* one appends nothing,
    so a lease ticking every few minutes never buries the row's record.
    `update` now has **two arms, and the fields pick the arm**: the holder arm
    (`in_progress | blocked | closed`, or a bare note) is claim-gated exactly
    as before; the board arm (`owner`, `title`, `project`, the unblock) is not,
    because addressing a card is a gesture on a row nobody need hold and the
    unblock is by definition a row whose holder is stuck. Mixing the two in one
    call is refused naming both fields — the looser gate must never carry the
    stricter arm's write. New refusal reason: `not_blocked`.
  - **The console's task routes** (`apps/console/src/task-routes.ts`):
    `PATCH /api/tasks/:id {status?, owner?, project?, title?}`,
    `POST /api/tasks/:id/{claim,release,renew}`. Until now
    `POST /api/tasks/:id/dispatch` was the *only* task route the console had.
    A thin adapter and nothing more: every refusal comes out of a `WHERE`
    clause in `packages/tasks`, and the route only turns it into a sentence
    that names what would permit it. `user` principal only — an agent token
    and a capture owner token both get the canonical `403` — and one `runs`
    row per request records the door beside the service's own row for the op.
  - **The drags** in the Board tab: HTML5 drag-and-drop, no library, four
    handlers. Each drop maps to exactly one route, `reported` is never a
    target, a closed card is not draggable, and a refused drop snaps back
    carrying the server's message. `m` on a focused card is the keyboard
    alternative. Clicking a card opens its room when one exists — `board.yaml`
    gained `has_thread`, so the panel never asks a second endpoint — and its
    detail popover when it does not.
  
  **Assignment stays the human's alone, by absence rather than by a check:**
  `owner` exists on `PATCH` and on no agent surface, because `tasks_update`'s
  schema has no `owner` key and its status enum has no `open`. That is
  collaboration rule 4 without a rule to run.
  
  `docs/ops/board.md` gained the **Drags** table; `docs/ops/console-api.md`
  gained the routes.
- 6504920: **The Board — one place to see who is working on what.** A read-only Kanban
  over the task list: six columns (Backlog, Assigned, In Progress, Needs You,
  Done, Reported), a project filter, per-column counts, and a red chip on
  anything that stalled. No migration and no fifth status value — every column
  is a `CASE` over columns `work` already carried, so the whole feature is two
  named queries (`board`, `board_projects`) and a panel.
  
  Two things it makes visible that nothing else did. **"Assigned but not
  started"** — a row addressed to an agent that nobody has claimed — was in the
  data all along with no view onto it. And **Done vs Reported**: a closed task
  that produced a finding no longer looks identical to one that produced
  nothing, reconstructed from the run that claimed it.
  
  `board_projects` is one row per project × column, which is the cross-project
  board a per-board isolation model structurally cannot produce; here it is a
  `GROUP BY` on a column the table already had.
  
  Read-only on purpose. Every task mutation is still a tool call (invariant 9),
  so the panel has no drag, no drop target and no mutating control, and a test
  asserts it. Adapted from `docs/research/2026-09-12-hermes-agent-review.md`
  (phases 1 and 2). New: `docs/ops/board.md`.
- b99d4ad: **The engine dials the provider, and every call costs a number you can see.**
  `compute.yaml`'s assignments now decide what actually answers a turn. One
  `Engine` interface with a factory keyed on the provider's `kind`: an assigned
  tier or crew runs on the in-house OpenAI-compatible loop — any base URL, so a
  local server, OpenRouter, Zen or anything else — and a turn nothing assigns
  keeps running on the Claude Agent SDK exactly as before. Write an
  `assignments.default` and no turn can reach the SDK path at all, which is why
  the assistant then starts with no engine credential set.
  
  The loop is about 300 lines over `fetch`, the pre-approved MCP client and
  zod — no new dependency. It owns the tool loop over the console's `/mcp`
  (the only tools that exist — invariant 9), `max_turns`, backoff on 429/5xx
  honouring `Retry-After`, `response_format: json_schema` *plus* zod validation
  with one repair retry, effort as `reasoning: { effort }` off-machine and
  reasoning-off on-machine, and the provider's `request:` block merged verbatim
  — except `model` and `messages`, which belong to the assignment, because a
  request block that could repoint the call would hand routing back to the file
  the router was told to obey. A **no-progress veto** ends a run that is
  learning nothing: a turn whose every tool call repeats a (name, arguments)
  already made *and* returns byte-identical output is unproductive; three in a
  row buys a nudge, five ends tool use and asks for the answer. Every early
  stop — the turn cap, a crew's per-run cost cap, the veto — still ANSWERS.
  
  **Cost is a first-class row.** `runs` gains `provider`, `cache_read_tokens`
  and `cache_write_tokens` beside the existing model and token columns
  (additive migration `0016`), and `meta.cost_source` records where the number
  came from: the response's own `usage.cost`, the provider's `pricing:` table,
  `local` (0 by definition), or `unknown` — an off-machine call nothing can
  price is recorded at $0 **and says so**, never at a guessed rate. The
  OpenAI-compatible engine keeps its own message history in a new
  `assistant_sessions` table under the same id `sessions` uses, so a task
  boundary rolls both at once and a rolled thread can never be replayed.
  
  **Budgets are enforced before the call**, against a new `spend` named query
  (invariant 3's one read path, `cache_ttl: 0` so a cached number cannot
  overspend). `allow` records, `stop` refuses, `critical_only` passes only an
  assignment marked `critical: true`; 80% of any window writes one warning per
  calendar window. What a refusal looks like depends on who asked: a chat turn
  is offered one more window as a Needs You item naming the exact field, a
  routine that declares `requires.engine` does not start at all (the runner's
  preflight asks the same budget question first), and a crew fails with
  `budget_exceeded` and parks. A budget that cannot be measured refuses rather
  than guessing.
  
  Also: a non-ZDR off-machine assignment writes one warning `runs` row per
  provider per day and still works — informed choice, never a block; and the
  console refuses a *directed* `agents_delegate` to a crew whose engine kind
  differs from the caller's, with the field that would permit it, while
  unassigned work any agent can claim stays open to everyone. `docs/ops/
  compute.md` gains "The engine", "Budgets" and "The collaboration rule".
- 6fd4c28: The console's API contract for a client that is not always connected
  (`docs/ops/console-api.md`, from the 2026-09-11 research note): a public
  `GET /api/identity` (`instance_id`, `name`, `icon`, `version` — read from
  `identity.yaml` through `METISTRY_IDENTITY_FILES`, 503 when absent) so a
  phone can name an instance before sign-in and recognise it after its origin
  moves; an `Idempotency-Key` header on `POST /capture`, scoped to the
  credential class, that returns the original row on replay — one file, one
  inbox row even when attempts race (migration `0014`, unique index on the
  inbox row) — with `Idempotency-Replayed: true`; `409 conflict` carrying the
  winning decision when a proposal was already settled (unknown stays `404`);
  and opaque `since` cursors on `GET /api/messages` and `GET /api/proposals`
  (`cursor`, `more`), where a rating moves a message and a decision moves a
  proposal, so a reconnect after hours is one bounded pull per list. The
  plain lists are unchanged.
- 5b3e6f2: **`targets/devin-sessions`** — dispatch a brief to a Devin session and get the
  answer back as a report to triage. The first `transport: http` compute target,
  and the first whose *content* returns rather than only its status.
  
  `POST /api/tasks/:id/dispatch` (passkey session only) gains `purpose` and
  `max_acu`. `purpose: "knowledge_research"` is the new brief kind: a question
  the assistant cannot answer goes out with a preamble that forbids touching any
  repository, and the whole output is a structured answer —
  `{answer, sources[], confidence, open_questions[]}`, sent as a Draft-7
  `structured_output_schema` so Devin's own `structured_output_required` will not
  let the session end without filling it in. The session id becomes the work
  row's `external_ref` (`devin:<id>`), and `collectors/devin-sessions` polls
  every five minutes: a finished session becomes a `report` proposal
  (`source_agent devin`, `trust external`) carrying the answer plus provenance —
  session URL, status, confidence, ACUs used against the cap — and closes the
  work row; an errored, suspended, timed-out or contract-breaking session files a
  report saying exactly that and leaves the row `blocked`. Accepting the proposal
  in Needs You is what puts it in the vault, through the existing fold path.
  Ruled a collector rather than an in-process timer: a poll is a scheduled pull
  with a cost, so it should have a manifest, a `runs` row and a `check()`.
  
  Safe to point at a third party: the shipped `data_policy` has an **empty**
  `allow` list, so the product default lets a brief cite nothing from the vault —
  widen it per instance in a `METISTRY_TARGETS_DIRS` overlay — and `deny_sources`
  is `[comms, devin]`, so Devin's own knowledge is not silently re-exported to
  Devin. The budget is Devin's per-session `max_acu_limit` (manifest default 5,
  overridable per dispatch), written to the dispatch `runs` row and reconciled
  with the ACUs Devin reports. Dispatch stays the owner's action: the route is
  the `user` principal only and `agents_delegate` reaches local crews and nothing
  else, so the rule that a non-Claude agent is never pushed to by name holds
  because there is no tool to break it with.
  
  Configure with `METISTRY_DEVIN_API_KEY` (the same key `devin-knowledge` uses)
  plus `METISTRY_DEVIN_ORG_ID`, which is **required** here — a session is a
  spend, and the organization it is charged to is not something to infer.
  Without either, the target's `check()` is `absent` with the remediation and the
  collector degrades absent. `docs/ops/devin.md` ("Dispatch out") has the full
  shape, including one thing now verified negative: Devin's v3 API supports **no**
  `Idempotency-Key` header, so the guard is the work row's unique `external_ref`.
- cde0691: **The inbox moved inside the vault, and human edits became first-class.**
  Captures live at `Knowledge/Inbox/` — Obsidian's vault root is `Knowledge/`,
  so that is the only place it can see them, add to them and edit them — and
  they are tracked, so git carries them: the inbox used to be the one thing a
  `docker compose down -v` rebuild could not bring back (invariant 1).
  `docs/ops/inbox.md`.
  
  - **One sink, every door.** `POST /capture`, the `/note` fast path, the
    bridge's `capture` tool and the collectors all write through the
    reconciler's vault bridge with `expected_sha256: ""` — must not exist — so
    a capture can never land on a file someone already wrote. The console still
    holds no part of the instance repo (D5, invariant 7), and each capture is a
    commit. With no bridge configured it degrades to a plain directory: capture
    keeps working, and moving those files into `Knowledge/Inbox/` later is
    enough for the scan below to pick them up.
  - **Files you write yourself are indexed.** The reconcile loop already walks
    the vault by content hash, so it now also reconciles `Knowledge/Inbox/`: a
    note you added in Obsidian gets a triage row, an edit to a capture
    refreshes its hash and — if it had already been classified or accepted —
    sends it back to `inbox-drain`, because a refinement is new information. A
    `rejected` row stays rejected; a deleted file archives its row rather than
    losing it; the file coming back re-opens it. No new watcher, no new
    component talking to Postgres (invariant 3).
  - **`knowledge_write` can no longer overwrite a note it has not seen.**
    Omitting `expected_sha256` used to mean "unconditional", which meant an
    edit *you* made to a page the assistant owns could vanish with no conflict
    and no trace but the commit. It now means create-only: an existing note
    answers `conflict` with the current hash, so changing a note requires
    `knowledge_read` first. Misuse test ships with it.
  - **Big captures.** Above `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB) a
    capture goes to `Knowledge/Inbox/.large/`, which the instance gitignores:
    Obsidian still sees a 40 MB screen recording, the repo does not carry it.
  - **`metistry migrate-inbox`** moves an existing instance — files (`git mv`
    for what git tracks), `.gitignore`, and `inbox.path` rows to the
    repo-relative form `db/migrations/0001_init.sql` always documented — with
    `--dry-run`, idempotent, restarting nothing. A second instance that already
    moved its inbox to a lowercase `Knowledge/inbox/` is renamed through a temp
    name, because macOS is case-insensitive and `git mv` would otherwise move
    the directory inside itself.
  
  Migration `0015_inbox_in_vault.sql` is additive: a partial unique index makes
  "one row per inbox file" true at the database, since the capture path and the
  scan both reach that directory now.
- 78d78d1: **Scheduled work that stops failing quietly.** A collector whose token expired
  used to fail every hour forever — one API call each time, one number on a
  tile, and nothing that ever said "fix it or retire it". Four additive
  behaviours, all derived from the `runs` table with no schema change
  (`docs/ops/automation.md`):
  
  - **Failure streak.** Consecutive `ok = false` runs since the last successful
    one. At `METISTRY_RUNNER_MAX_STREAK` (default 5) the runner stops running
    the component: no call, no spend. Each skipped window records exactly one
    `runs` row (`kind: runner`, `tool: skipped_streak`) — one per window, not
    one per 60-second tick. One successful run clears it; there is no state to
    reset by hand.
  - **One alert per error signature.** `sha256(component + error with uuids,
    paths, hex ids and digits normalised out)`, first 12 hex, stored on the
    failing run's `meta.error_signature` and carried in the alert as
    `[sig:…]`. One (component, signature) raises one **Needs You** item per
    `METISTRY_ALERT_DEDUPE_H` (default 24h), and speaks again when the
    signature changes or the streak cleared and came back. Alerts are ordinary
    `outbound_messages` rows of kind `alert` — the path the watchdog already
    uses, so there is no new row kind and nothing new for the PWA to render.
  - **Preflight before spend.** A collector or routine may declare
    `requires: {env: [NAMES], reachable: [URL_ENV_NAMES], engine: true}`. The
    runner checks it *before* opening a run row and, on a miss, records one
    `preflight_failed` row per window and runs nothing — the message names
    every variable and the manifest file that declares it. `engine: true` asks
    core's one `engineCredentialPresent` seam, moved from `packages/cli` to
    `packages/core` so the console can ask it too (the CLI re-exports it, so
    `up` and `doctor` are unchanged). The legacy `requires: [label]` array
    stays valid and checkless; no shipped manifest declares the structured form
    yet, because every shipped collector degrades absent by design.
  - **`metistry doctor` grows a `schedules` section.** One row per schedulable
    manifest: last run and whether it succeeded, open streak, next due,
    `skipped_streak` / `preflight_failed` state. Built from `runs` plus the
    manifests, importing no collector (invariant 5). Actionable states are
    `failed`, so the existing non-zero exit already covers them; `--json`
    carries the shape in `meta`.
  
  Every refusal, skip and remediation names the environment variable or manifest
  field that would change it.
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
- 367f456: **Rooms: a conversation can now hang on a task, not only on a deliverable.**
  A comment thread anchors to a `work` row as well as an artifact version
  (migration `0018` — one nullable `work_id`, a check constraint enforcing
  exactly one parent, and one room per row), so agents can negotiate scope
  before anything is published. Two new tools, `tasks_comment {work_id, body}`
  and `tasks_thread {work_id}`, under the same project grant as `tasks_*`.
  
  **A room cannot address anyone** — no `to_agent`, no `@name`, no addressee
  field anywhere on the path — so posting wakes nobody and triggering stays with
  `agents_delegate`. Because it is the same table, the shipped escalation
  applies unchanged: ten consecutive agent messages and the next one is not
  stored; the room becomes an owner item with its transcript, and a human
  message resets the run. **Resolving is the owner's hand alone**: one console
  route, no tool, and nothing on a timer.
  
  Also: a **Rooms** tab listing every conversation across both anchors, with the
  escalation reason rendered as a sentence; the last of a task's room riding
  along in a crew's brief under `METISTRY_BRIEF_THREAD_BYTES` (default 4096);
  and `proposals.work_id`, set server-side, so a proposal can finally say which
  work row it came from.
  
  Crews reach the new tools through a new `rooms` group in `uses` — its own
  group rather than part of `tasks`, so no existing crew gains the ability to
  speak without a manifest edit.

### Patch Changes

- e48ea1e: **Three contract checks that hold at the tool rather than the reader.**
  
  `@foldedspacelabs/metistry-core/test-env` is a new subpath export: a test
  harness loads `METISTRY_DB_*` and `METISTRY_TEST_DB_NAME` from a dotenv file
  and deletes every other `METISTRY_*` from the environment, and
  `assertTestEnvIsolated()` fails a run the moment a path resolves outside
  `os.tmpdir()`. A product checkout's `.env` is a RUNNING install's environment
  — instance directory, reconciler URL, reconciler bridge token — so a test that
  loaded the whole file and called a CLI verb was driving the live system, which
  is how a `compute providers add` case committed into a real instance repo.
  `docs/ops/testing.md` states the rule: tests never see the operator's instance.
  
  `ops/scripts/audit-limits.mjs` (CI) fails on a limit-shaped constant under
  `apps/**/src` or `packages/**/src` that is neither read from config nor
  annotated `// limit: fixed — <reason>`. Two of the forty it found on main are
  now operator-facing: `METISTRY_MAX_BODY_BYTES` (the console's request-body
  cap) and `METISTRY_COMPOSE_TIMEOUT_MS` (how long `metistry up` waits on a cold
  `--build`). The rest say why they are fixed.
  
  `core`'s stdio conformance contract spawns a stdio component with a bare
  environment and requires every line it writes to stdout to be a protocol
  frame; logs go to stderr. It covers mcp-apple-fm's Swift helper, whose
  protocol IS stdout, and fails the build if a `transport: stdio` bridge is ever
  declared without a case.
  
  And refusals on the console's owner surfaces now name the field that would
  permit them — the dispatch body's parameters, the grant validator's message
  (which `PUT /api/agents/<id>/grants` used to discard, so `metistry connect
  <tool> --areas knowledge/…` answered a bare 400), the budget validator's, and
  the two "not available" cases that now name the environment variables they
  need. The door is untouched: a 401 takes no detail and an agent's 403 stays
  the canonical "not granted" (invariant 8).
- ae0f9db: **`compute.yaml` — providers, assignments and budgets in one file.** Where
  work runs, what may leave the machine to get there, and what it may cost is
  now configuration in the owner's hand rather than a build-time decision: any
  OpenAI-compatible endpoint (a local server, OpenRouter, anything with a base
  URL) is a provider, each tier and crew is assigned one pinned
  `<provider>/<model>`, and a daily or monthly budget can be recorded per
  provider and for the instance. A provider is configuration, not a component —
  invariant 5 is met by a zod schema in `packages/core` that the CLI, CI and
  the app all validate against, so adding one is a command rather than a
  directory.
  
  New verbs, all `--json` and all `--dry-run`: `metistry compute show`,
  `providers list|add --from <template>|remove|test`, `models list`, `assign`,
  `budget`. The file is a §4.7 protected path, so every write goes through the
  reconciler as the `user` principal, and the RESULT is validated before it is
  written — an edit that would produce a file the engine could not load is
  refused and nothing changes. Comments and hand-written blocks survive every
  edit. `providers add` reads the API key from stdin into the login Keychain
  under the user account and cannot take it as an argument or print it.
  
  Every rule the schema enforces refuses with the field that would permit it: a
  model must be one pinned `<provider>/<id>` whose provider is declared in the
  same file (no `/auto`, no fallback lists — the router is deterministic), an
  off-machine provider must declare a data policy, a budget needs a limit, and
  `auth.secret` is a name a pasted key cannot match. The console and the
  assistant both hot-reload the file; an invalid save keeps the last good
  configuration and writes one `runs` warning row instead of taking a running
  install's assignments away.
  
  Nothing dials a provider, counts a token or enforces a budget yet — the
  engine is the next change. Until an instance writes `assignments:`,
  `rules.yaml`'s `tiers:` is still the live map, and the seed's `compute.yaml`
  ships commented out so no existing install routes differently. New:
  `docs/ops/compute.md`.
- 75c7547: **Local models: discovery, install, and a `llama-server` in the box.** Three
  local model servers, one protocol. LM Studio and Ollama are **peers** —
  discovered over `GET /v1/models` wherever they already run, never started by
  Metistry — and llama.cpp's `llama-server` is now **bundled**: built from
  pinned source into the runtime pack with Metal on, signed alongside Postgres
  and git, so a Mac with neither peer installed still has a local model
  provider and nothing to download first.
  
  `metistry compute models list` is live `/v1/models` against every declared
  provider **plus** a scan of the three known local ports, so a server that is
  running but that nothing dials is reported with the one command that would
  wire it up rather than silently omitted. `metistry doctor` carries the same
  finding as `local:lmstudio`, `local:ollama` and `local:llamaserver` rows —
  each `ok` with what it has loaded, or `absent`. **Absent is never a
  failure:** a Mac with no local server is a supported install and these rows
  can only add information.
  
  `metistry compute models install <provider>/<model>` speaks each server's own
  mechanism: `lms get` for LM Studio, streamed `POST /api/pull` for Ollama,
  and for `llama-server` one plain HTTPS GET of a Hugging Face GGUF into
  `<instance>/state/models/`, checked against the sha256 Hugging Face publishes
  before anything is written and then recorded as `serve.model_path`. `load`
  and `unload` act for LM Studio and are an honest message for the other two,
  which have no addressable load. No new dependency: a GGUF is one file behind
  one URL.
  
  `compute.yaml` gains an **additive, optional** `serve: { runtime, model_path,
  port, extra_args }` block. A provider without it is exactly what shipped
  before. A provider with it is one Metistry runs itself, as an optional
  supervisor child called `llamaserver` — `metistry logs llamaserver`,
  `metistry restart llamaserver`, a `child:llamaserver` doctor row. The host is
  hard-coded to loopback, the port must be the one `base_url` already dials,
  and a missing binary or GGUF is a note rather than a failed `up`.
  
  **Embeddings move to `/v1/embeddings`.** Knowledge search used Ollama's
  native `/api/embed`, which made Ollama the only server that could ever embed;
  it now posts the OpenAI-compatible route at `METISTRY_LOCAL_MODEL_URL`,
  defaulting to the first `on_machine` provider's `base_url` in `compute.yaml`.
  `METISTRY_OLLAMA_URL` keeps working as a deprecated alias — a bare host is
  mapped onto its `/v1` root — with one startup warning naming the new
  variable. `METISTRY_EMBED_MODEL` and `METISTRY_EMBED_DIM` are unchanged, so
  no re-embed is required.
  
  Docs: `docs/ops/compute.md` gains "Local models"; `docs/ops/bundled-runtime.md`,
  `docs/ops/cli.md`, `docs/ops/knowledge-search.md` updated.
- 54a737b: **`collectors/devin-knowledge`** — Devin (Cognition) knowledge and repo wikis
  into the inbox as captures, so the evening fold organises them into the vault.
  Set `METISTRY_DEVIN_API_KEY` (a `cog_` service-user key or personal access
  token) in `<instance>/state/.env`, run `metistry secrets sync --to keychain`,
  and hourly the collector pulls every Knowledge note changed since its last run
  plus — when `METISTRY_DEVIN_REPOS` lists repos — the DeepWiki pages for them.
  One capture per item, `source: devin`, frontmatter carrying `devin_id`, title,
  folder, repo, trigger and the source timestamp, then the text unchanged.
  
  Transports follow what Devin documents: Knowledge notes over REST v3
  (`GET /v3/organizations/{org_id}/knowledge/notes`, cursor pagination) with
  plain `fetch`, and repo wikis over `https://mcp.devin.ai/mcp` because **no
  REST route for wiki content exists** — the v3 `repositories/*` endpoints cover
  indexing status only.
  
  Safe to leave running: every capture is idempotent on
  `(collector:devin-knowledge, <kind>:<devin_id>:<version>)`, so a re-run inserts
  nothing and an edited item lands exactly once more; a `429` is
  backoff-and-stop, not a failed run, with the watermark held so nothing is
  skipped; and with no key the collector degrades **absent** — `run()` returns 0
  and `check()` names the variable and the command rather than failing. It is
  outbound-only, so it needs no inbound exposure. `METISTRY_DEVIN_API_KEY` is
  **user-scoped** in the Keychain, like the AWS credentials: it is the person's
  own key, shared by every instance on the Mac, and `secrets purge` never takes
  it. `docs/ops/devin.md` has the configuration, the verified endpoint details,
  and the two provenance points that need the owner's ruling (`deny_sources`,
  and that captures are stored verbatim because no capture door redacts).
- 23d72db: **Four rulings from 2026-09-17, each one closing an open question rather than
  adding a surface.**
  
  **One cloud template ships (OPEN-7).** `seed/compute-templates/zen.yaml` is
  gone: a seeded template is a promise to keep a base URL, a price table and a
  retention claim true, and OpenCode Zen's were ours to chase. `openrouter` is
  the one cloud; Zen and every other OpenAI-compatible provider is reached the
  way `compute.yaml` always allowed — a hand-written `providers:` block, or
  `--base-url` over the nearest template. `COMPUTE_TEMPLATES` and the Mac app's
  picker both lose the entry, and the C13 non-ZDR warning is now proved against
  a hand-written cloud, because no shipped template is non-ZDR any more.
  
  **`critical: true` belongs on `assignments.default` (OPEN-4).** The flag was
  already enforced; what carries it was open. The seed now marks the default
  assignment, with the consequence written beside it: under a budget's
  `action: critical_only` the turn you are waiting on keeps being answered while
  routines and delegation stop. The mark travels with the assignment, so
  `tiers.routine` has to stay declared for the pause to reach the evening fold —
  the seed says so, and a test uncomments the seed's own example to prove it.
  
  **The board's Assigned column is read "Addressed to" (OPEN-5).**
  `work.owner` is informational — a name on the card, not a lease; the lease is
  `claimed_by`, and claiming is what moves a row to In Progress. A rename of
  what the user reads only: the derived value stays `assigned`, so every drop's
  route, board.yaml and the `runs` ledger are untouched, and a new test pins the
  label and the key apart.
  
  **`agents_delegate` advertises each crew's description (H8).** The assistant
  saw crew names and nothing else, so which helper fitted a brief was guesswork
  the registry corrected by refusal — after the brief was written.
  `CrewDispatcher.names(): string[]` becomes `crews(): CrewSummary[]`, and the
  `crew` field's description now carries `<name> — <description>` from each
  manifest. It is in the tool definition rather than a prompt line, so it
  travels to whichever model `compute.yaml` assigned, and it is read off the
  registry at registration, so an edited manifest lands on the next call rather
  than the next restart. Capped at 20 crews and 120 characters each: the roster
  is spent out of the same definition-token budget the eager surface is measured
  against.
- Updated dependencies [6aa64c2]
- Updated dependencies [26ffe39]
- Updated dependencies [70f6580]
- Updated dependencies [f27e0af]
- Updated dependencies [e48ea1e]
- Updated dependencies [ae0f9db]
- Updated dependencies [b99d4ad]
- Updated dependencies [75c7547]
- Updated dependencies [6fd4c28]
- Updated dependencies [54a737b]
- Updated dependencies [5b3e6f2]
- Updated dependencies [cde0691]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
- Updated dependencies [367f456]
  - @foldedspacelabs/metistry-mcp-brain@0.8.0
  - @foldedspacelabs/metistry-core@0.8.0
  - @metistry-apps/collectors@0.8.0
  - @foldedspacelabs/metistry-tasks@0.8.0
  - @metistry-apps/routines@0.8.0
  - @foldedspacelabs/metistry-artifacts@0.8.0
  - @foldedspacelabs/metistry-queries@0.8.0

## 0.7.1

### Patch Changes

- @metistry-apps/collectors@0.7.1
  - @foldedspacelabs/metistry-artifacts@0.7.1
  - @foldedspacelabs/metistry-core@0.7.1
  - @foldedspacelabs/metistry-mcp-brain@0.7.1
  - @foldedspacelabs/metistry-queries@0.7.1
  - @foldedspacelabs/metistry-tasks@0.7.1
  - @metistry-apps/routines@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [f6c0eee]
  - @foldedspacelabs/metistry-core@0.7.0
  - @metistry-apps/collectors@0.7.0
  - @foldedspacelabs/metistry-artifacts@0.7.0
  - @foldedspacelabs/metistry-mcp-brain@0.7.0
  - @foldedspacelabs/metistry-tasks@0.7.0
  - @metistry-apps/routines@0.7.0
  - @foldedspacelabs/metistry-queries@0.7.0

## 0.6.0

### Minor Changes

- 410dcce: The console's **local owner token** (`docs/ops/auth.md`), so the Mac app and
  the CLI authenticate to a console on this machine without a passkey
  ceremony — they are the same package, on the same filesystem, running as the
  same person.
  
  - `Authorization: Bearer $METISTRY_LOCAL_OWNER_TOKEN` yields the `user` principal,
    the same one a passkey session yields, through the same `isUser()`
    predicate — but **only** when the connection's peer address is loopback.
    The decision comes from the socket; `X-Forwarded-For`, `Forwarded`,
    `X-Real-IP` and `Host` are never read. From anywhere else it is a 401
    byte-identical to an unknown token's, plus a `runs` audit line naming the
    address. Constant-time comparison; misuse tests ship with it.
  - Compose NATs a host-loopback connection to the bridge gateway, so
    `METISTRY_TRUSTED_LOOPBACK_PROXY` is how the console is told: the compose
    file sets the sentinel `docker-gateway`, resolved at startup from the
    container's own default route. The gateway address only — a sibling
    container is still remote. Unset (launchd) = plain loopback.
  - `GET /api/whoami` → `{principal, via, management, origin, as_of}`.
  - `POST /auth/logout` and `/api/push/*` stay passkey-session-only: they act
    on a device session row. A host-minted `owner_tokens` row (the capture
    Shortcut) is unchanged — capture-only, any address.
  - `METISTRY_ORIGIN` may be a comma-separated list (`expectedOrigin` takes an
    array in @simplewebauthn v13); the first entry stays canonical. An origin
    mismatch, which used to escape as HTTP 500, is a 401 naming expected vs
    presented.
  
  CLI: `METISTRY_LOCAL_OWNER_TOKEN` joins `SECRET_SCOPES` as instance-scoped;
  `metistry init` mints it into the `.env` lines it prints; `secrets sync --to
  env` mints one for an install that predates it (`GENERATED_SECRETS`, the
  same "generated, so minting cannot be the wrong guess" rule as `up`'s DB
  password); `metistry console whoami [--json]` prints the principal — what
  the app calls to show "signed in as owner"; and `metistry doctor`'s console
  row now presents the token, so `api_status` is a real authenticated read
  (a refused token degrades rather than fails).

### Patch Changes

- @metistry-apps/collectors@0.6.0
  - @foldedspacelabs/metistry-artifacts@0.6.0
  - @foldedspacelabs/metistry-core@0.6.0
  - @foldedspacelabs/metistry-mcp-brain@0.6.0
  - @foldedspacelabs/metistry-queries@0.6.0
  - @foldedspacelabs/metistry-tasks@0.6.0
  - @metistry-apps/routines@0.6.0

## 0.5.0

### Patch Changes

- @metistry-apps/collectors@0.5.0
  - @foldedspacelabs/metistry-artifacts@0.5.0
  - @foldedspacelabs/metistry-core@0.5.0
  - @foldedspacelabs/metistry-mcp-brain@0.5.0
  - @foldedspacelabs/metistry-queries@0.5.0
  - @foldedspacelabs/metistry-tasks@0.5.0
  - @metistry-apps/routines@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c32b27d]
  - @foldedspacelabs/metistry-mcp-brain@0.4.0
  - @foldedspacelabs/metistry-core@0.4.0
  - @metistry-apps/collectors@0.4.0
  - @foldedspacelabs/metistry-artifacts@0.4.0
  - @foldedspacelabs/metistry-tasks@0.4.0
  - @metistry-apps/routines@0.4.0
  - @foldedspacelabs/metistry-queries@0.4.0

## 0.3.1

### Patch Changes

- @metistry-apps/collectors@0.3.1
  - @foldedspacelabs/metistry-artifacts@0.3.1
  - @foldedspacelabs/metistry-core@0.3.1
  - @foldedspacelabs/metistry-mcp-brain@0.3.1
  - @foldedspacelabs/metistry-queries@0.3.1
  - @foldedspacelabs/metistry-tasks@0.3.1
  - @metistry-apps/routines@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ea541bc]
- Updated dependencies [c07a12c]
- Updated dependencies [92dd868]
- Updated dependencies
- Updated dependencies [ad185f2]
  - @foldedspacelabs/metistry-core@0.3.0
  - @foldedspacelabs/metistry-mcp-brain@0.3.0
  - @metistry-apps/collectors@0.3.0
  - @foldedspacelabs/metistry-artifacts@0.3.0
  - @foldedspacelabs/metistry-tasks@0.3.0
  - @metistry-apps/routines@0.3.0
  - @foldedspacelabs/metistry-queries@0.3.0

## 0.2.0

### Minor Changes

- 66d5c08: `queries_list` / `queries_run` on mcp-brain — invariant 3's one read path
  (named, parameterized queries, never free-form SQL) out to agents. An
  agent lists what's available (name, description, param types/defaults)
  and runs one, capped at 200 rows with truncation noted. The instance's
  own assistant always has it; an external agent needs an explicit
  `queries: true` grant (`PUT /api/agents/:id/grants`), a separate axis
  from the knowledge tier.
  
  Every mcp-brain tool also now takes an optional `turn_id` (≤ 64 chars,
  `[A-Za-z0-9_-]`), recorded on the tool's `runs` row (`meta.turn_id`); the
  `activity_feed` query surfaces it so one reply's tool calls group
  together. The seed assistant prompt tells it to generate one per reply.
  
  Crews never get `queries_list`/`queries_run` — a named query is not
  filtered by a crew's scope/projects the way every other tool group is.
- 4774e08: Phase 6 — embeddings on reconcile, and semantic search behind the same
  grants.
  
  The reconciler embeds settled notes as it reconciles (local Ollama
  `nomic-embed-text`, model and dim per row) and gains
  `POST /embeddings/rebuild`. `GET /vault/search` and mcp-brain's
  `knowledge_search` take `mode=keyword|semantic|hybrid`, defaulting to
  hybrid once vectors exist and keyword before that. Every mode keeps the
  grant tier and the draft exclusion in SQL. With no embedder running,
  search still answers in keyword and the index is unaffected.
  
  Migration 0012 adds `knowledge_files.embedded_hash` / `embedded_model`
  (additive, derived).

### Patch Changes

- Updated dependencies [66d5c08]
- Updated dependencies [4774e08]
- Updated dependencies
- Updated dependencies [fc0b525]
  - @foldedspacelabs/metistry-core@0.2.0
  - @foldedspacelabs/metistry-mcp-brain@0.2.0
  - @foldedspacelabs/metistry-queries@0.2.0
  - @foldedspacelabs/metistry-artifacts@0.2.0
  - @foldedspacelabs/metistry-tasks@0.2.0
  - @metistry-apps/collectors@0.2.0
  - @metistry-apps/routines@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @foldedspacelabs/metistry-core@0.1.0
  - @foldedspacelabs/metistry-queries@0.1.0
  - @foldedspacelabs/metistry-tasks@0.1.0
  - @foldedspacelabs/metistry-artifacts@0.1.0
  - @foldedspacelabs/metistry-mcp-brain@0.1.0
  - @metistry-apps/collectors@0.1.0
  - @metistry-apps/routines@0.1.0
