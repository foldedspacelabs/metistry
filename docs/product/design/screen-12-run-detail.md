# Screen 12 — Run detail

New, 2026-09-22. One page for any run — a routine, an agent, or a chat — opened
from Routines history, an Activity row, or an agent's recent work.

**Owner's ruling, 2026-09-22:** sessions are kept so Metistry can fold them into
knowledge, learn from what went well and badly, learn preferences, and build the
profile piece by piece. The page shows the **working conversation itself**, not a
reconstruction of the prompt from files.

## 1. Layout

```
Routines ▸ Morning brief ▸ Today, 6:02 AM
Morning brief   [ran clean]                        Tuesday 22 Sep · 6:02 AM
────────────────────────────────────────────┬────────────────────────────
▸ DEFINITION  collator                       │ WHAT METIS TOOK FROM THIS
▾ TASK        morning brief                  │  Lesson   routines/morning-brief
  Read yesterday's journal …                 │  Knowledge Areas/Ops/lease.md
                                             │
TASK · MORNING BRIEF          6:02:00        │ THE RUN
[ Write today's brief. ]                     │  sonnet · 1m 12s · 18.4k in
  ▸ calendar.events                  0.4s    │  71% from cache · 2.1¢
  ▾ knowledge.read                   0.2s    │
    ASKED  { "path": "Journal/…" }           │ TOOL CALLS · 3
    GOT    1,204 words · 3 open loops        │  calendar.events  ████  0.4s
┃ METIS                          6:03:12     │  knowledge.read   ██    0.2s
┃ Four things on today …                     │  work.list        ███   0.3s
```

- **The conversation leads**, at reading width, because it is what the page is
  opened for. The definition and task layers sit at the top, collapsed except
  the task. Each tool call sits in the conversation in order, collapsible, with
  what it **asked** and what it **got**, on the `agent-quiet` wash, because both
  are agent-side data (P1).
- **The side column** holds, in order: what Metis took from this session, the run
  (provider, model, time, tokens, cache, cost), and the tool sequence with
  proportional durations.

## 2. What Metis took from this

Above cost and timing, because it is the reason sessions are kept. Each item
names its **kind** (Lesson, Knowledge, Preference, Profile), **where it would
land**, the line itself, and its status: *In Needs You*, *Accepted*, *Declined*.

- **Preferences land in `Me/Working Style.md`; facts land in `Me/profile.md`.**
  Both files already exist, both are `source: user`, and both already say
  *"Metistry discovers these facts from you."* Nothing does that discovering
  today; the session fold is the mechanism.
- **Every item is a proposal (C79).** Working Style is included word for word
  into prompts and the profile gates routines, so a change to either changes how
  Metis behaves, which makes it a human change under invariant 2. Accepting
  writes your words, in your file.
- **Chat is in scope**, and it is where most of this comes from: *lead with the
  number* is a sentence typed once, and the fold is what makes it stick.

## 3. A failed run

The header states the failure in one sentence. The same call is red in the tool
sequence and open in the conversation with the refusal as its result, so a log
line never has to be matched to a moment. C45 holds: the run finished without
the step and said so. A lesson from a failure proposes the fix, not an apology.

## 4. Settings ▸ Sessions

- **Keep sessions** — **30 days** (ruled 2026-09-22). A session is raw material;
  what lasts is what the fold took from it.
- **Let Metis learn from them** — on by default; off keeps sessions for reading
  and debugging and stops the fold.
- **Purge now**, with the count beside it.
- **Stored outside git**, because a transcript committed to git is forever.
  Where exactly is the developer's call; the owner leans to a file cache under
  `.metistry`.

## 5. What this asks of the build

1. **A session archive (C78)** — every session, chat included: the system prompt
   as sent, every message, each tool call's arguments and result. Read-only:
   the engine never replays it. Outside git; a file cache under `.metistry` is
   the owner's lean.
2. **A session fold** — a routine like `knowledge-fold` that reads new sessions
   and proposes lessons, knowledge, preferences and profile facts (C79).
3. **Provenance both ways** — each proposal carries its session and turn; each
   session lists what was folded from it and its status.
4. **Retention and purge** — 30 days, and **the fold must run before a session
   expires**, or the learning is lost with it.
5. `run_detail` already returns everything in *The run* and *Tool calls*.
