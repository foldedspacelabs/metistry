# Scheduled work: what happens when it fails

Collectors and routines are run by the console's runner (`apps/console/src/runner.ts`),
once per manifest interval, each under a two-phase `runs` row. This document
is the other half of that: what the runner does when a component keeps
failing, and how you find out.

Before: a collector whose token expired failed every hour forever, spent an
API call each time, contributed one number to a tile, and nothing ever said
*"this has failed 168 times — fix it or retire it"*. Four behaviours close
that, all derived from the `runs` table, no new schema
(`docs/research/2026-09-12-hermes-agent-review-2.md` §2, §7.1–3, §7.6).

## 1. Failure streak — it stops trying

A component's **streak** is its run of consecutive `ok = false` rows since its
last `ok = true` one. At `METISTRY_RUNNER_MAX_STREAK` (default **5**) the
runner stops running it: no call, no spend, no new failure row. One
`runs` row per skipped window records the fact — `kind: runner`,
`tool: skipped_streak`, `ok: false`, `meta: {streak, max_streak, error_signature, since}` —
and **one per window, not one per tick**: the runner ticks every 60 s, so a
`*/15 * * * *` collector records four skips an hour at most one apiece.

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

**One shipped manifest declares the structured form**, and it is the shape the
rule admits: `routines/plan-tomorrow` names
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
gh     schedule  degraded   1  3 failed run(s) in a row since 2026-09-15T09:00:00Z: 401 Bad credentials — at METISTRY_RUNNER_MAX_STREAK (5) the runner stops running it
fold   schedule  ok         0
```

| status | when |
| --- | --- |
| `ok` | ran inside 2× its interval, last run succeeded, no open streak |
| `degraded` | an open failure streak below the limit |
| `failed` | the runner has stopped running it (`skipped_streak`), or a `preflight_failed` window is current, or it has not run in more than 2× its interval |
| `absent` | no run recorded yet (a fresh install is not broken), or no db configured |

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

`last_run_at` is `null` and `streak` is `0` for a component that has never
run. A `skipped_streak` / `preflight_failed` marker counts as the *current*
state only while it is inside 2× the component's interval; an older one is
history.

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
| `METISTRY_RUNNER_MAX_STREAK` | `5` | consecutive failures before a component stops being run |
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

The second routine that is hourly on paper and once-a-night in practice
(`knowledge-fold` was the first, and `docs/ops/knowledge-fold.md` explains why:
the runner has no notion of time of day, so an `@daily` routine that skips at
09:00 is due again at 09:00 tomorrow and never reaches the evening). It renders
`Templates/Plan.md` — a markdown file in the vault, which you edit in Obsidian
— into `Journal/Plan/<tomorrow>.md`, written through the reconciler's bridge as
`principal: plan-tomorrow` (`docs/product/daily-flow-spec.md` §5.1, §7).

**No model is in it, at any tier.** The ordering is the template's
(`order: "priority, due, size"` — a field list), your prioritisation *rule* is
prose the plan includes verbatim for you to read, and `{{ prose }}` is refused
outright in a template whose output the assistant may not write. The manifest
declares no `engine`, so the runner never asks whether one is configured.

### The gate, in order

| check | what it means | costs |
| --- | --- | --- |
| before **12:00** local | nothing is planned over breakfast — the day it plans *from* is not over | nothing: no query, no vault read |
| this target date is **settled** | one pass already decided tonight, whichever way | one indexed `runs` read |
| before your **day end** | `working_hours:` in `Me/profile.md` (`"09:00-17:30"` → 17:30); absent, **19:00** local, and the plan says so | one small vault read |
| tomorrow is **not a working day** | `working_days:` in `Me/profile.md`; absent, **nothing is written at all** and the run says `no_working_days` rather than guessing Monday-to-Friday | recorded, and the evening goes quiet |

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

One `runs` row per target date, written the first time a pass settles it —
which is what keeps an hourly routine from filing twenty rows a night.
`meta.planned_for` is the discriminator (the runner's own per-tick
`routine_run` row carries none), and `meta.outcome` is one of `wrote`,
`no_working_days`, `not_a_working_day`, `template_missing`,
`template_unreadable`, `user_owned` or `would_materialise`:

```sql
SELECT ts, meta->>'planned_for' AS for_day, meta->>'outcome' AS outcome, meta
FROM runs WHERE component = 'plan-tomorrow' AND kind = 'routine_run' AND ok
  AND meta ? 'planned_for'
ORDER BY ts DESC LIMIT 7;
```

`too_early` is deliberately **not** a row: it is the schedule working.

### What an install needs before the first plan renders

| file | what it decides | without it |
| --- | --- | --- |
| `Templates/Plan.md` | everything the plan says (`metistry init` stamps it; you edit it in Obsidian) | `template_missing`, silently — a missing template is a configuration fact |
| `Me/profile.md` → `working_days` | which eves plan at all | `no_working_days`, recorded: nothing is written and nothing is guessed |
| `Me/profile.md` → `working_hours` | when the evening starts | 19:00 local, with one visible line in the plan saying a default nobody chose was used |
| `Me/Working Style.md` → `## Prioritisation` | the prose the plan includes verbatim | one `> ⚠️ metistry: …` line where the include is |
| `METISTRY_EK_URL` + `METISTRY_BRIDGE_TOKEN_EVENTKIT` | tomorrow's events | one line saying the calendar bridge is not reachable |

`METISTRY_RECONCILER_URL` and `METISTRY_BRIDGE_TOKEN_RECONCILER` are the only
hard requirements, and they are in the manifest's `requires.env` — without
them the window is refused with the variables named rather than spent. The
eventkit bridge is deliberately **not** declared `reachable:`: blocking on it
would mean no plan at all on an evening the calendar was down.

Turning it off is the same as the fold's: remove `plan-tomorrow` from
`routines/index.ts` (a product change, a PR) — or, without a rebuild, take
`working_days:` out of `Me/profile.md`, which is your own hand and takes effect
at the next tick: the routine then records `no_working_days` and writes
nothing.

## What this is not

- **Not a budget.** Nothing here counts dollars; `compute.yaml` budgets are
  the compute work (plan refresh 2026-09-13, PR 3) and will fail an
  unattended run with a named error of their own. Preflight refuses on
  *configuration*, before any of that.
- **Not a pause switch.** There is no "pause this collector" verb: a
  component is scheduled because its manifest has a `schedule`, and retiring
  one means removing that line (invariant 5 — the manifest is the contract).
- **Not the watchdog.** The watchdog's `silent-collector` probe still
  independently reports a component with no `runs` row inside 3× its
  interval — it runs on the host and must be able to say the console itself
  is dead. The runner's rows and the watchdog's probe read the same table
  and the same manifests, so they cannot disagree about an interval.
