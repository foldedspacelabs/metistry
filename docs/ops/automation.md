# Scheduled work: what happens when it fails

Collectors and routines are run by the console's runner (`apps/console/src/runner.ts`),
each under a two-phase `runs` row: an interval schedule once per interval, a
time-of-day schedule once per slot, at its time (`docs/ops/scheduled.md`,
"How the runner fires"). This document is the other half of that: what the
runner does when a component keeps failing, and how you find out.

Before: a collector whose token expired failed every hour forever, spent an
API call each time, contributed one number to a tile, and nothing ever said
*"this has failed 168 times — fix it or retire it"*. Four behaviours close
that, all derived from the `runs` table, no new schema
(`docs/research/2026-09-12-hermes-agent-review-2.md` §2, §7.1–3, §7.6).

## 1. Failure streak — it stops trying

A component's **streak** is its run of consecutive `ok = false` rows since its
last `ok = true` one. At `METISTRY_RUNNER_MAX_STREAK` (default **3** — three
strikes, C135) the runner stops running it: no call, no spend, no new failure row. One
`runs` row per skipped window records the fact — `kind: runner`,
`tool: skipped_streak`, `ok: false`, `meta: {streak, max_streak, error_signature, since}` —
and **one per window, not one per tick**: the runner ticks every 60 s, so a
`*/15 * * * *` collector records four skips an hour at most one apiece. For a
time-of-day schedule the window is the slot: one row per slot it missed.

One successful run clears it. There is no ack, no pause file and no state to
reset by hand: the streak is a query, so fixing the cause is the whole
remedy. Raising `METISTRY_RUNNER_MAX_STREAK` resumes it immediately.

## 2. One alert per error signature

A **signature** is `sha256(component + normalised error)`, first 12 hex.
Normalising strips what changes between two occurrences of one fault — uuids,
absolute paths, long hex ids, every digit run — so `503 after 1841ms (request
0f8e…)` and `503 after 97ms (request 7a6b…)` are one signature, not two. It is
stored on the failing run's `meta.error_signature` and carried in the alert's
own text as `[sig:ab12cd34ef56]`.

Alerts are `outbound_messages` rows of kind `alert` — the same path the
watchdog's alerts already take, so the notifier pushes them as **Needs You**
with no new row kind and nothing new for the PWA to render. One
(component, signature) alerts **once per `METISTRY_ALERT_DEDUPE_H`** (default
**24**). It speaks again when:

- the signature changes — a different fault is different news;
- the streak cleared and came back — "you fixed it and it broke again the same
  way" is news even inside the window;
- the window elapses and it is still broken.

`[sig:…]` is the dedupe key and the handle a future `ack` would name.

The alert is a push; what the owner **answers** is a request (C96, T2-9). A
failed **routine** also raises one `report` in the Needs You queue per
signature — when it last ran cleanly, when it failed, and *Try Again* — and
it clears itself the next time the routine succeeds. A preflight miss on a
**secret** (a `requires.env` variable, or the engine's `auth.secret`) raises
one `secret_failure` request naming every component it stopped, cleared once
the variable is set. Neither is raised again after an answer until what it
was about has recovered (`docs/ops/client-api.md`, *Events become requests*).

**Three strikes** (C135, T3-12): the failure that stops a component raises
ONE request per (component, signature) per streak. A routine's waiting
failure report *becomes* the stop — its title says *stopped after 3
failures* and it gains `stopped: {failures, limit, since, at}` — rather than
a second request about the same fault; a collector, which raises nothing for
one failure, raises its stop as a `report` of its own. An answer sticks while
the streak lasts; the next clean run (after the fix, *Try Again*, or a raised
limit) clears it at its source.

**A Stop limit** (C133, T3-12): a budget whose action is `stop` pauses every
routine that would enqueue a turn (§3's preflight) and raises ONE `report`
per budget window — naming every routine it paused, and *Raise*, which opens
Settings › Compute › Spending limits. It clears itself when the budget no
longer stops them (the window reset, the limit or action changed); a limit
raised and spent again is a new request.

## 3. Preflight before spend

A collector or routine may declare what it needs, and the runner checks it
**before** `startRun` — so a misconfigured component never spends:

```yaml
requires:
  env: [METISTRY_X_TOKEN]      # must be set and non-empty
  reachable: [METISTRY_X_URL]  # GET <url>/check must answer (<500; 401 counts as up)
  engine: true                 # this run would enqueue an assistant turn
```

On a miss the window records one `runs` row — `kind: runner`,
`tool: preflight_failed`, `meta: {missing: [NAMES]}` — again one per window,
and no run is started at all. The message names every variable and the file:

> `blocked_config: devin-knowledge did not run — METISTRY_DEVIN_API_KEY is
> unset. Set METISTRY_DEVIN_API_KEY in this install's .env (`metistry secrets
> sync --to env`), or drop METISTRY_DEVIN_API_KEY from `requires` in
> collectors/devin-knowledge/manifest.yaml if it is no longer needed. No run
> was started, so nothing was spent.`

**Declare `requires` only for a component that cannot degrade.** The shipped
collectors all degrade absent — `aws-costs` with no AWS key returns 0 and
records an `ok` run, which is a supported install, not a fault. Declaring
`requires.env` on one of those would turn a supported install into a Needs
You item every day. The older `requires: [aws-credentials]` label list stays
valid and is documentation only, checked by nothing.

**Two shipped manifests declare the structured form**, and they are the shape
the rule admits: `routines/plan-tomorrow` (and `routines/standup`, for the same
reason) names
`METISTRY_RECONCILER_URL` and `METISTRY_BRIDGE_TOKEN_RECONCILER` under
`requires.env`, because without the vault bridge there is no template to read
and nowhere to write the plan — there is nothing left to degrade *to*. What it
deliberately does not declare is `reachable: [METISTRY_EK_URL]`: the calendar
genuinely degrades, and blocking the window on it would mean no plan at all on
an evening the bridge was down (below).

`engine: true` asks core's one engine seam (`packages/core/src/compute.ts`,
`engineStatus`) — the same function `metistry up`, `metistry doctor` and the
watchdog ask, so an install with no engine has one answer everywhere. It reads
the resolved `compute.yaml` the console already watches plus the environment:
an `assignments.default`, and the key its provider names. **Known gap:**
neither deployment shape currently puts the *provider key* in the console's
environment (compose passes an explicit list; launchd passes `METISTRY_*`
only), so the second half of that check is answered "unset" there even when the
engine has it. Widening the console's credential surface is a decision, not an
oversight; until it is ruled on, a routine that declares `engine: true` would
block on an install whose provider needs a key.
`knowledge-fold` therefore does not declare it: an engine-less install
deliberately queues the fold turn and lets it wait
(`docs/ops/assistant-tools.md`, "Running without an engine").

## 4. `metistry doctor` — the `schedules` section

One row per schedulable manifest, from `runs` plus the manifests — doctor
imports no collector and knows what none of them do (invariant 5):

```
name   kind      status    ms  remediation
gh     schedule  degraded   1  2 failed run(s) in a row since 2026-09-15T09:00:00Z: 401 Bad credentials — at METISTRY_RUNNER_MAX_STREAK (3) the runner stops running it
fold   schedule  ok         0
```

| status | when |
| --- | --- |
| `ok` | ran inside 2× its interval, last run succeeded, no open streak |
| `degraded` | an open failure streak below the limit |
| `failed` | the runner has stopped running it (`skipped_streak`), or a `preflight_failed` window is current, or it has not run in more than 2× its interval |
| `absent` | no run recorded yet (a fresh install is not broken), no db configured, or the runner could not place its schedule — `no_working_days`, `no_timezone`, `unknown_timezone` — and said why on its own row. A `no_working_days` skip is rechecked against `Me/profile.md` as it is now: once the profile has `working_days`, the row is `ok` and says it *was skipped … until the next run at <time>* |

**A time-of-day schedule** (`{days, at}`, §2.5) has no interval: doctor
bounds it by the widest gap between two slots of its week (`every day at
21:00` → 25 h, the extra hour for the night the clocks go back), and a day set
that follows `Me/profile.md` by the week itself, since doctor does not read
the profile. `next_due_at` is `null` for one — when it is next due depends on
the profile, which the console's runner reads.

`failed` is the actionable set, and `metistry doctor` already exits non-zero
when any row is `failed`.

`--json` gives each row core's `CheckResult` shape plus `kind: "schedule"` and
this `meta`:

```json
{
  "dir": "collectors/gh",
  "schedule": "@hourly",
  "interval_sec": 3600,
  "run_kind": "collector_run",
  "last_run_at": "2026-09-15T11:50:00.000Z",
  "last_ok": false,
  "streak": 3,
  "error_signature": "ab12cd34ef56",
  "next_due_at": "2026-09-15T12:50:00.000Z",
  "overdue_sec": 0,
  "skipped_streak": false,
  "preflight_failed": false
}
```

`schedule` is said the way a person would (`working days at 07:00`, or a
legacy cron string as written), and `schedule_refused` names the reason when
the runner could not place it. `last_run_at` is `null` and `streak` is `0`
for a component that has never run. A `skipped_streak` / `preflight_failed`
marker counts as the *current* state only while it is inside 2× the
component's interval **and** nothing has run since; an older one, or one a
later run has answered, is history.

## Where the rows show up

`skipped_streak` and `preflight_failed` rows carry `kind: runner`, which is
deliberately *not* `collector_run` or `routine_run`: they are the runner's
bookkeeping, not the component's work, so they are invisible to the due-gate,
to the streak, to `runs_summary`'s `runs_ok` / `runs_failed` counts and to the
activity feed. They do count in `runs_summary`'s all-kinds `failures` number,
which is right — a window the system could not do work in is a failure of the
system, and the `schedules` section is where you go to read why.

## Knobs

| variable | default | what it does |
| --- | --- | --- |
| `METISTRY_RUNNER_MAX_STREAK` | `3` | consecutive failures before a component stops being run (and raises one request) |
| `METISTRY_ALERT_DEDUPE_H` | `24` | hours one (component, error signature) stays quiet |

Both are read by the console. Every refusal, skip and doctor remediation in
this document names the variable or manifest field that would change it.

## What a collector may call

A collector runs unattended, on a clock, with nobody reading the answer until
later, so it may never call a **billable** model. One manifest line says
which model it may call, if any:

```yaml
# collectors/inbox-drain/manifest.yaml
uses_model: applefm/foundation-model
```

One pinned `<provider>/<model-id>`, the same spelling `compute.yaml` uses.
The runner hands it to the collector, so the manifest stays the single
statement of what a component may do (invariant 5). Two checks enforce it —
CI against the shipped provider templates, and `completeJson()` against the
`compute.yaml` actually in force, which **throws** rather than degrading if
the named provider is not `locality: on_machine`. Everything else about the
tier degrades absent. Details in `docs/ops/compute.md` — "Apple Foundation
Models".

## `plan-tomorrow` — the evening's one file

Scheduled `eve_of_working_days` at 23:00 (§2.5): every evening whose next day
is a working day in `Me/profile.md`, two hours after the 21:00 fold. The runner
fires it once, at its time (`docs/ops/scheduled.md`); until T3-1 it was hourly
with a clock gate inside the routine, because the runner had no time of day.
It renders `Templates/Plan.md` — a markdown file in the vault, which you edit
in Obsidian — into `Journal/Plan/<tomorrow>.md`, written through the
reconciler's bridge as `principal: plan-tomorrow`
(`docs/product/daily-flow-spec.md` §5.1, §7). A run the Mac slept through is
fired on waking and plans the day after its **slot** — Sunday 23:00 caught up
at 07:30 Monday plans Monday — in the zone the slot was read in. With
Monday–Friday working days, Sunday to Thursday evenings plan the next day;
Friday and Saturday evenings plan nothing (`skipped:not_a_working_eve`) —
nothing plans Monday on a Friday.

**After the fold.** The 23:00 run comes two hours after the 21:00 Knowledge
Fold, so the plan ends with a `## Tonight's fold` section: a link to
tonight's `Journal/Fold/<date>.md` and its `decisions:` frontmatter as a list,
read from the file's header and never summarised (still model-free). No fold
tonight → one line saying so.

**Early, then superseded.** Close the Day (T2-8) runs it with the day just
closed: the plan renders **early**, for the day after that one, usually
before there is a fold to link. The 23:00 run then **supersedes** it — the
same file, compare-and-swap on the bytes the early render left — with the
fold's context. Closing again re-renders every time; it is your act, not a
duplicate.

**No model is in it, at any tier.** The ordering is the template's
(`order: "priority, due, size"` — a field list), your prioritisation *rule* is
prose the plan includes verbatim for you to read, and `{{ prose }}` is refused
outright in a template whose output the assistant may not write. The manifest
declares no `engine`, so the runner never asks whether one is configured.

### The guard, in order

The schedule decides *when*; the routine keeps only the working-eve guard,
for a run nobody scheduled for an eve (a Run Now, Close the Day, or days you
set yourself):

| check | what it means | costs |
| --- | --- | --- |
| this target date is **settled** | only the SCHEDULED (23:00) pass asks: has an earlier non-close pass already decided that day, whichever way. A Close the Day row never settles a date (the 23:00 run supersedes it), and a close never asks. Run Now never asks either (ruling 15, X-15) — the owner asked for this one by hand, so it always re-renders, even a date the 23:00 run already settled | one indexed `runs` read, skipped entirely for `close` and `manual` |
| tonight is **not a working eve** | tomorrow is not in `working_days:` in `Me/profile.md` → `not_a_working_eve`; absent, **nothing is written at all** and the run says `no_working_days` rather than guessing Monday-to-Friday | one small vault read; recorded, and the evening goes quiet |

With no `working_days` at all, the runner refuses the schedule first
(`skipped:no_working_days` on its own row) and does not run the routine.

### What it writes, and what it will not

One file: `Journal/Plan/<date>.md`, `source: plan-tomorrow` in its own
frontmatter, ending in the provenance footer that names the template, its
sha256 and the engine version. Re-running the same evening replaces that same
file under compare-and-swap; nothing is ever appended.

- **A plan file that is not this routine's is never overwritten** — including
  one with no `source:` at all, which is yours (§5.1). The run records
  `user_owned` and writes nothing.
- **A recurring rule is listed, never materialised.** `- Water the plants —
  every week, due 2026-09-22` has no checkbox and no `^mt-` anchor: no routine
  writes a task line into a note you own (D4). The engine enforces it from the
  render's `source`; the routine refuses to write a file containing one anyway.
- **Absent is not failed** (§6.4). No calendar bridge, no query store, a
  `where:` the filter vocabulary refuses — each renders one `> ⚠️ metistry: …`
  line naming the template and the line number, and the plan still lands. A day
  with no plan because the calendar was down is the worst possible outcome.

### Reading the ledger

One `runs` row per pass that decides a target date: Close the Day's early
renders, then the scheduled one that settles it, and any Run Now on top —
Run Now (ruling 15, X-15) always writes its own row and never stays silent
for a date some earlier pass already settled. `meta.planned_for` is the
discriminator (the runner's own per-run `routine_run` row carries none; it
carries `meta.scheduled_for`, the slot). `meta.trigger` says who asked —
`close`, `schedule` or `manual` — and only the scheduled pass ASKS whether a
non-close row has already settled the date; a close or a manual (Run Now)
pass never asks, and always renders. `meta.outcome` (T1-4: every routine and the
runner share this vocabulary — `acted | silent | skipped:<reason>`) is
`acted` when the plan was written, or `skipped:<reason>` with `<reason>` one
of `no_working_days`, `not_a_working_eve`, `template_missing`,
`template_unreadable`, `user_owned` or `would_materialise`. A written plan
also records `fold` (the path), `fold_linked` and `fold_decisions`:

```sql
SELECT ts, meta->>'planned_for' AS for_day, meta->>'trigger' AS trigger, meta->>'outcome' AS outcome, meta
FROM runs WHERE component = 'plan-tomorrow' AND kind = 'routine_run' AND ok
  AND meta ? 'planned_for'
ORDER BY ts DESC LIMIT 7;
```

There is no `too_early` any more: the runner does not run it early.

### What an install needs before the first plan renders

| file | what it decides | without it |
| --- | --- | --- |
| `Templates/Plan.md` | everything the plan says (`metistry init` stamps it; you edit it in Obsidian) | `template_missing`, silently — a missing template is a configuration fact |
| `Me/profile.md` → `working_days` | which eves plan at all | `no_working_days`, recorded: nothing is written and nothing is guessed |
| `Me/profile.md` → `timezone` (or `METISTRY_TZ`) | the zone 23:00 is read in, and which day is "tomorrow" | `no_timezone`, recorded: never read in UTC by default |
| `Me/Working Style.md` → `## Prioritisation` | the prose the plan includes verbatim | one `> ⚠️ metistry: …` line where the include is |
| `METISTRY_EK_URL` + `METISTRY_BRIDGE_TOKEN_EVENTKIT` | tomorrow's events | one line saying the calendar bridge is not reachable |

`METISTRY_RECONCILER_URL` and `METISTRY_BRIDGE_TOKEN_RECONCILER` are the only
hard requirements, and they are in the manifest's `requires.env` — without
them the window is refused with the variables named rather than spent. The
eventkit bridge is deliberately **not** declared `reachable:`: blocking on it
would mean no plan at all on an evening the calendar was down.

Turning it off: `paused: true` on its entry in `.metistry/scheduled.yaml`
(`docs/ops/scheduled.md`; read on the next tick), or remove its directory,
`routines/plan-tomorrow/` (a product change, a PR — the routine registry is the
directory listing, plan §2.7) — or take `working_days:` out of
`Me/profile.md`, which is your own hand and also takes effect at the next
tick: the runner then records `no_working_days` and runs nothing.

## `standup` — the morning's one file

Scheduled working days at 08:00 (§2.5), an hour after the Morning Brief, which
embeds it. It renders `Templates/Standup.md` (or the path its `template`
config names) into `Journal/Standup/<date>.md` — its own reserved subfolder —
through the reconciler's bridge as `principal: standup`, so the file says
`source: standup`. It is `plan-tomorrow`'s shape, a morning later: the routine
calls no model, one file, never over one it does not own (`user_owned`), no
minted anchor (`would_materialise`), and a late run dated from its slot. A
`prose` line in its template (legal since C103, T3-6; the seeded template has
none) is left as a pending slot, and the routine enqueues ONE assistant turn to
fill it — the Morning Brief's mechanism, below.

- **Nothing is written without working days.** The runner does not start it
  (`skipped:no_working_days` on the runner's row), and a Run Now asks the same
  question and records the same reason on its own. Which days it runs is the
  schedule's: there is no working-day guard beyond "the profile says some".
- **A skip does not settle the morning.** Only a write does
  (`meta.standup_for` + `outcome: acted`), so a Run Now after the owner fills
  in the profile writes the file; a second run for a written morning writes
  nothing.
- **`skip_without_calendar_event`** (off by default): on, a day whose calendar
  has no event titled like *standup* is `skipped:no_standup_event`; a calendar
  that cannot be asked writes the file anyway (`meta.on_calendar: unknown`).
- **Today's swap.** The routine's own `routine_run` row is written after the
  vault write returns, and the event stream turns it into
  `routine.status {name: "standup"}` — the refresh arrives after the file.

```sql
SELECT ts, meta->>'standup_for' AS for_day, meta->>'outcome' AS outcome, meta
FROM runs WHERE component = 'standup' AND kind = 'routine_run' AND ok
  AND meta ? 'standup_for'
ORDER BY ts DESC LIMIT 7;
```

## `morning-brief` — the morning's one surface

Scheduled working days at 07:00 (§2.5), an hour **before** the standup. One
run does three things, then sends the chat message it always sent:

1. **Its own file**, `Journal/Brief/<date>.md`: `Templates/Brief.md` (or the
   path its `template` config names) rendered through the reconciler as
   `principal: morning-brief`, so the file says `source: morning-brief`.
   `Journal/Brief/` is its reserved subfolder (owner ruling (a), W1). The
   seeded template embeds the standup **by reference** —
   `![[Journal/Standup/<date>]]` — so at 7:00 the embed is empty and it fills
   the moment the standup lands at 8:00; nothing is regenerated. Under its
   `## Next Up` heading (appended at the end when the template has none) the
   routine lists today's **timed** meetings in start order, at most 12, each
   followed by one pending prose slot. Calendar text is someone else's: every
   title, place and name is made one bounded line with no comment delimiters
   before it is written anywhere.
2. **The daily note's section** — the bytes between `<!-- metistry:day -->` and
   `<!-- /metistry:day -->` in `Journal/<date>.md`, through `POST /vault/section`
   (`docs/ops/reconciler.md`): a stamped line, the plan embedded (or *No plan
   was written for today*), the meetings, the standup embedded. **Model-free
   by construction**: the body is built from calendar rows and paths alone
   (`daySectionBody`), and the section's writer list admits `morning-brief` and
   `user` — never `assistant`. It is the same act as the file (the runner's
   `runs.id` rides as `run` on both), so the two are **one commit**.
   - **No note yet** (the owner has not opened the day — the usual 7:00 AM):
     nothing is written and nothing is created; the run says
     `day_section: no_daily_note`, and Close the Day writes the section later.
   - **No markers yet**: the heading and the pair are appended at the end;
     the owner's bytes are an untouched prefix. `Templates/Daily.md` places
     them.
   - **Broken markers**: nothing is written into the note, and ONE `note`
     request (stored kind `knowledge`) names the file, the reason and the
     line — deduped while it is pending (C102).
   - **The owner typed in between**: one fresh read and a retry; a second
     conflict leaves the note alone (`day_section: conflict`).
3. **ONE assistant turn** for the file's prose slots — the template's
   `{{ prose }}` lines (C103) and each meeting's Next Up line — on thread
   `morning-brief`, `meta.kind: prose`, the `routine` tier, a fresh session.
   No slot, no turn: a template with no `prose` and a day with no meetings
   asks no model. The routine never calls one itself (invariant 4).

**How the slots are filled, and why the assistant can do nothing else.** The
turn tells the assistant to `knowledge_read` the file and `knowledge_write` it
back with each `<!-- metistry:prose N --> _pending…_` replaced by one line. In
a routine's own folder (`Journal/Brief/`, `Journal/Standup/`; core's
`JOURNAL_ROUTINE_DIRS`) `knowledge_write` accepts exactly that: it compares
the content with the file on disk (`fillProseSlots`) and refuses any other
changed byte, any slot text that is not one line of prose (no heading, list
item, task box, quote, fence, table, HTML comment, control character), any
file that is not the routine's, any create, and any stale hash. What it writes
is built from the checked lines, in the **routine's** name with the reply's
turn as the act — a second commit, touching the brief only. Each filled line
keeps `<!-- metistry:written N -->` at its end: the file says which words were
written, not retrieved (C103). `Journal/Plan/` takes no fill at all —
Tomorrow's Plan is model-free.

Then the chat message: the D10 soft budget over Needs You, reviews, areas and
system, opening with `📄 Journal/Brief/<date>.md` when the file was written
(C97: the message links there). It keeps its silence-default; the **file** is
written every working day, because it is Today's first state.

The routine's own row carries `brief_for`, `outcome` (`acted`, or
`skipped:<reason>` — `no_working_days`, `template_missing`,
`template_unreadable`, `user_owned`, `would_materialise`), `day_section`,
`next_up` (meetings listed, or null when the calendar could not be asked),
`prose_slots` and `inbound_id`. Only a write settles a morning.

A template it cannot use — `template_missing` or `template_unreadable` —
also raises **one** `report` request naming the file (`payload.template_issue
{path, reason}`), deduped per template while one is pending, so a vault
without `Templates/Brief.md` is asked once rather than skipped silently every
morning; `metistry update` re-seeds a seed template the vault lacks, and
`metistry doctor`'s schedule row for the routine is degraded while its last
run says `skipped:template_missing`.

```sql
SELECT ts, meta->>'brief_for' AS for_day, meta->>'outcome' AS outcome,
       meta->>'day_section' AS section, meta->>'prose_slots' AS slots
FROM runs WHERE component = 'morning-brief' AND kind = 'routine_run' AND ok
  AND meta ? 'brief_for'
ORDER BY ts DESC LIMIT 7;
```

## What this is not

- **Not a budget.** Nothing here counts dollars; `compute.yaml` budgets are
  the compute work (plan refresh 2026-09-13, PR 3) and will fail an
  unattended run with a named error of their own. Preflight refuses on
  *configuration*, before any of that.
- **Not the pause switch.** Pausing is the owner's, in
  `.metistry/scheduled.yaml` (`paused: true`; `docs/ops/scheduled.md`) — the
  Scheduled doors write it (T3-3). Retiring a component for good still means
  removing its manifest's `schedule` (invariant 5 — the manifest is the
  contract).
- **Not the watchdog.** The watchdog's `silent-collector` probe still
  independently reports a component with no `runs` row inside 3× its
  interval — for a time of day, 3× the widest gap of its week
  (`longestGapSeconds`) — because it runs on the host and must be able to say
  the console itself is dead. The runner's rows and the watchdog's probe read
  the same table and the same manifests. The probe does not read
  `scheduled.yaml`, so a component paused or held there is reported silent
  after that bound (a schedule refused for want of a profile is not: its
  once-a-day `skipped:` row is a run row).
