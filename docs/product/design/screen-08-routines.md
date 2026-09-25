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

## 3. The schedule is when it acts; the recurrence is the rule

This is the screen's central honesty problem and it is easy to get wrong.

`plan-tomorrow` is `@hourly`. It acts **once an evening**, after the day end
`Me/profile.md` states, on the eve of a working day, "and is silent otherwise."
`knowledge-fold` is hourly and folds **once a night** after 18:00. The hourly
tick is a mechanism — *"the runner has no time of day"* — not a description of
what the system does.

So a row that reads `@hourly` is technically true and useless. **The row says
when it next runs**, and beside it the **Recurrence** — the rule, in words. The
cron expression is mechanism and appears once, in the routine's Schedule section,
not on a list the owner reads every morning.

> **Tomorrow's Plan** · each evening, once your day has ended

A routine that ticked twelve times and did nothing has not run twelve times, and
the list must not suggest it did. That is the same discipline as Activity giving
a too-early tick no row at all.

**"Silent" is gone.** It described the runner's internals, which the owner has no
reason to care about. A run that did nothing already reports *wrote an empty
table — nothing had changed*, which is the same fact in words that mean
something.

## 4. The list — ordered by what runs next

Grouped by cadence it was an unordered set of configuration. Ordered by next run,
under day bands, it is a schedule.

```
Routines                                                [+ New Routine]

    WHEN      ROUTINE             AGENT              RECURRENCE
TODAY
    6:02 AM   Morning Brief      collator →         ↻ Every day at 6:02 AM
 !  7:00 AM   Vendor Sweep        vendor-research →  ↻ Every day at 7:00 AM
    6:00 PM   Knowledge Fold      Built-in           ↻ Every evening
   10:00 PM   Tomorrow's Plan     Built-in           ↻ Every evening
TOMORROW · TUESDAY
    6:02 AM   Morning Brief      collator →         ↻ Every day at 6:02 AM
    9:00 AM   Standup Notes       collator →         ↻ Every Tuesday at 9:00 AM
INACTIVE
 ⏱  —         Inbox Triage        inbox-triage →     ↻ Paused 4 days ago by you
```

**A routine appears once per occurrence**, so a daily one appears under each day.
That repetition is what removed two columns: the row *is* an occurrence, so it
needs no "next run" column and no "how it went" column — the time is the
occurrence, and history belongs to the routine rather than to the list. Four
columns and a state glyph, down from five columns.

**The agent is a link**, and it is the deep link in the direction the owner
arrives from. `Built-in` is not a link, because there is nothing behind it.

### 4.1 The week on one axis — at the top of the pane

Revised 2026-09-22, and it sits **at the top of the pane**, above the list —
because *what is Metistry running for me* is answered by the shape before it is
answered by the rows. The first pass drew a seven-row week × hour grid: seven rows
to say one thing. **One axis says it** — a mark per run, day and week markers for
scale, a faint noon line inside each day — and the thing it says is
*everything runs before 7 AM or after 6 PM, and the working day is empty.*
Day · Week · Month are the same marks at three scales, and Month is the one a
budget would attach to.

**The agent-versus-built-in distinction left with the grid.** It was carried by
two marks, which the palette validator had already forced into filled-and-outlined
(the agent ink and the neutral separate at **14.3 ΔE** in dark mode, under the
hard floor of 15 — indistinguishable even with full colour vision). But it was
never the picture's job: the **Agent** column in the list says who runs each one,
in words. One ink, no legend to learn. The ΔE finding stands as a rule for any
future pair of marks (C54); it simply has nothing to apply to here.

Per-agent hues were never an option: **hue carries *what kind of thing*, never
*which one***.

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

### 5.2 Permissions

**The same table as Agents §4.1**, showing the permissions in force *for this
run*. Effective is the answer; where each line came from is a marker on it. Not
"what the agent has" beside "what this routine added" — that made the reader
compute the union themselves.

| Resource | Read | Write |
| --- | --- | --- |
| Knowledge | `Areas/Ops` · `Areas/Vendors` *(Morning Brief only)* | `Journal/Digest/` *(Morning Brief only)* |
| Work | All tasks | Update · Comment |

And the sentence that makes the layering safe: *outside this routine, `collator`
cannot read `Areas/Finance`.* Access that exists only during a task has to say so
out loud, or it reads as a permanent grant.

### 5.3 Schedule

The **Recurrence** as a headline — *Every day at 6:02 AM* — then Next Run, the
runs after it, and the time zone. The cron expression lives here and only here.

### 5.4 Outputs, and History

Where it writes — one path, machine-owned, one writer (§5.1 of the daily-flow
spec). Then the last runs: when, outcome, what it produced, what it cost. This is
where a per-routine cost belongs, and where a budget would go if one existed
(C3): recurring compute is where money leaks, and a routine is the only object in
the product that can be said to have a monthly cost.

**History is where a routine gets debugged.** A result tells you *that* it went
wrong. Expanding a run shows **the prompt that was sent** — the definition and
the task, composed as the agent received them — and **what it wrote back**. That
is the whole of what you need to work out why a routine produces the wrong thing,
and to fix it in the layer that caused it. The prompt is the owner's text and
takes the interface face; the output is the agent's and takes the serif and the
verdict controls, like agent prose everywhere.

**Metis suggests** is not a new mechanism. Metistry already emits `improvement`
proposals — `reply-review` does it for reply quality, with a deterministic
suggested edit that nothing applies until the owner allows it in triage. A
routine suggestion is that proposal kind pointed at a routine, so it arrives in
Needs You like every other request and this panel is only where it is read in
context.

### 5.5 A built-in routine's detail

> **Superseded by §10 (C111).** There is no read-only built-in: defaults are
> attributed to Metis, tagged **default**, and editable.

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

## Corrected 2026-09-23 (review 01)

- **Metis suggests** is a proposal, so it is answered **Approve · Revise ·
  Decline** like every other (amendments §8.1); *Change The Schedule* and
  *Dismiss* are gone.
- The 6:02 AM routine is **Morning Brief** everywhere (C55, C97). Standup and
  Tomorrow's Plan are routines of their own that the brief presents (§10, C111).
- A failed run carries the failed mark in the failed ink.

## 10. v2 — everything scheduled, all editable (2026-09-25)

Board: `Routines-v2`. Rulings C111 and C112.

### 10.1 The list

- Two tabs in the header: **Routines 8 · Sources 6**. The button follows the tab:
  *New Routine* or *Connect Source*.
- Routines stay ordered by next occurrence with day bands (§3). Rows: **Standup**
  6:00 AM, **Morning Brief** 6:02, Vendor Sweep 7:00, **Tomorrow's Plan** 7 PM
  (or when the day is closed), **Knowledge Fold** 10 PM, **Reply Review** 11 PM,
  **Weekly Review** Sunday 6 PM; paused ones last.
- A default carries a **default** tag. *Run By* names **Metis**; *Built-in* is gone.
- A routine that feeds another says so after its name: *→ Morning Brief*.
- Selection is a 3px accent rule on the surface, never a tinted fill (the ok
  glyph fails on the accent wash).

### 10.2 One routine — Standup

Header: renamable name, **default** tag, *Run by Metis · change*, **Run Now**,
**Pause**. Then:

| Section | Holds |
| --- | --- |
| Schedule | weekday toggles (defaults to working days), a time, *Skip days with no standup on your calendar*, the next three runs |
| What it's asked to do | the task in the owner's words, **Edit**; *Shape from* `Templates/Standup.md`, *voice from* `Me/Working Style.md`, Open in Obsidian |
| Reads and writes | Reads · Writes `Journal/Standup/<date>.md` · Feeds the brief's Standup section · Never posts anywhere |
| History | the latest run opened to its **steps** (reads, the model call with tokens, the write) with durations, and what it wrote; older runs one line each; a skipped day says why |

Foot: *Shipped with Metistry; everything above is yours to change.* and **Reset
to Default**, which restores the schedule, task and grants and asks nothing.

### 10.3 Sources

One row per collector: status glyph, name and collector id, what it reads and
what it may raise, cadence, last success. A failed source shows the reason in
failed ink (*token expired*) and is also a Needs You request (C95, C96). A source
not connected says so and points to Settings › Resources.

A source's detail: **Check Now**, **Pause**; *Checked* as a segmented cadence
(5 min · 15 min · Hour · 6 hours) with the last result; **What reaches Needs
You** as toggles (C108); *What it reads* — repos, the token's scope.

### 10.4 Suggestions

A Metis suggestion about a routine is an **improvement** request in Needs You
(§9 of the amendments): the ask, context on the wash, a before/after body,
Approve · Revise · Decline. Approve writes the change to the routine and the
history records it.
