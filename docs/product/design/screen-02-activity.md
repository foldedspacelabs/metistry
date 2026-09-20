# Screen 2 — Activity

Round D, second screen. Mac first, light and dark. The board is `Activity`
on the design canvas.

`Feed` is the rendering; **Activity** is the noun (ratified, decision 1).
Nothing in this screen may call it a feed in user-visible copy.

## 1. The problem this screen has and no other does

Every row is recent and none is urgent. P2 forbids colouring a row for being
recent, which removes the one hierarchy a timeline normally gets for free, and
the rows come from six different tables so there is no shared magnitude to sort
by either. What is left is: **time bands, one glyph column, and who did it.**

That is enough, but only if the list is short. At the query's own defaults —
`hours: 24`, `limit: 100` — a real window is mostly `tool` rows, and a screen
that answers *what happened while I was away* with forty tool calls has
answered nothing. So the single most important thing on this screen is not a
style, it is **collapsing a reply's tool calls into the reply**, and the wire
already supports it.

## 2. Layout

```
toolbar   Metistry · + · bell(4) · usage
sidebar   Chat · Activity* · Work · Knowledge · Agents
pane      Activity          [Last 24 hours ▾] [agent: every ▾] [project: every ▾]
          ( All )( Captures )( Proposals )( Decisions )( Work )( Runs )( Messages )
                                 ↓ 12 new
          ── Just now ──────────────────────────────────
          [glyph]  (actor) Subject                            2m
                   detail, clamped to two lines
          ── Earlier today ─────────────────────────────
```

The pane title is `Activity`; the **window** title is always `Metistry`
(ruling, round B). Time bands are sticky headers on `sunken`; rows inside a
band are flat and equal, because they are.

### 2.1 Row anatomy

`[kind glyph] [actor chip] [subject] … [relative time]`, with `detail` on a
second line under the subject.

| Part | Column | Notes |
| --- | --- | --- |
| kind glyph | `kind` | one of fifteen, each named to an SF Symbol in §3.2. Takes `failed` **only** when the row failed — see §6 fault 1 |
| actor chip | `actor` | `agent` tint for an agent, `absent-quiet` neutral for a channel (`imessage`, `email`) or the system (P1) |
| subject | `subject` | Title Cased at render for system-composed kinds only — §2.2 |
| detail | `detail` | already `left(…, 200)` server-side. Clamped to two lines; the rest lives at the row's destination |
| time | `ts` | relative, absolute in `title=` / `.help()` |
| the row | `ref` | its destination |

Two lines, **one left edge**. The actor chip sits *before* the subject, not
after it, so a long subject truncates into the gap before the time column
instead of pushing anything about — the fault the owner flagged on the request
card in round C, fixed here by ordering rather than by clamping.

`ref` decides where a row goes: `inbox:` the capture · `proposals:` the
request · `work:` the task · `outbound_messages:` the message · `runs:` the run
detail, **which does not exist yet** (§6 fault 2).

### 2.2 Title case, and one kind that is in the list wrongly

§3.2's rule is right: title-case at render, from a closed allow-list of kinds
whose subject *the console composed*, never in the database, never for a kind
that can carry authored text.

`work_history` is in that allow-list in both `design-system.md` §3.2 and
`apps/console/web/app.js`, and it does not belong there. Its subject is
`w.title` — what a person or an agent typed. "Migrate the settings pane to
tokens" renders today as "Migrate The Settings Pane To Tokens". The test is
whether the console composed the string; here it did not. **Remove it from
both lists** (C18).

`capture` is not in either list, which is correct — its subject is the first
line of the note — but it is also missing from §3.2's *kind inventory*
altogether, which is wrong: the query's first branch is captures, and
`app.js` has shipped a `capture` icon since ADOPT 1 (C17).

## 3. Filters

Seven chips. Six of them are the `group` column `activity_feed.yaml` derives —
`capture · proposal · decision · run · work · message` — and the query's `kind`
param matches **either** an exact row kind or a group. So the console passes
the chip value straight through and the SQL owns what is in each group: adding
a sixteenth kind never touches the interface. This is the query's own comment,
and the shipping `FEED_CHIPS` already does it.

`hours`, `agent` and `project` are the other three params and are the three
controls beside the title. **Nothing on this screen is a filter the query
cannot run**, and nothing the query can run is missing.

## 4. New rows arrive while you are reading

`since` hands back the newest `ts` already painted and returns everything at or
after it (inclusive — two sources can share a microsecond), de-duplicated on
`(ref, ts, kind)`. So the list is always mid-refresh.

New rows are **held and counted, never inserted**. The pill reads `↓ 12 new`;
taking it scrolls to the top and paints them in one step. The list moves when
you ask it to and not before (P9), the same discipline the transcript keeps.

A filter change resets both the cursor and the buffer — a different question
deserves a full answer, not a merge.

## 5. States

Three ways this list is empty, and they are not the same thing.

| State | Copy | Action |
| --- | --- | --- |
| empty | "Nothing in the last 24 hours." — the system ran and nothing happened worth recording. A quiet day, not a fault | Widen to 7 days |
| filtered-empty | "No captures in the last 24 hours." — names the filter, because six other kinds have rows in this window | Clear the filter |
| failed | "Couldn't load activity." + the error verbatim. **Nothing is known** about the window — this is not an empty feed | Try again |

The third never renders as "nothing happened", which is the lie a shared empty
state tells (P5).

**One case the wire cannot separate.** A first run — nothing has *ever*
happened — is identical to a quiet day, because the only signal is zero rows in
this window. Rather than guess, the empty state's action resolves it: widen to
7 days and the answer is the same or it is not.

Row states are §3.2's: default · hover (`surface` lifts to `elevated`, no
colour) · pressed · focused · failure (the glyph, not the row).

## 6. What this screen found in the wire

1. **`ok` is never returned, so failure cannot be drawn.** §3.2 says "the
   glyph, not the row, takes `failed`". `runs.ok` exists and is indexed, but
   `activity_feed` selects `ts, kind, group, actor, subject, detail, ref,
   turn_id` and drops it. Failure survives only as English inside `detail` —
   `(failed)`, `refused:`, `collector failed`. Drawing the state would mean
   regex-matching prose, which is not a state, it is a guess. **Add `ok` to the
   select.** One column. (C19)
2. **Run detail has no data source, so it is not drawn this round.** §7 below
   specifies the query it needs.
3. **A `turn` row cannot say what the turn was about.** Its subject falls
   through to `r.kind` — the literal string `turn` — and its detail reads
   `turn claude-sonnet-5 $0.031`: the word twice, and no topic. Nothing in
   `runs` carries one. Drawn here as **model as subject, cost and tokens as
   detail**, which is all true. A topic needs a field that does not exist and
   P5 says we do not invent one.
4. **`work_history` is title-cased and should not be** — §2.2. (C18)
5. **A successful collector pass is invisible.** The union takes
   `collector_run` only `WHERE ok = false`. That is deliberate and mostly
   right, but it means Activity can never answer "is `github-state` still
   current" — which is what the **stale** state from round C exists to answer.
   That answer belongs on Knowledge and Agents, not here. Recorded so it is not
   later mistaken for an omission.
6. **Turn grouping does not survive the window edge.** `turn_id` groups the
   calls one reply made, but it is not a query param, so grouping happens
   client-side over the rows already fetched. A turn whose tools fall past row
   100 shows a count larger than what expanding can display. Either
   `activity_feed` gains a `turn_id` param — preferred — or the disclosure
   reads "4 tools, 2 shown".
7. **`runs.ok` is `NOT NULL` in `db/migrations/0001_init.sql` and nullable in
   `packages/tasks/sql/schema.sql`.** Two schemas for one table. It matters
   here beyond tidiness: a nullable `ok` is exactly how an in-flight run would
   be expressed, and the working state on Chat (§5.1 of screen 1) wants that.
   Worth deciding deliberately rather than by drift.

## 7. The `run_detail` query Run detail needs

There is no `/api/runs/:id` and no `run_detail` seeded query — only
`runs_summary` and `runs_export`, which are aggregates. The brief says a screen
that cannot name its data source does not pass, so **Run detail is not drawn**.
It follows the round after this query exists.

```yaml
name: run_detail
description: One run and the calls that belong to it — the destination of every
  `runs:` row in activity_feed.
params:
  id:      { type: int,  default: 0 }    # runs.id
  turn_id: { type: text, default: "" }   # or: every call of one turn
```

Columns the screen needs, all of which `runs` already has:
`id · ts · component · kind · session_id · tool · model · tokens_in ·
tokens_out · cost_usd · duration_ms · ok · error · meta`, plus the sibling
calls sharing `turn_id` ordered by `ts`, so the detail can show a turn as
what it was: a sequence with a total.

Two things the screen will need that the table does not have, to be settled
when the query is written rather than discovered when it is drawn: whether
`meta` is safe to render verbatim (it is agent-written, so P1 says it is data
and must not look like interface), and whether a run's *input* is recoverable
at all — today it is not, which means Run detail can show what a run cost and
not what it was asked.

## 8. Keyboard

`↑`/`↓` move the selection · `↩` opens the row's destination · `⌘↩` opens it in
a new window · `←`/`→` collapse and expand a turn group · `1`–`7` select a
filter chip · `⌘R` takes the pending rows · `/` focuses the window filter ·
`esc` clears the filter before it blurs.

Selection is a real focus ring on the row, and it never scrolls the list to
recentre — the row scrolls into view by the minimum amount (P9).

## 9. VoiceOver

- "drey-dev, Access, you decided approve, scoped to packages slash core, 1 hour ago. Decision. Button."
- "metis, claude-sonnet-5, turn, 6.2 seconds, 3.1 cents, 4 tools collapsed, 4 minutes ago. Expandable."
- "imessage, Ask Drey's landlord about the March renewal, capture, new, 2 minutes ago. Button."
- the band header: "Just now, heading level 3."
- the pill: "12 new rows. Button. Activates to show them."

Each sentence is `<actor>, <subject>, <kind said in words>, <detail>, <time>`
— kind is spoken because the glyph carries it visually and a glyph has no
accessible name of its own.

## 10. Data sources

| Element | Source |
| --- | --- |
| every row | `GET /api/q/activity_feed` — `hours`, `limit`, `agent`, `project`, `kind`, `since` |
| the seven chips | the query's `group` column; the chip value is the `kind` param |
| turn grouping | `turn_id`, client-side over the fetched window (§6 fault 6) |
| the row's destination | `ref` — four of five prefixes resolve today (§6 fault 2) |
| failure on a glyph | **nothing** — `ok` is not returned (§6 fault 1) |
| a row's destination detail | `run_detail`, **which does not exist** (§7) |

## 11. Open items

- `ok` on the select, and a `turn_id` param, are both one-line query changes
  this screen is waiting on.
- `work_history` out of the title-case allow-list in two files.
- `capture` into §3.2's kind inventory.
- Whether a `turn` row can ever carry a topic, or whether the model is the
  honest subject forever.
- `runs.ok` nullability, across two schema files.
