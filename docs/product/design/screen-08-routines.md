# Screen 8 — Routines

New, 2026-09-21. Top-level in the nav (C50). The owner's brief for it is one
sentence: *one place where I can see all of the scheduled compute Metistry is
running each day, and how.*

## 1. What a routine is

**An agent is a capability. A routine is an assignment.** That split is the whole
screen:

| | Lives on | Says |
| --- | --- | --- |
| the agent's definition | `agents/<area>/<id>.md` | **how it behaves** — read-only here, edited on Agents |
| the routine's task prompt | the routine | **what to do this occasion** — additive on top of the definition |

Reach layers the same way: the agent's base permissions, plus whatever this
routine grants for this task. An agent that is good at collating gets, on one
routine, the knowledge to summarise and a place to write it — and holds neither
the rest of the time.

## 2. Two species in one list, and the honest difference

Five routines ship today and **all five are deliberately model-free.**
`plan-tomorrow`'s own manifest says so: *"Model-free (invariant 4): the plan is
deterministic … nothing here reaches an engine."* They are code with a schedule.

What the owner is describing is different — a user-defined agent, a prompt, a
grant — and the closest shipped thing is `knowledge-fold`, which assembles a
brief and **enqueues one assistant turn**. That is this shape already, with Metis
as the agent and a hardcoded brief.

They belong in one list, because *what is Metistry running for me* does not care
whether the output was computed or generated. The difference is a fact in the
row: a routine either **names the agent that runs it**, or says **built-in ·
deterministic**. That teaches the distinction for free and gives the deep links
one rule.

## 3. The schedule a routine keeps is not when it acts

This is the screen's central honesty problem and it is easy to get wrong.

`plan-tomorrow` is `@hourly`. It acts **once an evening**, after the day end
`Me/profile.md` states, on the eve of a working day, "and is silent otherwise."
`knowledge-fold` is hourly and folds **once a night** after 18:00. The hourly
tick is a mechanism — *"the runner has no time of day"* — not a description of
what the system does.

So a row that reads `@hourly` is technically true and useless. **The row says
when it acts**, in words, and the tick is mechanism shown in detail:

> **Tomorrow's Plan** · each evening, once your day has ended

A routine that ticked twelve times and did nothing has not run twelve times, and
the list must not suggest it did. That is the same discipline as Activity giving
a too-early tick no row at all.

## 4. The roster

Grouped by how often it acts, because that is the shape of the question.

```
Routines                                                [+ New routine]

EACH DAY · 4
●  Morning Digest        collator          6:02 AM      ✓ 6m ago      6:02 AM
●  Tomorrow's Plan       built-in          each evening  ✓ 9:14 PM     tonight
◌  Reply Review          built-in          overnight     — nothing to do  tonight
!  Vendor Sweep          vendor-research   7:00 AM      ✗ failed 2d    7:00 AM

EACH WEEK · 1
◌  Weekly Review         built-in          Sunday 18:00  ✓ Sunday      Sunday

PAUSED · 1
   Inbox Triage          inbox-triage      —             —             —
```

Five columns: **what it is · who runs it · when it acts · how it went · next.**

- **who runs it** links to the agent, or reads `built-in`.
- **how it went** carries the one state that matters, and *nothing to do* is a
  first-class outcome rather than a blank. Four of the five shipped routines are
  explicitly silent when there is nothing to act on; a screen that shows that as
  an empty cell reads as a fault.
- **next** is a time, not a countdown. A countdown is motion carrying no
  information the reader cannot otherwise get (the C16 amendment).

A failed routine takes `degraded` on the row's glyph, not `failed`, unless the
transport said so — a routine that could not run because a bridge was down is
`absent`, and it names the variable rather than spending it.

## 5. A routine

### 5.1 The two prompt layers, shown as two layers

```
DEFINITION · from collator                                    [Edit on Agents →]
  You organise and collate. You prefer tables to prose, you never
  invent a figure, and you cite the file every claim came from.

TASK · this routine                                                    [editable]
  Summarise everything added to Areas/Finance since yesterday into
  one table: vendor, amount, what changed. Write it to
  Journal/Digest/<date>.md.
```

The inherited half is read-only and says where it comes from, with a link rather
than a copy — one record, said once. The task half is the editable part, and it
is the only prose on this screen the routine owns.

**Additive, and the screen says so**: the task prompt does not replace the
definition, it is appended to it. A user who believes they are replacing it will
write a task prompt that contradicts the agent's behaviour and get neither.

### 5.2 Reach for this run

The same provenance vocabulary as Agents §3.2, from the other side:

| | |
| --- | --- |
| inherited from `collator` | `folders: Areas/Ops` — unmarked, it is the base |
| **granted for this routine** | `Areas/Finance` read · `Journal/Digest/` write — marked, and removable here |

And the sentence that makes the layering safe: *outside this routine, `collator`
cannot read `Areas/Finance`.* Reach that exists only during a task has to say
that out loud, or it reads as a permanent grant.

### 5.3 When it acts, and the mechanism underneath

The schedule in words, then the tick that implements it, then the conditions that
make it silent — because those conditions are the actual behaviour:

> each evening, once your day has ended · ticks `@hourly` · silent before the
> day end `Me/profile.md` states, and on the eve of a non-working day

### 5.4 Output, and history

Where it writes — one path, machine-owned, one writer (§5.1 of the daily-flow
spec). Then the last runs: when, outcome, what it produced, what it cost. This is
where a per-routine cost belongs, and where a budget would go if one existed
(C3): recurring compute is where money leaks, and a routine is the only object in
the product that can be said to have a monthly cost.

### 5.5 A built-in routine's detail

No agent, no prompts, no editable grant. It shows its description verbatim from
the manifest, its schedule and silence conditions, what it writes, and its
history — and states **built-in · deterministic · reaches no model**, which is a
fact worth knowing and not an apology.

## 6. States

| State | Copy |
| --- | --- |
| empty | "Nothing is scheduled." + *a routine gives one of your agents a standing task* + New routine |
| never run | "Hasn't run yet." + the next time. Not an error |
| nothing to do | *nothing to do* — a real outcome, said in words, with the last time it did act |
| absent | could not run — the variable or bridge named, not spent |
| failed | the error verbatim, and the next run still shown, because a failure does not unschedule anything |
| paused | its own group at the bottom, no schedule reported, and it says who paused it and when |

## 7. Keyboard

`↑ ↓` move · `↩` opens · `r` run now, confirmed · `p` pause · `esc` back.

## 8. Data sources

| Element | Source |
| --- | --- |
| the list | `routines/<name>/manifest.yaml` — `name`, `description`, `schedule`, `requires` |
| when it last ran, and how | `runs` where `kind = 'routine_run'` — `ok`, `ts`, `meta` |
| when it acts, versus when it ticks | **nothing** — the silence conditions are prose in each manifest's description (request D5) |
| next run | **nothing** — derivable from `schedule` and the last `routine_run`, computed nowhere (D6) |
| *nothing to do* versus *did work* | **nothing** — a silent tick and a working tick are both `ok = true` (D7) |
| who runs it | **nothing** — no `agent` field (D3) |
| the task prompt | **nothing** — does not exist (D8) |
| reach granted for the run | **nothing** — does not exist (D2) |
| cost | `runs.cost_usd` for that component, summable |

Most of this screen is drawn ahead of its wire, per the owner's ruling of
2026-09-20. Every gap is a numbered request rather than a guess.

## 9. Requests for the developer

| # | Request |
| --- | --- |
| **D5** | a machine-readable `acts:` on the manifest — the human sentence and the conditions — so three surfaces stop parsing a description |
| **D6** | `next_run_at`, computed where the runner already computes due-ness |
| **D7** | a routine outcome beyond `ok` — `acted` versus `silent`. Without it the list cannot tell a working routine from a sleeping one, and four of five ship deliberately silent |
| **D8** | a routine task prompt, additive over the agent's definition, plus D2's grant and D3's `agent` field. These three are one feature |
