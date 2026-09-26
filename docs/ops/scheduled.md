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

The schema is `packages/core/src/scheduled.ts`; the schedule shape and the
next-occurrence signature are `packages/core/src/schedule.ts`.

## What is not wired yet

F-4 freezes the schema and the types. **Nothing reads the file yet**, and
until something does, what runs is the product manifests' cron strings, read
when the console starts. Each missing piece is a ticket in the plan's §3.3:

- **Loading it and merging the layers**, and the console's authority to write
  it (`CALLER_AUTHORITY.console`) — T3-2. The manifests move to the closed
  shape and carry §2.5's default schedules there too.
- **The next-occurrence function** and the runner that reads manifests ⊕ this
  file on every tick — T3-1.
- **The Scheduled doors**, the file's only writer — T3-3. Agent routines run
  through T3-8.
- **Reading `Me/profile.md`**, and moving `standup_days` / `standup_time` onto
  the Standup routine — T3-4.

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
    grants: { read: [Areas/Finance], write: [Journal/Digest/] }
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

`.metistry/scheduled.yaml` is a protected path. The console writes it, through
the Scheduled doors only, after validating what it writes against this
schema; the assistant cannot write it at all (invariant 2).

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
  (`METISTRY_TZ`, then `TZ`). A UTC offset such as `+05:00` is refused: it has
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

**Cron strings** are accepted in a *product manifest's* `schedule:` for one
release (`manifestScheduleSchema`), read as an interval by
`scheduleToSeconds` exactly as today. They are never accepted in this file.

## Routines

An entry is one of two kinds, told apart by its keys.

**A change to a routine with a manifest** — product or extension — keyed by
the manifest's name. Every field is optional; each one you set overrides that
field and leaves the rest to the layers below:

| Field | |
| --- | --- |
| `schedule` | a schedule, as above |
| `paused` | `true` or `false` |
| `config` | `snake_case` keys, each a string, a number, `true`/`false`, or a list of those. Which keys a routine takes is its manifest's `config` schema, checked when the file loads (T3-2) |

**A New Routine — an assignment**, with no product code (ruling 4). It names
an `actor`, `task` or `grants`, and then it needs:

| Field | |
| --- | --- |
| `actor` | an agent id (`vendor-research`) — the actor that runs it |
| `task` | what to do, appended to the actor's definition, never replacing it. At most 4000 characters; more than that is a new actor |
| `grants` | optional: `read:` and `write:` lists of vault prefixes, given for that run only (T3-8) |
| `schedule` | **required** — there is no manifest to default from |
| `paused` | optional |

It has no `config`: config is declared by a manifest, and an assignment has
none, so `config` on one is refused by name.

A grant is a TitleCase vault prefix an agent may hold — `Areas/Finance`, or
`Journal/Digest/` (a trailing slash names the same prefix). `.metistry/`,
`Artifacts/`, a traversal and a lowercase root are refused. A grant never
widens what the tool refuses: `Me/` and your own journal (`Journal/` outside
`Plan/`, `Fold/`, `Standup/`) are written by you alone, grant or no grant
(`isUserOwnedPath`, `packages/core/src/instance-layout.ts`).

## Syncs

A sync is a collector reading one connection, on an interval. Its entry lives
here, never in the connection's file (§2.6):

| Field | |
| --- | --- |
| `connection` | **required** — the connection's name |
| `every` | the cadence, from the same closed four. A sync has no time of day |
| `paused` | `true` or `false` |
| `raise` | the collector's declared Needs You rules, each `true` or `false` (`review_requested: true`) |

## Where a field came from

Every resolved field carries its origin, and the app shows the label beside
it (`FIELD_ORIGINS`, `FIELD_ORIGIN_LABELS` in `scheduled.ts`):

| Origin | Label | From |
| --- | --- | --- |
| `default` | *default* | the manifest |
| `profile` | *from your profile* | `Me/profile.md` — the days behind `working_days`, the zone behind an absent `tz` |
| `yours` | *yours* | this file |

A resolved field is a `Sourced<T>` — `{ value, origin }`. The resolver that
produces them is T3-2's, and T3-4's for the profile.

## The next occurrence

`schedule.ts` freezes the signature; T3-1 writes the function, hand-rolled
over `Intl`:

```ts
type NextOccurrence = (schedule: Schedule, after: Date, ctx: OccurrenceContext) => Occurrence;

interface OccurrenceContext {
  profile: { timezone?: string; working_days?: Weekday[] };  // Me/profile.md, read only
  fallbackTimeZone: string | null;                           // METISTRY_TZ, then TZ; null = none
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
  day's `at` runs at most once.

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
