# Scheduled — `scheduled.yaml`

Everything recurring is a **routine** or a **sync**, and all of its timing and
configuration lives in one place (`docs/product/design-build-plan.md` §2.5,
ruling 2): Standup, Morning Brief, Tomorrow's Plan, the Knowledge Fold, Reply
Review, the Weekly Review, Inbox Sort, Usage Rollup, and every sync.

Each field resolves from three layers, and shows which one it came from:

1. **the manifest** — a product routine or collector, or an extension: the
   default schedule, the config schema, what it reads and writes;
2. **`Me/profile.md`** — facts about you a schedule may *follow*
   (`working_days`, `timezone`). Read, never written;
3. **`.metistry/scheduled.yaml`** — your changes. **Reset to Default** deletes
   an entry.

The schema is `packages/core/src/scheduled.ts`; the schedule shape, the
next-occurrence function and the runner's question `dueOccurrence` are
`packages/core/src/schedule.ts`; the runner is `apps/console/src/runner.ts`.

## What is wired, and what is not yet

**The runner reads this file on every tick** (T3-1): each component's
`schedule` and `paused` from `routines.<name>` or `syncs.<name>` over its
manifest's default, and — when a time of day follows it — the two facts in
`Me/profile.md` a schedule may follow. See "How the runner fires", below.
**Every entry is checked against its manifest** (T3-2): the section it
lives in, the config keys and Needs You rules it names — an entry that does
not fit holds its component ("What a manifest declares", below). Every
routine and collector manifest carries §2.5's default schedule in the closed
shape, a `display_name`, and what it declares for this file ("Defaults").
`resolveScheduled` (`scheduled.ts`) resolves every field with its origin
(`Sourced<T>`) for the app, and the console may write the file
(`CALLER_AUTHORITY.console`, `apps/reconciler/src/paths.ts`).

**The Scheduled doors** (T3-3, `apps/console/src/scheduled-routes.ts`;
`docs/ops/client-api.md`, "Scheduled") are the file's only writer and serve
`resolveScheduled`'s listing: a routine's schedule, pause and Reset to
Default, a sync's cadence, pause and raise toggles, and — from the Mac alone —
a New Routine: creating one (`POST /api/scheduled/routines`) and its actor,
task and per-run grants (read-only). Each writes the
file as a YAML document, so your comments survive, only after the result
validates and fits the component it names; an invalid file is never
rewritten. **Run Now** runs one component through the runner, under your
pause and the preflight, budget included. **Each run is handed its resolved
config** (`ctx.config`: every key the manifest declares, your value over the
default).

**A routine suggestion** (T3-11, `apps/console/src/routine-suggestions.ts`)
is a request in Needs You — an *improvement* — showing one entry of this file
before and after: a routine's schedule or pause, a sync's cadence, pause or
raise toggles, never what runs or a sync's connection. Nothing is written
until you Approve; Approve then writes exactly the "after" through the same
Scheduled door, as you, and is refused, writing nothing, if the entry changed
since you were shown it (`docs/ops/client-api.md`, "`allow` on a routine
suggestion"). Revise, Decline and Later write nothing.

**New Routines run** (T3-8): each run is one crew run for its actor, with
its per-run grants held only while that run lasts ("New Routines — how one
runs", below).

## The file

```yaml
# .metistry/scheduled.yaml (F-4 freezes the schema)
routines:
  standup:
    schedule: { days: working_days, at: ["08:00"] }   # or days: [mon, tue, …]
    paused: false
    config: { template: Templates/Standup.md, skip_without_calendar_event: false }
  vendor-sweep:                       # a New Routine: an assignment, no product code
    actor: vendor-research
    task: "Summarise everything added to Areas/Finance since yesterday…"
    grants: { read: [Areas/Finance] }   # per-run grants are read-only; Journal/Digest/ is the routine's own subfolder — ownership, not a grant (below)
    schedule: { days: [mon, tue, wed, thu, fri], at: ["07:00"] }
syncs:
  github-state:
    connection: github
    every: 15m                        # 5m | 15m | 1h | 6h
    raise: { review_requested: true, assigned: true }
```

That is §2.5's example, unedited, and a test holds it valid
(`packages/core/test/scheduled.test.ts`) — as it does every example on this
page that starts with the file's name.

`.metistry/scheduled.yaml` is a protected path, and the **one** the console
gained on 2026-09-26: the reconciler lets the console's credential write it
as `user` beside `assistant-prompt.md` and `compute.yaml`, and nothing else
under `.metistry/` (`CALLER_AUTHORITY.console`; the misuse test is *the
console still cannot write any other protected path*,
`apps/reconciler/test/paths.test.ts`). The console writes it through the
Scheduled doors only, after validating what it writes against this schema
and the manifests; the assistant cannot write it at all (invariant 2).

## Schedules — the closed shape

A schedule is one of exactly two forms:

| Form | Means |
| --- | --- |
| `{days, at, tz?}` | at each `at` time, on each of `days`, in `tz` |
| `{every: 5m \| 15m \| 1h \| 6h}` | that long after the last run |

- **`days`** — a list of weekdays (`sun mon tue wed thu fri sat`), or one of
  two sets that *follow* your profile:
  - `working_days` — the days `Me/profile.md` lists;
  - `eve_of_working_days` — every day whose **next** day is a working day.
    Monday to Friday gives Sunday to Thursday: Sunday evening plans Monday,
    and Friday evening does not plan Saturday.

  A set follows the profile until you set explicit days on that routine. If
  the profile does not say which days you work, a routine on a set does not
  run and says why (`no_working_days`) — nothing guesses Monday to Friday.
  `resolveDays` in `schedule.ts` is the one definition of both sets.
- **`at`** — one or more `HH:MM` times, 24-hour, two-digit hours, quoted:
  `["08:00", "23:00"]`. At most 48 (every half hour); anything denser is an
  `every`.
- **`tz`** — an IANA zone name (`America/New_York`, `Etc/UTC`). Absent, it is
  your profile's `timezone`, then the zone the runner is configured with
  (`METISTRY_TZ` — not `TZ`, which both deployment shapes set to `UTC` when
  `METISTRY_TZ` is unset). A UTC offset such as `+05:00` is refused: it has
  no daylight-saving rules, so 08:00 in it is 08:00 on your clock for only
  half the year.
- **`every`** — `5m`, `15m`, `1h` or `6h`, and nothing else. The set is
  closed: a new interval is a product change, not a line in this file.

Refused, each with one line naming the field:

| Written | Why |
| --- | --- |
| `every: 10m`, `every: 1d`, `every: 15` | not one of the four |
| `schedule: "0 8 * * 1-5"` | a cron string — see below |
| `{ every: 1h, days: working_days, at: ["08:00"] }` | both forms at once |
| `at: "08:00"`, `at: ["8:00"]`, `at: ["24:00"]` | `at` is a list of two-digit 24-hour times |
| `days: weekdays`, `days: [monday]`, `days: []` | not a set, not the weekday tokens, or empty |
| `days: [mon, mon]`, `at: ["08:00", "08:00"]` | the same day or time twice |

**Cron strings** are accepted in a manifest's `schedule:` for one release
(`manifestScheduleSchema`, which `manifest.ts` validates every collector and
routine against), read as an interval by `scheduleToSeconds` exactly as
before — for an extension that still carries one; every product manifest
has moved to the closed shape. They are never accepted in this file.

## Routines

An entry is one of two kinds, told apart by its keys.

**A change to a routine with a manifest** — product or extension — keyed by
the manifest's name. Every field is optional; each one you set overrides that
field and leaves the rest to the layers below:

| Field | |
| --- | --- |
| `schedule` | a schedule, as above |
| `paused` | `true` or `false` |
| `config` | `snake_case` keys, each a string, a number, `true`/`false`, or a list of those. Which keys a routine takes, and of what kind, is its manifest's `config` — a key it does not declare, or a value of the wrong kind, holds the routine |

**A New Routine — an assignment**, with no product code (ruling 4). It names
an `actor`, `task` or `grants`, and then it needs:

| Field | |
| --- | --- |
| `actor` | a crew's id (`vendor-research`) — the crew that runs it. Its run is one crew run, so the actor is a crew this console loaded (`agents/<area>/<name>.md`) |
| `task` | what to do, appended to the actor's definition, never replacing it. At most 4000 characters; more than that is a new actor |
| `grants` | optional: `read:` — a list of vault prefixes the actor may read for that run only. **Read-only**: `write:` is refused by name (below) |
| `schedule` | **required** — there is no manifest to default from |
| `paused` | optional |

It has no `config`: config is declared by a manifest, and an assignment has
none, so `config` on one is refused by name.

A grant is a TitleCase vault prefix an agent may hold — `Areas/Finance`, or
`Areas/Finance/` (a trailing slash names the same prefix). `.metistry/`,
`Artifacts/`, a traversal and a lowercase root are refused. A grant never
widens what the tool refuses: `Me/` and your own journal (`Journal/` outside
`Plan/`, `Fold/`, `Standup/`) are written by you alone, grant or no grant
(`isUserOwnedPath`, `packages/core/src/instance-layout.ts`).

**Per-run grants are read-only** (the owner's ruling (a), W1; confirmed at the
W2 checkpoint). `grants: { write: […] }` does not validate — the line names
the ruling — and so the file is not applied until it goes. Where a routine
writes is not a grant: a routine's reserved subfolder (`Journal/Plan/` for
Tomorrow's Plan, `Journal/Digest/` for a Digest routine) is an **ownership**
fact about the routine, written through the reconciler under the routine's own
principal, and nothing a run is granted widens it.

### New Routines — how one runs

A New Routine is scheduled exactly like a routine with a manifest — the same
due-gate, failure streak, runs rows, pause and Run Now — from the file the
runner reads on that tick. Its run does one thing (`agentRoutineComponents`,
`apps/console/src/runner.ts`):

1. **One crew run is enqueued** for its actor (`crewRoutineQueue`,
   `apps/console/src/crews.ts`): a `work` row on the crew's queue carrying the
   crew's definition — which stays its system prompt — and the task as the
   brief, appended to it, never replacing it. One row per runner row, however
   often a tick is retried. The runner's row says `acted`.
2. **The run's grant rides on that row** (`meta.routine`: the routine, the
   runner row, `grants.read`), never on the crew's registry row.
3. **The assistant's drain runs it** with a bearer minted for that run and
   burnt after (`apps/assistant/src/crew-drain.ts`), stamping the bearer's
   hash on the row while it runs and removing it after.
4. **The console's door honours the grant only for that bearer, while the row
   runs** (`authenticateAgent`, `apps/console/src/agents.ts`): before the run,
   after it, for the crew's next run and for any other agent, the crew reads
   its own scope and nothing more. A crew never writes the vault, so the
   grant is Knowledge · Read and nothing else.

An actor that is not a crew this console loaded — a removed manifest, the
assistant, an external agent — is a failed run naming the fix, and enqueues
nothing. A console whose runner has no crew queue lists a New Routine as
held and does not run it. The actor's permission lines show each area a New
Routine grants it as held *while this routine runs*.

## Syncs

A sync is a collector reading one connection, on an interval. Its entry lives
here, never in the connection's file (§2.6):

| Field | |
| --- | --- |
| `connection` | **required** — the connection's name |
| `every` | the cadence, from the same closed four. A sync has no time of day |
| `paused` | `true` or `false` |
| `raise` | the collector's declared Needs You rules (`needs_you` in its manifest), each `true` or `false` (`review_requested: true`). A rule it does not declare holds the sync |

## What a manifest declares

A routine or collector manifest is the first layer, and it says what this
file may name for it (`manifest.ts`; `scheduledUnitOf` in `scheduled.ts`
reads it):

| Field | |
| --- | --- |
| `display_name` | what a person reads — *Morning Brief*, not `morning-brief`. The `name` stays the stable handle, and the key in this file (C55) |
| `schedule` | the default, in the closed shape |
| `config` | a routine's config fields, each `{kind, label, default, description?, options?}`. `kind` is one of a closed five — `text`, `path` (a TitleCase vault path, never `.metistry/`), `number`, `boolean`, `choice` (with `options`) — and the default must be a value of its kind. None declared: it takes no config |
| `needs_you` | a collector's Needs You rules, each `{label, default, description?}` — the toggles `syncs.<name>.raise` switches |
| `presents_as` | a collector's section: `sync` (the default) or `routine` — housekeeping with no connection. Inbox Sort (`inbox-drain`) and Usage Rollup (`claude-usage`) present as routines, so their changes live under `routines.<name>` |

Each entry is checked against its component (`entryProblems`), and every
problem names its field. One that **holds** the component — it is not run,
one `schedule_held` row a day says why, one alert names it:

| In the file | Why it holds |
| --- | --- |
| `routines.github-state: …` | `github-state` is a sync — its changes live under `syncs.github-state` |
| `syncs.inbox-drain: …` | `inbox-drain` presents as a routine |
| the same name under `routines:` and `syncs:` | one entry per component |
| a New Routine named like a routine or sync with a manifest | give it a name of its own |
| `routines.standup.config.voice` | a key `standup` does not declare, or a value not of its kind |
| `syncs.github-state.raise.merged` | a rule `github-state` does not declare |

An entry naming nothing installed — an extension since removed — holds
nothing (there is nothing to hold) and is reported as applying to nothing;
nothing deletes it (§2.7).

## Where a field came from

Every resolved field carries its origin, and the app shows the label beside
it (`FIELD_ORIGINS`, `FIELD_ORIGIN_LABELS` in `scheduled.ts`):

| Origin | Label | From |
| --- | --- | --- |
| `default` | *default* | the manifest |
| `profile` | *from your profile* | `Me/profile.md` — the days behind `working_days`, the zone behind an absent `tz` |
| `yours` | *yours* | this file |

A resolved field is a `Sourced<T>` — `{ value, origin }`. `resolveScheduled`
(`scheduled.ts`) resolves every routine and sync — pure, over the manifests,
a **valid** file and the profile's facts — into what the Scheduled pane
shows:

| Field | |
| --- | --- |
| `displayName`, `section` | from the manifest |
| `isDefault` | no entry in this file — the **default** tag; Reset to Default returns here |
| `schedule`, `describe` | the schedule in force and its origin; `working days at 07:00` |
| `days` | a time of day's weekdays — `profile` when a day set follows `Me/profile.md`; `null` when it has no working days to follow |
| `timeZone` | the schedule's `tz`, then the profile's `timezone` (`profile`), then `METISTRY_TZ` (`default`) |
| `paused`, `config`, `raise` | every declared field, the owner's value or the manifest's default |
| `connection` | a sync's, as its entry names it |
| `held` | why the runner holds it — its entries do not fit its manifest; a held component shows its manifest's values |
| `next` | when it runs next (`nextOccurrence`); an interval counts from its last run, and a never-run one is due now; `null` while paused or held |

An invalid file is never resolved — it is shown as its errors. The
profile's facts come in through `profileFacts` (below).

## `Me/profile.md`, and the standup move

`Me/profile.md` keeps facts about you — `timezone`, `working_days`,
`working_hours`, `daily_capacity_min`, `task_size_minutes`, `today_cap` — and
Metistry only reads it. The readers are `profileFacts`, `profileFrontmatter`
and `profileWeekdays` in `scheduled.ts`: the scheduler and Tomorrow's Plan's
working-day guard read the file through the same ones. A schedule on
`working_days` follows the profile until you set days on the routine
(`resolveScheduleDays`, origin *from your profile*); with no working days in
the profile the routine is absent — `no_working_days` — and nothing guesses.

**`standup_days` and `standup_time` moved to the Standup routine** (§4 Q13).
When the console starts it reads them **once** into
`routines.standup.schedule` here — days that are your working days become
`working_days`, so the standup keeps following the profile; a missing time is
08:00 — and then raises **one** request in Needs You, *Tidy Me/profile.md*,
showing the file before and after the two lines go:

- **Approve** writes that "after", as you — and is refused, writing nothing,
  if the file changed since you were shown it.
- **Decline** leaves the lines. Nothing reads them, and `metistry doctor`
  names them in one info line under `instance`.
- It is raised once, ever: not again after either answer. Delete the lines
  yourself and a waiting request clears on its own.

What the move will not do: rewrite an entry you already gave the Standup
routine a schedule in (yours wins; the tidy is still offered), rewrite a file
that does not validate (it waits for you to fix it), or move a line it
cannot read (`standup_time: after coffee` — doctor says why). The code is
`planStandupMove` (core, pure) and `apps/console/src/profile-tidy.ts`.

## The next occurrence

`schedule.ts` froze the signature (F-4); `nextOccurrence` is its body (T3-1),
hand-rolled over `Intl`:

```ts
type NextOccurrence = (schedule: Schedule, after: Date, ctx: OccurrenceContext) => Occurrence;

interface OccurrenceContext {
  profile: { timezone?: string; working_days?: Weekday[] };  // Me/profile.md, read only
  fallbackTimeZone: string | null;                           // METISTRY_TZ (configuredTimeZone); null = none
}

type Occurrence =
  | { ok: true; at: Date; timeZone: string | null }          // null for an {every}
  | { ok: false; reason: "no_working_days" | "no_timezone" | "unknown_timezone"; why: string };
```

- **Pure**: no clock, no IO, no environment — so every DST case is a plain
  call in a test.
- **`{every}`** is `after` plus the interval, where `after` is the last run.
- **`{days, at, tz?}`** is the earliest instant strictly after `after` whose
  wall-clock time in the zone is one of `at`, on one of the resolved days.
- **The zone** is the first of `tz`, the profile's `timezone`, and
  `fallbackTimeZone` that is present. An unknown one is refused
  (`unknown_timezone`), never skipped for the next in line; none is
  `no_timezone`.
- **Daylight saving** follows Temporal's `compatible` rule: a time the clocks
  skip runs shifted forward by the gap (02:30 on a night that jumps from 02:00
  to 03:00 runs at 03:30); a time that happens twice runs at the first. Each
  day's `at` runs at most once. Tested on both New York nights of 2026,
  London's, Sydney's, and Lord Howe's half-hour jump
  (`packages/core/test/next-occurrence.test.ts`).
- **An empty `timezone`** is the profile not saying, not a zone; a present
  but unknown one (`Mars/Olympus_Mons`, `+05:00`) is refused.

## How the runner fires

The console's runner ticks once a minute (`METISTRY_RUNNER_TICK_MS`). On every
tick, for every collector and routine:

1. **This file**, read afresh. `paused: true` → not run, and no row a tick —
   the choice is yours and the file says it. An entry the runner cannot apply
   **holds** the component rather than being ignored: a New Routine named like
   a product routine, a `syncs:` entry naming a routine, or one component
   under both `routines:` and `syncs:`. A held component is not run; one
   `runs` row a day says why (`kind: runner`, `tool: schedule_held`) and one
   alert names it.
2. **An invalid file is never applied** — and never replaced by the defaults
   either, because a routine you paused would run again. Every component the
   broken file names is held; when it is too broken to say which (a YAML
   error, or a top-level key that is not `routines` or `syncs`, which might be
   a typo of one), **every** component is. One alert per distinct error, once
   a day while it lasts; the next tick after you fix the file picks it up.
3. **The schedule**: the entry's, else the manifest's — `routines.<name>`
   for a routine or a collector that presents as one, `syncs.<name>.every`
   for a sync. An entry that does not fit its manifest holds the component
   ("What a manifest declares", above).
4. **Is it due?**
   - **An interval** (`{every}`, or a manifest's cron string): once that long
     has passed since the last run. A component that has never run is due at
     once.
   - **A time of day**: once one of its slots has passed since the last run —
     **once, at its time** (within the minute's tick). The slot rides on the
     run's row (`meta.scheduled_for`, `meta.time_zone`) and in the routine's
     context (`ctx.scheduledFor`, `ctx.timeZone`), so a late run still dates
     and plans from its slot. The last run is the later of the row's `ts`
     and its `scheduled_for`, so a Postgres clock that drifted behind this
     process's (a Docker VM after sleep) cannot fire one slot twice.
   - **Missed while the Mac slept**: the slots are coalesced into **one**
     run on waking, for the **latest** of them — launchd's own rule for
     `StartCalendarInterval`. Tomorrow's Plan, asleep from Friday to Monday
     07:30, runs once at 07:30 for Sunday 23:00 and plans Monday.
   - **Never run**: its slots count from when the runner started, so a fresh
     install at 10:00 does not fire the 07:00 brief at 10:01; the next
     working day's 07:00 is its first.
5. **`Me/profile.md`** is read at most once a tick, through the vault
   bridge, and only when a time of day follows it — a day set, or no `tz`.
   A read that fails (the bridge is down) is not "the profile says nothing":
   those components **wait**, and run late, once, when it can be read.
6. **A schedule the runner cannot place** — `no_working_days`,
   `no_timezone`, `unknown_timezone` — is not run and says so once a day, on
   the component's own row (`ok`, `meta.schedule_refused`, and for a routine
   `meta.outcome = skipped:<reason>` — D7's vocabulary, so Activity shows the
   absent skip). No alert: it is a fact about the profile, not a fault.
   `metistry doctor` reports it `absent`, in the runner's own words.
7. Then the failure streak, preflight and the run itself, exactly as
   `docs/ops/automation.md` describes — one marker row per slot, not per tick.

A **timezone change** takes effect on the next tick: the next slot is the new
zone's wall clock, counted from the last run, so none fires twice (moving
west, the day's remaining slot in the new zone is still ahead, and runs).

**Where the runner looks.** This file is
`$METISTRY_INSTANCE_DIR/.metistry/scheduled.yaml`, or
`METISTRY_SCHEDULED_FILE` when set; with neither, there is no overlay and
every component runs on its manifest's defaults. The console logs, at start,
each component's schedule, the overlay path, whether the profile is readable,
and the fallback zone — or that there is none, and what that refuses.

## Defaults

§2.5's defaults, as answered (§4 Q12; the owner's times of 2026-09-26), in
each routine's manifest:

| Routine | Default |
| --- | --- |
| Morning Brief (`morning-brief`) | working days at 07:00 — writes `Journal/Brief/<date>.md` from `Templates/Brief.md` and the daily note's section; embeds the standup, which lands at 08:00 (T3-6) |
| Standup (`standup`) | working days at 08:00 — writes `Journal/Standup/<date>.md` from `Templates/Standup.md` (T3-5) |
| Knowledge Fold (`knowledge-fold`) | every day at 21:00 |
| Tomorrow's Plan (`plan-tomorrow`) | `eve_of_working_days` at 23:00 — after the fold |
| Reply Review (`reply-review`) | every day at 23:00 |
| Weekly Review (`weekly-review`) | Sunday at 18:00 |
| Session Purge (`session-purge`) | every day at 04:00 — the session archive's retention (`retention_days`, 1–30, default 30; T3-9) |
| Session Fold (`session-fold`) | every hour — the chat turns not yet folded, quiet for an hour, become ONE assistant turn; its checked answer becomes at most one request per file for `Me/Working Style.md` or `Me/profile.md`, written only on Approve (C79, T3-10); Pause it to stop learning; not one of §2.5's defaults |
| Update Check (`update-check`) | every day at 06:00 — §2.20's check for a newer release (T2-18); not one of §2.5's defaults |
| Recording Retention (`recording-retention`) | every hour — a live-capture recording kept to the owner's rulings: audio until the transcript is ingested + 7 days, never over 30; the transcript 30 days (T8-4, §2.15); not one of §2.5's defaults |
| Inbox Sort (`inbox-drain`) | every 5 min — a collector that presents as a routine |
| Usage Rollup (`claude-usage`) | hourly — likewise |

The syncs: GitHub (`github-state`) every 15 min, raising *A pull request
asks for your review* — one `pull_request` request per open PR waiting on
your review, for its current head, cleared when your review lands, the PR is
drafted or it closes (T2-13; `docs/ops/client-api.md`, *Pull requests*) — and
*An issue is assigned to you* — one `task` request per open issue assigned to
you, cleared when it closes or is given to someone else (both on; T4-23). The
runner hands a sync its switches, your `raise` over the manifest's defaults,
on every pass; Calendar (`eventkit-calendar`,
T2-11) every 5 min — the owner's calendars on this Mac, today and the next two
weeks, through the eventkit bridge into `calendar_events` (connection
`eventkit`), the one table every calendar source syncs into and Today reads;
it degrades absent without `METISTRY_EK_URL` and the bridge token, and a
helper built before T2-11 is a failed run naming the rebuild; Calendar Feed
(`ics-calendar`, T4-12) every 15 min — an ICS connection's feed into the same
table under the connection's name, absent until one is added; Devin Sessions
every 5 min; Devin Knowledge hourly; AWS Costs every 6 hours. No shipped
manifest carries a cron string any more.

GitHub, Devin Sessions and Devin Knowledge read their **connection**
(T4-11): `github-state` the `github` tracker connection, both Devin syncs
the one `devin` agent connection (its type names `devin-sessions` in
`sync:` and `devin-knowledge` in `also_read_by:`). Each finds it as every
sync does — `syncs.<name>.connection`, or the one `ok` connection its
provider declares — and its key is filled at the connection's door
(`docs/ops/connections.md`, *A sync reading its connection*). With no
connection, each reads its legacy environment for one release.

**Standup** is §2.5's eighth default, working days at 08:00. It renders
its template into `Journal/Standup/<date>.md` — its own reserved subfolder,
written through the reconciler as principal `standup`, so the file says
`source: standup` — and never over a file it does not own. The routine calls
no model; a `prose` line in its template (legal since C103) is filled by one
assistant turn, as the Morning Brief's are (`docs/ops/automation.md`). Its row
landing is the `routine.status` that swaps Today's
*Standup at 8:00 AM* for the file. With no working days in `Me/profile.md`
nothing is written — the runner does not start it, and a Run Now asks the
same question and records `skipped:no_working_days`.

Three shipped routines declare `config`. Session Purge: `retention_days` (a
number, default 30; the run refuses anything outside 1–30). Morning Brief:
`template` (a path, default `Templates/Brief.md`). Standup:
`template` (a path, default `Templates/Standup.md`) and
`skip_without_calendar_event` (a boolean, default off — when on, a day whose
calendar has no event titled like *standup* gets no file,
`skipped:no_standup_event`; a calendar that cannot be asked is not a reason to
skip). Every other key in a routine's `config:` is held. The runner hands
each run its resolved config (`ctx.config`) — your value over the manifest's
default, key by key.

**Recording Retention** keeps a live-capture recording to the owner's
rulings (plan §2.15, Q7, C91). One `capture_sessions` row per recording
(migration 0033) says where each part is; `GET /api/recordings/:id` reads it.
Each hourly pass:

1. **Rebuilds** a row for any transcript under `Journal/Transcripts/` the
   table does not have, from the file's own frontmatter — the table is
   derived, so a `down -v` never leaves a transcript no purge will find. A
   file whose name does not match the recording its frontmatter declares is
   left alone.
2. **Records ingestion** — `folded_at` — when every proposal raised from the
   transcript's inbox row is decided (allowed, allowed with changes, or
   denied; never pending, never merely expired). A value the fold wrote first
   stands.
3. **Tells the Mac.** For each recording whose audio is not yet known gone,
   `POST /recording/retention {session_id, ingested_at}` on the live-capture
   bridge (`METISTRY_LIVE_CAPTURE_URL`, the bridge token), and stores what
   the recorder answers: the bytes it keeps, and when and why it deleted
   them. **The Mac decides**: its recorder applies the same rule every hour
   on its own clock, so the 30-day ceiling holds with no console at all, and
   an ingestion report is clamped to the delivery and to now — it can bring
   a deletion forward, never past the ceiling and never earlier than 7 days
   after the console took the transcript. No bridge configured: this step is
   skipped and the run says so.
4. **Deletes a transcript on its 30th day** as a commit through the
   reconciler in the owner's name (`user`) — `Journal/` is the owner's at the
   tool, and git is the record, so it is never a raw unlink — with the
   run's act key, so one pass is one commit. Its words are cleared from the
   capture's `inbox.note` and its proposal's `payload.note` in the same pass.
   Git history still holds the file: a transcript that must be gone from
   history too is the owner's to rewrite.

It returns what it deleted (0 is silent) and warns for each recording it
could not finish, trying again next hour. Model-free.

A routine on `working_days` or `eve_of_working_days` runs only once
`Me/profile.md` says which days you work — the seeded profile says nothing,
on purpose, so on a fresh install they record `skipped:no_working_days` until
you fill it in.

## Validation

- **One line per problem, each naming its field** —
  `routines.standup.schedule.every: every must be one of 5m, 15m, 1h, 6h — "10m" is not (the set is closed)`.
  Every problem in the file is reported at once.
- **An invalid file is never applied** — not half of it, and not as if it
  were empty. Falling back to the defaults is not safe here: a routine you
  paused would run again. `parseScheduled` returns `value: null`, so no
  caller can apply it by accident.
- **Nothing is rewritten.** No defaults are filled in and no value is
  normalised: what parses is exactly what was written, so a door writes back
  the object it validated.
- **An absent or empty file** is no changes — every routine and sync on its
  manifest's defaults.
