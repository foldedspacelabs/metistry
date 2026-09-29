# @metistry-apps/collectors

## 0.15.0

### Minor Changes

- 5008ef6: **The live-capture recorder: the end of a session (T8-2b).** When a recording ends — Stop, the ten-hour stop, the disk, or a crash the helper finds when it next starts — the bridge sends its transcript to the console's `POST /capture` as one Markdown capture (`kind: transcript`), with `Idempotency-Key: live-capture:<session>`, using a capture owner token of its own (`METISTRY_LIVE_CAPTURE_INBOX_TOKEN`) that it never accepts and that must differ from its other two. A session stays owed on the Mac until the console answers with a row; a refusal or an outage leaves it there, `check` says why, and the next pass retries with the same key. The helper ships as a signed `lc-helper.app` ("Metistry Recorder") with its microphone and app-audio usage strings, built and signed the way the calendar helper is. `metistry up` installs it as its own launchd job, `com.foldedspacelabs.metistry.recorder`, and the bridge beside the other bridges — only once `METISTRY_LIVE_CAPTURE_URL` is set, under every shape — and `metistry doctor` reports both. The inbox drain classifies a transcript without a model, and a crashed recording raises one report in Needs You. The assistant now routes every turn that names a capture session onto the private tier — an on-machine provider — whatever was chosen, and refuses the turn when no private tier is assigned; it never falls back.
- e41aa66: **Pull requests, reviewed in Metistry and posted as you (T2-13, R6).** The
  GitHub sync now raises a *pull request* request in Needs You for each open PR
  waiting on your review — with its head SHA, its diff and its open review
  threads — and clears it when your review lands on GitHub, the PR goes back to
  draft, or it closes; a new push is a new question. An agent asks for the same
  review with `requests_create` kind `pull_request` and the PR in `refs`, and
  the two asks are one card. You answer through three new doors —
  `POST /api/github/pulls/:owner/:repo/:number/review` and
  `…/threads/:id/{reply,resolve}` — which post to GitHub as you, through the one
  client holding your `github_write` secret, and only after checking that the
  PR's head is still the one you were shown (`409 stale` otherwise, and nothing
  is posted). The sync's own token stays read-only by construction: it can send
  nothing but GETs and GraphQL queries. `metistry secrets sync --to env` delivers
  `github_write` to the console when `secrets.yaml` names it; store it with
  `metistry secrets set github_write --hosts api.github.com`. A sync is now
  handed its Needs You switches (`syncs.<name>.raise`) by the runner.
- 290cc20: T4-12: an `ics` calendar connection type and its `ics-calendar` sync. A public
  iCalendar feed is read through the egress door — pinned to the feed's own
  origin, no redirect followed, https only, capped at 10 MB — and its events
  (RRULE, RDATE, EXDATE and RECURRENCE-ID overrides; IANA and VTIMEZONE zones,
  DST-correct; all-day dates in the owner's `METISTRY_TZ`) are written into
  `calendar_events` beside the eventkit sync's, so Today reads one table for
  every source. The invite body is never read. A feed address carrying a token
  is refused at the connection file as a key; private feeds wait on a ruling.
  `openSyncHttp` accepts a provider with no origin of its own (the pin is then
  the connection's own URL), and collectors receive the owner's zone as
  `ownerTimeZone`.
- accfc70: T4-13: CalDAV with replies. A `caldav` calendar connection type, with iCloud
  (`icloud-calendar`) and Fastmail (`fastmail-calendar`) as known services that
  name their servers, signed in with an app password: read (the
  `caldav-calendar` sync writes the owner's two weeks into `calendar_events`,
  the owner's own answer as `self_status`), `rsvp` (only the owner's own
  ATTENDEE line changes — its PARTSTAT — and the RFC 6638 server delivers the
  REPLY) and `write_own` (events nobody else is in). Every change previews
  first and is confirmed against the event's ETag with `If-Match`. A Google
  address is refused: Google needs sign-in with Google. `openSyncHttp` sends
  Basic sign-in — `Basic {{ secret.x }}`, encoded and filled at the egress
  door — and `metistry connections add|set` take `--auth basic --username`.
  The WebDAV XML subset is hand-rolled (no dependency; a DOCTYPE is refused).
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
- c552e43: **Linear: completion both ways (T4-26).** `POST /api/trackers/:connection/issues/:key/complete` (owner reach) closes an issue in Linear: `completeIssue` reads it and, only if it is still open, sends one fixed mutation moving it to its team's first `completed` state — through the connection's egress door, the key filled for `api.linear.app` only; an issue already completed or canceled is answered as it stands (`changed: false`). `linearQuery` still refuses every mutation, so no caller can send another change. The owner's setting is the connection's `complete_issue` tool mode, which the `linear` connection type now declares (capability `complete`): Ask First (the default) — the client offers *Close <KEY> in Linear* after a tick; Allow — the client makes the call itself; Never — the door refuses `403 tool_off` and sends nothing. The door closes the issue's `work` row and resolves its `task` request at source, and writes no vault file. The other way, `GET /api/today` gains `tracker_closed`: the day's open lines whose `linear:` issue the tracker closed, for *Done in Linear* with a one-click Tick (named query `tracker_closed`, route-only) — the sync never writes the owner's note. The client-API row is served.

### Patch Changes

- Updated dependencies [4099fcb]
- Updated dependencies [6dd922a]
- Updated dependencies [0c07861]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [290cc20]
- Updated dependencies [accfc70]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [f3d8db3]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0
  - @foldedspacelabs/metistry-mcp-brain@0.15.0
  - @foldedspacelabs/metistry-connections@0.15.0

## 0.14.4

### Patch Changes

- @foldedspacelabs/metistry-connections@0.14.4
  - @foldedspacelabs/metistry-core@0.14.4
  - @foldedspacelabs/metistry-mcp-brain@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [dcd9384]
  - @foldedspacelabs/metistry-core@0.14.3
  - @foldedspacelabs/metistry-connections@0.14.3
  - @foldedspacelabs/metistry-mcp-brain@0.14.3

## 0.14.2

### Patch Changes

- @foldedspacelabs/metistry-connections@0.14.2
  - @foldedspacelabs/metistry-core@0.14.2
  - @foldedspacelabs/metistry-mcp-brain@0.14.2

## 0.14.1

### Patch Changes

- @foldedspacelabs/metistry-connections@0.14.1
  - @foldedspacelabs/metistry-core@0.14.1
  - @foldedspacelabs/metistry-mcp-brain@0.14.1

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
- Updated dependencies [d92ea0c]
- Updated dependencies [f01606b]
- Updated dependencies [2fc0ef0]
- Updated dependencies [211b408]
- Updated dependencies [851e08a]
- Updated dependencies [23b963a]
- Updated dependencies [ed7f5c2]
- Updated dependencies [ea2e876]
- Updated dependencies [50a455d]
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
  - @foldedspacelabs/metistry-mcp-brain@0.14.0
  - @foldedspacelabs/metistry-connections@0.14.0

## 0.13.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [42021b1]
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
- Updated dependencies [739564d]
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
  - @foldedspacelabs/metistry-mcp-brain@0.13.0
  - @foldedspacelabs/metistry-core@0.13.0

## 0.12.0

### Patch Changes

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
  - @foldedspacelabs/metistry-mcp-brain@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [4a778f9]
- Updated dependencies [4f43f9c]
- Updated dependencies [9c9da4a]
- Updated dependencies [1bf5c76]
- Updated dependencies [5cc302d]
- Updated dependencies [b6586de]
- Updated dependencies [579662f]
- Updated dependencies [57ceb02]
- Updated dependencies [45b64df]
- Updated dependencies [9ec30d5]
- Updated dependencies [7f9ceb7]
- Updated dependencies [23cc47f]
  - @foldedspacelabs/metistry-core@0.11.0
  - @foldedspacelabs/metistry-mcp-brain@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [7782cf4]
- Updated dependencies [ad73f5a]
- Updated dependencies [8fc0e5e]
- Updated dependencies [0171bc0]
- Updated dependencies [7782cf4]
  - @foldedspacelabs/metistry-mcp-brain@0.10.0
  - @foldedspacelabs/metistry-core@0.10.0

## 0.9.1

### Patch Changes

- @foldedspacelabs/metistry-mcp-brain@0.9.1
  - @foldedspacelabs/metistry-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [c1f512e]
- Updated dependencies [337bc0a]
- Updated dependencies [dade46d]
- Updated dependencies [f57b3b0]
- Updated dependencies [76f82a2]
  - @foldedspacelabs/metistry-core@0.9.0
  - @foldedspacelabs/metistry-mcp-brain@0.9.0

## 0.8.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.8.1
  - @foldedspacelabs/metistry-mcp-brain@0.8.1

## 0.8.0

### Minor Changes

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
- Updated dependencies [6fd4c28]
- Updated dependencies [cde0691]
- Updated dependencies [23d72db]
- Updated dependencies [78d78d1]
- Updated dependencies [d21f953]
- Updated dependencies [26df04d]
- Updated dependencies [367f456]
  - @foldedspacelabs/metistry-mcp-brain@0.8.0
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
