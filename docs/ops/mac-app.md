# The Mac app — `apps/macos`

The SwiftUI front end for the `metistry` CLI. It is the way the plan expects
most people to get Metistry (`docs/product/desktop-app-plan.md`, "Distribution:
the app as the installer", strategy ratified 2026-09-07): download a signed,
notarized DMG from GitHub Releases, open it, and never touch a terminal.

**The design rule that makes it safe:** the app is a front end for the CLI,
never a second implementation. Every install step is a `metistry` verb the app
runs with a progress view. It opens no database connection (invariant 3), runs
no git of its own, and has no private endpoints. The terminal path stays
first-class and identical, so open-source users and app users share one tested
path.

## What it does today, and what it does not

**Real:**

- **The shell** (T5-2, "The shell" below): the window's sidebar — Needs You
  while something waits, then Today · Chat · Activity · Work ▸ · Knowledge ·
  Agents · Scheduled, then Pinned — the toolbar's + and Usage gauge, the title
  *Metistry* on every screen, the Go · Capture · Item menus with every
  shortcut in them, Help ▸ Keyboard Shortcuts, and the Needs You count on the
  Dock. The screens behind the rows are their own tickets; until one lands its
  detail says so and offers the web app. Needs You, Today (the brief, Next Up,
  Close the Day, and the day's spine and All — "Today" below), Chat, Activity,
  Knowledge, Scheduled, Agents, the Usage popover and the capture composer
  have landed. So have Work ▸ Board, with the card detail and a task's room
  ("Work ▸ Board" below), Work ▸ Projects and Work ▸ Artifacts.
- **Status.** Its own window now (Window ▸ Status), no longer a sidebar row.
  Runs `metistry doctor --json` and renders the rows to the design
  system's §3.13 — grouped by doctor's own `kind`, `absent` shown in absent
  grey and labelled "not configured", a summary line first ("26 ok · 1 degraded
  · 1 not configured") so the panel answers before it is read. The remediation
  replaces the probe on any row that is not `ok`.
- **Settings**, in the `Settings` scene: ⌘, and the app menu, seven panes —
  Instance, Services, Connections, **Compute**, Secrets, Updates, Advanced.
  Every value on them is one of three things and the pane says which: a pointer
  the app remembers, a read-through of a file or a verb the CLI owns, or a
  labelled "not yet". The table below is the whole contract. Compute is the
  first pane that also **writes** — and it writes the only way anything in this
  product does, by running a `metistry compute` verb ("The Compute pane" below).
- **The first-launch wizard.** A sheet over the plan's seven steps, shown when
  no instance is selected and re-enterable from **Settings → Instance → Set up
  again…**. Back/Continue/Skip; each choice carries what it gets you and what it
  costs; every step shows the exact argument array *before* running the verb and
  streams the CLI's own output. **All seven act:**
  1. `metistry runtime install --from <bundle> --to <product dir>` when this
     build is running out of its own read-only bundle (below).
  2. `metistry init`, or adopt a folder that already holds a `.metistry/identity.yaml`,
     which runs nothing.
  3. `metistry connect-repo --auth device|ssh` — the GitHub device code is
     parsed out of the CLI's stream and shown as a card with a link, while
     connect-repo keeps polling.
  4. `metistry secrets sync`, plus a
     `metistry secrets mint METISTRY_BRIDGE_TOKEN_<NAME>` per bridge you enable.
  5. `metistry up`, preceded by the shape: preview the other one
     (`up --dry-run` with `METISTRY_DEPLOYMENT_SHAPE`), then
     `metistry deployment set-shape <shape> --yes`. **"Set the Shape" stays
     disabled until the preview has been on screen** — preview-then-confirm is
     the rule the CLI holds destructive verbs to, and a `--yes` reachable
     without the preview would be the app confirming on the user's behalf.
  6. The door — **optional, and usually already done**: it opens with this
     Mac's sign-in state (`metistry console whoami --json`, "Signing in" below)
     and offers the console's enrolment code for a browser or a phone. The
     `ASAuthorization` path is still written and still runs the moment an
     install qualifies; the probe that measures why none does yet moved to
     Settings → Advanced.
  7. **Compute** — pick a provider template, paste its API key into a secure
     field, name a model, and the app runs `metistry compute providers add
     --from <template> --json` (key on stdin) then `metistry compute assign
     default <provider/model> --json`. "Skip: no engine yet" is a real
     choice, with its consequence on screen.

  Steps 6 and 7 are the two that are **not** a `metistry` verb, so they own
  their own screens rather than being forced through the generic run row
  (`FirstRunStep.hasOwnScreen`, pinned by a test).
- **The menu-bar item.** Its glyph is the worst *fault* across components.
  `absent` never drives it — a bridge that was never configured is not a fault,
  which is the same rule that keeps `absent` out of doctor's exit code. The menu
  groups every component by doctor's own `kind` (Services, Bridges, Launchd
  Jobs, Containers, …) with a status dot and a submenu: Restart, Stop, Start,
  View Log. Above them: Restart All, Stop All, and "Update Available: x.y.z"
  when Sparkle has found one.

  **Two things the compute work added.** The supervisor's **children** are
  listed under *Services* rather than in a group of their own, and they carry
  the same four controls: `metistry restart|stop|start|logs llamaserver`
  resolves a `child` target over the supervisor's control socket
  (`packages/cli/src/service-control.ts`), which is the same four verbs a
  launchd job gets — doctor reports them under their own `kind` because *how*
  they are addressed differs, and nobody opens a menu looking for a "child".
  The supervisor itself keeps its own group: it owns them, and booting it out
  takes them with it. And the **apple-fm** bridge row reads `apple-fm · serves
  foundation-model` once `compute.yaml` declares a provider that dials it —
  doctor's `local:applefm` row already names that provider, so the menu reads it
  rather than asking `compute show` a second time. A bridge being *up* and a
  bridge being *where turns run* are different facts.
- **Sparkle auto-update.** Pinned to 2.9.6 — the same version
  `ops/release/runtime-versions.env` pins the signing tools to. The feed is
  `https://github.com/foldedspacelabs/metistry/releases/latest/download/appcast.xml`
  and the public EdDSA key is `SUPublicEDKey` in `Info.plist`; both are read by
  Sparkle itself, so the app cannot disagree with the workflow that signs the
  feed. Sparkle also owns its own preferences — the Updates pane's
  automatic-checks toggle writes Sparkle's `automaticallyChecksForUpdates`, not
  a key of ours. Sparkle is not the only way in: `metistry update` installs the
  same release's DMG (below, "Updated from the terminal too").

**Not yet, and labelled as such on screen:**

| | why | what to do today |
| --- | --- | --- |
| **A native passkey** (wizard step 6) | measured, not assumed — see "What ASAuthorization actually says" below. `ASAuthorization` refuses *every* relying party from a Developer ID build, because an application identifier comes from an embedded provisioning profile and a DMG from GitHub Releases has none. **This stopped being step 6's problem on 2026-09-10**: this Mac needs no passkey at all | for a browser or a phone, the step's enrolment code — open the link here, or type it on the phone. Same `passkeys` row either way. The probe is under Settings → Advanced |
| `connect-repo --auth token` | it reads the PAT from **stdin**, and the app gives every child an empty stdin on purpose so no verb can hang a progress view waiting for a paste | the wizard shows the option, disabled, with that reason; run it in a terminal |
| **Minting an enrolment code** | there is no HTTP route that mints one, deliberately — whoever can run the host command already controls Postgres and the vault, so shell access is the root of trust for a first passkey (plan §4.2) — and `metistry enroll` is on the CLI's own "not yet" list | step 6 shows the exact `scripts/enroll.mjs` command and takes the code you paste back |
| **A QR code** for the phone | nothing in this product renders one yet; `apps/console/scripts/enroll.mjs` says the same about itself ("QR rendering arrives with `packages/cli`"), and an encoder is a dependency nobody has asked for | step 6 shows the enrolment URL, selectable, to type or hand over |
| **The screens behind the rest of the sidebar's rows** | the shell has the rows (T5-2); each screen is its own ticket, and until it lands the row's detail names the gap and offers the web app. Landed in W2, each with its section below: Needs You (T5-4a's list, T5-4b's bodies), Today (T6-1a's spine, T6-1b's brief, Next Up and Close the Day), Chat (T6-2), Activity (T6-3), the Usage popover (T5-6) and the capture composer (T5-5); in W3, Knowledge (T6-4), Agents (T6-5), Scheduled (T6-6), Work ▸ Board (T6-7), Work ▸ Projects (T6-8), Work ▸ Artifacts (T6-9) and Run detail (T6-10). Still to come: the rest of W3 (T6-11) | the PWA — "Add to Dock" in Safari, or the detail's **Open in Browser** |
| **Attachments and live capture in the composer** | New Capture is the text composer (T5-5, "The capture composer" below); the owner held audio and screen capture until the designer's floating action bar returns (#253), and the attachment chip, ⌘⇧A and the window's drop target are not built. The Capture menu's Ask · Note · To-do and Start/Stop Recording stay dimmed for the bar (T8) | the PWA's +, or `metistry console call POST /capture` with `filename` and `content_base64` |
| **The keep-awake control** (Services) | the model half is shipped — `KeepAwakeSetting` (four values, each with what it costs), `KeepAwakeFacts` (doctor's row) and `deploymentSetKeepAwake` — and the pane is a switch with a radio pair under it, which is the designer's. First run can pass `--keep-awake` and does not ask on its own | a terminal: `metistry deployment set-keep-awake <value> --yes`, or `metistry init --keep-awake <value>` |
| **An iOS target** | `MetistryKit` is already free of AppKit and of `Process` so it can be shared; there is no iOS target in `Package.swift` | — |

**Four things left this table on 2026-09-10**, and it is worth saying what
replaced them rather than letting them vanish: wizard step 7 (a terminal the app
opens plus a watch on the secret's *name*); writing `.metistry/deployment.yaml` (the CLI
grew `deployment set-shape`, so the invariant is enforced at the tool where it
belongs and the app still writes no file); "Start at login" (`SMAppService.mainApp`,
which needed no CLI change at all — the old entry had conflated it with the
launchd agents); and "an instance id" (`metistry init` mints one into
`.metistry/identity.yaml`, and `metistry identity --json` reports it).

**A fifth left it on 2026-09-17**: registering the install's launchd agent
through `SMAppService.agent(plistName:)`. The app does that now, and Settings
has the toggle — "The install's agent, nested under the app" below.

An empty destination is not listed as a greyed-out placeholder. §3.15's
distinction holds throughout: *empty* (nothing has happened) and *absent* (never
configured) are different states, and neither is a failure.

## Signing in: this Mac is the owner, and it never sees the token

**The decision (owner, 2026-09-10).** The app is the same package as the CLI,
on the same machine, running as the same person. It therefore authenticates to
the **local** console *implicitly* — by a token only the logged-in user can
read — and never by a passkey ceremony. Passkeys stay exactly as they were, for
browsers, the phone, and every remote client. `docs/ops/auth.md` is the
console's side of this; what follows is the app's.

**The one call, and it is not HTTP.** On launch and on every instance switch
the app runs

```
metistry console whoami --json
```

and renders what came back. It does **not** read the login Keychain from Swift,
does **not** open `<instance>/.metistry/state/.env`, and sends **no `Authorization`
header** anywhere. The CLI is the one place that knows where
`METISTRY_LOCAL_OWNER_TOKEN` lives, and it presents it over loopback without the
value ever reaching this process — `ConsoleWhoami` has no field a token could
land in. `apps/macos/tests/kit/console-sign-in-tests.swift` walks
`apps/macos/sources` and asserts all of that: one file uses `URLSession`, no
file sets a header other than `content-type`/`cookie`, no file names a Keychain
API, and no file opens a file at all.

**The five states, and what each says on screen.** Told apart by the CLI's exit
code and by three phrases in its own message — never by the variable's name,
which is being renamed and must not be load-bearing.

| state | header / Connections | dot | what it offers |
| --- | --- | --- | --- |
| **signed in** | "Signed in as owner (local token)", with `via local_owner_token`, `management yes` and the console URL | `ok` | nothing — there is nothing to do |
| **CLI too old** | "Cannot ask — this install's CLI has no `console whoami`" | `degraded` | `metistry update`. The install works; this app's view of it does not |
| **token unset** | "No local owner token on this install", with the CLI's own line | `absent` | `metistry secrets sync --to env`, then `metistry restart console` — both, in that order, because a freshly minted token does nothing until the console is restarted with it |
| **unreachable** | "The console did not answer", with the transport error verbatim | `failed` | nothing. No command this app could name would fix it |
| **401** | "The console refused the token (401)" | `failed` | the same two commands, plus **which cause is likelier**: under `compose` the loopback rule (Docker's NAT means the console sees the bridge gateway, so it needs `METISTRY_TRUSTED_LOOPBACK_PROXY`); under `launchd`, that the value here is not the one the console was *started* with. Shape unknown → both, said as both |

`absent` for an unminted token is the same rule as everywhere else: a thing
nobody configured is a fact, not a fault.

**Where it appears.** One `ConsoleSignInModel` for the whole app, so no two
screens can disagree and the question is asked once per launch rather than four
times: the Status panel's header (under the doctor summary, with `via`),
Settings ▸ Account (the full card, with the remedy and the exact argument
array), the menu bar (a second dot beside the `console` row, and the headline
inside its submenu — a service being *up* and a service *knowing who you are*
are different questions), and the wizard's step 6, which now leads with it.

**What the app can and cannot call.** It can ask who it is, and — since the
data layer below — it can make any authenticated request the owner surface
offers. That took the **CLI change first**, exactly as this section said it
would: `metistry console call <METHOD> <path>` keeps the token out of this
process entirely, which a token-printing verb would not, and keeps the rule
that makes this app safe — a front end for the CLI, never a second
implementation. ~~Everything on the owner surface is therefore the PWA's job
for now~~ (struck 2026-09-18; the verb shipped and `ConsoleAPI` is its client).

## Data layer

Phase A's non-visual half (`docs/product/app-ux-plan.md` §6): the typed client
and the store the seven sections read. **Views never call `URLSession` and
never run a verb** — a view reads a section (`InstanceStore`'s, or a
`SectionModel`) and calls a store method through `AppModel.console`, and a
screen that reached past the store would be the bug this section exists to name.

| Type | File | What it is |
| --- | --- | --- |
| `ConsoleCallTransport` | `sources/kit/console-api.swift` | One authenticated request against this machine's console, behind a protocol so the store is testable with nothing spawned and no network |
| `SessionConsoleCallTransport` | same | The production transport: one long-lived `metistry console session --stdio` child, requests matched by id, restarted on the next call after it exits, and `events(lastEventID:)` for `GET /api/events`. The kit declares `SessionProcess`/`SessionSpawner`; `ProcessCommandRunner` (`sources/app/`) is the `Process` behind them |
| `CLIConsoleCallTransport` | same | One process per request: `metistry console call <METHOD> <path> [--body -] --json`. A body goes on **stdin**, never argv. The session's fallback for a CLI that predates it |
| `ConsoleAPI` | same | One method per route in `docs/ops/console-api.md` — identity, whoami, `activity_feed`, proposals (+ batch), board and the four task routes, rooms, agents and `agent_presence` (+ autonomy, approve), `/api/compute*`, `/api/knowledge/search|page|pages`, `/api/commands`, `/api/runs/:id` |
| `ConsoleError` | `sources/kit/console-client.swift` | The standard envelope — with `details`, every key of the body beside `error` (a `409`'s `reason` and the row as it stands) — plus `cliUnavailable` (this install's CLI predates the verb) and `notConfigured` (no token, or a non-loopback console). `namedField(among:)` attributes a refusal to a field **the caller already sent** — the envelope is `{code, message}` and names its field in prose, so nothing is inferred from the sentence's shape |
| `ConsoleReachability` | `sources/kit/console-api.swift` | reachable / degraded / unreachable, **reported not inferred** (P5). A `401` is unreachable; a `403` is not — the console answered and one route declined this credential |
| the wire shapes | `sources/kit/console-data.swift` | `Codable` per route and per named-query row. Two tolerances live here so no call site repeats them: a Postgres `numeric` arrives as a **string**, and timestamps are text |
| `RequestAnswer` | same | The six answers and the option form a `decision` request takes. `isBatchable` is "only Later, Skip and Decline"; `isSendable` is "Revise with an empty reason is a cancel" |
| `TaskPatch` | same | `PATCH /api/tasks/:id`'s two arms. A body mixing them is refused **here**, because the route's own refusal names both fields and discovering that on submit is worse |
| `LoadState` · `Section<Value>` | `sources/kit/instance-store.swift` | loading / loaded / failed / stale, with the console's `as_of` beside the value. A failed refresh over data already on screen goes **stale and keeps it** — never a blank pane |
| `RefreshPolicy` | same | The intervals, and a backoff that changes how often the app *asks* and never what it *claims*. No timer is started here: a view owns its `.task` and the policy says whether it is too soon |
| `InstanceStore` | same | The Phase-A sections — feed, queue, board, rooms, agents, presence, compute, commands, knowledge — one `@Observable` store per instance, a `Section` per section. `adopt` drops every section on an instance switch |
| `ConsoleSession` | `sources/kit/stores/console-session.swift` | **What the app holds** (`AppModel.console`, T5-1): per instance, the one `console session` child, `ReachabilityGate` in front of it, `ConsoleStores` over the gate, the `InstanceStore` over the same stores, and `management` (`CLIManagementRunner`). The child starts on the first request. `adopt` — every instance switch and every re-resolved runtime — ends the old child, drops every section built on the session and moves `generation`, so an answer still in flight for the previous instance is discarded when it lands |
| `ReachabilityGate` · `ConsoleAct` | `sources/kit/stores/reachability-gate.swift` | **O3 at the tool.** Every store request passes through it: the newest request's answer is recorded as the connection's reachability (a `401`, no process, no token → unreachable; any answer at all → reachable), and a **decision** is refused before it is sent while unreachable. `ConsoleAct` sorts a request by screen-18 §4's one rule per verb: a read always goes; an **append** — capture, tick, defer (the table's `key` rows) and a 👍/👎 — goes and may be kept by its composer; everything else is a decision, including any route the file does not name |
| `SectionModel<Value>` | `sources/kit/stores/section-model.swift` | One section of a screen built on the §2.16 stores: `Section`'s state machine, the store read that fills it, `refreshIfDue` (a redraw is never a request), `topics` — the `EventTopic`s an event may name to mark it due (`invalidate()`), and while the stream is live a loaded section with topics waits to be told rather than asking on its clock — and registration with its session so an instance switch drops it |
| `LiveEvents` · `EventTopic` | `sources/kit/stores/events-store.swift` | **The one live-changes subscription** (`ConsoleSession.events`, T5-7): `GET /api/events` held open over the session child, the last id heard (the console's cursor included), each event handed to the watchers of its topics — the catalogue's "the client refetches" column, one topic per store. `off` · `connecting` · `live` · `down(why)` · `unavailable(why)`; reopened on a backoff (3 s doubling to a minute) with `Last-Event-ID`; a `resync`, an unreadable frame, or a subscription with no cursor to resume from marks every watcher due |
| `CLIManagementRunner` | `sources/kit/stores/management-runner.swift` | §2.2's verbs (M1–M18) as one `metistry` invocation each through `MetistryCLI`: the argument array `plannedArguments` shows is exactly what runs, a value rides stdin and never argv, and a command may not name its own `--product-dir`. **Not behind the gate** — M5 restarts a console that is down |
| `PinnedItem` · `PinnedItems` | `sources/kit/pinned-items.swift` | The sidebar's Pinned area: project · board · page · search · agent, reorderable and removable, filed in app preferences under `pinnedItems.<instance_id>` |

Three rules the layer encodes rather than asks for:

- **`isRefreshing` is not a state.** P2 wants calm, so a background refresh is
  a flag beside `.loaded` rather than a fifth case — there is nothing for a
  view to draw a spinner from. Only `.loading` with no value yet earns one.
- **O3 is enforced at the transport, for every route.** The Mac app is
  local-only (§7.3) and the rule still holds: while the console is unreachable,
  every decision — all of the §2.16 stores' mutating methods except the appends
  — is refused by `ReachabilityGate` **before sending**, in components-01
  §1.3's sentence ("the instance is unreachable — decisions are never
  queued"), rather than as a request that fails where nobody can see it. A
  control binds `ConsoleSession.allowsDecisions` and prints
  `decisionsUnavailableReason` under itself. `InstanceStore`'s own per-section
  guards on `answer`, `answerMany`, `move`, `address` and `dispatch` stay as a
  second line; they are no longer the only one.
- **The two cursors are not the same mechanism.** The feed's `since` is an
  inclusive timestamp and de-duplicates on `(ref, ts, kind)`; the request
  queue's is an opaque cursor whose page is *everything that changed*, so a row
  answered on the phone leaves the queue instead of lingering. Both folds live
  in `merging(_:)` and are called from the store and nowhere else.

**What this transport costs, and what it no longer does.** Until F-12 every
request was a `metistry console call` process — node starting, the environment
loading, the token being looked up — about **141 ms** median on a scratch
instance, which is fine for a script and wrong for a board that repaints. The
production transport is now `SessionConsoleCallTransport`: one long-lived
`metistry console session --stdio` child per instance, a JSON line per request
answered by a JSON line matched on `id` (`docs/ops/cli.md` has the contract),
**~1.5 ms** median for the same request. The token is still resolved by the
CLI, once, and never reaches this process: the request line carries a method,
a path, a body and an idempotency key, and the source scan above holds with
the new code in.

Four things the transport promises rather than hopes for:

- **A crashed child fails what is in flight; it never hangs it.** When the
  child's stdout closes, every pending call gets the child's own reason — the
  CLI's sentence as `notConfigured` for a missing token or a non-loopback
  console, the last stderr line as `transport` otherwise — and an open event
  stream finishes with the same error. The next call starts a new child; a
  child that cannot start is not respawned in a loop nobody asked for. A call
  that gets no answer at all fails after `callTimeout` (45 s, above the CLI's
  own 30 s per request).
- **An older install is slower, not broken.** A CLI that predates the verb
  answers `console session` with `console`'s usage line (exit 2), which names
  no `session`; the transport reads that as `cliUnavailable` and sends that
  call and every later one through `CLIConsoleCallTransport`.
- **A refusal arrives whole.** F-11 made `console call --json` print the
  console's body for a `>= 400`, and the session always carries it, so a
  conflict `409` keeps its `reason` and **the row as it stands** (`decision`,
  `decided_at`, `proposal`, …; `docs/ops/client-api.md`). They live in
  `ConsoleErrorEnvelope.details`, read as `ConsoleError.conflictReason` and
  `.details` — which is what the queue's `if_unchanged` repaint draws from
  instead of re-fetching. (`ConsoleError.conflictBodyIsUnavailable`, which said
  out loud that the body could not be there, went with F-11.) Capture is still
  not on `ConsoleAPI` — no route method calls it yet — but `Idempotency-Key`
  rides the session as `idempotency_key`, so the transport is not why.

- **A body that is not JSON arrives as its bytes.** The CLI hands a
  non-JSON reply over as its raw text (`readConsoleResponse`), which on the
  session line is a JSON string; the transport returns that text's bytes
  rather than re-encoding it, so `GET /api/runs/export`'s NDJSON reaches
  `RunExport` as rows (T5-1 — before, an export over the session came back as
  one quoted string with no cursor). The one-shot fallback pretty-prints a
  body that parses as JSON, so a one-row export spans several lines there;
  `RunExport` reads a whole body that is one object as that one row.

The live-changes stream rides the same child: `events(lastEventID:)` is `GET
/api/events` (design-build-plan §2.20) as `ConsoleLiveEvent` frames — ids and
counts, never bodies — and cancelling the consuming task sends the session's
`{id, cancel: true}`. The console's cursor (an id with no data, sent to a
fresh subscriber) arrives as `{id, event: {id}}` and is kept as the id to
resume from. A console that does not serve the route finishes the stream with
a `404`; `LiveEvents` reports `down`, every reader polls on its own clock, and
the stream is asked again on the backoff.

**Live vs polling, in one rule.** A reader the stream speaks for (a
`SectionModel` with topics, the shell's count) polls on its `RefreshPolicy`
while the stream is anything but `live`. While it is live, it asks when an
event names it, and otherwise only on `RefreshPolicy.whileLive` — every five
minutes — which catches the one kind of change no table write announces (a
snoozed request coming due). A section that failed keeps its own clock either
way.

### The store interface, and the fixtures every view is built against (F-7)

`sources/kit/stores/` is the interface the screens are written against
(design-build-plan §2.16): **one protocol per domain, one method per route** of
the client API table (`packages/core/src/client-api.ts`) — `NeedsYouStore`,
`TodayStore`, `ChatStore`, `ActivityStore`, `KnowledgeStore`, `AgentsStore`,
`ScheduledStore`, `WorkStore`, `ArtifactsStore`, `UsageStore`, `SettingsStore`,
`CaptureStore`, `EventsStore`, `VaultStore` — each requirement carrying a
`/// route: METHOD /path` line naming its row. `ConsoleStores` implements all
fourteen over any `ConsoleCallTransport` (the session transport in production)
and the event stream over a `ConsoleEventTransport`, which
`SessionConsoleCallTransport` already is. The rows with no method — the passkey
ceremony, logout and push, all bound to a device session the Mac does not hold,
and `/mcp` — are listed with their reasons in
`apps/console/scripts/client-fixtures.mjs`. Two interfaces sit beside the
stores: `ManagementRunner`, whose `ManagementCommand` can only hold one of
§2.2's verbs (M1–M18 — the set is closed at the type; `CLIManagementRunner`
runs it, T5-1), and `LiveCaptureClient`
for the local live-capture bridge (T8). The bridge and its recorder job are
`metistry up`'s (T8-2b; `docs/ops/cli.md`), not the app's: the app's
entitlements stay empty — the recorder, a separate signed bundle
(`lc-helper.app`, *Metistry Recorder* in System Settings ▸ Privacy &
Security), holds the Microphone, Audio Capture and Screen Recording grants —
and Settings ▸ Services shows the two doctor rows it adds, the recorder's
`launchd:` job and the bridge's `live-capture` check. A recording's
transcript reaches the console from the bridge through `POST /capture`, so
the app sends nothing when a session ends. No capture UI is drawn here; the
bar is T8-5's. *Window* and *Screen* (T8-3) are chosen in the system picker,
which the recorder — not the app — presents, so the start the bar sends
names only the mode (`{"mode":"window"}`); the bridge's `status` carries
`senses` (`display`, `app_audio`, `microphone`) — the open streams the rail
draws its display glyph from.

The routes `ConsoleAPI` already spoke keep their names and typed replies. A
reply the contract spells out field by field is typed; every other reply is a
**`ConsoleBody`** — a named type holding the console's JSON whole, which the
ticket that renders it types in place, so no protocol signature moves when it
does.

**The fixtures** — `tests/kit/fixtures/<method>-<path>.json`, one per route
(`GET /api/runs/:id` → `get-api-runs-id.json`; the named queries one per query,
`get-api-q-board.json`) — come from two places, and each file says which:

- `recorded`: every row the console serves, recorded from a **scratch console**
  by `node apps/console/scripts/record-client-fixtures.mjs` — the real server
  in-process, the scratch database (`testDb()`), a `metistry init` instance
  under `os.tmpdir()`, every outbound call faked (`docs/ops/testing.md`).
  `--check` re-records in memory and fails where a served shape moved;
  `--only "<METHOD> <path>"` writes just those routes.
- `contract`: a row frozen ahead of its ticket, written from the contract so
  its view is built before the route lands (U9), naming the ticket that serves
  it. That ticket re-records it, and the recorder **refuses a recording whose
  shape differs from the contract fixture** unless run with `--accept` — which
  is how "F-7's Today fixture matches" (T2-7) is checked by the tool.

`tests/kit/fixture-console.swift`'s `FixtureConsole` is the fake transport:
it routes a request to its fixture the way the console's table routes it and
records what was sent. `store-fixtures-tests.swift` parses the protocols and
holds them to the fixtures both ways, then drives every method with the
arguments its fixture's request was made with — so a method must send exactly
the path, query, body and `Idempotency-Key` the real console accepted, and
decode exactly what it answered — and builds a view from them with no console
running. `apps/console/test/client-fixtures.test.ts` holds the fixtures to the
table: a row gained, a row that became served, a fixture left behind — each
fails CI.

## What `ASAuthorization` actually says about a local origin

Measured on 2026-09-10, because "passkeys don't work locally" is not an answer
anybody can act on. A probe making the same
`ASAuthorizationPlatformPublicKeyCredentialProvider` registration request the app
makes, in a bundle carrying this project's own identifier and signed with its
Developer ID identity, was pointed at three relying parties in turn:

```
RP 127.0.0.1:    com.apple.AuthenticationServices.AuthorizationError 1004: The operation
                 couldn’t be completed. The calling process does not have an application
                 identifier. Make sure it is properly configured.
RP localhost:    …identical…
RP studio.ts.net: …identical…
```

**The refusal is not about the relying party.** It is about the app.
`ASAuthorization` wants `com.apple.application-identifier`, which comes from an
embedded provisioning profile; a Developer ID build has none. Signing the
entitlement in by hand (`application-identifier` + `associated-domains`, same
identity) does not get further either — AMFI kills the process at launch,
SIGKILL, before `main` runs, because those are restricted entitlements that need
a matching profile.

So native passkeys are blocked by the **distribution channel**, not by the local
origin. The ratified channel is a Developer ID DMG from GitHub Releases
(`docs/product/desktop-app-plan.md`), which cannot carry a profile. It would take
an App Store build, or a Developer ID build provisioned through a profile.

**And even with a provisioned build, the origin would still have to change.**
Four separate reasons, each checked separately in
`sources/kit/passkey-enrolment.swift` and each named on screen, because they have
different fixes:

| | why | fixable by |
| --- | --- | --- |
| an IP-literal relying party | the console's RP ID is `new URL(METISTRY_ORIGIN).hostname` (`apps/console/src/webauthn.ts`), so `http://127.0.0.1:8080` gives `127.0.0.1` — and a WebAuthn relying party must be a domain | setting `METISTRY_ORIGIN` to a name |
| an `http:` origin | `ASAuthorization` presents the ceremony's origin as `https://<rpID>`, and the console compares it to `METISTRY_ORIGIN` with a plain `!==` | https |
| a port in the origin | that synthesized origin carries **no port** — it is exactly `https://<host>` — and the comparison is on the whole string, so `https://host:8443` can never match | serving on 443, or an `expectedOrigin` array server-side |
| no associated domain | macOS gates the RP ID on `webcredentials:<domain>`, which Apple verifies by fetching `https://<domain>/.well-known/apple-app-site-association` **through its own CDN** — unreachable for a loopback, a `.local` or a tailnet name | a publicly resolvable HTTPS domain |

`localhost` is a valid relying party in a *browser*, which is exactly why the
console's own enrolment page works and is the fallback. A browser's loopback
secure-context exemption is not an associated-domain exemption.

**The native path is written, not stubbed.** `sources/kit/console-client.swift`
speaks the real `POST /auth/enroll/start` and `POST /auth/enroll/finish` — the
same request and response shapes `apps/console/web/app.js` posts, field for
field, base64url and all — and `sources/app/passkey-registrar.swift` is the real
`ASAuthorization` call. `PasskeyRouting.decide` returns `.native` the moment an
install's origin and this app's entitlements allow it, and that code runs. Today
none do, and the screen says which reason applies.

The step also carries an **"Ask macOS"** button that runs the registration
request with a locally generated challenge and posts nothing anywhere. It exists
so the reason on screen is *evidence* rather than an assertion: press it and the
system says, in its own words, what it thinks of this relying party. It cannot
enrol anything — there is no console challenge in it.

**One thing to raise server-side.** `apps/console/src/webauthn.ts` compares
`clientDataJSON.origin !== cfg.origin` and lets `verifyRegistrationResponse`
throw, which the top-level handler turns into **HTTP 500**, not 401. So an origin
mismatch from any native client looks like an internal error with no useful body.
`@simplewebauthn/server` v13 accepts an array for `expectedOrigin`; accepting one
would make a native ceremony possible against a ported origin and would turn that
500 into a real answer. Not done here — it is a console change, and this PR is
the app.

## Start at login

**`SMAppService.mainApp`, and only that.** One call, one approval in System
Settings › General › Login Items, nothing written, no CLI change — the old
"not yet" entry had conflated it with something else entirely.

The status mapping lives in `sources/kit/login-item.swift` so it is testable
without a signed bundle to register (`SMAppService.Status` is `Int`-backed;
0 notRegistered, 1 enabled, 2 requiresApproval, 3 notFound, and anything else is
reported as `unknown(n)` rather than rounded to "off"). Two behaviours are worth
naming:

- **`requiresApproval` reads as ON.** It is registered — macOS is holding it,
  waiting for the person — so the toggle stays on and the row explains what is
  outstanding, with a button that opens the right pane. A toggle that flicked
  back off there would look broken when nothing is wrong.
- **The status is always re-read from macOS after a write**, never assumed from
  `register()` returning. `register()` succeeding *and* the status being
  `requiresApproval` is the normal first-time path.

`swift build` alone produces an executable, not a bundle, so `SMAppService.mainApp`
has nothing to register and answers `notFound`. The pane says exactly that and
points at `ops/release/build-app.sh`.

### The install's agent, nested under the app (2026-09-17)

The objection to `SMAppService.agent(plistName:)` used to be that it would mean
registering a *job set* — several plists, signed and unwritable, in place of
the ones `metistry up` renders. There is one job now (`docs/ops/deployment-shapes.md`,
"One background item, called Metistry"): the supervisor. That made the move
small enough to be worth it, and it is what turns two rows in System Settings —
the app, and a background item beside it — into one row with the agent nested
underneath.

**It is done.** The bundle carries the agent, the app registers it, and Settings
has a toggle for it beside the app's own.

| | |
|---|---|
| `apps/macos/resources/launchd/com.foldedspacelabs.metistry.plist` | the agent as the app registers it; `build-app.sh` copies it to `Contents/Library/LaunchAgents/`, the one path `SMAppService.agent(plistName:)` resolves |
| `apps/macos/resources/launchd/metistry-supervisor` | its `BundleProgram`, copied to `Contents/Resources/MetistrySupervisor` (not `MacOS/`, where codesign would demand a nested signature a script cannot carry). A plist inside a signed bundle is immutable and identical on every Mac, and `BundleProgram` is its only bundle-relative key — so this small script is what turns "the app's agent" into "this Mac's install" |
| `~/Library/Application Support/Metistry/supervisor.env` | the three paths it reads: this install's node (as `Metistry`), the supervisor's entry point, and `<instance>/.metistry/state/supervisor.json`. Written by `metistry up --register-via app`, shell-quoted (the app's own default location has a space in it) |
| `apps/macos/sources/kit/background-agent.swift` | `BackgroundAgentService` (the seam) and `BackgroundAgentModel` (the states, the prose). Named for what macOS calls it — a *background item* — rather than for the API |
| `apps/macos/sources/app/login-item-service.swift` | both implementations: `SMAppServiceLoginItem` (`.mainApp`) and `SMAppServiceBackgroundAgent` (`.agent(plistName:)`) |
| `metistry up --register-via app` | does everything a normal `up` does **except** install the supervisor's agent into `~/Library/LaunchAgents` — the app registers its bundled copy instead, so the install never has two |

The launcher deliberately does **not** exec the product inside the bundle: the
bundle is a seed, and the install that runs is the writable one under
`~/Library/Application Support/Metistry/product` that `metistry update` moves
forward. Pointing at the bundle would pin the running services to whatever
shipped in the `.app`.

#### The toggle, and what it is not

Two rows in Settings → Services, in this order, because these two are
constantly confused and each one's prose says which it is:

| row | registration | what turning it on does |
|---|---|---|
| **Start Metistry at login** | `SMAppService.mainApp` | opens this window when you log in. Starts no service |
| **Run Metistry in the background** | `SMAppService.agent(plistName: "com.foldedspacelabs.metistry.plist")` | runs the install: Postgres, the console, the reconciler, the assistant and any configured bridge, as children of one launchd agent |

The status machine is the same one the login-item row uses (`LoginItemStatus`,
`Int`-backed, `unknown(n)` for a value Apple adds later), and so are the two
behaviours that make it trustworthy: **`requiresApproval` reads as ON** — macOS
has the registration and is waiting for the person, with a button that opens
General › Login Items — and **the status is always re-read from macOS after a
write**, never assumed from `register()` returning.

`notFound` is its own answer and not a failure: `SMAppService.agent` says that
when the bundle has no `Contents/Library/LaunchAgents/<name>`, which is every
`swift build` executable. The row says so, points at `build-app.sh`, and adds
what a terminal install does instead.

**Wizard step 5 carries the flag.** When the build has an agent to register
(`BackgroundAgentModel.bundlesAgent`), step 5 runs `metistry up --instance <dir>
--register-via app` and registers the agent *after* `up` returns — registering
first would start an agent with no `supervisor.json` and no `supervisor.env` to
find this install by, which exits 78 and looks broken.

#### What Login Items shows

One row, **Metistry**, with the agent nested under it, attributed to Folded
Space Labs — and the same switch in two places, System Settings and this app,
meaning the same thing.

Before this, the item was registered by `launchctl bootstrap`, which makes it
nobody's: it appeared *beside* the app as a separate background item, named
after its program, with no way to turn it off but a terminal. Naming the program
`Metistry` (the symlink `up` writes to `<instance>/.metistry/state/bin/Metistry`) and
signing the bundled node under the Folded Space Labs identity (#133,
`docs/ops/bundled-runtime.md`) fixed the *name* and the *attribution*; neither
could make it the app's, or give the app a switch. That is what this change is
for.

#### Two registrars, and only ever one

A terminal install still bootstraps the same-named agent itself, and must keep
working unchanged. So `metistry up` asks launchd who owns
`com.foldedspacelabs.metistry` before it installs anything, and leaves an
app-registered one alone — see `docs/ops/deployment-shapes.md`, "Two
registrars", for the signal and why it is launchd's answer rather than a marker
file. `metistry doctor` reports the owner on the supervisor's row
(`meta.registrar`, and in the probe text the Services pane renders).

## Step 7: choosing compute, and what the app never stores

The step is a provider template, a model id and — where the provider needs one
— an API key. It runs two verbs in order and implements neither
(`sources/kit/compute-step.swift`):

```
metistry compute providers add --from <openrouter|lmstudio|ollama|llamaserver|applefm> --json
metistry compute assign default <provider>/<model> --json
```

**The key goes to stdin, never to argv.** The app hands every child an **empty
stdin** by default (`sources/app/process-command-runner.swift`) so no verb can
hang a progress view waiting for input. `compute providers add` is the one
exception, and it is the reason the seam exists: its whole design is "read the
value on stdin so it is never in a command line, a shell history or a log".
The pipe is written once and closed at once — the child gets one value and EOF,
never a prompt it can sit at. The `SecureField`'s property is cleared *before*
the process runs, so nothing observable holds it for longer than one statement,
and a test asserts both halves: the key appears in no argument of any call, and
the runner was handed it as `standardInput`.

Everything the app knows afterwards is what `metistry compute show --json`
reports: the provider's `auth.secret` — a **reference**, `{{ secret.openrouter_api_key }}`
since T4-18, the key being one of this instance's secrets — and whether this
instance holds that item. The verb has no code path that can print a value, and
`ComputeProviderFacts` has no field that could hold one.

**Skipping is a supported install, and says so.** With no `assignments.default`
there is no engine: `metistry up` does not start the assistant, `metistry
doctor` reports `assistant: absent`, and captures, tasks, search and the console
keep working while queued turns wait (docs/ops/assistant-tools.md, "Running
without an engine"). The step offers that as a button with the consequence
written down, not as a dead end — and Settings → Compute adds one later.

## The Compute pane

Settings ▸ Compute (T6-12; screen-15 §5.3, C130–C133) is one column, in the
spec's order: **\<the assistant\> Uses** — one model and its effort, no
fallback · **Providers** — one line each · **Your Models** — memory, disk, the
search with Refresh, the catalogue · **Spending Limits** · **Advanced ▸ Tiers**
(Q1). The model is `sources/kit/compute-model.swift`, the view
`compute-view.swift`. The heading templates the name from `identity.yaml`;
nothing in either file names the assistant.

**Reads are the client API, and only what it serves.** `GET /api/compute`
(the providers with their switch, their one tag and whether the key each names
is present; the assignments; T4-19's `limits`) and `GET /api/compute/catalogue`
(every switched-on provider's catalogue, grouped by model — T4-18). The pane
re-reads on open and on an instance switch; there is no file watcher and no
cache.

**Writes go through two doors, and §2.3 decides which.**

| Change | Door | How |
| --- | --- | --- |
| the assistant's model and effort; a tier's; adding and removing a tier | `POST /api/compute/assign`, `/unassign` | at once — reversible, and a phone may do it too (§2.3) |
| a spending limit: the instance's, a provider's by the token | `POST /api/compute/budget` | Save on the row; an empty field is left as it stands |
| a project's daily budget | `PUT /api/projects/:slug` | the same door the Projects pane uses |
| Test | `POST /api/compute/providers/test` | at once; a 401/403 is *Key rejected* · Replace Key, anything else *Not answering* · Retry |
| a provider's switch, its gear (base URL, which secret is its key, billing), Remove | `metistry compute providers set\|remove … --json` (M16) | **confirmed with the exact command** before it runs |
| Install a Model…, Load, Unload | `metistry compute models install\|load\|unload … --json` (M17) | confirmed; disk and memory are said before Install; the CLI's own progress lines stream under *Downloading…* / *Loading into memory…* |
| Add Provider… | `compute providers add` (key on stdin) — the wizard's step-7 model | the sheet shows both commands before its button runs them |

A `ManagementCommand` cannot hold `compute assign` or `compute budget`, which
is the point: inside the boundary is the API, the boundary itself is §2.2.

**A model is written one way everywhere.** `ComputeModelLine` — **name**
maker · provider · tag, price on the right — is built in exactly two ways
(a catalogue place, or a bare reference the catalogue does not hold) and
drawn by one view (`ModelLineText`); the dropdowns' menus use the same words.
`compute-pane-tests.swift`'s first test holds the dropdown, Your Models, a
search result and a tier to the same line. Tags are *Local*, *Cloud*,
*Subscription* — there is no *By token* tag.

**A subscription's window is its limit.** The pane renders `limits` and
decides none of it: a provider the server sends as `kind: window` shows its
calls today and this month and no dollar field. Local providers with no limit
set are left out of the list; they cost nothing.

**The state row (components-03 §2).** Empty: *No models match "zebra"*, and a
provider that did not answer is named with Retry. Waiting: *Loading into
memory…* and a download's own lines. Stale: *lmstudio's list is from
yesterday*, from the catalogue's `read_at`. Failed: *Not answering* · Retry,
*Key rejected* · Replace Key (which opens Settings ▸ Secrets — a key is one of
this instance's secrets, never a field here), *Not running* from doctor's
`local:` row, and disk and memory said before Install.

**Drawn and not served (C138: said where it would be, never invented).** A
model's size and *Fits this Mac*; a download's Cancel (the runner has no
cancel); a provider's headers and data policy (`providers set` has no flag for
either); removing a model (`compute models` has no remove verb); *Add* on a
cloud place (nothing records "your" cloud models). Each is dimmed with its
reason or said once in the section.

**The provider switch is a checkbox.** SwiftUI on the Mac gives a `.switch`
toggle's AppKit control no accessibility name — its label, `.accessibilityLabel`
and a string title all leave it empty (measured) — and §2.18.7 fails an
unlabeled control, so it is the platform checkbox, named for the provider.

**Memory is an estimate and says so every time.** `ProcessInfo.physicalMemory`
less a reserve (a quarter, never under 4 GB) is labelled an estimate; the disk
bar is the home volume's own figures (`volumeAvailableCapacityForImportantUsage`),
where LM Studio, Ollama and the bundled server keep their models.

**`assistant: absent` is said where it can be acted on.** Doctor decides it.
With no providers the banner's one button opens Add Provider…; with a provider
the fix is the model dropdown already on the pane, so the banner has none.

## The Connections pane

Settings ▸ Connections (T6-13a, screen-09-resources.md §10.1–§10.4, plan
§2.6). The model is `sources/kit/connections-model.swift`, the view
`connections-view.swift`; it replaced the interim pane that listed doctor's
bridge rows (those stay in `metistry doctor` and Services' problems).

**Three served routes, and nothing else.** The list is `GET /api/connections`,
one connection `GET /api/connections/:name` (its file and its provider's unit
join the row), and *Sent only to*, the grants and presence come from `GET
/api/secrets`. Every one carries names — header, query-parameter,
environment and secret names — and never a value, so the pane has no field a
value could live in. Nothing is dialled to draw it; a connection's
`connection.health` event and a write to `.metistry/connections/`,
`secrets.yaml` or `scheduled.yaml` (`config.changed`) re-read it while it has
been opened. What the routes do not serve is not drawn: the last check, and
the agents a connection is lent to (`used_by` serves syncs; *Nobody yet* is
then the true answer).

**The list** (§10.1): status · the name with its type's glyph · Type (*MCP ·
By command*, or the provider for a known service) · Used By, with *Key
expired* first in the failed ink when a key it names has passed its `expires`
· a shield when it is offered to agents · a chevron. A row is one button that
speaks all of it and opens the connection; *All Connections* goes back. The
empty, failed (*Try Again*, the console's reason verbatim) and not-configured
(503: no instance directory) states are the shared `StatePanel`.

**One connection** (§10.3): how Metistry reaches it (URL, authentication,
header and parameter names, timeout — or command, folder, environment names,
runs on — or path), each secret as `{{ secret.name }}` with where it may be
sent, each variable as `{{ variable.name }}`; *What it sends*; the offer
switch; the tools under *Reads · Changes things · Starts an agent* (the CLI's
`TOOL_GROUP_LABEL`, compared by a test), each with three buttons *Allow · Ask
First · Never* that say the tool they set; Used By; and Test, with **Replace
Key** when a key it names has expired or has no Keychain item (components-03
§2) — which opens Secrets, because a value is typed there and nowhere else.

**What it sends blocks, and never over-promises.** For an HTTP connection the
destination is worked out exactly as core's `egressDestination` does — the
host lowercased, and `host:port` unless the port is 443 (so plain http is
`:80`) — and each secret is judged in the door's order: not on its *Sent only
to* list (**blocked**, with *Allow <host>…*), plain http off this Mac
(blocked), not granted to `connection:<name>` (blocked, with *Grant…*), no
Keychain item (blocked); otherwise *Sent to <host>*, or *after you approve
each call* for Ask First. A command's environment is *given to this command
only*, and needs Allow (it is filled once, at start). A secret list that did
not read, or a host that is a `{{ variable }}`, shows nothing as sent. One
blocked secret blocks the preview. The preview is a drawing of the door's
rule, not the rule: the door refuses on its own (`EgressRefused`), whatever
this pane shows.

**Every change is a §2.2 verb, confirmed.** A tool's mode is `metistry
connections policy <name> <tool> allow|ask|never`, the offer switch `policy
<name> --offer on|off`, Test `connections test <name>` (it dials, so its
confirmation says what it starts), *Allow <host>* `secrets hosts <name>
<every host on the list> <host>` (the verb replaces the list) and *Grant*
`secrets grant <name> connection:<c> on` — each a `ManagementCommand` shown in
`SettingsConfirmation` with its exact command, its answer the CLI's own last
line in the pane's banner, and the pane re-read after it. No console route
writes a connection (invariant 10). Adding and configuring one is T6-13b's
editor; until then the empty state names `metistry connections add`.

## The Secrets and Variables panes

Screen 19 and plan §2.14, built as T6-14 (`sources/kit/secrets-model.swift`,
`secrets-view.swift`, `variables-model.swift`, `variables-view.swift`).

**Read from the console, written through the CLI.** The lists are
`GET /api/secrets` and `GET /api/variables` — routes that already existed, so
the panes add no door (invariant 10). Every write is a §2.2 verb run as an
argument array through the session's `ManagementRunner`: `metistry secrets
set|replace|remove|hosts|grant` (M7) and `metistry variables set|unset` (M14),
each with `--instance <dir>` so the command says which instance it changes.

**A secret's value exists in the app for one keystroke's worth of time.** The
rows the pane draws (`NamedSecret`) mirror the route's row — name, hosts,
grants, expiry, presence, last used — and have no field a value could go in;
the Value section is dots. The only place a value is typed is the New Secret /
Replace sheet's `SecureField`, bound to `SecretDraft.value`. `saveSecret()`
copies it into the command's standard input and clears the draft **before**
the process starts; the command is a local that goes out of scope when the CLI
returns. It is never an argument (the CLI takes it from stdin only), never in
an outcome, a log line or a confirmation, and `SecretDraft` and
`ManagementCommand` print, dump and interpolate as `<redacted>`. A refused
save reopens the sheet with the name, hosts and expiry kept and the value
field **empty** — the owner pastes it again rather than the app holding it
across a failure. `secrets-variables-tests.swift` asserts all of it, and walks
the pane's accessibility tree, every secret opened up, for the value.

**Confirmed, naming the cost.** New Secret and Replace are confirmed by their
sheet, which shows the exact command before its button runs it (an alert over
a closing sheet is not reliably presented on the Mac). Save Hosts…, a grant and
Delete… use the window's confirmation. **Delete… runs `secrets remove <name>
--json` first** — without `--yes` it deletes nothing and names every file
under `.metistry/` that references `{{ secret.<name> }}` — and the
confirmation says what stops: each file as what it is (*the github connection
(.metistry/connections/github.yaml)*, *agent triage (…)*), then anyone still
granted it that no file named (*agent devin, granted Ask*).

**A refused grant reads on its own row.** The pane checks no name, host or
grantee — the CLI does. When it refuses a grant (X-41 will refuse a
`connection:` or `agent:` grantee for a secret an owner door holds), its words,
without the `metistry secrets grant:` prefix, sit under that grantee's On ·
Ask · Off, which stays where the file has it; the next accepted change there
clears them. Grantees are this instance's connections and agents (the
assistant's own row and revoked ones left out) plus anyone the file grants —
`provider:<name>` included, shown as spelled.

**A key-shaped variable is refused with Store as Secret — and nothing else.**
Screen 19 §2 drew *Save as Variable* beside it; the plan and T4-4's CLI refuse
the value outright, and the plan wins, so no override is drawn. The app checks
**first**, with `KeyShape` — core's `looksLikeKey`, pattern for pattern, held
to core's own examples by a test — because a value that reaches `variables
set` is in that process's argv. While the value looks like a key the sheet
draws no command at all; Save shows *This looks like a key. Variables can be
read by agents.* with **Store as Secret**, which moves the name and value into
New Secret and runs nothing until that sheet's own button. A key the copy
misses is still the CLI's to refuse, and the sheet reads the same. The CLI's
other refusals (a schedule or a time — ruling 2; a secret's name; a value
equal to one of this instance's secrets) reopen the sheet in its words.

**Not here yet:** *Preview as the agent sees it* (screen 19 §2) belongs with
an agent's instructions; the Value section's *when set* has no field on the
route to read it from; the *Devin's key expired* request (§1.2) is a Needs You
body. *Metistry's own* is names only: rotating one is `metistry secrets` in
Terminal, because §2.2's M7 lists `set`, `replace`, `remove`, `hosts` and
`grant`, not `mint` or `sync`.

## Settings: persisted vs read-through

**The rule (owner direction 2026-09-09):** every setting is a front for a file
the CLI owns. The app persists three POINTERS and no configuration.

| The app persists | Key | Why it is a pointer, not a setting |
| --- | --- | --- |
| Active instance | `activeInstance` | Which install the app is looking at. Reaches every verb as `METISTRY_INSTANCE_DIR`. |
| Recents | `recentInstances` | The eight it looked at before, most recent first. |
| Developer runtime override | `developerProductDirectory` | A product checkout, for a build with no runtime bundled inside it. Settings → Advanced only. |

Sparkle's own preferences (`SUEnableAutomaticChecks`, `SULastCheckTime`) and
AppKit's window frames live in the same domain and are *theirs*: the app keeps no
copy. `apps/macos/tests/kit/settings-model-tests.swift` drives the models through
a fresh defaults suite and asserts exactly those three keys reach disk, so a
fourth one fails CI rather than appearing quietly.

One FILE, not a fourth key (ruling 19, X-19): the offline capture queue
(`AppFileStore.captureQueueFilename`, "The capture composer" above) is unsent
work, not a setting, so it is a `UserDefaults` domain the settings test above
does not — and should not — see.

**The window (T6-11, screen-15).** Settings is its own window, never a pane
in the main one: a sidebar in four groups — *Instance · Services · Compute ·
Updates*, **Access** (*Account · Connections · Secrets · Variables*),
**Capture** (*Live Capture · Sessions*), *Keyboard · Advanced* — at a fixed
**840 × 600** (a 200 pt sidebar, a 640 pt pane; the owner ruled it is not
resizable, and the scene takes the view's size). Every pane is a vertical
scroll view, so the largest macOS text makes a pane **longer, never wider**;
a row of controls that cannot fit side by side stacks (`SettingsControls`).
`metistryText` scales on the Mac for it (`metistryFont`: the semantic font at
`.large`, the Mac's point sizes by Dynamic Type's ratios otherwise).
*Connections* was renamed **Account** (console sign-in and the instance
repository); *Connections* is now the external servers' pane. The model is
`sources/kit/settings-model.swift`, the window `settings-view.swift`, each pane
a file under `settings-panes/`.

**Every write is a §2.2 verb, confirmed.** A change to a protected file
(`identity.yaml`, `deployment.yaml`, `instances.yaml`), to the running services
or to the runtime is a `ManagementCommand` — a type that cannot hold a verb
§2.2 does not list — shown in a confirmation with what it costs and the exact
command (`SettingsConfirmation`), and run through the session's
`ManagementRunner`. Its answer is the CLI's own last line, with everything it
printed under View Log. Restarting or starting one service acts at once;
stopping anything, Restart All, Update and Roll Back ask first. No console
route was added for any of it (invariant 10).

**The lid dialog runs nothing (plan §2.15, ruling 3).** *Allow sleep when the
lid is closed* switched off opens a sheet: *Keeping a closed Mac awake needs
an administrator setting Metistry will not change for you*, the command
(`sudo pmset -a disablesleep 1`) with **Copy**, how to undo it
(`sudo pmset -a disablesleep 0`) and the warning. Presenting it, Copy and
Cancel reach no runner; **Turn Off** closes it and stores the switch —
`set-keep-awake --sleep-lid-closed false --yes`, M4 — and doctor's read of
`pmset -g` decides whether the pane says it is in effect. The words are
core's (`LID_CLOSED_*` in `packages/core/src/power.ts`), mirrored in
`keep-awake.swift`; `settings-window-tests.swift` reads power.ts and compares.

| Pane | Value | Read through |
| --- | --- | --- |
| Instance | the assistant: name, mention, mark, instance ID | `metistry identity --json` |
| Instance | Edit… (name, mention, mark) | `metistry identity set --name --mention --mark` (M10, T2-16), only the fields that changed, **confirmed with the exact command** — a protected write through the reconciler, shown in Activity as a `config_write` run |
| Instance | this instance: path, Choose…, Open in Finder, Set Up Again… | the persisted pointers above; Set Up Again re-enters the wizard |
| Instance | namespace and ports | `doctor --json` → the `deployment` row's `meta.namespace` (`state/ports.yaml`); none said is the default labels and ports, which the app does not copy |
| Instance | Recent (up to eight, Forget) | the persisted pointers above |
| Instance | History: the sync policy in force, branch, ahead and behind, the last commit, the last push and pull, any conflict | `GET /api/vault/status` (T10-2), **read only** — the policy is `deployment.yaml`'s `vault:` block, changed with `metistry vault settings` (M18); the pane names the verb and offers no field |
| Instance | History: Roll Back… (the last commit, one commit, or a day) | `POST /api/vault/rollback` (T10-6) — raises a Needs You request with the preview and changes nothing; the sheet names what Approve would undo. Reach `local`: drawn and sent only while `GET /api/whoami`'s `via` is `local_owner_token` (ruling 7) |
| Instance | linked instances: name, origin, capabilities, last seen — *Not seen for 3 days* past a day | `GET /api/instances` |
| Instance | Link an Instance…, Refresh / Check Now, Remove | `metistry instances add <origin>` / `refresh` / `remove <id>` (M11) — add and remove confirmed; `instances.yaml` is a protected path |
| Services | Doctor: Run Doctor, each problem with its fix, checks passed | `doctor --json` — a failed or degraded row, or a not-configured one that carries an `action` (T4-21). The fix is the row's `action`: open Secrets, open System Settings, open a `logs` verb in the Log window, or run a §2.2 verb **after a confirmation naming it**; any other argv is shown with Copy |
| Services | the supervisor (launchd or Docker Compose), Restart All, Stop All | `doctor --json` → the `supervisor` / `compose` row; `metistry restart\|stop --json` (M5), both confirmed |
| Services | one line per service: state, uptime or reason, port; Restart · Stop · Log | the `deployment` row's plan, matched to the `child:`, `compose:`, `launchd:…` and manifest rows by name — the worst state, `meta.uptime_sec`, the remediation verbatim; `metistry restart\|start <svc> --json` at once, `stop <svc>` confirmed, `logs <svc>` in the Log window |
| Services | Start at Login | `SMAppService.mainApp` — macOS keeps the registration; the app writes nothing (above) |
| Services | Run in the Background | `SMAppService.agent(plistName:)` on the plist sealed in this bundle — the install's ONE background item; macOS keeps this registration too (above) |
| Services | Keep this Mac Awake; Allow sleep on battery; Allow sleep when the lid is closed | `metistry deployment --json` → `keep_awake_setting` (the object form, T4-20); whether it holds and whether the lid half is in effect from doctor's `keep-awake` row (`lid_closed`) |
| Services | changing a switch | `metistry deployment set-keep-awake --enabled\|--sleep-on-battery\|--sleep-lid-closed true\|false --yes` (M4), confirmed with what the value it becomes costs. Turning the lid switch off opens **the lid dialog, which runs nothing** (below) |
| Compute | the assistant's model and effort, the tiers, the providers (switch, tag, key present), spending limits (instance, provider, project) | `GET /api/compute` — `limits` from T4-19 |
| Compute | Your Models, the search grouped by model, Refresh | `GET /api/compute/catalogue[?q=…][&refresh=true]` (T4-18) |
| Compute | the model and effort, a tier, a spending limit, Test | `POST /api/compute/assign\|unassign\|budget\|providers/test`, at once (§2.3); a project's budget `PUT /api/projects/:slug` |
| Compute | a provider's switch, gear, Remove | `metistry compute providers set\|remove <name> … --json` (M16), **confirmed with the exact command** |
| Compute | Add Provider… (template, name, base URL, key) | `metistry compute providers add --from <t> [--name] [--base-url] --json`, **key on stdin** |
| Compute | Install a Model…, Load, Unload (LM Studio only) | `metistry compute models install\|load\|unload <provider/model> --json` (M17), confirmed; disk and memory said first |
| Compute | the local model servers and whether each is running | `doctor --json` → the `local:lmstudio\|ollama\|llamaserver\|applefm` rows |
| Compute | memory and disk | `ProcessInfo.physicalMemory` less a documented reserve, **labelled an estimate**; the home volume's own capacity figures |
| Account | console sign-in: who this Mac is, with `via`, the remedy, and the argument array | `metistry console whoami --json` — the app never resolves, holds or displays the token ("Signing in" above) |
| Account | instance repo status, HEAD, queue depth | `doctor --json` → the `reconciler` row's `meta`. The reconciler is the sole committer, so the app runs no git of its own |
| Connections | the list: status, name and type, Used By (*Nobody yet*), *Key expired*, the offer shield | `GET /api/connections` and `GET /api/secrets` — names, never a value ("The Connections pane" above) |
| Connections | one connection: how it is reached, its secrets with *Sent only to*, *What it sends*, the tools by group, Used By | `GET /api/connections/:name` and `GET /api/secrets`; *What it sends* is worked out from them as core's egress door would, and nothing is dialled |
| Connections | a tool's mode, the offer switch, Test | `metistry connections policy <name> <tool> allow\|ask\|never`, `policy <name> --offer on\|off`, `connections test <name>` (M13), each **confirmed with the exact command** |
| Connections | *Allow <host>*, *Grant* on a secret's row; Replace Key | `metistry secrets hosts <name> <hosts…>` / `secrets grant <name> connection:<c> on` (M7), confirmed; Replace Key opens Secrets |
| Secrets | name · Used by · Sent only to · last used or *Expired*; per secret its Value (dots), Sent Only To and Who May Use It | `GET /api/secrets` — never a value; the grantees offered are `GET /api/connections` and `GET /api/agents` plus whoever the file already grants ("The Secrets and Variables panes" below) |
| Secrets | New Secret…, Replace…, Save Hosts…, a grant's On · Ask · Off, Delete… | `metistry secrets set\|replace <name>` with the value **on stdin**, `secrets hosts\|grant\|remove` (M7) — each shown with its exact command first |
| Secrets | *Metistry's own* (collapsed): names, scope, and the account each was found under | `metistry secrets list --json` — names only; rotating one is a Terminal step, not an M7 verb |
| Variables | name · value · used in; New Variable…, Edit…, Remove… | `GET /api/variables`; `metistry variables set\|unset` (M14), shown with its exact command first |
| Live Capture, Sessions | what the pane will hold, and the verb that does it today | not built yet (T6-15): a sentence, never a dead end (C138) |
| Updates | this app: version, channel, automatic checks, Check Now | Sparkle, which owns those preferences itself |
| Updates | the runtime: running version, channel, instance pin | `metistry version --json` → `product_version`, `lock.channel`, `lock.version` |
| Updates | a newer runtime | `release.available` on `GET /api/events` (T2-18), heard while the app is open — nothing serves it otherwise, so the row says *none announced since the app opened* |
| Updates | Update Runtime…, Roll Back… | `metistry update` / `metistry update --rollback` (M2), confirmed; Roll Back only on the release channel, which keeps the previous release. A failure is the CLI's own last line, with View Log |
| Keyboard | Shortcuts in any app, and the five | components-02 §2's suggestions, **off and dimmed** until T6-16 registers them — nothing is registered; Show All opens Help ▸ Keyboard Shortcuts (⌘/) |
| Advanced | runtime from (Releases · Git checkout), located, command, product folder | the pin's channel, and the runtime locator (below) |
| Advanced | product and runtime-pack versions, instance pin | `metistry version --json` |
| Advanced | developer override | the persisted pointer |
| Advanced | Passkeys: the diagnostic ("Ask macOS") | `ASAuthorization` against the console's relying party with a LOCAL challenge — nothing is sent and nothing can be enrolled |
| Advanced | log folder | the launchd plists' `StandardOutPath` convention (`/tmp/metistry-<name>.log`), labelled as a convention. Each service's **Log** runs `metistry logs <name>` instead, because a container's or a systemd unit's log is not a file here |

**There are no file reads left.** The scaffold read `.metistry/identity.yaml` and
`metistry.lock` with a ~60-line YAML scalar reader, read the checkout's
`package.json` for a version, and parsed `metistry secrets list`'s table — all
four because the CLI reported none of it. This doc named the first as the thing
`metistry identity --json` would delete. It did, along with the rest:
`identity --json`, `version --json` and `secrets list --json` replaced every one,
and `sources/kit/instance-files.swift` is now a single file-existence test (is
there a `.metistry/identity.yaml` here?), which is not a parse.

The table parser was worth deleting on its own: `secrets list` grew a `scope`
column when instance directories became self-contained, and the app's
three-column regex had matched nothing since. A parser of somebody else's table
is a bug with a delay on it.

**What a CLI older than this app looks like.** `packages/cli/src/main.ts`'s
default branch answers `unknown command: <verb>` with exit 2, and every read
turns that into one sentence — *"this CLI has no `identity` verb yet — update it
(metistry update, or Check for Updates…)"* — rather than a blank pane or a wrong
"not set". One place decides it (`CLIDegradation` in `sources/kit/cli-facts.swift`),
so the menu bar's lifecycle verbs, the log window and the four read verbs all say
it identically.

**On key spellings.** The CLI's JSON is not internally consistent — `doctor
--json` is snake_case (`as_of`, `latency_ms`), `restart --json` is single words,
and `SecretListing` in `packages/cli/src/secrets.ts` is camelCase (`inKeychain`,
`foundUnder`). The readers accept both spellings of a two-word key rather than
guessing one and blanking a pane over a convention. That is a reader-side
tolerance, not a wire contract: the shape is the CLI's.

## The shell

`sources/kit/root-view.swift` is the window; `shell-model.swift` is its state;
`shell-commands.swift` is every menu; `keyboard-shortcuts-view.swift` is Help ▸
Keyboard Shortcuts. The design is `docs/product/design/` (DEVELOPER-HANDOFF
§2.1, screen-03 §13.3, components-02) and the acceptance is design-build-plan
§2.18.

**The sidebar.** Needs You (only while something waits), then Today · Chat ·
Activity · Work ▸ (Board · Projects · Artifacts — no Rooms, C89) · Knowledge ·
Agents · Scheduled, then Pinned (`pinned-items.swift`, filed under the identity's
instance id). No row but Needs You carries a count (C15). Work's disclosure is
held in memory only: the app persists pointers and nothing else.

**The Needs You row (C110).** It appears with the first waiting request and
carries the product's one badge — nothing at zero, the number to 99, then
`99+`; VoiceOver says *Needs You, 10 waiting*. It leaves **on the next
navigation after the count reaches zero**, never before: answering the last
request leaves the owner on *Nothing needs you* with the row still there, and a
count that drops while they are elsewhere does not shift the sidebar under the
pointer. A count that cannot be read is not zero — the row, the badge and the
Dock keep the console's last answer. The Dock tile carries the same label
(`NSApp.dockTile.badgeLabel`, set from the app target). A change is announced
to VoiceOver once, and not while the owner is on Needs You. Under Reduce Motion
the row appears without sliding.

**The Needs You view (T5-4a, `needs-you-view.swift`).** The row opens a list
and a detail (screen 3 §13): one line per request — the type's word *as the
console gives it* (X-5's `request`; the stored kind is never shown), what it
asks, who asked (the configured name for the assistant, an agent's id, or the
source a mirror lives in, with `external` / `you` as a neutral chip) and its
age — grouped *Today* and *Earlier*, newest first, and filtered by type and by
**From** (Everyone · the assistant · Agents · each source present). One
selected request is drawn beside the list; several selected is the **bulk
list**: **Later · Skip · Decline** and never Approve — `BulkVerb` is the closed
list the selection is answered through, and it has no case that sends `allow`,
`accept_with_changes` or `accept_as_work`. Skip lives only there (K2); Decline
is `deny` with one reason given once (R15); *Select All on This Page* is capped
at the batch's 100. The batch's result is a band above the list, not a toast —
*2 of 3 declined*, what happened to the rest, the row still pending kept
selected and **Retry** re-sending exactly it; a Later that went through leaves
no receipt. While the console is unreachable every one of those verbs, Retry
and the Item menu's L and D are off with the gate's sentence under them, and
`NeedsYouModel` refuses before the store is asked (O3). The source filter reads
`source` off each row, which `GET /api/proposals` does not serve yet — until it
does, From offers Everyone · the assistant · Agents.

**Where it reads from.** `ShellModel` holds no client: it reads
`NeedsYouStore.waitingCount()` (`GET /api/needs-you/count`),
`SettingsStore.identity()` (the configured name, and the instance id pins are
filed under) and `UsageStore.compute()` (the gauge), over `AppModel.console`'s
stores — the same session child and O3 gate every screen uses; an instance
switch adopts the new session's. It polls on `RefreshPolicy`'s intervals for
the app's lifetime rather than a window's, because the Dock is read with every
window closed, so the first poll is what starts the session child. Once
`AppModel.startShell` has called `follow(console.events)` and started the
stream, `needs_you.changed` carries the count itself (the same filter as
`GET /api/needs-you/count`) and is applied as it stands; while the stream is
live the count is asked only on the five-minute `whileLive` clock, and while
it is down the 30 s poll resumes. `budget.state` and `release.available` (and a
`config.changed` naming `compute.yaml` or `identity.yaml`) make the gauge or
the name due at the next tick. The badge announces a change once — never the
first reading, never a repeat of the same count, whether the event or the poll
said it.

**The toolbar.** The mark and the title *Metistry* (the same on every screen —
the highlighted row says where you are); **+** (New Capture, ⌘N — the composer, below, registers in
`ShellModel.captureActions`); the **Usage gauge**,
`gauge.medium` in secondary ink, `gauge.high` in primary ink over 90% of a
spending limit, the warning tint at it, speaking *Usage, $1.84 today, 37% of
the daily spending limit* (components-02 §3's row in C130's words: budgets are
spending limits). Its popover is Usage (screen 17, below). There is no bell
(C110).

**Usage — the gauge's popover (screen 17, T5-6; `usage-view.swift`).** 400
points on `elevated`: *This month* — the amount, *of $60 this month*, a meter,
*$1.84 today · 8 days left*, and at a limit what the engine is doing about it
(*Compute stopped at the $60 monthly spending limit* for Stop, C133) with
**Raise**; *Each day* — one bar per day from the 1st to today in `chart-3`
(light) / `chart-2` (dark), the peak on the heading, hover for a day's amount,
one spoken sentence and an `AXChartDescriptor` table for the rotor; *Where it
went* — actors ranked by this month's spend (the chat turns read *Chat*, a crew
its name), five then *N more*; one line each for the cache rate, AWS this month
(*not compute*) and the calls with no price (*count as $0*); then **Spending
Limits in Settings**. Raise and that link both open Settings on Compute (C138).
**No projection**: nothing says or draws where the month is heading. It reads
`UsageStore.compute()` — the gauge's own read, so the two cannot disagree —
and three named queries through `GET /api/q/:name`: `spend` (the days and the
cache rate), `spend_by_actor` (*Where it went*, unpriced calls) and
`aws_costs_daily`, each over the trailing days back to the 1st. It opens on the
last answer (the toolbar's gauge on first open), asks again every time it
opens, and keeps an answer a later read fails to replace (C135). Nothing spent
says *Nothing Spent This Month*; compute unreadable with nothing known says
*Couldn't Read Spend* with the console's reason and Try Again.

**The capture composer (T5-5, `capture-view.swift`).** The + and ⌘N open a
popover under the +: one field (placeholder `note…`, growing from three
lines), **Capture** (⌘↩) and a receipt line — no title, nothing that suggests
(screen 4). It does not wait for the 201: ⌘↩ moves the words into a pending
capture and the line reads *capturing… you can close this*; closing cancels
nothing. **Esc closes and keeps the draft** — the draft is
`CaptureComposerModel.draft`, held by `AppModel`, not by the popover. **The
`Idempotency-Key` is minted once**, when Capture is pressed, and every resend
of that capture carries it; `POST /capture` answers a key it has seen with the
original response, so **a replay renders as the same capture** — *captured →
inbox #418 · Inbox/….md*, the id and path that came back. A capture that got
no answer (no session child, no connection) is **queued** with its key — the
`degraded` chip *queued — will send when the instance is reachable* — and
resent every 10 s backing off to a minute, when the popover opens, and as soon
as any read hears the console again; a capture is an append, so O3's gate
lets it through while decisions are held. A console that **answered** with a
refusal (a 4xx, a 5xx, a 401) is a failure instead: its words on the line, the
text back in the field, and **Retry** with the same key — so is Capture on the
unchanged words; edited words are a new capture with a new key. A failure
always wins the line; otherwise it shows the oldest unresolved capture with a
count (*capturing… (2)*). **The queue survives a relaunch (X-19, ruling 19,
2026-09-27).** A capture still queued when the app quits is written to
`stores/capture-store.swift`'s `JSONCaptureQueueStore` — one JSON file under
this app's own Application Support directory, never the instance's — the
moment it goes offline, and read back at launch (`AppModel` wires
`CaptureComposerModel.currentInstanceID` to `InstanceBookmarks.active?.path`
and calls `loadPersistedQueue()` once, the same pattern `startShell` uses).
It resends through the same gate and the same key as any other queued
capture, so a replay dedupes on the console exactly as it would have before
the relaunch. Nothing but a queued capture is ever written there: a sent one
is gone the instant it lands, and a failed one lives in the field, not on
disk. An instance switch never sends a queued or failed capture to the other
instance — its words come back into the field with a line saying why, and the
switched-from instance's disk entry clears the same moment; a store beyond
`app-preferences.swift`'s allowlist for exactly this is `AppFileStore`'s
documented exception, and every OTHER instance's entries in the file are left
untouched.

**The menus (C119).** Every shortcut is a menu item, and every menu item is one
case of `ShellCommand` — the menus, the Keyboard Shortcuts page and the tests
all read that one table. Go: Needs You ⌘0 (while shown), Today ⌘1 … Scheduled
⌘7, Back ⌘[, Forward ⌘], Command Palette ⌘K, Filter ⌘F. Capture: New Capture
⌘N, Ask *<name>*, Note, To-do, Start/Stop Recording, Hide Capture Bar, Shortcuts
in Any App…. Item: Open ↩, Open in Obsidian ⌘O, Approve A, Revise R, Decline D,
Later L, Complete Space, Move… M, Hand to an Agent… ⇧⌘P, Run Now ⌘R, Pause ⌥⌘P.
View: Today / All ⌥⌘T, Show Sidebar ⌃⌘S. File: New Conversation ⇧⌘N (the
window group's New Window gives up ⌘N). Help: Keyboard Shortcuts ⌘/. ⌘9 is
bound to nothing.

Who answers an item: the shell answers Go and Capture; the focused screen
answers its own four by publishing `shellScreenActions`, and the selection
answers Item through `shellItemActions`. A table can only light a command of
its own kind, so a screen can never add a menu item. An item nobody answers is
dimmed. The single keys (↩ A R D L Space M) are **attached only while a list
publishes `shellListFocus()`** — a bare key in the main menu is taken before a
text field sees it, and even a dimmed item swallows its key, so the key is not
there at all otherwise.

**Words.** Labels template the configured name from `GET /api/identity`; with
no name known yet, *Ask* stands alone. No label anywhere says "assistant" —
`shell-commands-tests.swift` checks every label the shell can produce and every
string literal in its source.

**Accessibility tests.** `shell-accessibility-tests.swift` puts each view in a
real window, asks AppKit for SwiftUI's accessibility tree the way an assistive
app does, and walks it: every control must say something, nothing may say
"assistant", and the Spoken rows are checked word for word. An SF Symbol is
never "unlabeled" to VoiceOver — the system names it for its glyph, so `plus`
says *Add* — which is why the shell's glyph controls are held to their exact
names, not merely to saying something. macOS's text size is the system's: the
shell uses semantic text styles only and fixes no height a label must fit in.

## The menu bar

Grouped by doctor's own `kind`, so a new component kind appears without a change
here (invariant 5). The per-row submenu maps the row to the **component name**
the lifecycle verbs take — `compose:console` → `console`,
`launchd:com.foldedspacelabs.metistry.watchdog` → `watchdog` — and a launchd
label that is not ours keeps its full name rather than being guessed at
(`sources/kit/component-control.swift`, pinned by tests).

Only kinds with a process behind them (`service`, `bridge`, `launchd`,
`container`) offer Restart/Stop/Start; a manifest that validates, a migration
count and the resolved shape are checks, not processes, and the menu does not
invent a control the CLI has no verb for.

**Refresh:** doctor is re-run when the menu opens and every 30s while it stays
open — never continuously. `doctor --json` is a full sweep (every bridge over
HTTP, `docker compose ps`), far too heavy to poll; the watchdog already keeps a
liveness view of the same components, and its feed is the intended faster source
once the app has a read path to it (a management-API query, not a database
connection — invariant 3).

**`restart` / `stop` / `start` / `logs` are new verbs.** A CLI that predates them
answers `unknown command: restart` with exit 2, and the app says "this CLI has no
`restart` verb yet — update it" rather than reporting a failed restart.

## Layout

```
apps/macos/
  Package.swift        SwiftPM manifest — no Xcode project
  Package.resolved     the Sparkle pin; tracked, and CI builds with
                       --disable-automatic-resolution so a stale one fails
  package.json         name and version only, private. It ships no JavaScript:
                       it exists so changesets versions the app with the product
                       and gives it a CHANGELOG line (docs/ops/releases.md)
  sources/kit/         MetistryKit: the models and the views — the shell
                       (root-view, shell-model, shell-commands,
                       keyboard-shortcuts-view), Settings, the wizard, the menu
                       bar, the Status panel, the log window.
                       No AppKit, no Process, no platform frameworks — an iOS
                       target shares it as is.
  sources/kit/stores/  the store interface: one protocol per domain, one
                       method per client-API route (F-7), and what the app
                       holds of it — the session, O3's gate, the section
                       model, the management runner (T5-1, "Data layer")
  sources/kit/components/
                       the shared components every screen draws with (T5-3,
                       "Shared components") — each a presentation value, then
                       a view that only draws it
  sources/kit/request-bodies/
                       one Needs You request as a card, and a meeting's parts
                       as one — its reading, its answers, their refusals
                       (T5-4b, "Needs You: the bodies")
  sources/app/         the Metistry executable: @main and the six scenes
                       (window, Settings, log window, Status, Keyboard
                       Shortcuts, MenuBarExtra), the menus, the Dock badge, Sparkle,
                       the Process-backed CommandRunner, and the platform
                       seams the kit declares and does not have: SMAppService
                       (twice — the app, and the install's background item),
                       ASAuthorization, a terminal opener, and the AppKit calls
                       (reveal in Finder, quit, Sparkle's own UI)
  tests/kit/           swift-testing unit tests over the kit
  tests/kit/fixtures/  one recorded (or contract) JSON per client-API route —
                       excluded from the target, read by #filePath
  tests/kit/snapshots/ one text baseline per shared component — light, dark and
                       the largest text; excluded, read by #filePath
  resources/           Info.plist template + the entitlements file
```

**Every platform framework is behind a protocol the kit declares.**
`CommandRunner` (a subprocess), `LoginItemService` (`SMAppService.mainApp`),
`BackgroundAgentService` (`SMAppService.agent(plistName:)` — a second
registration, so a second seam), `PasskeyRegistrar` (`ASAuthorization`, which
needs an `NSWindow` as its presentation anchor) and `TerminalOpener`
(`NSWorkspace`). That is what keeps
`MetistryKit` free of AppKit and of `Process` — an iOS target supplies its own
four — and it is also what makes the models testable: every one of those seams
has a fake in `tests/kit/`, so the SMAppService status machine, the passkey route
decision and the token watch are exercised without a signed bundle, a Touch ID
prompt or a terminal window.

Paths are lowercase, so every target names its own `path:` rather than taking
SwiftPM's default `Sources/<TargetName>/`. `Package.swift` and
`Package.resolved` are the two names SwiftPM will not let us rename; they are
the only entries `ops/scripts/check-path-case.sh` allowlists under `apps/macos`.

`sources/kit/design-tokens.swift` is **generated** from
`docs/product/design/tokens.json` by `ops/scripts/build-design-tokens.mjs`,
alongside `tokens.css`. Edit the JSON, run the script, never edit the Swift —
CI's `--check` fails on drift.

## Shared components

`sources/kit/components/` is what every screen draws with (design-build-plan
T5-3): agent prose (the gutter rule in a transcript, the wash everywhere
else), the agent chip, the facet row, the permissions table, the seven request
body blocks, the four states plus `partial`, the stale pill and band with first
paint, Undo and the cost-naming confirm, and 12-hour clock times. Each is built
in two steps, and the split is the point:

1. **A presentation** — a plain value: the words in order, each a `Mark`
   naming its type step, ink, plate and the ground it sits on, and each
   control a `ControlSpec` with the words VoiceOver says. Every rule the
   design record makes lives here, where a test can read it.
2. **A view** that only draws that value.

What they hold to, by construction and by test:

- **One word per idea.** The permission modes are `PermissionWords` and
  nothing else — the CLI's *Allow · Ask First · Never* while the owner's
  wording ruling (decisions-log (b); C93's *On · Ask · Off*) is open — and an
  effective action's line is the CLI's `renderActionLine`, word for word. The
  O3 sentence is `ReachabilityGate`'s. The assistant is its configured name:
  the agent chip never prints the `assistant` principal id.
- **One glyph per meaning.** Every symbol is a `MetistryGlyph` case.
- **The ground actually painted.** Every ink is checked against its own
  plate, or the ground under it, in both schemes — 4.5:1 for words, 3:1 for a
  glyph or an outline. That check found `border-control` at 2.94:1 (light) and
  2.62:1 (dark) on `stale-quiet`, so the stale band's action is a plain button.
- **Never a bare confirmation.** A `CostConfirmation` that names no cost, or
  whose button is not the act's own verb, cannot be made (P3). Reversible acts
  get `UndoWindow` instead — ten seconds, no dialog.
- **Reported, not inferred.** A facet state is the query's `row_flags`; a
  stale pill draws what it is told. The one comparison made here is
  `FirstPaint`'s: a reply's `as_of` against the screen's own age limit.
- **12-hour times** (`ClockTime`) in `en_US_POSIX` with the caller's time
  zone, whatever the Mac's 24-hour setting.

**The largest text, on a Mac.** SwiftUI's semantic fonts ignore
`dynamicTypeSize` on macOS — `Text(…).font(.body)` measures the same at
`.large` and `.accessibility5` (macOS 26.4) — so a test at the largest size
would pass without anything growing. `metistryFont` hands the platform's
semantic font through at `.large` (every Mac today) and on iOS, and otherwise
scales the Mac's point sizes by body's Dynamic Type ratios (13 pt → 41 pt at
`.accessibility5`). Nothing on the Mac sets the size yet; whatever wires the
owner's text size in sets `dynamicTypeSize` at the root.

**The snapshots.** `tests/kit/snapshots/<component>.txt` is each component's
presentation for every sample, walked field by field — words, type step and
point size, ink, plate and ground as the hex each scheme ships, contrast, and
what VoiceOver says — under `## light`, `## dark` and `## largest text`. Text,
not PNGs: what a component decides is deterministic, while a pixel baseline
recorded on one macOS fails on the next. The pixels are still drawn with
`ImageRenderer` and checked for what does not depend on the font: every sample
renders in both schemes and at both sizes, is never wider than the 480 pt
column it is offered, is taller at the largest text, and draws differently in
dark. The samples come from F-7's fixtures through the stores wherever a route
serves the data (the configured name, the requests, Today's task, the agents'
effective actions); the permissions table's rows are screen 7's, decoded
through the `Decodable` `describePermissions()` will fill (T4-6).

```sh
# after a deliberate change: re-record, then read the diff
METISTRY_RECORD_SNAPSHOTS=1 swift test --package-path apps/macos --filter Snapshot
# to look at every drawing
METISTRY_SNAPSHOT_PNG_DIR=/tmp/shots swift test --package-path apps/macos --filter Grows
```

## Needs You: the bodies

`sources/kit/request-bodies/` draws one request as screen 3 §12.2's five parts
— header · the ask · context · one body · answers — and a meeting's parts as
one card (T5-4b). Three rules carry it:

- **The reading is the server's.** Each `GET /api/proposals` row carries
  `request` — core's `describeRequest`: the type, the word, the body block,
  the three answers and what each sends (X-5). The card draws that and keeps
  no kind → word map; a row without one reads as core's unknown kind, a report
  with Dismiss. `RequestReading` fills the block from `payload.body` when a
  producer sends it and otherwise from the fields each producer writes (named
  in the file), and says *partial* — never invents — when it cannot.
- **An answer is to the row that was shown.** A decision goes through
  `POST /api/proposals/:id` with `if_unchanged.seen_at`. `409 stale` sends
  nothing and repaints from the row the refusal carries (its `changed_at` is
  what the next answer claims); `409 already_decided` shows the winner; any
  other refusal is shown verbatim and the card stays answerable (C40, C45); O3
  holds a decision before it is sent and keeps the draft. An answer that posts
  to another system is a door (`RequestDoorHandling`) — none is wired in this
  build, and each such control says so.
- **A meeting's two verbs wait for Undo, then go one by one.** Accept All and
  Decline All are held ten seconds (client-held — there is no verb that takes
  an answer back), then sent one per part in order; the result counts (*4 of 5
  accepted*) and says why, and Try Again resends only what was never applied.

The list hosts it (T5-4a): `RequestCards.card(for:)` keeps one
`RequestAnswering` per request, which the detail draws as `RequestCardView` and
whose `itemActions` are the selection's Approve · Revise · Decline · Later in
the Item menu — so the menu and the button act on the same card.

Questions step one at a time and end on Your Answers; one question sends on
the choice. Access Revise composes `<asked>/<folder>`, so it cannot name a
wider area (C40), and the receipt states the tier trade from `prior_tier`
(C41). The cards are snapshotted with the shared components
(`tests/kit/snapshots/request-card.txt`, `meeting-card.txt`) and walked by the
accessibility probe; a SwiftUI text field on the Mac does not carry its
`.accessibilityLabel` onto the AppKit field (macOS 26.4), so each field is held
to a prompt that names it instead.

## Activity

`sources/kit/activity-view.swift` is the Activity row's screen (T6-3,
screen-02-activity.md). It reads `ActivityStore` — the `activity_feed` named
query — and, on demand, `GET /api/runs/:id` and `GET /api/knowledge/page`;
`AppModel.activity` holds its model so the list the owner left is the list they
come back to, and an instance switch drops it.

- **Bands, one glyph column, who did it.** *Just now* (15 minutes) · *Earlier
  today* · *Yesterday* · the day, as sticky headers on `sunken`. The glyph is
  the kind's SF Symbol (design-system §3.2, plus `capture`, `routine_run`,
  `config_write`); a row whose `ok` is `false` draws `failed`'s own mark in
  `failed` — the glyph, never the row, and never read from `detail` (C19).
  Subjects are Title Cased only for the kinds the console composes
  (`work_history` is not one, C18). The actor chip is the `agent` hue for the
  assistant (by its configured name, left out until known) and for an id the
  registry lists; anything else is neutral on `absent-quiet`.
- **Eight chips** — All and the query's seven groups, passed straight through
  as `kind` — beside *Window* (24 hours · 7 days), *Agent* and *Project*.
- **New rows are held, never inserted.** The poll (`RefreshPolicy.feed`) asks
  with `since` — the newest `ts` painted or held — de-duplicates on
  `(ref, ts, kind)` and holds what is new behind *↓ 12 new*; taking it paints
  them at the top in one step. A filter change starts again: no cursor, no
  buffer.
- **A turn folds its calls.** Rows sharing a `turn_id` sit under their `turn`
  row; the run (`GET /api/runs/:id`) gives the model, time, cost, tokens and
  the whole call count, and opening it asks `activity_feed` with `turn_id` —
  the one parameter this ticket added to `ActivityStore` — so a turn whose
  calls fell past `limit` still shows them all, or says *4 tools, 1 shown*.
- **A routine that wrote carries the spark**, read from its run's `meta.path`,
  and opening it draws that file in the one prose component. `meta.outcome`
  `skipped:…` draws `absent`, not `failed` (§12.3).
- **States.** Empty (*Nothing in the Last 24 Hours* · Widen to 7 Days),
  filtered-empty (*No Captures in the Last 24 Hours* · Clear the Filter) and
  failed (*Couldn't Load Activity*, the error verbatim, Try Again) are three
  panels; a failed refresh over rows is the stale band.
- **Keys.** ↑↓ and ←→ are the list's own; ↩ is Item ▸ Open for a row with a
  destination: a run opens Run detail over Activity (T6-10); the capture,
  request, task and message open the web app, which has them. Screen 2
  §8's `1`–`7`, `/`, ⌘R and ⌘↩ are not in the closed menu table (C119), so they
  are not bound; the chips and the pill are focusable controls instead.

## Chat

`sources/kit/chat-view.swift` and `chat-model.swift` (T6-2) draw screen 1 as the
round-0 final draws it (`boards/chat.py`): one capped column — 620pt at the
reply's 16pt, growing with the text size — centred in the pane so a resize
moves it and never rewraps a line; the owner's turns on `accent-quiet`, the
assistant's with no fill and a 2px `agent` rule hung 18pt in the gutter (C69).
Every fact is one route's answer, and where the wire says nothing the screen
guesses nothing:

- **The transcript** is `GET /api/messages?limit=30`, merged by direction and
  id (inbound and outbound ids are separate sequences). A turn is *working*
  while its own message says `new` or `processing`, finished at `done`,
  failed at `failed` — never inferred from whether a reply has shown up.
- **The tool strip is joined exactly.** A message row carries no `turn_id` and
  no `in_reply_to`, so the strip belongs to the message that *started* the
  turn: the recent `turn` runs (`GET /api/q/activity_feed?kind=turn`), each
  read once (`GET /api/runs/:id`) for the `meta.message_id` the drain stamps,
  then `GET /api/turns/:turn_id/progress`. Never by adjacency or a time
  window. While the live stream is up (T5-7), a turn run starting or a call
  moving (`EventTopic.working`) makes the strip due at once, and the in-flight
  poll drops to a 5 s net. A consequence, stated rather than papered over: a turn that finished
  before the screen watched it has no strip — nothing on the wire joins an old
  reply to its turn.
- **Waiting** (§5.1): the dots and *working*; a tool name, the count and the
  elapsed seconds once there is one; *working · nothing back for 62s* on
  `degraded-quiet` at sixty seconds with nothing new — never "stuck". The dots
  are the product's one loop and hold flat at 0.5 under Reduce Motion
  (`ChatDots`). Token streaming is not in v1 (§2.20), so there is no
  *prose streaming* moment.
- **P9.** A reply that arrives while the reader is scrolled up is appended,
  announced once, and shown as *↓ New Reply*; the transcript scrolls only for
  the owner's own send, the first paint, a reply while already at the end, or
  the pill. Whether the reader is at the end is measured, not guessed: the
  transcript is not lazy, so its end's position in the viewport says so.
- **Sending is a decision (O3).** `POST /message` is not an append
  (`ConsoleAct`), so Send is off while the instance is unreachable, with the
  gate's sentence under it; a send that goes out and fails stays on screen as
  *Not sent* with its words and Try Again. A rating is an append and is
  always sent; a refused one goes back to what it was, with the reason.
- **Stop is drawn and off.** The console has no route that cancels a turn, so
  Stop says so beneath the composer, and Send stays — a composer offering only
  a dead Stop would be a dead end (C138).
- **The tier** (§3c) is the tiers `GET /api/commands` names in a field — each
  `model_override` row's `tier`, with the model and effort it resolves to — sent
  as `POST /message`'s `tier`, pinned for this turn or this conversation.
  Model and effort are shown, not chosen: the route takes a tier and nothing
  else, and a tier's model is Settings ▸ Compute's. ⇧⌘N (New Conversation)
  puts the tier back in the router's hands.
- **The prompt card** is the pending `decision` row whose `payload.message_id`
  is the reply's id, drawn as Needs You's own card (`RequestCardView`) with an
  `accent` rule — one act on one row from either place.
- **Page chips and the pane.** A reply's `[[wikilinks]]` are chips; one opens
  `GET /api/knowledge/page` in a 400pt pane beside the column when the window
  holds both at full width, and as a sheet when it does not. A reply names no
  artifacts on the wire, so there are no artifact chips yet.

Tapbacks are the board's two thumbs beside the name and the turn's right-click
menu (P8); Bad asks for an optional note. The Chat row in the sidebar carries
one `agent` dot while a turn works — presence, not a badge — and the model keeps
watching a working turn after the owner walks away.

## Today: the brief, Next Up, Close the Day, the spine and All

`sources/kit/today-view.swift` is the Today row's screen and its spine,
`today-brief-view.swift` its top (T6-1b, screen-05-today.md §15.1–15.3,
§15.5), and `today-model.swift` the model under both (T6-1a, §12–§15.4,
§15.6–15.7). `AppModel.today` holds the model, so a folded brief, a closed
day, a dismissed offer and the All box outlive a trip elsewhere; an instance
switch drops it.

- **What it reads.** `GET /api/today` (T2-7) for the day; the brief
  (`Journal/Brief/<date>.md`, T3-6) and the Standup routine's file (C111)
  through `GET /api/knowledge/page`; `Me/profile.md`'s `working_days` and
  `working_hours`, the two fields the routines read; `GET
  /api/scheduled/routines/morning-brief` only when the brief is missing, to
  tell a failed run from one not due yet; tomorrow's shape from `GET
  /api/today?date=<tomorrow>` while Close the Day is open.
- **The Morning Brief.** One wash — the file's first paragraph, the
  configured name with the spark, *written, not retrieved* — then Standup
  collapsed with **Copy Standup** (the app target hands the kit the
  pasteboard) and *Metistry doesn't post this*, then the foot: *The plan is
  the day below · 7 tasks, 2 carried · <file>*. It folds to its first
  sentence on the next open once it has been on screen (scrolled past, or
  left); a click reopens it; nothing folds under the reader. Missing, it says
  why — no working days, the run failed (when, and when next), not written
  yet, unreadable — and that the day below is still complete.
- **Next Up** from thirty minutes before the next timed meeting: title,
  time, place, who; **what you owe them** — open tasks whose person facet
  names an attendee and are not `waiting` — tickable through the Tick door;
  the brief's one written line for that meeting; **Open Notes**
  (`POST /api/meetings/:event_id/note`, opened in Obsidian), **Record**
  (dimmed with its reason until the capture bar lands, #253) and **Draft the
  Agenda**, which sends one chat message naming the meeting and what is owed.
  The standup gets two lines and Copy Standup. After the last meeting:
  *Nothing else on your calendar today.*
- **One voice open, three predictions.** The brief is the open wash; opening
  Next Up's line folds it, and while Close the Day holds the top the brief is
  its line. Every prediction goes through `TodayPredictions.page` (three).
- **Calendar help** is computed here, not written: when no 90-minute stretch
  is left in the working day and moving one meeting (at least 30 minutes out)
  would leave one, a line says so beside **Move the <meeting>…** and **Not
  Today** (today only). The move asks the preview first; with other people in
  it, a neutral confirmation names who the calendar will tell and the new
  time (C90), and only then is the single-use token sent. The owner's own
  meeting moves on the token without the warning.
- **Close the Day** takes the top from thirty minutes before `working_hours`
  ends (never on its own without them — *Close the Day…* in the header opens
  it early): Done (a count, the first three), Still Open and Owed to People
  each with **Tomorrow · This Week · Someday** through the Defer door, the
  next working day's shape, and an optional line. **Close the Day** is `POST
  /api/today/close`; it folds to *Day closed at 5:14 PM · 6 done · 3 to
  tomorrow · 1 this week · 1 someday* with Reopen and the file it wrote. `409
  section_missing` is shown as the request it raised — *Today's Note Wasn't
  Updated*, why, and **Open the Request** — never as a success; `409 stale`
  and `404` keep the panel open and say why.
- **The header** is the title and day, **Today / All** (a segmented
  control; View ▸ Today / All ⌥⌘T), *Close the Day…* before the window, and
  on Today the **day bar**: Meetings · Travel · Focus Blocked · Tasks That
  Fit · Doesn't Fit against `working_hours`, `chart-1`…`chart-4` and
  `degraded`, a 2px gap between segments, every category in the legend
  (hollow at 0m), *5h 2m committed of 9h · everything planned fits* — one
  spoken sentence and an `AXChartDescriptor` for the rotor. Overlapping
  meetings count once; a focus block is an event with nobody else in it.
  Travel is 0m until the calendar serves a travel time (A1 carries
  `location`, not the drive). No `working_hours`: no bar, and a line says
  why.
- **The spine** (§12.2, §14.4): meetings at their time and the owner's rows
  in the gaps — `GET /api/today`'s `tasks` and `work` in its `order`, the
  rest as served. A row goes in the first gap, from the one the row above
  it went in, that has room for its estimate (`task_size_minutes` from the
  profile, `s 15 · m 45 · l 90` until it says; a line with no size counts
  none, and its gap says so); a row too long for any gap left is shown
  under *Doesn't fit before 5:30 PM* — never refused, and never holding up
  the rows after it. Focus blocks take rows; gaps under ten minutes do not.
  NOW is a section header pinned under the header; above it the morning is
  one line — *Earlier today — 3 done · 1 meeting · 2 carried forward* —
  expanding in place, folded on every open, so the page opens at now. A
  meeting in Next Up says *in Next Up ↑*. With no timed meeting on the day
  there is no NOW: the spine is the plain list, in the owner's order
  (§12.4). The *keep the morning open* setting (§14.4) is not built.
- **Work rows** (`day_work`) carry the board glyph in `agent` and no
  checkbox, with *Work #41 · blocked · waiting on you: <line>*.
- **Ticking** is one click (C99): struck, *Ticked in <file>* with Undo, and
  Edit ▸ Undo (⌘Z) through the window's undo manager — the same door the
  other way. `409 stale` shows the line as it now stands under *This line
  changed in your note since it was shown. Nothing was written.* — one
  call, no retry, no reload. A line ticked here keeps its place until the
  next open, when it joins the morning's line.
- **Drag order**: a row is draggable onto another's place; Move Up and Move
  Down are VoiceOver actions and the context menu. The whole order goes to
  `PUT /api/today/order` and is drawn at once; the console's stored order
  is the day's from the next load; a refusal puts the rows back with *Not
  moved — why*.
- **All** (§8, §15.6): the `where:` box — monospaced, editable, **Copy**
  beside it (⌘F focuses it) — runs `GET /api/vault-tasks?where=` exactly as
  typed; a `400` shows the parser's own message under *Couldn't read this
  filter. Nothing was guessed.* Rows tick through the same door. Saved
  views: **Waiting on Others** is `where: waiting`; **Slipping** and
  **Owed** are drawn dimmed with why — the grammar has no carry count and
  no "names a person" yet (T2-7's open item), so neither is approximated.

## Knowledge

`sources/kit/knowledge-view.swift` is the Knowledge row's screen (T6-4,
screen-10-knowledge.md); its model is `knowledge-model.swift`, held by
`AppModel.knowledge` so a held Keep Mine outlives a trip elsewhere, and
dropped on an instance switch. It is where the owner reads what the system
learned and settles what it could not — not a file browser; Obsidian is that.
Top to bottom, in the order the owner's questions arrive:

- **The fold.** `GET /api/knowledge/fold` names the newest
  `Journal/Fold/*.md` and its links; its words are that file's own bytes
  (`GET /api/knowledge/page`), split at its `##` sections, a slot still pending
  drawn as *Still being written*. The agent wash, the serif, the configured
  name with the spark; page names in the prose are links that open the page
  here (a path is a reference, not an action). *Open the Fold* opens it in
  Obsidian; *Earlier Folds* asks for the newest on or before the day before.
  No thumbs: the route carries no `prose_id`, and a rating needs one.
- **Needs your eye** — Draft · Conflict · Suggestion, one row each (*what ·
  which page · why · the verb*), the count in the heading and never a badge.
  The rows are the Needs You queue's `draft_settle`, knowledge-conflict
  `review` and `knowledge` requests, plus the owner-only
  `GET /api/knowledge/drafts` — a draft reaches the screen through that route
  and nothing else. A draft or suggestion opens the **Needs You card itself**
  (Approve · Revise · Decline, the same `POST /api/proposals/:id`), so
  answering it here answers it there, and the shell's count asks again. A
  draft nothing has raised a request for says so, its verbs dimmed with the
  fact.
- **A conflict, in place** (§4). Whose file is whose, from the request alone
  (the note, the copy a sync kept beside it, when it was found); that neither
  version was lost; the line diff — `−` yours, `+` the other; and **Keep Mine
  · Take the Other · Merge in Obsidian**, the first two with the words the
  request is served with. The choice is **held ten seconds with Undo and only
  then sent** to T2-10's `POST /api/knowledge/conflicts/resolve` with
  `seen_sha` the hash of the side given up (C136: the Undo is the client's, so
  Undo sends nothing). A `409 stale` repaints the hashes and says so; one with
  nothing in conflict says it was settled elsewhere. Item ▸ Approve and Revise
  choose the two sides.
- **Areas**, each with its written line (its `README.md` description, or *No
  line written for this area yet*, C68) and why it is in front of the owner —
  *Named by the latest fold* or *Changed 2 hours ago*, provenance and never a
  count or a rank (P5). An area opens its page table.
- **The sources line.** `GET /api/scheduled`'s syncs: *4 sources · freshness
  unknown*, folded. It says *all current* only when every source's
  `collector_health` answers it — and **no route serves that query yet**
  (`expose: route`, no route), so today it never does. A sync whose last run
  failed is a fault the line can name without it (*last run failed … · last
  success not known*); a fault opens the line by itself.
- **A page**: its words (page names as links), *Open in Obsidian* (Item ▸
  ⌘O), and two lists — links from it and links to it — each with its `kind`
  (link, frontmatter, embed); an unwritten target is shown, not followed.
- **A page's history** (T10-7): its commits, newest first, from
  `GET /api/knowledge/history` — the subject, who made it (*You*, the
  configured name, an agent id; no name known, no author — never a default),
  when, and what it did (`added`, `modified`, `renamed`, …). *Show This
  Version* reads `GET /api/knowledge/version` under the name the commit knew
  the page by, so a version from before a rename still opens. **Restore**
  sends `POST /api/knowledge/restore` with the hash of the page as it was
  drawn (`seen_sha`) and writes nothing: it raises one Needs You request,
  which the page then draws inline — found by `payload.restore.path` — with
  the Needs You card itself, so Approve · Revise · Decline there is the same
  `POST /api/proposals/:id` Needs You sends (Item ▸ has the same verbs); an
  Approve re-reads the page. The newest commit is *Current*; a commit that
  knew the page by an earlier name, or deleted it, offers no Restore and says
  why (the door restores a page under its own name); one restore waits at a
  time. A `409 stale` says the page changed and re-reads it, raising nothing.
  **Reach `local` (ruling 7):** Restore is drawn, and sent, only while
  `GET /api/whoami` says this client is the local owner token; any other
  client sees the history and the sentence saying where restoring happens,
  and a `403 local_only` answer takes the control away.
- **Search** is Go ▸ Filter (⌘F): `GET /api/knowledge/search`, the page
  table of hits, the bridge's `degraded` note said, and components-03's *no
  match* — *Nothing matches “zebra”*.
- **States.** Placeholder rows only on the very first load (*Reading your
  vault*); a failed refresh over what is shown is the stale band; nothing at
  all is *Knowledge Isn't Answering* (Try Again), or — when the refusal says
  the vault is missing — *Vault Not Found* · Choose Folder, which opens
  Settings on Instance.
- **Accessibility (§2.18).** Every row is one spoken element (*Draft,
  Areas/Health/Sleep.md, the taper. Review*; *Sources, 4 sources · freshness
  unknown, collapsed*); each section is a heading; nothing moves; no key is
  bound outside the menu table; text is `metistryFont`, so the largest size
  grows a row longer, never wider; the root frame is flexible to zero (#392).

## Scheduled

`sources/kit/scheduled-view.swift` is the Scheduled row's screen,
`routine-detail-view.swift` the detail beside its list (one routine, one
sync), and `scheduled-model.swift` the model under both (T6-6,
screen-08-routines.md §10–§11, design-build-plan §2.5). It reads
`ScheduledStore` — T3-3's doors — plus `GET /api/runs/:id` for the latest
run's steps and `GET /api/whoami` for whether this client may change what
runs. `AppModel.scheduled` holds the model; an instance switch drops it.

- **The list is the schedule.** A routine appears once per time it acts —
  its resolved `days` (the console's, which already follow the profile) at
  each `at`, in its `time_zone` — in bands: *Throughout the day* (interval
  housekeeping: Inbox Sort, Usage Rollup), *Today*, *Tomorrow · Monday*, the
  day a weekly one next acts, then *Inactive* (paused, held, or with no next
  run it can place, each saying why). A row never comes from a run, so a
  silent tick is not an occurrence; where the console's `next_run` differs,
  it is added. Rows speak components-02 §3: *7:00 AM, Morning Brief, default,
  run by Aide, working days at 7 AM. Nothing to do* — the configured name,
  left out until known. *Silent* is never said.
- **The week on one axis** — the next seven days, a mark per run, a marker
  per day, a faint noon line — speaks one sentence (*This week: 44 runs, 5
  between 7 AM and 6 PM*) and **Show as Table** draws the same runs per day.
- **A routine.** Run Now and Pause/Resume; the schedule (weekday toggles and
  the time, each with its origin — *default* · *from your profile* · *yours*
  — the zone, the next three runs; a day set left alone is saved by its name,
  so it keeps following the profile; an interval routine is a segmented
  cadence); what it's asked to do (a product routine's config, read-only; a
  New Routine's task, added to its agent's definition); reads and writes;
  History with the latest run opened to its calls, model call and write;
  Reset to Default, which asks nothing, when it is not at its default.
- **Changing what runs is the Mac's.** The task editor (and New Routine)
  exist only while `whoami` says `local_owner_token`; `saveAssignment`
  refuses with nothing sent otherwise, and a `403 local_only` answer takes
  the editor away. New Routine is shown disabled (*isn't in this build yet*)
  until T3-8 serves `POST /api/scheduled/routines`.
- **A sync.** Sync Now, Pause, *Every* as the closed four, *What reaches
  Needs You* as toggles — `PUT /api/scheduled/syncs/:name`, never the
  connection. A sync with no connection says `metistry connections add` and
  offers nothing its door would refuse. Three failures in a row in its
  history (T3-12) is drawn as the stop, with **Go to Needs You**.
- **Keys.** ⌘R (Run Now / Sync Now) and ⌥⌘P (Pause) are the Item menu's,
  answered through `shellItemActions`; screen 8 §7's `r` and `p` are not in
  the closed menu table (C119), so they are not bound.
- **Not on the wire yet.** A product routine's task, actor and reads/writes
  (only `config` is served, and no door writes it), renaming, who paused a
  routine and when, and a stopped sync's streak (drawn from its history).

## Agents

`sources/kit/agents-view.swift` (the roster, New Agent) and
`sources/kit/agent-detail-view.swift` (one agent) are the Agents row's screen
(T6-5, screen-07-agents.md); `sources/kit/agents-model.swift` is what both
draw from, held as `AppModel.agents` so a draft kept with Esc outlives a trip
to another screen. It reads `GET /api/agents` (with `access_ceilings`, which
`AgentList` now decodes), `agent_presence`, `GET /api/scheduled` (a routine's
`actor`), and for one agent `GET /api/agents/:id/definition`, `activity_feed`
with `agent`, and `GET /api/compute` for the model dropdown. No route was added.

- **The assistant is never listed** (C52): its row is dropped by `kind:
  internal` and by its principal id. **Yours** (crews) and **Connected**
  (external) are two groups; revoked credentials a third, collapsed and
  `absent`. A row is who, what (its routine, *when <name> delegates*, or
  *paused*; a connected agent's project or reach) and presence — filled for
  working and queued, hollow and wordless for idle, `degraded` only for
  interrupted and over-cap. Presence's age rides the header when stale.
- **A local agent** shows its definition file as prose with its path and
  *versioned in the vault*, its compute line, the permissions table, its
  routines (each leading to Scheduled) and the last 7 days of what it did.
  **Edit Definition** runs `metistry agents define <id> … --if-sha256 <hex>
  --json` (M12) with the prompt on standard input; a `stale:` refusal reads
  the file again and offers the edit against it. **Esc closes the editor and
  keeps a draft** (C136). The editor, Rotate Token and New Agent's three
  paths are drawn only when the session has a management runner — the Mac that
  runs Metistry; a remote client sees *The definition is edited on the Mac
  that runs Metistry* and no editor at all.
- **A connected agent** shows how it connects, Approve while pending, the
  permissions table with **Edit** (grant tier and folders, named queries,
  projects, autonomy level and per-kind modes), the escalation ceiling (C42:
  *Asked twice for Areas/Finance · declined both · it can no longer ask*),
  Rotate Token and Revoke.
- **Changing things** (§5). The registry is read again before anything is
  sent; a record that moved sends nothing and offers the edit again. A
  narrowing goes at once. A widening confirms first, listing core's
  `autonomyWidenings` strings verbatim — `AgentAutonomy.widenings` is that
  function carried over, held to core's own test cases and to the recorded
  PUT's `widened` — plus reach added in the same `key a → b` shape; the button
  says **Widen**. Revoke and Rotate confirm, naming the cascade.
- **Run Now** (C138) runs the agent's one routine (Item ▸ Run Now ⌘R); with
  none it is dimmed with *Nothing is scheduled for <id>.* beside **Give It
  One** (Scheduled). **New Agent** asks the kind first: a local agent (blank or
  from one you have, `agents define --area --model --prompt-file -`), connect an
  agent (Settings › Connections) or a tool that works for you (`POST
  /api/agents`, the token shown once and copied, never kept).
- **Keys.** ↑↓ are the list's own; ↩ is Item ▸ Open; Esc goes back (or closes
  an editor, keeping the draft). Screen 7 §7's ⌘S and ⌘⌫ are not in the closed
  menu table (C119), so they are not bound — Save and Revoke are focusable
  controls, as ruled for Activity's keys at the W2 checkpoint.

## Work ▸ Board, the card, and a task's room

`sources/kit/board-view.swift` is Work ▸ Board (T6-7, screen-06-board.md;
`docs/ops/board.md`), `board-model.swift` its model and rules,
`card-detail-view.swift` the popover every card opens (screen 14, C84) and
`room-view.swift` a task's room (screen 16 §2, C89). It reads `WorkStore` —
`board`, and `board_projects` for the column totals and the project filter
(the one method this ticket added: counts come from the query, never from the
capped cards) — and `GET /api/agents` for the assign step. `AppModel.board`
holds the model, so the filter and a refused move's sentence are there when
the owner comes back; an instance switch drops it.

- **Five columns.** Backlog · Assigned · In Progress · Blocked share the width;
  Done is 168 pt with compact rows and folds to a strip under 760 pt. Headers
  count every card (*showing 50 of 212* when capped, or when Has Thread is on)
  and put the escalations beside the count in `degraded` — nothing on the
  board is red (C36). Each card shows its column's one facet — *2d in
  backlog*, who it is for, *held by … · 4m left*, the blocked reason (*Waiting
  on you: …*, never the word Blocked again), *closed 2 hours ago* — plus
  *Overdue* or *Reported* where it applies; the bubble and its count, and the
  note glyph for a card promoted from the vault, are marks. Polls every 10 s
  (`cache_ttl: 0`), and a `board` event asks at once.
- **No drop the service would refuse.** `BoardRules` is the PWA's `movesFor()`
  in Swift, sentence for sentence: claim takes an unclaimed open card as the
  owner; release and close are the holder's; assign, unassign and the unblock
  are the board arm; a released or unblocked card lands in its home. A column
  draws a target, and its drop delegate accepts, only where a route would
  succeed; each drop is one route. A drop on Done sends `status: "closed"` —
  `TaskPatch.moving(to:)` used to send `done`, which is no task status —
  Assigned → Backlog sends `owner: null` (`TaskPatch.unassigning`), and
  Backlog → Assigned asks for the name first (the owner, then every agent not
  revoked). Moves are decisions: none is offered while the console is not
  answering (O3).
- **Optimistic, then authoritative.** The card is drawn where it was dropped,
  the route runs, the board is asked again either way. A refusal puts it back
  and prints *Couldn't move "…" — <the server's sentence>* under the board;
  Try Again appears only for a move that never reached the service.
- **Keys** (components-02 §1): ← → between columns, ↑ ↓ within one, Item ▸
  Move… (M) opens the move list — offered moves say what they do, refused ones
  are dimmed with the service's reason, read with the row — Item ▸ Open (↩)
  opens the card, Esc closes a picker. Screen 6's `[` `]` are not in the menu
  table (C119), so they are not bound; the project picker is a control.
- **The card** (screen 14). A work row: the board glyph in `agent`, the title,
  the facet row, Description (the owner edits it — `PATCH {description}`, a
  board-arm field; a failed save keeps the edit with Try Again), Held By,
  Waiting On, the Thread with its last message and **Open Room →**, Comment,
  and the review artifact in the footer. A card that moved while open says
  *Moved elsewhere: Done, by collator* with **Open in Done**. A markdown task
  (`CardSubject.task`) draws its checkbox, *In Its File* — the heading above
  the line and its neighbours, the line highlighted, from `GET
  /api/knowledge/page` — and Complete (the Tick door) · Open in Obsidian ·
  Delegate. **Not drawn:** History and a `depends_on` Blocked By — the `board`
  row carries neither and no route serves one task; Delegate is dimmed (no
  door yet). Today does not open this popover yet — its rows are T6-1a's.
- **The room** is a pane over the board, Board still selected: the
  came-to-you band when the agent tail reached the cap, agent turns on the
  2px rule in the serif, the owner's in the accent wash, the pips with *yours
  resets it*, and *Add to the Room* — no recipient. Resolve and Reopen are
  the owner's; a message that did not post stays in the composer.

## Work ▸ Projects

`sources/kit/projects-view.swift` is Work ▸ Projects (T6-8,
screen-13-projects.md, C83, C94); its model is `projects-model.swift`, held by
`AppModel.projects` so the project the owner left is the one they come back
to, and dropped on an instance switch. Projects appear on first use (0011), so
there is no New Project.

- **The list** is `GET /api/projects`: the name, then the **mode** — read first
  after the name — then the agents that joined, *4 open · 1 blocked* (the
  board's Blocked column, `GET /api/q/board`, counted per project), today's
  spend against the budget as a line and a bar that turns `degraded` at the
  budget, and the last activity. ↩ opens a project; ⌘O opens its folder in
  Obsidian. Empty: *No Projects Yet* · **Open Board** (plan §1.4). Spend older
  than fifteen minutes, or a failed refresh over it, draws the stale band —
  *Spend as of 40 minutes ago* · **Sync Now** (components-03 §2).
- **The mode uses the channels honestly (C83).** Autonomous is a quiet
  outline. A Review the owner chose takes **weight** — a 2 pt `text-primary`
  outline and the review mark (`MetistryGlyph.reviewMode`, a raised hand; not
  the eye, which is Needs You's *review* request). Only a Review the budget
  forced takes the **tint** — `degraded-quiet`, the warning mark and *Review ·
  over budget*. Which one is `last_mode_change`: a `project_mode` run is the
  budget's flip, a `project_admin` run the owner's toggle; the spend is never
  read to guess it, so a project over its budget that the owner put back into
  Review is a choice.
- **A project**: the header — name, chip, the **Review** switch, and footnotes
  (*$5 a day · 20 handoffs at once*; *review since 2:40 PM (over budget)* or
  *(you set it)*); over budget, one sentence — *Went over its $3 budget at
  2:40 PM. Handoffs between agents now come to you.* — and **Raise Budget**,
  which opens Settings › Compute › Spending limits (C138; T4-19 puts project
  budgets there). Then **In Flight** (open, blocked, handoffs in flight of the
  cap, queued, open threads, spent today); **Permissions** — the project's own
  grant, served on `GET /api/projects` since T6-8, labelled *every member gets
  these* and drawn in the Agents table (C58) in `core`'s words (*Titles only*,
  *Named queries*); **Agents**, each with only what it holds **beyond** the
  project — *+ Areas/Ops (Approved in Needs You · #4)*, *+ Areas/Beta (via
  project beta)* — or *project access only*; and **Recent Runs** from
  `activity_feed` for the project, each opening Run detail over Projects.
- **The instance's own agent.** The rollup lists an internal row with no
  project list as a member of every project, and it inherits nothing from any
  (T4-7: its reach is its configuration). It is not counted among a project's
  agents, is never offered to Add Agent, and is drawn apart: *Aide works in
  every project on its own access. It inherits nothing from a project.* (the
  configured name).
- **The confirmations (§4).** Nothing is sent until the owner confirms, and
  the row is read again after. **Back to Autonomous**: *Its agents will hand
  work to each other without you again.*, the button in the destructive role.
  **Into Review**: *3 handoffs in flight will wait for you.* **Add Agent**
  lists the connected agents that are let in and not members (a crew's
  projects are its definition's) and names exactly what joining gives: the
  project's tasks and artifacts, and each line of the project's grant the
  agent does not already hold — or *Nothing more to inherit*. It sends `PUT
  /api/agents/:id/projects` with the agent's projects and this one. A refusal
  is said in the console's words, and the switch stays where the console says.
- **Accessibility (§2.18).** A row is one element — *Metistry, Review, 1 agent,
  4 open, 1 blocked, active 2 hours ago, $0.00 today · no budget*; the chip
  says its mode (and *over budget*) in words; the switch is one control, *Review,
  on*, with the focus ring; each section is a heading; nothing moves; no key is
  bound outside the menu table; the root frame is flexible to zero (#392).

## Work ▸ Artifacts

`sources/kit/artifacts-view.swift` is Work ▸ Artifacts (T6-9,
screen-16-artifacts-and-rooms.md §1); its model is `artifacts-model.swift`,
held by `AppModel.artifacts` so the version the owner left is the one they
come back to, and dropped on an instance switch. It reads the §2.16
`ArtifactsStore` and one named query, and writes nothing — every read is a
route that was already served, and no console route was added.

- **The list** is `GET /api/artifacts`: the slug, then *project · kind ·
  updated 1 hour ago*, and the open threads across every version — one
  `GET /api/q/rooms?anchor=artifact&state=open&limit=500` for the whole list,
  counted per artifact (and per version for the rail), said as *500+* when
  the read hits its limit. ↩ opens one. Empty: *No Artifacts Yet*. No event
  names a publication, so the list polls (30 s); `thread.changed` re-reads the
  counts and, for the artifact on screen, its threads.
- **Not drawn, because nothing serves it** (spec §1 asks for them): a
  **title** — an artifact has none, the slug is its name — and the list's
  **latest version and who made it** — `GET /api/artifacts` carries
  `current_version` as an id and `created_by` (the first author), not the
  latest version's number or author. Both appear once an artifact is open,
  from its versions; drawing them on the list would take one versions read
  per row.
- **An artifact**: the **version rail** on the left — *v2 · latest*, who made
  it (*You*, the configured name for the instance's own agent, an agent by its
  id), when, the message, and that version's open threads; versions are ids
  on the wire and are numbered here oldest-first, as the PWA numbers them.
  The **version at reading width**, line by line (markdown headings as
  headings; text, JSON and CSV in mono; HTML as its source — agent markup
  never renders on the Mac); an image, PDF or binary says so and opens in
  Obsidian (⌘O opens the file on screen, whatever its kind). A bundle's files
  are a picker; a version opens on its entry file (`index.md`, `README.md`,
  `index.html`, `index.json`, else the first).
- **The margin (§1).** A thread's anchor is the client's `{line}`, as the PWA
  writes it. Each thread whose line is on screen sits in the right margin
  **level with its highlighted line** (`accent-quiet`); when two would
  collide, **the lower moves down, 8 pt below the card above, and keeps a
  leader** to its line (`ThreadMarginLayout` over
  `ThreadMarginPlacement.place`, measured in the tests: the first at 0 from
  its line, the pushed one 35 below with 8 between). Replies fold to a count
  (*Show 2 replies*). A thread with no line here — another file, no anchor, a
  line past the end — is listed under the text, never placed on a line it is
  not about. Switching version shows that version's threads: the comments
  route is asked per version, and a thread is only ever drawn on its own.
- **Compare** is `GET …/diff?from=&to=`, drawn per file with + on `ok-quiet`
  and − on `failed-quiet`, the glyph carrying it too. It opens from the
  version before the one on screen to it (from v1, to the latest), with From
  and To pickers. The diff is read for which lines of the FROM version it
  changed (git's `@@ -a,b` hunks, or the header-only form from line 1), and
  when open threads on that version sit on such a line: *1 thread on v1 is
  about a line v2 changed. It stays on v1.* with **Open on v1 →**.
- **The states (components-03 §2).** A wait past a second: *Opening
  store-interface · v2 · 66 bytes*. An older version's file is served only
  while its hash still matches the working tree (`readFile`), so an older
  version is usually unreadable: the failed panel says *notes.md at v1 was
  replaced on disk, so it can't be shown*, offers **Show v2** (the latest, or
  the version before the latest when the latest itself fails), and lists
  that version's threads. No stale state: versions are commits and do not
  age. A console with no vault bridge (503) is the failed panel in the
  console's words with Try Again.
- **Accessibility (§2.18).** A row is one element — *store-interface,
  metistry, markdown, 1 open thread, updated 1 hour ago*; a version row says
  its number, author, when, message and threads; a highlighted line says
  *Line 3, 1 thread* after its words; a card says *You, 10:54 PM, Line 3:*
  and the words, its replies control *Show 2 replies*; each section is a
  heading; nothing moves; no key is bound outside the menu table; the root
  frame is flexible to zero (#392).

## Run detail

`sources/kit/run-detail-view.swift` is Run detail (T6-10,
screen-12-run-detail.md, C78, C79, C95); its model is `run-detail-model.swift`,
held by `AppModel.runDetail`. It is **one page for any run**, drawn by
`ShellDetail` over the screen the run was opened from — an Activity row
(`runs:<id>` is openable now), a project's Recent Runs — with that screen still
selected in the sidebar and its name as the way back (*Activity ▸ Morning
Brief ▸ 6:02 AM*). An instance switch closes it.

Three reads, each through its own door:

| Part | Door | What it gives |
| --- | --- | --- |
| The run, *The run*, *Tool calls* | `GET /api/runs/:id` (`run_detail`) | the row, model and provider, time, tokens, cache, cost, `meta.tier`, shadow, and the calls of its turn joined exactly on `meta.turn_id` |
| The conversation | `GET /api/sessions/:id?turn_id=` (`session_detail`) | the turn as the archive kept it: the system prompt as sent, the messages, each call's arguments and result. Keyed by the run's `meta.session_id` and `meta.turn_id` (drain.ts). `ChatStore.session(_:turnID:)` now sends the route's existing `turn_id` |
| *What … took from this* | `GET /api/proposals` | the session fold's waiting requests whose `payload.items` name this session and turn |

- **The conversation leads**, at reading width: the definition layer (the
  system prompt) collapsed, the task, the replies in the transcript rule
  (C69), and each tool call where the message that asked for it stands, on the
  `agent-quiet` wash, opening to **Asked** and **Got** (a `tool` message its
  call already shows is not drawn twice; a value past 4,000 characters is
  clipped and says how much is left). A failed call is **open**, its refusal
  as its result (§3). Durations are not joined into the conversation by
  guess: they are the ledger's, and stay in the side column.
- **The side column**: *What <name> took from this* (the configured name,
  C88) — each item's kind, where it lands, the line and *In Needs You*; empty,
  the session's own `folded_at` says whether the fold has read it and until
  when it is kept. Then **The Run**, **The Route** for a `kind: route` row
  (T9-1: served, policy outcome, would serve, bounded by, agrees), and **Tool
  Calls · n** — each call with a bar for its share of the longest, a failed
  one in `failed` with its mark and its error. The header's pill is *ran
  clean*, or *failed* in `failed` with its mark (C95), and a failed run says
  so in one sentence with the ledger's error.
- **The transcript gone is not a failure** (components-03 §2, review-01
  R2.7). `session_detail` answers nothing past the archive's 30 days, and the
  route says `404`: the page says *The transcript expired after 30 days. The
  summary and cost remain.* (or, younger than 30 days, *purged, or never
  kept*) and still draws the run, its cost and its tool calls. A run that
  names no session — a routine's own `routine_run` row, a tool call, the
  recorded fixture's turn — says that instead. Only a run the console will
  not answer is the failed panel, with Try Again.
- **What is not drawn, because it is not served.** *Accepted* and *Declined*:
  only the waiting queue is served per session, so decided fold items do not
  appear. A turn's route decision: the `kind: route` row is its own ledger row
  keyed by `meta.message_id`, and `run_detail` joins only `kind: tool` rows,
  so a turn shows its `meta.tier` and a route row shows its decision.
  A routine's conversation: a `routine_run` row carries no `session_id` or
  `turn_id`, so Routines history would open a page with no transcript; the
  prose turn it enqueues is its own `turn` row in Activity. Scheduled's
  History and an agent's recent work are not wired to the page yet.
- **Accessibility (§2.18).** Screen 12 carries no Spoken table; C121's rules
  stand in: each section is a heading; the pill says *failed* in words; a call
  is a button saying its tool and *failed*, with *open*/*closed* as its value;
  a tool-sequence row says *knowledge_read, 200 milliseconds, failed, …* (the
  bars are the chart, the rows its table); a taken item says its kind, line,
  destination and status. Nothing moves; no key is bound outside the menu
  table — Item ▸ Open in Obsidian (⌘O) opens the file a routine run wrote;
  the root frame is flexible to zero (#392).

## Build and run it

```sh
swift build --package-path apps/macos      # compile
swift test  --package-path apps/macos      # the kit's unit tests
```

`swift build` alone gives you an executable, not an app: no `Info.plist`, so no
bundle identifier, no menu-bar item and no Sparkle feed. To get a real
`Metistry.app`:

```sh
ops/release/build-app.sh --no-dmg          # -> dist-app/Metistry.app
open dist-app/Metistry.app
```

Add the DMG by dropping `--no-dmg`. Other flags:

| flag | |
| --- | --- |
| `--version <x.y.z>` | default: the root `package.json`'s version |
| `--runtime <tar.gz\|dir>` | embed a runtime pack (`ops/release/pack-runtime.sh`) |
| `--runtime-deps <tar.gz\|dir>` | embed the bundled runtime (`ops/release/build-runtime-deps.sh`) |
| `--out <dir>` | default `dist-app/` |
| `--skip-build` | reuse `.build/release/Metistry` for fast iteration |

### The install layout: the bundle is a seed

A signed bundle's `Contents/Resources/metistry/` cannot be written to, and
`metistry update --channel release` must write `releases/<version>/`, flip
`current` and unpack a new `runtime/`. So the bundle **seeds** a writable
product directory, once, and the CLI owns it from then on — identically to
a checkout install (decision ratified 2026-09-10,
`docs/product/desktop-app-plan.md`).

```sh
metistry runtime install --from /Applications/Metistry.app
```

```
/Applications/Metistry.app/Contents/Resources/metistry/   the SEED (read-only, signed)
  releases/<version>/ · current -> releases/<version> · runtime/

~/Library/Application Support/Metistry/product/           the PRODUCT DIR (writable)
  releases/<version>/      the runtime pack — what every plist's __REPO__ resolves through
  current -> releases/<version>
  runtime/                 Node, Postgres + pgvector, git — BESIDE releases/, so a
                           version flip never orphans the Postgres the db job points at
  .metistry-install.json   {version, release.manifest_sha256, runtime.manifest_sha256, from}
```

`--to <dir>` overrides the destination. It is **idempotent**: the seed's own
`releases/<v>/metistry-runtime.json` and `runtime/manifest.json` are read
and cross-checked against the `current` symlink before a byte is copied,
and their sha256s land in `.metistry-install.json`, so the same seed twice
does nothing (`--force` copies anyway). A bundle whose manifest and
`current` disagree, or that carries no `packages/cli/dist/main.js`, is
refused rather than half-installed. The receipt is written **last**, so an
interrupted run is re-done rather than mistaken for a finished one.

When Sparkle updates the app it ships a newer seed; the next
`metistry runtime install` copies it forward and leaves the previous
`releases/<v>` in place, so `metistry update --rollback` still works.

### Updated from the terminal too

The other direction closes the loop. On a launchd Mac, `metistry update` in
release mode moves the **bundle** as well as the product dir: after the
runtime pack it downloads the same release's `Metistry-<version>.dmg`,
verifies it against `checksums.txt` exactly as it verified the pack, mounts
it read-only (`hdiutil attach -nobrowse -readonly`), and swaps the bundle
into `/Applications/Metistry.app` — checked first for this bundle id, the
release's `CFBundleShortVersionString`, and (signed builds) `codesign
--verify --deep --strict` plus `spctl --assess`. The old bundle stays beside
it as `Metistry.app.previous` for `metistry update --rollback`; `Finder` and
Launch Services do not treat that name as an app. The seed inside the new
bundle is the release `update` just unpacked, so the app's next
`metistry runtime install` finds nothing to copy.

What it will not do, by design: ask for an administrator (a `/Applications`
the user cannot write gets the `--app-path ~/Applications/Metistry.app`
line instead), quit a running app (it says to reopen it; `--relaunch`
opts in), downgrade an app Sparkle already moved further, or replace a
signed app with an unsigned one. `--no-app` skips it. The runbook is
`docs/ops/cli.md`, "Moving the Mac app with the release"; the code is
`packages/cli/src/mac-app.ts`, and doctor's `app` row reports the app's
version against `metistry.lock`.

Two details that are not cosmetic. The copied tree is made **writable**
(`cp` preserves the bundle's `0555` directories, and `update` could not
then delete a release to install the next one over it). And `runtime/` is
copied with its symlinks intact, not through them — `postgres/lib` is
libpq's versioned-name symlink farm, and the pack's `node_modules` is
pnpm's relative-symlink tree, which dereferencing severs.

Instances go elsewhere and are self-contained:
`~/Library/Application Support/Metistry/<name>/` holds the vault at its
root and, under `.metistry/`, `identity.yaml`, `state/.env`, `state/pg`,
`state/assistant` and — when the install is namespaced —
`state/ports.yaml`.

> **`.metistry/state/.env` values must be shell-quoted** when they contain a space.
> The reconciler, watchdog and TCC bridge jobs load that file with
> `set -a; . <file>`, which *runs* it. `metistry up` refuses rather than
> installing jobs that respawn forever, but the app should write
> `METISTRY_INSTANCE_DIR="…/Application Support/…"` with the quotes.

### Pointing a local build at an install

Two pointers, and they are different things. The **instance** is the install the
app manages; the **developer runtime override** is where the CLI itself lives,
and a build with an embedded runtime never needs it.

```sh
# which install the app manages — Settings → Instance → Choose…
defaults write com.foldedspacelabs.metistry activeInstance -string ~/Development/metistry-instance
# only for a build with no runtime inside it — Settings → Advanced
defaults write com.foldedspacelabs.metistry developerProductDirectory -string ~/src/metistry
```

The wizard's step 1 offers the override too, but only when no runtime was found —
there is no reason to ask a shipped app where the product is. **The scaffold's
`productDirectory` key is gone**; a value left over from an earlier build is
migrated to `developerProductDirectory` on first launch and removed.

The checkout needs `packages/cli/dist/main.js` built (`pnpm -r build`) and a
`.env`. The app also honours `METISTRY_PRODUCT_DIR` when the process happens to
have one — a Finder-launched app does not, which is why the folder picker
exists. Every verb the app runs is given `METISTRY_INSTANCE_DIR=<activeInstance>`;
an inherited variable wins over the checkout's `.env` (the CLI's loader fills
gaps only), which is what makes the app's instance choice mean something.

**How the runtime resolves, in order.** Each rejection is shown on the screen
with its reason, so "not found" is never a shrug:

1. **checkout** — the folder chosen in the app, or `METISTRY_PRODUCT_DIR`. Uses
   the checkout's own `runtime/node/bin/node` when it has one (the node
   `metistry up` renders into the launchd plists), else a `node` from
   `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
2. **installed** — `~/Library/Application Support/Metistry/product/`, what
   `metistry runtime install` wrote out of the bundle. **The writable one**, and
   therefore the one `metistry update` can lay a new `releases/<version>/` into.
3. **bundled** — `Metistry.app/Contents/Resources/metistry/`, needing both
   `runtime/node/bin/node` and `…/packages/cli/dist/main.js`. Signed and
   read-only, so it is a **seed**, not the install.
4. **path** — a `metistry` in those same directories, plus two more:
   `~/.local/bin` (where `metistry up`'s own printed one-liner suggests
   linking its shim — `docs/ops/cli.md`, "Getting `metistry` on your
   PATH") and the active instance's own `.metistry/state/cli` (the shim
   itself, written there by `up`/`update` whether or not anyone has linked
   it — a sibling of `state/bin/`, which stays the launchd shape's
   supervisor identity symlink, never the shim). The instance is known
   here — `AppModel.instances.active` — so this stage finds an install
   even before the operator has run the `ln -s` line by hand.

Both 2 and 3 prefer the `current` symlink when there is one, because that is
exactly how `metistry update` lays out a release install — `releases/<version>/`
with `current` pointing at one and `runtime/` **beside** them, never inside one,
so a version flip never orphans Node.

**Why the checkout moved to the front.** It was third. The new second stage is
something the *app* put there; a developer override is the only pointer in this
app a person sets **by hand**, and an explicit choice has to beat one the app
made for itself — otherwise a stale Application Support copy silently shadows the
checkout somebody is actively working on, which is exactly what happened the
first time this was ordered the other way round. Nothing changes for a shipped
app: it has neither set, so it falls straight through to its own runtime.

Every verb is invoked with an explicit `--product-dir`: a GUI process has no
meaningful working directory to fall back on.

**Where a bundled install's writable product dir lives — settled.** This was the
scaffold's open question: `Contents/Resources/metistry/` is inside a signed
bundle and cannot be written to, but `metistry update` in release mode has to
write `releases/<version>/`, flip `current`, and unpack a new `runtime/`. The
answer is the first of the two options the plan set out — **the bundle is a seed,
copied once to `~/Library/Application Support/Metistry/product`** — which is also
what the plan's own "Two channels, both signed" paragraph already read as.
Application Support rather than the instance directory because the product is
*code*: one copy serves every instance, and the plan's "what lives where" table
already puts `releases/`, `runtime/` and `current` in the install dir.

**The copy is a CLI verb, not something the app does.** Wizard step 1 runs
`metistry runtime install --from <bundle> --to <dir>` and re-resolves when it
succeeds. An app that laid out a release install itself would be a second
implementation of `metistry update`'s release mode, which is the one thing this
design forbids. Until the copy exists the app runs happily out of the seed and
step 1 says what is left to do and why — a read-only runtime is not a fault.

## Signing locally

`ops/release/build-app.sh` signs with `METISTRY_SIGN_IDENTITY` when it is set,
otherwise with the first installed **Developer ID Application** identity,
otherwise not at all.

```sh
METISTRY_SIGN_IDENTITY=none ops/release/build-app.sh --no-dmg   # force unsigned
```

An unsigned app runs perfectly well on the machine that built it, which is all a
local build needs. It is *notarization* that requires a real identity, and
`ops/release/notarize.sh` refuses an unsigned artifact up front rather than
letting Apple reject it five minutes later.

Auto-detection resolves the identity's **SHA-1 hash**, not its display name. A
Mac holding two valid Developer ID certs for one team — a renewal, typically —
has two byte-identical names, and `codesign -s "<name>"` fails with `ambiguous
(matches …)`. `security find-identity -v -p codesigning` shows both.

What the script signs, and in what order:

1. any Mach-O inside `Contents/Resources/metistry/` that arrived **unsigned**.
   `build-runtime-deps.sh` signs everything it produces and the TCC helpers are
   signed by their own build scripts, so those are left exactly as they are —
   re-signing a helper without its `--identifier` would change the bundle ID TCC
   keys its grant on (`docs/ops/apple-signing.md` §3).
2. Sparkle inside-out: its XPC services, `Updater.app`, `Autoupdate`, then
   `Sparkle.framework`.
3. the app, with `--options runtime --timestamp` and the entitlements file.
4. the DMG (`--timestamp`, no `--options runtime` — the hardened runtime is a
   property of an executable, and a disk image has none).

**The entitlements file is deliberately empty**, and
`apps/macos/resources/metistry.entitlements` explains why at length: under the
hardened runtime an entitlement is an *exception*, and this app needs none. It
touches no TCC-protected resource itself (Calendars and Reminders go through the
EventKit helper, its own signed bundle with its own grant), spawning `metistry`
is not restricted, and the one framework it loads is signed with the same
identity so library validation is satisfied. `com.apple.security.app-sandbox`
stays absent: the app drives an installer.

## Notarizing locally

One-time setup is `docs/ops/apple-signing.md` §4 — an App Store Connect API key
stored as the `metistry-notary` keychain profile. Then:

```sh
ops/release/build-app.sh                      # produces dist-app/Metistry-<version>.dmg
ops/release/notarize.sh dist-app/Metistry-<version>.dmg
```

It submits, waits, staples the ticket to the DMG and validates. In CI it uses
`APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` instead of the
profile; the decoded `.p8` goes to a `0600` temp file and is deleted on exit.

## In CI

- **`ci.yml` → `macos-app`** (macos-15): `swift build` and `swift test` on every
  PR, cached on `Package.resolved`. No signing, no bundle, no DMG — this exists
  so the app cannot rot silently, and it is kept small on purpose.
- **`release.yml` → `macos-app`** (macos-15): imports the Developer ID cert into
  a temporary keychain, embeds the runtime pack and the bundled runtime this
  same run built, signs, notarizes, staples, and uploads the DMG.
- **`release.yml` → `appcast`** (macos-14 — it compiles nothing): signs that DMG
  with Sparkle's `sign_update` and renders `appcast.xml` through
  `ops/release/appcast.mjs`.

**Why macos-15 for the two jobs that compile.** The macos-14 image's default
Xcode is 15.4, whose Swift is 5.10, and it refuses the package before doing
anything:

```
error: 'macos': package 'macos' is using Swift tools version 6.0.0 but the installed version is 5.10.0
```

The app still *targets* macOS 14 — `Package.swift`'s `platforms:` puts `minos
14.0` in the binary, which `otool -l` confirms. The runner image is the
toolchain that builds it, not the floor it runs on.

Both release jobs **skip cleanly** when their secrets are absent, the same way
the `images` job does for a fork without `packages:write`: the run logs a
`::notice::` and the release still gets every other asset. `publish` gathers
whatever exists and covers all of it in `checksums.txt`.

## The icon is a placeholder

`ops/release/make-app-icon.mjs` draws it — a rounded square in the design
system's `accent` with a white M — and `build-app.sh` runs it through `sips` and
`iconutil` at build time. Generated rather than committed on purpose: a binary
blob nobody remembers is the kind of placeholder that ships forever. Replacing
it means saving a real 1024pt master and pointing `build-app.sh`'s `ICON_PNG`
at it (`ICON_PNG=/path/to/icon-1024.png ops/release/build-app.sh …`); unset, the
generator still runs.

## Open, and worth settling before launch

**Whether native passkeys are worth a provisioned build.** Measured above: they
are unreachable from a Developer ID DMG whatever the origin is, because
`ASAuthorization` wants an application identifier and that needs an embedded
provisioning profile. Getting one is a build step, not a channel change: Apple
issues Developer ID provisioning profiles (App ID + Associated Domains,
embedded as `Contents/embedded.provisionprofile`, signed with the
application-identifier and associated-domains entitlements) — and it would
*still* need a publicly resolvable HTTPS origin on 443 serving an AASA, which a
loopback install does not have and a tailnet install has only through a
gateway. The console's
enrolment-code flow works today on every install, on this Mac and on the phone.
Worth deciding deliberately rather than drifting into.

**Whether the console should accept an array of expected origins.** One line in
`apps/console/src/webauthn.ts` (`@simplewebauthn/server` v13 supports it) would
let a native ceremony match a ported origin, and would turn today's opaque
HTTP 500 on a mismatch into a real answer. It is a console change, so it is not
in this PR — but it is half of what a provisioned build would need, and the
error-shape half is worth doing on its own.

**~~Where a bundled install's writable product dir lives.~~ Settled
2026-09-10: the bundle is a seed.** The app runs `metistry runtime install
--from <its own bundle>` on first launch, which copies the embedded tree to
`~/Library/Application Support/Metistry/product/`; every plist points there
and `metistry update --channel release` works exactly as it does on a
checkout install. The alternative — Sparkle-only updates, with `update` a
no-op for app installs — was rejected: the product could then only move when
the whole app did, the terminal and app paths would stop being one tested
path, and `releases/`/`current`/`--rollback` would exist for checkout
installs only. "The install layout" above has the shape; the rationale is in
`docs/product/desktop-app-plan.md`.

**What the app still has to do about it.** Run the verb on launch (it is a
no-op when the seed is unchanged, so it is safe every time), and show its
output on a progress screen the way the other first-run steps do. Until then
a developer build points at a checkout instead.

**Whether the app gets a `manifest.yaml`.** Invariant 5 enumerates bridges,
collectors, agents, routines, targets and services — a client app is none of
those, and `core`'s manifest union has no type for one. `apps/macos` therefore
ships without a manifest and `metistry doctor` skips it, following the precedent
`packages/cli` already set: "the CLI ships no `manifest.yaml`: `core`'s schema
has no type for a command-line tool and inventing one is worse than the gap"
(`docs/ops/cli.md`, "Not yet"). Adding a `client` type is a schema change with
its own blast radius; worth doing deliberately or not at all.
