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
You item every day. That is why no shipped manifest declares the structured
form yet; the older `requires: [aws-credentials]` label list stays valid and
is documentation only, checked by nothing.

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
