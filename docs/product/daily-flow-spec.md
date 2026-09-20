# The daily flow — a buildable spec

Tasks in markdown, templates with directives, the routines that render them,
and the mail door. **This is a product spec, not research**: every section
below is a decision, a schema, or a ticket. Where an alternative was
considered and rejected, it is named in a clause and not surveyed.

**Provenance.** It turns `docs/research/2026-09-19-daily-flow-and-tasks.md`
(PR #227) plus the owner's rulings of 2026-09-19 into something an agent can
build. The research note stays as history and is not edited; where this spec
departs from it, §14 says so. Every `file:line` here was read at `origin/main`
`47fe7c5` (post-#231), not at the research note's `2aba1fb` — four of the
note's findings had already moved (§14.1).

**What the owner ruled** (2026-09-19, and the spec obeys these rather than
re-arguing them): markdown `- [ ]` is where a human todo lives; a derived index
over it is right; the syntax must be one Metistry *helps* with, because the
owner will not type it and will not look at literal field text; assignment to
another person is line syntax; the user edits the daily journal directly;
due dates, priorities, sizes and types are all needed and the prioritisation
rules must be flexible prose, not arithmetic; the user defines schedule,
content and format and the assistant supplies the input; Reminders is skipped;
Apple Mail is a direct, well-scoped read on the second instance; Slack is
later, possibly via Devin; task-vs-agent-work stays split; no assistant writes
into the user's notes for now; the keys nothing can guess live on `Me/`;
transcripts are fine to read; files are segregated by writer; dated folders
archive into `<folder>/<year>/<month>/`; templates are user-editable and carry
directives.

---

## 0. Decisions at a glance

| # | Decision | §
| --- | --- | --- |
| D1 | A user's todo is a `- [ ]` line in a vault note. `work` stays canonical for what an agent may claim. One-way promotion, never a mirror | §1, §3 |
| D2 | The typed grammar is **English-shaped trailing tokens** (`due 2026-09-22`, `p1`, `@Jim`, `every weekday`) — *not* Dataview `[k:: v]`, because the owner refuses literal field text | §1.1 |
| D3 | **Normalisation happens in the index, never on disk.** The parser reads loosely; nothing writes back. Q3 is satisfied by construction, not by restraint | §1.4 |
| D4 | Identity is an Obsidian block id `^mt-<8>`, minted by the **plugin at edit time** or by a template/quick-add at creation — never by a routine. Before the plugin, identity is `(path, text-hash, ordinal)` and mirrors are generated lists, not transclusions | §2.1 |
| D5 | Priority is **P1–P4** with named aliases (`critical│high│normal│low`); unset sorts as P3 | §1.3 |
| D6 | `type` is free text, not an enum: adding "errand" must not be a product change | §1.3 |
| D7 | Two derived tables: `vault_tasks`, `vault_task_refs`. Filled by the reconciler's existing walk. Drop the database, re-walk, they come back | §1.5 |
| D8 | A `work` row may name a human todo as `meta.blocked_by`. It **surfaces and never gates** — `depends_on` and `DEPS_CLOSED` are untouched | §3 |
| D9 | Recurrence lives on a rule line; the **daily-note template** materialises the day's instance when the user creates the note. One open instance per rule, ever | §4 |
| D10 | `Journal/<date>.md` and `Journal/Meetings/<date>-<topic>.md` are the user's. `Journal/Plan/`, `Journal/Fold/`, `Journal/Standup/` are machine-owned, one writer each | §5.1 |
| D11 | Archiving is **`metistry archive`**, run by the user, preserving basenames so links resolve unchanged | §5.2 |
| D12 | Templates live in **`Templates/` in the vault**, not `.metistry/templates/` | §6.1 |
| D13 | Eight directives, one block form, no expressions, no recursion. A directive that cannot be satisfied renders a visible note and the file still renders | §6.2–§6.4 |
| D14 | `{{ prose }}` is legal **only in a template whose output the assistant owns** (`Journal/Fold/`), because `ownershipRefusal` admits exactly that one non-self source | §6.3 |
| D15 | One filter vocabulary, three consumers: the template's `where:`, the app's filters, the plugin's suggester. It compiles to bind params of one named query — never to SQL text | §6.2, §10 |
| D16 | Two new routines (`plan-tomorrow`, `standup-draft`), three extended. All `@hourly` with an in-routine gate | §7 |
| D17 | Mail is a **Swift, read-only, allowlisted** `apple-mail` bridge on the second instance. `full_disk_access` is already in the manifest TCC enum | §8.2 |
| D18 | Build a small Metistry Obsidian plugin (4 jobs). The vault must stay fully readable with no plugin at all, and it does | §9 |
| D19 | **Work ▸ Today** is the 5th child of Work. No new sidebar row, no new top-level section | §10 |
| D20 | No new `brain` tool. The bridge is at its declared ceiling; every new read capability is a named query behind `queries_run` | §1.5, §10 |

---

## 1. The task line

### 1.1 What a human types

```markdown
- [ ] Call the dentist due friday
- [ ] Draft the Q4 plan due 2026-09-30 p1 size l type planning +drey
- [ ] Send Jim the brand deck @Jim due tomorrow
- [ ] Water the plants every week
- [x] Send the contract
```

The whole grammar:

```
- [ ] <text> <field>*  [^mt-xxxxxxxx]
```

`- [ ]` and `- [x]` are plain GFM and are the only load-bearing glyphs.
`- [-]` reads as **dropped** if present; nothing requires it.

**Fields are a trailing run, parsed right to left.** The parser starts at the
end of the line, consumes the anchor if present, then consumes recognised
field tokens while they keep matching, and stops at the first token that is
not a field. Everything to its left is the task's text, verbatim.

That one rule is what makes the grammar safe to type without thinking:

- `- [ ] Ask @Jim about the pricing deck` — `deck` is not a field, so parsing
  stops immediately. `@Jim` stays in the text and assigns nothing.
- `- [ ] Ask Jim about pricing @Jim due friday` — the trailing run is
  `@Jim due friday`; the text is `Ask Jim about pricing`.

**Rejected: Dataview inline fields** (`[due:: 2026-09-22]`), which the
research note recommended. They render as literal bracketed text in Obsidian's
source and live-preview modes unless Dataview is installed and the reader is
in reading mode — exactly what the owner ruled out in Q2 ("I don't want to
type it manually and see it rendered as literal text"). The note's argument for
them was diff legibility; `due 2026-09-22` diffs at least as well.

**Rejected: the Tasks plugin's emoji format** (`📅 2026-09-22`, `⏫`, `🔁`) for
the same reason the research note gave: a `git diff` of emoji signifiers is
unreadable and this repo's record *is* the diff (invariant 1), and the glyph
table belongs to a third party. The parser **reads** both the emoji set and
Dataview inline fields (§1.4); it never writes them.

**Rejected: frontmatter task arrays.** You cannot tick a YAML entry.

### 1.2 What Metistry adds

Exactly one thing on disk: `^mt-<8 chars, Crockford base32>` at the end of the
line. Obsidian's block identifiers admit Latin letters, numbers and dashes, so
`^mt-7x2k9abc` is legal and `^mt_7x2k` is not. It is minted **once** and never
re-minted, and the only writers are the plugin (at edit time, in the user's own
editor) and whatever creates a task line from scratch — the daily-note
template, quick-add, the Today view's "add". **No routine ever mints one into a
note the user owns.**

Everything else Metistry "adds" it adds to the *index*: the normalised date
behind `due friday`, the person page behind `@Jim`, the project slug behind the
note's location, the ageing counter, the duplicate link. None of it touches the
file. §1.4 is the whole of the rule.

### 1.3 Field reference

Every field, its typed forms, and what the index stores.

| Field | Typed | Stored | Notes |
| --- | --- | --- | --- |
| **due** | `due 2026-09-22`, `due friday`, `due tomorrow`, `due 22 sep` | `due date` | A hard date the user set. Never moved by anything. |
| **scheduled** | `do 2026-09-22`, `do monday` | `scheduled_for date` | The day the user means to *do* it, as distinct from the day it is owed. |
| **start** | `start 2026-10-01` | `start_on date` | Not actionable before this. Suppressed from Today until then. |
| **done** | (added by the plugin on tick) `done 2026-09-19` | `done_on date` + `done_on_observed bool` | If the line is `[x]` with no `done`, the index records the first day it *saw* it checked and sets `done_on_observed`. Honest, and it is what makes yesterday's standup work before the plugin exists. |
| **priority** | `p1`…`p4`; aliases `critical`, `high`, `normal`, `low` | `priority smallint` | **D5.** See below. |
| **size** | `size s│m│l`; aliases `small`, `medium`, `large` | `size char(1)` | Rough effort. Rendered as a minutes estimate in the plan (`S`≈15, `M`≈45, `L`≈90 — all config, §6.2). |
| **type** | `type coding`, `type reading`, `type meeting`, … | `type text` | **D6.** Free lowercase slug, no enum. |
| **assigned** | `@Jim`, `@[[Jim Fallon]]` | `assigned text` (vault path) | **R5's line syntax.** The canonical form is `@[[Jim Fallon]]` — a real wikilink, so it is clickable, it lands in `knowledge_links` for free (`apps/reconciler/src/notes.ts:68-71`), and it satisfies the frontmatter rule that people are always wikilinks (`metistry-build-plan.md:1650-1651`). `@Jim` resolves to a unique `People/Jim*.md` the way every other link resolves (`notes.ts:91-103`); ambiguous or unresolved, it is stored as written and flagged. |
| **project** | `+drey` | `project text` | Derived from location unless overridden (below). `+<slug>` matches `projects.id`'s own shape (`db/migrations/0011_projects.sql:14`). |
| **area** | — (never typed) | `area text` | From the note's frontmatter `area:` or its path prefix. |
| **recurring** | `every day`, `every weekday`, `every week`, `every 2 weeks`, `every month`, `every 3 months`, `every year` | `recur_rule text`, `recur_next date` | §4. |
| **status** | `waiting` | `waiting bool` | Delegated and waiting on someone. Almost always appears with `@Person`. Distinct from `- [ ]`: it is still open, it is just not the user's move. |
| **source** | (never typed) | `source text` | Provenance, set by whatever created the line: `meeting:<path>`, `mail:<message-id>`, `agent:<id>`, `template:recurring`. A hand-typed line has none. |
| **links** | `linear:ABC-123`, `gh:owner/repo#418`, `work:418` | `ext_refs text[]`, `work_id bigint` | `work:418` is the promotion pointer (§3). The others are one-way references a collector can join on (`external_ref` is already uniquely indexed, `db/migrations/0005_work_external_ref_unique.sql:3`). |

**D5, argued.** Four levels, not five, and not three:

- An unset default must exist, and it must be the *middle*, so the user only
  ever types a departure from normal. With five levels the typed set is
  {p1, p2, p4, p5} — four decisions wearing a five-point label.
- Four maps exactly onto the named scale the owner offered
  (`critical│high│normal│low`), so both spellings normalise to one value and
  neither has to win.
- The owner ruled that prioritisation is prose, not arithmetic (Q8). A finer
  scale invites the deliberation the ruling rejects.
- Storage is `smallint` with `coalesce(priority, 3)` everywhere it is ordered,
  so "unset" and "normal" sort identically and no NULL-ordering surprise
  exists.

**Dates.** `YYYY-MM-DD` canonical. The parser also accepts `today`,
`tomorrow`, a weekday name (the *next* such weekday, never today), `22 sep`,
`sep 22`, and `+3d`/`+2w`. Resolution is relative to `METISTRY_TZ` and to the
run's date — recorded in `vault_tasks.parsed_on` so a relative date parsed on
one day is not silently re-read as a different date on another. Anything else
is a **parse warning** (§1.4), never a guess.

### 1.4 Who normalises, and how — the answer to "Metistry helps with the syntax"

**The rule: Metistry reads loosely and writes nothing.**

The owner asked for two things that look opposed — "I will have trouble with
this syntax, so Metistry will need to help" (R3) and "for now no assistant
writing user notes" (Q3). They are only opposed if "helping" means editing.
It does not:

1. **Read-side normalisation.** The parser resolves `due friday` to a date, `@Jim`
   to `People/Jim Fallon.md`, `critical` to `p1`, and stores the resolved
   values. The line on disk is untouched, forever. Everything downstream — the
   plan, the app, the person view, the queries — works off the resolved values.
   This costs one function and no mechanism at all.
2. **Write-side help is the plugin's** (§9), in the user's own editor, under
   the user's own hand, in the user's own commit. The plugin's suggester is how
   `due 2026-09-22` gets typed without typing it.
3. **The compatibility reader.** The parser also accepts `[due:: 2026-09-22]`
   (Dataview) and the common Obsidian-Tasks emoji signifiers, on read only.
   A user who already runs those plugins is not locked out; nothing in
   Metistry ever emits them.

**A field Metistry cannot read is never guessed.** `due nextweek` produces a
`vault_tasks.parse_warning` row value and one visible line in the day's plan:

```
> ⚠️ couldn't read `due nextweek` — Journal/2026-09-18.md:14
```

That is the whole feedback loop. It is not a proposal, because a proposal per
typo is a queue nobody reads.

**Rejected: normalisation as a proposal.** The obvious alternative — the fold
raises "may I rewrite line 14 to `due 2026-09-26`?" — was rejected on three
grounds: it puts the assistant's hand in the user's note for a cosmetic
change; a note with six loose fields is six queue items; and `knowledge_write`
is a whole-file replace under compare-and-swap
(`packages/mcp-brain/src/knowledge-write.ts:24-31`), so it races the editor
the user is typing in and loses.

**Rejected: the indexer editing the file directly.** The reconciler is the
sole committer and the one process that must stay boring. Giving it an opinion
about the contents of a line is how that stops being true.

### 1.5 The index

Two derived tables, filled by the walk the reconciler already does
(`apps/reconciler/src/indexer.ts:113-128` scans and parses every markdown file;
`:173-200` upserts `knowledge_files` and rebuilds `knowledge_links`;
`:304-337` maintains `inbox` from the same pass — the precedent this copies).

```sql
-- 0023_vault_tasks.sql
-- DERIVED IN FULL (D6). Drop the database, re-walk the vault, every row here
-- comes back from the markdown that produced it. `first_seen_on` is the one
-- column that is not a pure projection of the current bytes; it is
-- recoverable from git (`GET /vault/log`, apps/reconciler/src/server.ts:189),
-- and a rebuild that resets it loses a nudge, not a task.

CREATE TABLE IF NOT EXISTS vault_tasks (
    path            text    NOT NULL,          -- derived: vault-relative
    task_key        text    NOT NULL,          -- derived: the anchor when present, else 'h:'||sha256(normalised text)||':'||ordinal
    anchor          text,                      -- derived: the ^mt-… block id, without the caret; NULL before the plugin
    line_no         integer NOT NULL,          -- derived
    text            text    NOT NULL,          -- derived: the line minus fields and anchor, verbatim
    text_norm       text    NOT NULL,          -- derived: lowercased, whitespace-collapsed, punctuation-stripped — the dedupe key
    checked         boolean NOT NULL,          -- derived: [x]
    dropped         boolean NOT NULL DEFAULT false,  -- derived: [-]
    waiting         boolean NOT NULL DEFAULT false,  -- derived
    due             date,                      -- derived
    scheduled_for   date,                      -- derived
    start_on        date,                      -- derived
    done_on         date,                      -- derived
    done_on_observed boolean NOT NULL DEFAULT false, -- derived: done_on came from the index, not the line
    priority        smallint,                  -- derived: 1..4; NULL sorts as 3
    size            char(1),                   -- derived: S | M | L
    type            text,                      -- derived: free slug
    assigned        text,                      -- derived: vault path of the person page
    project         text,                      -- derived: slug
    area            text,                      -- derived
    recur_rule      text,                      -- derived: the `every …` clause, verbatim
    recur_next      date,                      -- derived
    recur_parent    text,                      -- derived: task_key of the rule line this instance came from
    source          text,                      -- derived: meeting:… | mail:… | agent:… | template:recurring
    ext_refs        text[]  NOT NULL DEFAULT '{}',   -- derived: linear:ABC-123, gh:owner/repo#418
    work_id         bigint,                    -- derived: from a `work:418` token on the line
    duplicate_of    text,                      -- derived: task_key of the earlier-seen twin
    parse_warning   text,                      -- derived: the token that could not be read
    parsed_on       date    NOT NULL,          -- derived: the date a relative token was resolved against
    first_seen_on   date    NOT NULL,          -- derived (recoverable from git log): for ageing
    last_seen_at    timestamptz NOT NULL,      -- derived
    PRIMARY KEY (path, task_key)
);
CREATE INDEX vault_tasks_open_idx   ON vault_tasks (scheduled_for, due) WHERE NOT checked AND NOT dropped;
CREATE INDEX vault_tasks_person_idx ON vault_tasks (assigned)      WHERE NOT checked AND NOT dropped;
CREATE INDEX vault_tasks_dupe_idx   ON vault_tasks (text_norm)     WHERE NOT checked AND NOT dropped;
CREATE INDEX vault_tasks_work_idx   ON vault_tasks (work_id)       WHERE work_id IS NOT NULL;

-- Block-anchored references, because knowledge_links cannot hold them:
-- extractLinks strips `#` and `^` from every target (notes.ts:69) and
-- knowledge_links' primary key is (from_path, to_path, kind), so widening it
-- would be a destructive migration. A second derived table is additive.
CREATE TABLE IF NOT EXISTS vault_task_refs (
    from_path  text NOT NULL,   -- derived: the note doing the referring
    to_path    text NOT NULL,   -- derived: the note holding the task
    anchor     text NOT NULL,   -- derived: the ^mt-… it names
    kind       text NOT NULL,   -- derived: wikilink | embed
    PRIMARY KEY (from_path, to_path, anchor, kind)
);
CREATE INDEX vault_task_refs_to_idx ON vault_task_refs (to_path, anchor);
```

**`task_key` is the identity, and it degrades honestly.** With an anchor it is
the anchor and survives the line moving to another note. Without one it is
`h:<sha256 of text_norm>:<ordinal among identical lines in that file>` — stable
across a field edit, unstable across a text edit, which is precisely the
guarantee a system with no id can make. Phase 2's plugin turns every open task
into the first case; nothing has to be migrated, because the index is derived
and the next walk re-keys it.

**Invariant 3.** The reconciler already writes `knowledge_files`,
`knowledge_links`, `embeddings`, `proposals` and `inbox` directly; these are
the sixth and seventh. The invariant's force is on the **read** path, and every
read here is a named query (§6.2, §10). This widens a pre-existing gap and is
logged as such (§13.5), not waved through.

**No new `brain` tool.** The bridge declares 27 tools at its stated ceiling and
`ops/scripts/check-tool-surface.mjs` fails on the tool after the acknowledged
number (`packages/mcp-brain/manifest.yaml:8`). Everything the assistant needs
here arrives through `queries_run` over the named queries in §6.2 — which is
what that manifest says the answer is.

---

## 2. Identity, mirrors and completion

### 2.1 One canonical line

A task exists **once**: on the line where it was typed. Everything else that
shows it is a *view*, and a view is one of exactly three things:

| View | Mechanism | Writes? |
| --- | --- | --- |
| **The daily plan** (`Journal/Plan/<date>.md`) | phase 1: a generated list, each item linking to its note (`[[Journal/2026-09-18]] — Call the dentist`). Phase 2: `![[Journal/2026-09-18#^mt-7x2k]]`, a transclusion | a machine file, one writer, never the user's note |
| **A person page** (`People/Jim Fallon.md`) | Obsidian's own **backlinks pane** (free, no plugin, because `@[[Jim Fallon]]` is a real wikilink), plus an optional query block the *user* pastes once | nothing writes it |
| **A project note / the app** | a named query rendered in the app, or the same optional query block | nothing writes it |

**Nothing is ever copied.** The plan note holds links, not duplicated task
text — except where phase 1's generated list necessarily restates the text,
which is why phase 2 replaces it with a transclusion. That is the whole reason
the plugin phase exists.

The person page deserves a sentence, because the owner liked the idea and then
correctly called it a composed view: **it is a composed view, and it costs
nothing.** `@[[Jim Fallon]]` is a wikilink, so `extractLinks`
(`apps/reconciler/src/notes.ts:57-82`) already files the edge into
`knowledge_links`, and Obsidian's built-in backlinks pane already shows every
line that names him — with no plugin, no write, and no Metistry at all. The
richer view ("open, waiting, overdue, grouped") is `vault_tasks.assigned` in
the app and in a `{{ tasks where: "assigned:[[Jim Fallon]]" }}` directive in
any template.

### 2.2 Completing from a mirror — and whether that is the user's hand

**Phase 1: it is not possible.** Today and the plan are read-only; the
affordance is "open in Obsidian" (`obsidian://open?vault=…&file=…`). No
write-back ships before anchors do.

**Phase 2: yes, and here is why it is the user's hand.**

The distinction this repo draws has never been "did a machine's bytes touch the
file" — every write is machine bytes. It is *whose intent authored the change,
and under whose principal it commits*. That distinction is already a mechanism:
`writeAllowed(rel, principal)` (`apps/reconciler/src/paths.ts:132-135`) grants
the `user` principal authority nothing else has, and
`packages/cli/src/protected-write.ts:53-70` is the shipped pattern for "a
command the owner ran, writing through the bridge as `principal: user`".

So a tick in Work ▸ Today is:

```
POST /api/vault-tasks/:task_key/check     (console, owner session only)
  → GET  /vault/read   path=Journal/2026-09-18.md
  → find the line by anchor; refuse if it is not there, if it is already
    checked, or if the line's text differs from what the client was shown
  → flip exactly `[ ]` → `[x]` and append ` done <today>`
  → POST /vault/write  expected_sha256=<what we just read>
                       intent: { principal: "user",
                                 message: 'complete "Call the dentist"' }
```

Four properties make that safe enough to call the user's hand:

1. **The route is incapable of anything else.** It takes a `task_key`, not a
   patch. It can produce exactly two byte changes and refuses every other
   outcome rather than falling back to a rewrite. Enforced at the tool, per
   `CLAUDE.md`'s closing principle — and the misuse tests ship with it
   (invariant 8): a `task_key` in a note whose bytes moved → `409`; a line
   whose text no longer matches → `409`; a `task_key` resolving to a
   `.metistry/` path → `forbidden`.
2. **No model is anywhere in it**, at any point, in any tier.
3. **It is initiated by the owner's authenticated gesture** on a surface that
   shows the exact line before it is touched.
4. **It is not an agent-reachable action.** `ACTION_KINDS` stays
   `["dispatch","task_update","comment","capture"]`
   (`packages/core/src/actions.ts:34`). Nothing is added to it, so
   `propose_action` can never ask for this, at any autonomy level. Invariant 10
   says a new console action is a *product change, never a prompt or a config
   line* — this spec is that product change, and the new door is enumerated,
   owner-only, and closed to agents.

**Open question Q2 (§15) asks the owner to confirm this reading**, because it
is the single place where the spec interprets Q3 rather than obeying it
literally.

**One behaviour to verify before phase 2, not assumed here:** whether Obsidian
writes through a checkbox ticked inside an embed (`![[note#^mt-…]]`) to the
source line. If it does, the transcluded plan is complete-in-place for free. If
it does not, the plugin supplies the affordance on the rendered line. Ticket
P2-7 is a 30-minute spike that answers it; nothing else in the design turns on
the answer.

### 2.3 The same task typed twice

The index stores both — they are two lines, and markdown is the record. Then:

- `duplicate_of` links the later-seen to the earlier when `text_norm` matches
  and both are open. Deterministic, no model.
- The global task view **collapses the group into one row** with a "2 places"
  chip; opening it lists both paths.
- `plan-tomorrow` raises **at most one** `report` proposal per duplicate group,
  ever: *"`Call the dentist` appears in Journal/2026-09-16.md and
  Journal/2026-09-18.md — keep one?"*, carrying both paths as `refs`. It is
  re-raised only if both are still open `METISTRY_DUPLICATE_RENUDGE_DAYS`
  (default 14) later. Nothing merges, nothing deletes; the user opens one and
  ticks it.

A *deliberate* duplicate — the same errand for two different projects — is
answered once with Skip (`docs/ops/reply-feedback.md:20`), which settles the
group and writes the fixed skip marker rather than the user's words.

---

## 3. Agent work that waits on a human

`work.depends_on` is `bigint[]` and `DEPS_CLOSED` joins it back to `work`
(`db/migrations/0002_review_decisions.sql:39`;
`packages/tasks/src/index.ts:148-155`). It cannot hold `^mt-7x2k` and must not
learn to.

**The design:**

- A `work` row waiting on a human todo carries
  `meta.blocked_by = "vault:Journal/2026-09-18.md#^mt-7x2k"` — `work.meta` is
  the free-form, service-owned slot that already exists for exactly this kind
  of source metadata (`db/migrations/0006_work_meta.sql:5`). No migration.
- **It surfaces; it never gates.** `DEPS_CLOSED` is untouched, claimability is
  untouched, and an agent may still take the row. Three reasons: the board's
  `blocked` state is the one state only the user's hand can leave
  (`docs/ops/board.md:44`) and inventing a second, file-driven way in would
  undo that; the index is up to `METISTRY_RECONCILE_INTERVAL_SEC` (default 300,
  `.env.example:173`) stale, so a typo would stall a crew for five minutes
  before anyone could see why; and the owner asked for *visibility*, not
  scheduling.
- **The board** gains two scalar columns in `seed/queries/board.yaml`:
  `blocked_by_task` (the text of the human todo) and `blocked_by_task_open`
  (a `LEFT JOIN vault_tasks`). The card renders "waiting on you: Call the
  dentist". `escalated` is deliberately **not** widened — `docs/ops/board.md:87-97`
  rules that a fourth clause needs its own sentence and its own decision, and
  this is not it.
- **The daily plan** gains a section, from one named query:

  ```
  ## ⛔ Agents are waiting on you (2)
  - Call the dentist — blocks work #418 "Book the follow-up"
  - Sign the SOW — blocks work #431
  ```

- **The reverse direction** is the `work:418` token on a task line: the index
  sets `vault_tasks.work_id` and the plan shows the row's status and board
  column beside the todo. Promotion (a markdown task handed to an agent) writes
  `work.external_ref = 'vault:<path>#^mt-…'`, whose partial unique index
  (`db/migrations/0005_work_external_ref_unique.sql:3`) makes a second promotion
  a no-op. Promotion is one-way; there is no demotion, and the UI must not
  imply one.

---

## 4. Recurring tasks

**The rule lives on a line, in English**, in a note the user chooses — usually
`Me/Routines.md` or the relevant project note:

```markdown
- [ ] Water the plants every week
- [ ] Standup notes every weekday type meeting size s
- [ ] Pay the card every month due 28
```

Grammar: `every (day│weekday│week│N weeks│month│N months│year)`, optionally
with `due <day-of-month>` or `due <weekday>` to pin where in the period it
falls. Parsed into `recur_rule` (verbatim) and `recur_next` (computed). A rule
line is **never itself a task**: `recur_rule IS NOT NULL` excludes it from
every "open tasks" query, and it is shown in the app under Recurring.

**Rejected: RRULE.** It is unreadable in a note the user is meant to edit, and
the owner's cases are "every day, week, month".

**Who materialises the day's instance:** the **daily-note template**, at the
moment the user creates the note.

```markdown
## Today

{{ recurring due: today }}
```

renders

```markdown
- [ ] Water the plants source template:recurring ^mt-9k4p
```

That resolves Q3 structurally rather than by restraint: the instance is written
by the same action, in the same hand, in the same second as the note it lands
in — the user's own template action. No routine writes a task into a note the
user owns, ever.

**`plan-tomorrow` proposes, and does not materialise.** Tomorrow's plan lists
the recurring instances that will be due under "Recurring tomorrow", so they are
visible before the note exists. It writes only its own machine file.

**Runaway generation is bounded three ways, structurally:**

1. **One open instance per rule, ever.** The `recurring` directive skips a rule
   whose previous instance (`recur_parent = <rule's task_key>`) is still
   unchecked, and renders it as a carry-over line instead
   (`- [ ] Water the plants — carried, 3rd time`). A month away from the vault
   produces one line, not thirty.
2. **Instances only exist for days the user opened a note.** Nothing runs on a
   schedule to create them.
3. **A per-render cap** (`METISTRY_RECURRING_MAX_PER_DAY`, default 12) with the
   overflow rendered as `…and N more recurring (see Work ▸ Today)`.

---

## 5. Files

### 5.1 One writer per file

The owner's ruling, made mechanical: *"I can stay focused on `Journal/date.md`
and `Journal/Meetings/date-topic.md`, and you can keep a continuous set of
edits going in `Journal/Plan/*` and `Journal/Fold/*`."*

| Path | Writer | `source:` | Contents |
| --- | --- | --- | --- |
| `Journal/<date>.md` | **the user only** | `user` | the day's notes, tasks, thoughts |
| `Journal/Meetings/<date>-<topic>.md` | **the user only** | `user` | attendees, decisions, action items |
| `Journal/Plan/<date>.md` | `plan-tomorrow` | `plan-tomorrow` | schedule, today's tasks + why, carry-overs, what agents are waiting on |
| `Journal/Fold/<date>.md` | the assistant's fold turn | `knowledge-fold` | what happened, what was decided, `decisions:` frontmatter |
| `Journal/Standup/<date>.md` | `standup-draft` | `standup-draft` | yesterday / today / blockers, rendered from `Templates/Standup.md` |

The daily note **embeds** the machine files (`![[Journal/Plan/2026-09-22]]`,
`![[Journal/Standup/2026-09-22]]`, `![[Journal/Fold/2026-09-22]]`), so the
user opens one page and reads five files.

**Why a separate `Journal/Standup/` rather than a section inside the plan:**
the plan is written the evening before and the standup the following morning.
Two runs at two times writing one file is the conflict the whole scheme exists
to avoid. Files are cheap; a second writer is not.

**Why `-` and not a space in the meeting filename:** the owner's spelling
(`Journal/Meetings/date-topic.md`) wins over the plan's
(`metistry-build-plan.md:1713`, `Journal/Meetings/2026-08-29 <topic>.md`), and
it avoids a space inside a link target. Logged in §13.7.

**The backstop is already at the tool.** `ownershipRefusal`
(`packages/mcp-brain/src/knowledge-write.ts:262-268`) refuses an assistant
write to any note whose `source:` is not the caller's own or `knowledge-fold`,
and since #231 a note with **no** `source:` is the user's, not free. So the
five-file split is the mechanism and the refusal is the belt behind it, in that
order.

**This moves shipped behaviour.** The fold writes `Journal/<date>.md` today
(`routines/knowledge-fold/run.ts:104`, `seed/assistant-prompt.md:40`,
`docs/ops/knowledge-fold.md:22-23`). Ticket P1-9 moves it to
`Journal/Fold/<date>.md`. Logged in §13.2.

### 5.2 Archiving — `metistry archive`

Recent files stay flat; older ones move to `<folder>/<year>/<month>/`, keeping
the basename:

```
Journal/2026-09-18.md                    ← flat, recent
Journal/2026/01/2026-01-05.md            ← archived, basename unchanged
Journal/Plan/2026/01/2026-01-05.md
Journal/Meetings/2026/01/2026-01-05-q4-planning.md
```

**Who does it: a CLI verb the user runs.**

```
metistry archive [--older-than 90d] [--dry-run]
```

**Rejected: the reconciler doing it mechanically.** The reconciler is the sole
committer and the one process that must stay boring. Its rename handling
*observes* a rename by content hash and re-keys the index
(`apps/reconciler/src/indexer.ts:143-155`); it has never initiated a move. And
where a file lives is the user's organisation — invariant 2's territory — not
something a 300-second loop should decide.

**Rejected: the plugin doing it.** Two implementations of one behaviour. The
plugin does not move files.

**Links do not break, and here is the exact reason.** `resolveLink`
(`apps/reconciler/src/notes.ts:91-103`) resolves a target as: exact
vault-relative path → path relative to the linking note's directory → **unique
basename match anywhere in the vault**. Obsidian resolves the same way. So:

- **The basename is preserved byte for byte.** `Journal/2026-01-05.md` becomes
  `Journal/2026/01/2026-01-05.md`, never `Journal/2026/01/05.md`. Every
  `[[2026-01-05]]` and `![[2026-01-05#^mt-7x2k]]` in the vault keeps resolving
  with **no rewrite at all**, in Obsidian and in the index.
- **Path-spelled links are rewritten.** `[[Journal/2026-01-05]]` would break, so
  the verb rewrites exactly those: for each moved file it finds occurrences of
  the old path string (with and without `.md`, wikilink and markdown forms) in
  every note body, replaces them with the new path, prints each rewritten line,
  and commits all of it in one commit as `principal: user`.
- **The move refuses if the basename would stop being unique** after it. That
  cannot happen for dates, and it is the misuse test.
- **No re-embed.** Same bytes at a new path: the reconciler's hash-based rename
  detection re-keys `knowledge_files`, `knowledge_links` and the vectors
  (`indexer.ts:143-155`), exactly as `metistry-build-plan.md:1739-1742`
  designed.

The verb writes through the bridge (`POST /vault/rename`,
`apps/reconciler/src/server.ts:213`) as `principal: user` — which is how
`metistry` already writes protected files
(`packages/cli/src/protected-write.ts:53-70`). `rename` is exposed on the
bridge and deliberately not to the assistant
(`packages/mcp-brain/src/knowledge-write.ts:33`); this does not change that.

`--older-than` reads `METISTRY_JOURNAL_FLAT_DAYS` (default 90). It must be
`intEnv`-wired, not a literal: `ops/scripts/audit-limits.mjs` scans
`packages/**/src` and would fail CI on a bare constant.

The weekly review adds one line when more than 60 files are flat and older than
the threshold: *"`metistry archive` would move 84 files"*. It never runs it.

---

## 6. Templates with directives

### 6.1 Where templates live — `Templates/`, in the vault

Four reasons, and one counter-argument answered:

1. **Obsidian cannot see `.metistry/`.** It is dot-prefixed precisely so
   Obsidian ignores it (`packages/core/src/instance-layout.ts:6-7`). A template
   the user edits constantly, in Obsidian, cannot live where Obsidian is blind,
   and Templater/QuickAdd take a *vault* folder.
2. **`.metistry/` is protected** — `writeAllowed` admits only `principal: user`
   there (`apps/reconciler/src/paths.ts:132-135`). Protection is the opposite of
   what a file the user edits hourly needs.
3. **The plan already put them there** — `Templates/` is in the §4.15 tree
   (`metistry-build-plan.md:1601`) and "Templates ship in `seed/` (stamped to
   `Templates/`)" (`:1726`). Nothing has stamped them yet; this closes the gap.
4. **TitleCase at the vault root** is the casing rule, and
   `ops/scripts/check-path-case.sh` already exempts `seed/vault/` from the
   lowercase rule, so the seed copies need no new exception.

**The counter-argument**: a template shapes what the system produces, so
invariant 2 says it is the user's hand. It stays the user's hand, and not by
convention: the seeded templates ship with `source: user` in their frontmatter,
so `ownershipRefusal` refuses any assistant write to them
(`packages/mcp-brain/src/knowledge-write.ts:262-268`). Routines only read them.
Confirmed as open question Q5.

Seeded files, stamped by `metistry init` from `seed/vault/Templates/`:
`Daily.md`, `Meeting.md`, `Plan.md`, `Standup.md`, `Fold.md`, `Weekly.md`.

### 6.2 The grammar

One directive per line, on its own line:

```
{{ verb "positional" key: value key: "value" }}
```

No expressions, no arithmetic, no conditionals, no nesting, no recursion. Eight
verbs and one block form — the ceiling is deliberate, and a ninth verb is a
product decision, not a config line.

| # | Directive | Backed by | Example |
| --- | --- | --- | --- |
| 1 | `date` | pure | `{{ date format: "YYYY-MM-DD" offset: 1 }}` |
| 2 | `tasks` | named query `vault_tasks_query` | `{{ tasks where: "due <= today or overdue" order: "priority, due" limit: 10 as: "list" }}` |
| 3 | `recurring` | named query `vault_tasks_recurring` | `{{ recurring due: today }}` |
| 4 | `calendar` | bridge `GET /events` (`packages/mcp-eventkit/src/index.ts:74-78`) | `{{ calendar day: today }}` |
| 5 | `work` | named query `day_work` | `{{ work where: "blocked or waiting_on_me" limit: 5 }}` |
| 6 | `requests` | named query `pending_requests` | `{{ requests limit: 5 }}` |
| 7 | `include` | `GET /vault/read` (`apps/reconciler/src/server.ts:155`) | `{{ include "Me/Working Style.md#Prioritisation" }}` |
| 8 | `prose` | one assistant turn, **fold templates only** | `{{ prose "summarise yesterday in three lines" using: "Journal/Fold/{{date offset: -1}}" }}` |
| — | `section` … `{{ /section }}` | wrapper | `{{ section "Things due today" if_empty: "hide" }}` |

**The filter vocabulary (D15).** `where:` is **not SQL and is never
interpolated into SQL.** It is a closed predicate language the renderer
*compiles into bind parameters* of one named query — which is what keeps
invariant 3 intact (`packages/queries/src/index.ts:1-4`: "parameterized
execution, NEVER string interpolation"; `:181-187` refuses unknown params
loudly).

```
predicate := clause (("and" | "or") clause)*
clause    := field op value | flag
field     := due | do | start | done | priority | size | type
           | assigned | project | area | source | status
op        := <= | < | = | >= | >
value     := a date literal | today | tomorrow | yesterday | +Nd | p1..p4
           | s|m|l | a slug | [[A Page]]
flag      := overdue | unscheduled | waiting | recurring | carried
           | blocking_agent | assigned_to_me
order     := a comma list of fields, each optionally `desc`
```

Anything outside that grammar is a render-time failure note (§6.4). The same
vocabulary is what the app's filter chips emit and what the plugin's suggester
builds — one language, three consumers, one parser
(`packages/core/src/task-filter.ts`).

The size-to-minutes map (`S`=15, `M`=45, `L`=90) and the day's capacity come
from `Me/profile.md`, never from a literal in code.

### 6.3 Evaluation

1. **One pass, top to bottom.** The renderer reads the template through
   `GET /vault/read`, substitutes each directive in place, and writes the result
   through `POST /vault/write` under its own principal with
   `expected_sha256` from the read.
2. **`include` splices literal text.** Directives inside an included file are
   **not** evaluated. Recursion is where a template engine becomes a program and
   where a user can build a loop; and the included file is a user note whose
   `{{ }}` should not execute.
3. **`prose` is the only directive that reaches a model, and it is legal only
   in a template whose output file the assistant owns.** In practice that means
   `Templates/Fold.md` → `Journal/Fold/<date>.md`, because
   `ownershipRefusal` admits exactly two sources for an assistant write: the
   caller's own, and `knowledge-fold`
   (`packages/mcp-brain/src/knowledge-write.ts:266`). A `prose` directive in
   `Templates/Plan.md` renders a failure note naming this rule, at render time,
   every time — because a routine calls no model (invariant 4) and the plan file
   is `source: plan-tomorrow`, which the assistant may not write.
   The mechanism for a legal `prose`: the fold routine renders `Fold.md`,
   collects every `prose` directive into **one** numbered list on the existing
   fold turn (`docs/ops/knowledge-fold.md:49-55`), and the assistant writes the
   file with the slots filled via `knowledge_write` — the write it already does
   today, to a file it already owns. No new channel, no new tool.
4. **A rendered machine file ends with a provenance footer:**

   ```
   <!-- rendered by plan-tomorrow from Templates/Plan.md (sha256 3f9c…) at 2026-09-21T19:04Z -->
   ```

   so "why does my plan look like that" has an answer that names a file.
5. **Size cap.** `METISTRY_TEMPLATE_MAX_BYTES` (default 16 KB). A directive
   that would exceed it truncates with `…and N more`, the fold's own convention
   (`docs/ops/knowledge-fold.md:46-47`).

### 6.4 Failure modes — all visible, none fatal

| What went wrong | What renders | Run outcome |
| --- | --- | --- |
| unknown directive | `> ⚠️ metistry: unknown directive \`foo\` (Templates/Plan.md:12)` | `ok`, `meta.template_warnings: 1` |
| unknown key, or a `where:` the parser refuses | `> ⚠️ metistry: can't read \`where: "due soonish"\` (Templates/Plan.md:14)` | `ok`, counted |
| a source that is not configured | `> ⚠️ metistry: no calendar — the eventkit bridge is not reachable` | `ok`, counted |
| a query returned nothing | `_nothing due today_`, or the section vanishes under `if_empty: "hide"` | `ok` |
| `prose` in a template the assistant may not write | `> ⚠️ metistry: \`prose\` is only available in a fold template (§6.3)` | `ok`, counted |
| the template file is missing | the routine writes **nothing** and records `skipped: template_missing` | `ok`, silent — a missing template is a configuration fact, not a failure |
| the template is not valid UTF-8 or exceeds the cap | nothing written, `skipped: template_unreadable`, one `report` request naming the file | `ok` |

**Absent is not failed.** No calendar bridge is a fact rendered in the plan, the
same distinction the design system already draws between `absent` and `failed`
(`docs/product/design-system.md` §3.15, §3.16). A template that cannot be fully
satisfied still produces a file — a day with no plan because the calendar was
down is the worst possible outcome.

### 6.5 When a change takes effect

**The next run.** The template is read from the vault on every run; nothing is
cached across runs. Editing `Templates/Plan.md` at 18:00 changes the plan
written at 19:00.

**Today's already-written file is never re-rendered.** One writer, one file, and
rewriting a note the user may already have read is worse than being a day stale.
`metistry template render --template Templates/Plan.md --date today --dry-run`
prints what it *would* produce, for iterating without waiting.

### 6.6 Where the user's prose rules live

`Me/` — the plan already says `Me/profile.md` carries the machine-readable core
as typed frontmatter and that `rules.yaml` *references* profile values rather
than duplicating them (`metistry-build-plan.md:1687-1692`). Two files:

```yaml
# Me/profile.md — frontmatter. Nothing can guess these (Q4).
timezone: America/New_York
working_days: [mon, tue, wed, thu, fri]
working_hours: "09:00-17:30"
daily_capacity_min: 240
standup_days: [mon, tue, wed, thu, fri]
standup_time: "09:15"
task_size_minutes: { s: 15, m: 45, l: 90 }
today_cap: 3
```

```markdown
# Me/Working Style.md

## Prioritisation

Prioritise anything due tomorrow, then everything P1, then as many small tasks
as fit the day. Deep work before the first meeting. Never more than one large
task on a day with two or more meetings.

## Standup

Yesterday / today / blockers. Skip anything that is not in a shared repo.
```

The prose sections are **included verbatim** into the rendered plan by
`{{ include "Me/Working Style.md#Prioritisation" }}`. They are not executed.

**This is how Q8 is honoured without breaking invariant 4.** The ordering a
routine performs is deterministic and declared in the template (`order:
"priority, due, size"` — a field list, not a sentence). The user's *rule* is
prose the human reads, and which any later assistant turn reading the plan can
act on. The alternative — a routine asking a model "which of these fits my
rule?" — is exactly what invariant 4 forbids, and this spec does not do it. If
the owner later wants the plan *composed* by a model rather than ordered by a
field list, that is a `prose` directive in a fold-owned file, and §15 Q6 asks
the question.

**Degrading honestly.** No `working_days` → `plan-tomorrow` and
`standup-draft` write nothing and record `skipped: no_working_days` on the run,
rather than guessing Monday-to-Friday. `metistry doctor` reports it as
`absent: Me/profile.md has no working_days` with the remediation.

---

## 7. Routines

| Routine | Schedule | Gate (in the routine) | Reads | Writes |
| --- | --- | --- | --- | --- |
| **`knowledge-fold`** *(extend)* | `@hourly` | ≥18:00 local, once/day, already shipped (`routines/knowledge-fold/run.ts:239-254`) | + a fifth handle group: `knowledge_files` paths changed today under `Journal/` and `Inbox/`, **excluding** `Journal/{Plan,Fold,Standup}/`; + `vault_tasks` closed today | one assistant turn → `Journal/Fold/<date>.md` (moved, §13.2) rendered from `Templates/Fold.md`; task proposals |
| **`plan-tomorrow`** *(new)* | `@hourly` | ≥19:00 local, after the fold's anchor, once/day, and only if tomorrow is a working day | `vault_tasks`, `work`, `proposals`, `GET /events?days=2`, `Templates/Plan.md`, `Me/` | `Journal/Plan/<tomorrow>.md` |
| **`standup-draft`** *(new)* | `@hourly` | within the hour before `standup_time`, `standup_days` only, once/day | yesterday's plan, `vault_tasks.done_on`, `work.closed_at`, `work` blocked, `Templates/Standup.md` | `Journal/Standup/<today>.md` |
| **`morning-brief`** *(extend)* | `@daily` | — | + today's Plan and Standup files | `outbound_messages` (unchanged) |
| **`weekly-review`** *(extend)* | `@weekly` | — | + ageing, completion rate, counts by `source`, the archive nudge | `outbound_messages` (unchanged) |

**`@hourly` plus a gate, not real cron.** `scheduleToSeconds` converts a
schedule to an *interval* (`packages/core/src/schedule.ts:16-25`) and the
runner marks a routine due from its last `routine_run` row — so an `@daily`
routine that skipped at 09:00 would be due again at 09:00 tomorrow and never
reach the evening (`docs/ops/knowledge-fold.md:63-75`). Hourly ticks plus a gate
give one run a night, retried until it lands. Widening the parser to real cron
is the right end state and is **not this work**: `scheduleToSeconds` returns an
interval that two callers use for two different things — the runner's "is it
due" and the watchdog's silence budget — so real cron needs a
`nextFireTime(schedule, after)` in both, with the watchdog's alerting re-tuned.
Its own PR, and when it lands it deletes three gates.

**Manifests declare what they need**, so a run never spends a window
misconfigured (`packages/core/src/manifest.ts:84-88`;
`packages/core/src/preflight.ts:22-28`):

```yaml
# routines/plan-tomorrow/manifest.yaml
name: plan-tomorrow
type: routine
description: >
  Renders tomorrow's plan from Templates/Plan.md — the day's events, the tasks
  the template asks for in the order it asks for, carry-overs, what agents are
  waiting on, and the user's own prioritisation prose included verbatim.
  Model-free (invariant 4); writes exactly one machine-owned file and never a
  note the user owns. Hourly because the runner has no time of day; it plans
  once an evening and is silent otherwise.
schedule: "@hourly"
requires:
  env: [METISTRY_RECONCILER_URL, METISTRY_BRIDGE_TOKEN_RECONCILER]
  reachable: [METISTRY_EK_URL]   # the eventkit bridge (.env.example:160-162); degrades absent — the plan renders, without the schedule
```

**How a routine writes.** `POST /vault/write` with `expected_sha256` and
`intent: { principal: "plan-tomorrow", message: "plan for 2026-09-22" }`
(`apps/reconciler/src/vault.ts:38-47`, `:229-246`) — the same door
`captureToInbox` uses (`docs/ops/inbox.md:32-42`). The routine puts
`source: plan-tomorrow` in the rendered frontmatter itself; the reconciler
bridge does not stamp provenance (only `mcp-brain` does, via `stampProvenance`,
`packages/mcp-brain/src/knowledge-write.ts:150-194`). A conformance test pins
that every machine-owned journal file carries the right `source:`, because
that string is what `ownershipRefusal` reads later.

**The fold's extra job**, in `seed/assistant-prompt.md`'s fold section:

> **Tasks you found.** For each unchecked `- [ ]` line in today's notes that
> the index has not already seen, and for each action item stated in a meeting
> note or transcript, raise **one** request carrying `suggested_work` — title,
> `project` if a slug is named, `refs` pointing at the note path and line.
> Never write a task into a note. Never create a row. Nothing found: one line
> saying so.

`suggested_work` already exists and already drives the Approve-as-Work button
(`docs/ops/reply-feedback.md:60-82`); the fold becomes a second producer of it
beside `inbox-drain` (`collectors/inbox-drain/run.ts:115-140`), which is
explicitly allowed. **Precision, not recall**, and the two guards are
deterministic and live in the routine, not the prompt: dedupe by `text_norm`
against open `vault_tasks` and `work` before the request is written, and a cap
of `METISTRY_FOLD_MAX_TASK_REQUESTS` (default 5) per fold, so one bad night
cannot flood the queue.

---

## 8. Capture paths in scope

| Path | Status | Shape | Direction |
| --- | --- | --- | --- |
| Vault notes (`- [ ]`) | **new, phase 1** | the reconciler walk → `vault_tasks` | n/a — the note is the record |
| Meeting notes + transcripts | **new, phase 1/4** | same parser; transcripts land as `Inbox/` captures, `kind: transcript` | in |
| Quick capture (`+`, `/note`, `POST /capture`) | **exists** | `docs/ops/inbox.md:16-30`; the composer gains a task mode whose first body line is `- [ ] …`, which `TASK_CUE_RE` already recognises (`collectors/inbox-drain/run.ts:54`) — **no server change** | in |
| Calendar | **exists (read)** | `GET /events` (`packages/mcp-eventkit/src/index.ts:74-78`) | in |
| **Apple Mail**, second instance | **new, phase 3** | §8.2 | in |
| **Linear** | **new, phase 4** | §8.3 | in (+ a fold-back proposal) |
| Devin | **exists** | `collectors/devin-knowledge`, `targets/devin-sessions` (`docs/plan-refresh-2026-09-13.md:441-442`) | in |
| GitHub | **exists** | `collectors/github-state` | in |

**Out of scope now, by ruling:** Apple Reminders (R11, Q5 — "skip, keep it in
markdown"), Slack (R13 — later, possibly via Devin), personal email as a direct
connection (R12 — the abstracted connection only).

**The sync rule, stated once:** exactly one system owns each item's state and
names itself in the `external_ref` prefix; everything is one-way in with
provenance; a collector never invents status (`metistry-build-plan.md:1286`);
a collected row is never claimable (`docs/ops/board.md:26-32`); idempotency is
a key, never a heuristic; and **no inbound source may create a task** — every
door lands as a proposal.

### 8.2 The `apple-mail` bridge

Read-only, allowlisted, on the second instance. Swift, because a TCC grant
attaches to the responsible process and `brew upgrade node` would drop a grant
held by a node binary — the Phase 0 ruling on stably-signed Swift binaries (D3,
invariant 6) is exactly this case.

```yaml
# packages/mcp-apple-mail/manifest.yaml
name: apple-mail
type: bridge
description: >
  Read-only Apple Mail on this Mac. Lists and reads messages from an
  allowlisted set of accounts and mailboxes and nothing else: no send, no
  reply, no move, no delete, no flag, no attachment content. Bodies are
  reduced to text and secret-redacted before they leave the helper.
transport: http
port: 7812
runs_on: host            # TCC-bound; its own launchd service is its own responsible process (PoC-1)
requires_tcc: [full_disk_access]
discovery: eager         # 2 tools
degrades: absent         # no Mail on this Mac, or the grant was never given
exposes:
  - name: list_messages
    description: Message handles from an allowlisted mailbox since a date — id, date, from, to, subject, mailbox, attachment names, redacted snippet. Never bodies.
  - name: read_message
    description: One message by id — a header subset and its text body, html reduced to text, secret-redacted, capped. Refused for any mailbox outside the allowlist.
```

`full_disk_access` is **already** in the manifest's TCC enum
(`packages/core/src/manifest.ts:30-36`) — the research note's claim that it
would be a new grant kind was true at `2aba1fb` and is not true now. The
schema's `superRefine` (`:57-69`) already forces `transport: http` +
`runs_on: host` for any `requires_tcc` bridge, so the manifest above validates
with no core change at all.

**Shape: read `~/Library/Mail/V*/` directly.** Rejected: driving Mail.app over
AppleScript/ScriptingBridge — it needs Mail running, it is a per-app-pair
Automation grant that is fragile across upgrades, and it is a round trip per
message. The store is plain files.

The honest cost of that choice, stated rather than discovered later: the
on-disk layout is undocumented and has changed between macOS versions. So
`check()` is behavioural, like eventkit's
(`packages/mcp-eventkit/src/index.ts:57-72`): it opens an allowlisted mailbox,
counts messages in the last 24 hours, and reports the `V<n>` it found. An
unrecognised layout is `failed` with a remediation naming the directory — never
a silent empty result.

**Enforcement, all in the Swift helper, not the TypeScript wrapper:**

- **`METISTRY_MAIL_ALLOW`** — `account/mailbox` globs. A mailbox outside it is
  not listable, and a message id inside it is not readable even if guessed.
  Misuse tests ship with the interface (invariant 8): denied mailbox →
  `forbidden`; guessed id in a denied mailbox → `forbidden`; traversal in a
  mailbox name → `invalid_request`.
- **Secret redaction by default** (`CLAUDE.md`, the wire contract): OTP-shaped
  digit runs, `Authorization:`-shaped strings, long base64 blobs and anything
  matching a configured pattern are replaced before the text leaves the helper.
  PoC-13's worst failure was flagging OTP mails; redaction is the cheap half of
  not doing that again.
- **No store of its own.** The bridge caches nothing, so §4.12's "days, not
  years" retention rule for raw comms (`metistry-build-plan.md:1523-1526`) holds
  by construction: the only copy that persists is whatever a proposal carries,
  and the user decided that.
- **No attachment content, ever.** Names and MIME types only.

**What the collector does with it** (`collectors/mail-triage`, the policy half):

| Mail shape | Detected by | Becomes |
| --- | --- | --- |
| Gemini meeting notes | sender address on an allowlist + subject shape | a `knowledge` proposal carrying a **draft meeting note** for `Journal/Meetings/<date>-<topic>.md` — the user's Approve writes it, and it is the user's file thereafter |
| A request addressed to the owner | deterministic cues on the first lines, the same shape `suggestedWork` already uses (`collectors/inbox-drain/run.ts:115-140`) | a proposal carrying `suggested_work` → **Approve as Work** |
| Travel | airline/hotel sender allowlist | a `report` request with the itinerary as handles. **No calendar write** — `create_event` is preview-then-confirm and nothing automates it |

**The gate, and how phase 3 stays buildable.** PoC-13's verdict is "do not
build the ingest" and its bar is *≥80% precision on a held-out labelled set
**and** zero misses on a hand-labelled must-catch stratum*
(`metistry-build-plan.md:1513-1519`). That bar is about *extraction*, not about
reading mail. So phase 3 ships the bridge plus **sender-allowlisted,
deterministic** rules only — three known senders, no model, precision by
construction — and model extraction over the general mailbox stays gated on
the bar being re-run. The collector's manifest declares no `uses_model` at all,
which CI can see.

**One real limitation, named now.** Gemini often sends meeting notes as a
Google Doc *link* rather than inline text. When the body carries the notes,
this works; when it carries only a link, the proposal carries the link and says
so, because fetching it would need a Google bridge, Google credentials, and an
assumption about a shared account — a different project (§15 Q3).

### 8.3 Linear

`collectors/linear-state`, built on the `github-state` pattern: upsert `work`
rows on `external_ref = 'linear:ABC-123'` (unique-indexed already,
`db/migrations/0005_work_external_ref_unique.sql:3`), reconcile status from the
source, close rows that vanished, never invent status
(`metistry-build-plan.md:1286`). One-way in. `kind: 'issue'`, so the rows are
visible and not claimable (`docs/ops/board.md:26-32`).

**Fold-back on completion.** A task line may carry `linear:ABC-123`. When that
row closes, `plan-tomorrow` raises **one** `report` request: *"ABC-123 is
closed — tick `- [ ] Write the migration` in Journal/2026-09-18.md?"* with the
path and line as `refs`. Nothing writes. From phase 2, the request's answer and
the Today view's one-tap complete are the same mechanical write (§2.2).

### 8.4 Transcripts

A transcript lands as a **capture** — a `.md` or `.vtt` in `Inbox/` with
frontmatter `kind: transcript`, which the reconcile scan already picks up
(`apps/reconciler/src/indexer.ts:304-337`). Two rules come with it, because a
transcript is a recording of other people (the owner ruled consent is collected
in the meeting, Q7; this is about who can read it afterwards):

- **Reader/writer separation** (`metistry-build-plan.md:1476-1483`): the turn
  that reads a transcript holds no vault-commit and no durable-memory tool. It
  emits proposals.
- **Transcripts land under `Journal/Transcripts/`, outside every default
  grant.** The assistant's default area list names `Journal`
  (`.env.example:68`), which would include it, so the default becomes
  `Journal` narrowed or `Journal/Transcripts` explicitly excluded. §15 Q4 is
  the owner's, because the prefix semantics make exclusion awkward and it also
  bears on retention — a transcript committed to git is forever.

---

## 9. The Obsidian plugin

**Recommendation: build one, small, at `plugins/obsidian/`** — beside the
existing `plugins/claude-code`, `plugins/cursor`, `plugins/opencode`.

Four jobs, and a hard ceiling at four:

1. **Task metadata UI.** A command and an inline suggester on the current line:
   due, priority, size, type, assignee, recurrence, picked from a list and
   written as the shorthand of §1.1. **The owner never types `due 2026-09-22`.**
   This is the plugin's reason to exist.
2. **Mint the anchor.** On save, any `- [ ]` line without `^mt-` in a
   configured folder gets one. The user's editor, the user's hand, the user's
   commit — which is what makes §1.2's rule ("no routine ever writes an anchor")
   affordable.
3. **Complete in a mirror.** In a rendered plan or person view, completing the
   shown line completes the canonical line. If Obsidian's own embed write-through
   already does this (ticket P2-7), the plugin does nothing here.
4. **Directive preview.** Render an open `Templates/*.md` with today's data,
   read-only, in a side pane — so the user can see tomorrow's plan before the
   routine writes it. It calls the console's
   `GET /api/templates/preview?path=…&date=…`.

**The vault stays fully readable with no plugin at all**, and that is a
constraint the design already satisfies rather than a promise:

- The tasks are GFM checkboxes. Every renderer on earth shows them.
- The metadata is English words in the line.
- The anchors are **native Obsidian block ids**, which Obsidian is believed to
  hide in reading mode — ticket P2-7 confirms that alongside the embed
  question, and if it does not, the plugin's reading-mode postprocessor does.
  In source mode `^mt-7x2k` is eight quiet characters at the end of a line.
- `@[[Jim Fallon]]` is a native wikilink, so the person page's task list is
  Obsidian's own **backlinks pane** — no plugin, no query language.
- Uninstall the plugin and nothing breaks: the index keeps working off the
  text, and the only thing lost is the ergonomics of *writing* the metadata.

**Not Dataview or Tasks as the substrate**, for three reasons already argued:
Tasks' default emoji format is unreadable in a diff and binds meaning to a
third party's glyph table; Dataview's `[k:: v]` renders as literal text without
it, which the owner rejected (Q2); and neither can mint the anchor. But the
**parser reads both** (§1.4), so a user who already runs them is not locked
out. One writer, several readers.

**Distribution.** The plugin is product code, and code flows down as releases:
`metistry up` / `metistry update` install and refresh it into
`<instance>/.obsidian/plugins/metistry/`, and an instance migration adds
`.obsidian/plugins/` to the instance `.gitignore` (today only
`.obsidian/workspace*` is ignored,
`packages/core/src/instance-layout.ts:80-84`). Without that line the plugin's
build output would be committed to the user's vault repo.

---

## 10. App surfaces

**No new top-level section.** The sidebar is settled at six rows plus Pinned
(`docs/product/app-ux-plan.md:614-624`), and Work's children are Board ·
Projects · Artifacts · Rooms (`:170`). This adds **one child** —
**Work ▸ Today**, the fifth — and one card type.

| Surface | Where | New? |
| --- | --- | --- |
| The day's plan and standup draft | **Feed** (a new row type) and **Work ▸ Today** | row type: new |
| **Today** — the day's tasks, carry-overs, capacity, what agents are waiting on | **Work ▸ Today**, 5th child | **new** |
| The global task view | a **mode of Today** (segmented: Today / All), not a sixth child | **new** |
| Task proposals | the **bell**, six-answer card, Approve as Work | exists (`docs/ops/reply-feedback.md:8-21`) |
| Quick-add a task | the **"+"** composer, task mode | composer exists (`app-ux-plan.md:220`) |
| Person and project pages | **Knowledge ▸ Pages** (phase E) + a "Tasks on this page" strip from `vault_task_refs` and `assigned` | strip: new |
| Templates | **Settings ▸ Templates**, read-only with "edit in Obsidian" and a live preview | **new**, small |

**One filter vocabulary (D15).** The chips on the All view emit exactly the
`where:` language of §6.2 and hit the same named query with the same bind
params. Saved views are a stored `where:` string, so a view the user builds in
the app can be pasted into a template and vice versa. This is the single
highest-leverage decision in §10: without it there are three filter languages
within a year.

**What the designer needs** (a list, not a design):

1. A **task card that is not a board card**: it carries a *reason*
   ("due Wed · P1 · 45m · blocking work #418") and it is reorderable by drag;
   the order the user leaves it in is authoritative and is stored.
2. **Two visually distinct origins** — a markdown task (lives in a note,
   click-through opens the note at the block) and a `work` row (lives on the
   board, has an owner and a lease). Their verbs differ, so they must not look
   identical.
3. A **carry-over chip** with a count, escalating in weight at 3 and again at 5.
4. A **capacity meter** — minutes planned against `daily_capacity_min` — that
   shows over-capacity without refusing anything.
5. A **"2 places" chip** for a duplicate group (§2.3), opening to both paths.
6. The **standup block** needs one-tap "copy as plain text" and **nothing that
   looks like a send button**. Metistry does not post it, and there is no
   message-sending action in the enum (`packages/core/src/actions.ts:34`).
7. **Empty and absent are different** and Today has four: no tasks; no calendar
   bridge; no `Me/profile.md` working days; no template.
8. **Promotion is one control with a confirmation, and it is one-way.** The UI
   must not imply a task can be demoted back.
9. A **staleness stamp**: a box ticked in Obsidian is up to
   `METISTRY_RECONCILE_INTERVAL_SEC` (300s) old. Say "as of 2 min ago" rather
   than papering over it.
10. **Complete is a confirmed, undo-able gesture** on the Today view, because
    it writes the user's file (§2.2). Undo is a second mechanical write, not a
    revert.

---

## 11. Phases and tickets

Sizes in agent-days, the unit `docs/product/app-ux-plan.md:479-499` uses.

### Phase 1 — the line, the index, the plan (no plugin) · 8 days

Buildable today by an agent with no owner input, except that the *content* of
`Me/` is the owner's and the routines degrade honestly without it.

| # | Ticket | Files | Tests | Size |
| --- | --- | --- | --- | --- |
| P1-1 | **Task line parser** — the §1.1 grammar, the trailing-run rule, relative dates against `METISTRY_TZ`, the Dataview + emoji compatibility readers, `parse_warning` | `packages/core/src/task-line.ts` (new), `packages/core/src/index.ts` | unit: every field, every alias, the trailing-run boundary, `@Jim` mid-text not assigning, `due nextweek` warning not guess, an emoji line read and never emitted | **1.5** |
| P1-2 | **Filter vocabulary** — the `where:`/`order:` parser compiling to bind params; shared by template, app, plugin | `packages/core/src/task-filter.ts` (new) | unit: every clause; **misuse: a `where:` containing SQL is refused, not escaped** | **1** |
| P1-3 | **Migration `0023_vault_tasks.sql`** — both tables, every column marked derived | `db/migrations/0023_vault_tasks.sql` | `ops/scripts/migrate.sh` twice (CI already does); a `down -v` + re-walk restores every row | **0.5** |
| P1-4 | **Indexer pass** — extract tasks and block-anchored refs in the existing walk; `first_seen_on`, `duplicate_of`, `done_on_observed` | `apps/reconciler/src/notes.ts`, `apps/reconciler/src/indexer.ts` | integration: write a note, reconcile, assert rows; edit a field, assert the same `task_key`; edit the text, assert a new one; delete the note, assert the rows go | **1.5** |
| P1-5 | **Named queries** — `vault_tasks_query` (the one `where:` compiles into), `vault_tasks_recurring`, `day_work`, `pending_requests`, `task_ageing` | `seed/queries/*.yaml` | `apps/console/test/seed-queries.test.ts` shape + param tests; **no new brain tool** | **1** |
| P1-6 | **Template engine** — the 8 directives, `section`, evaluation, failure notes, provenance footer, size cap | `packages/core/src/template.ts` (new) | unit per directive; every §6.4 failure row renders its note and the file still renders; `include` does not recurse; `prose` refused outside a fold template | **1.5** |
| P1-7 | **`routines/plan-tomorrow`** — manifest, gate, render, write as `principal: plan-tomorrow` | `routines/plan-tomorrow/{manifest.yaml,run.ts}`, `routines/index.ts` | unit on the gate (too early, already planned, non-working day, no `Me/`); integration writing a real file; `apps/console/test/manifests.test.ts` must still pass the schedule | **1** |
| P1-8 | **Seed the vault tree and templates** — `metistry init` stamps `Journal/{,Plan,Fold,Standup,Meetings}/`, `Templates/`, `Me/`, `People/`, `Projects/`, and six templates | `seed/vault/Templates/*.md`, `seed/vault/Me/*.md`, `packages/cli/src/init.ts` | `packages/cli/test/init.test.ts`; `ops/scripts/check-path-case.sh` (seed/vault is exempt from the lowercase rule, not from the duplicate-case rule) | **0.5** |
| P1-9 | **Move the fold's output** to `Journal/Fold/<date>.md` rendered from `Templates/Fold.md` | `routines/knowledge-fold/run.ts:104`, `seed/assistant-prompt.md:40`, `docs/ops/knowledge-fold.md:22-23` | the fold's existing tests, updated; a note that the assistant must not write `Journal/<date>.md` | **0.5** |

### Phase 2 — the plugin, anchors, and Today · 7 days

| # | Ticket | Files | Tests | Size |
| --- | --- | --- | --- | --- |
| P2-1 | **The Obsidian plugin** — metadata suggester, anchor minting, settings | `plugins/obsidian/**` | the plugin's own tests; a fixture vault round-trip proving anchors are minted once and never re-minted | **2** |
| P2-2 | **Plugin distribution** — `metistry up`/`update` install it; instance migration adds `.obsidian/plugins/` to `.gitignore` | `packages/cli/src/{up,update}.ts`, an instance migration | `packages/cli/test/` | **0.5** |
| P2-3 | **`POST /api/vault-tasks/:task_key/check`** — the bounded mechanical write of §2.2 | `apps/console/src/task-routes.ts` | **misuse tests ship with it**: stale sha → 409; text mismatch → 409; already checked → 409; a `.metistry/` path → forbidden; no agent credential may call it | **1** |
| P2-4 | **Work ▸ Today** (Mac + PWA) — the day's list, capacity meter, carry-over chips, staleness stamp, complete with undo | `apps/macos/sources/**`, `apps/console/src/pwa/**` | Swift unit tests on the view model; PWA integration | **2** |
| P2-5 | **Global task view** — Today/All segmented, filter chips over the §6.2 vocabulary, saved views, the `Me/Working Style.md` card | same | as above | **1** |
| P2-6 | **`metistry archive`** — §5.2, with `--dry-run` | `packages/cli/src/archive.ts` (new), `packages/cli/src/main.ts`, `docs/ops/cli.md` | unit: basename preserved; path-spelled links rewritten; basename-spelled links untouched; refuse on a basename collision; `intEnv` for the threshold (`audit-limits` will fail a literal) | **0.5** |
| P2-7 | **Spike: two Obsidian behaviours.** Does a checkbox ticked inside an embed write through to the source line, and does reading mode hide `^mt-…`? 30 minutes, a fixture vault, written up in the PR | — | — | **0.1** |

### Phase 3 — mail on the second instance · 6 days

| # | Ticket | Files | Tests | Size |
| --- | --- | --- | --- | --- |
| P3-1 | **`apple-mail` Swift helper** — allowlist, list, read, html→text, redaction, behavioural `check()` | `packages/mcp-apple-mail/helper/*.swift` | Swift tests over a fixture store; **misuse: denied mailbox, guessed id, traversal** | **2.5** |
| P3-2 | **The bridge wrapper** — the §4.3 wire contract, conformance tests, `check()` JSON | `packages/mcp-apple-mail/src/*.ts`, `manifest.yaml` | the shared bridge conformance suite; `check-tool-surface.mjs` | **1** |
| P3-3 | **Signing + launchd** — a stably-signed binary so the TCC grant survives (D3) | `packages/mcp-apple-mail/scripts/`, `docs/ops/apple-signing.md` | `metistry doctor` reports the grant | **1** |
| P3-4 | **`collectors/mail-triage`** — deterministic, sender-allowlisted rules only; three mail shapes → three proposal kinds; no `uses_model` | `collectors/mail-triage/{manifest.yaml,run.ts}` | unit per shape; a mail from an unknown sender produces nothing | **1.5** |

### Phase 4 — Linear, Devin, and prose · 4 days

| # | Ticket | Files | Tests | Size |
| --- | --- | --- | --- | --- |
| P4-1 | **`collectors/linear-state`** — one-way in on the `github-state` pattern | `collectors/linear-state/**` | unit on upsert/close-on-vanish; never invents status | **1.5** |
| P4-2 | **Fold-back proposal** — a closed `linear:` row whose todo is still open raises one `report` | `routines/plan-tomorrow/run.ts` | unit: exactly one, ever, until the re-nudge window | **0.5** |
| P4-3 | **`prose` in fold templates** — collect the slots onto the existing fold turn, splice the answer | `routines/knowledge-fold/run.ts`, `seed/assistant-prompt.md` | unit: no engine → failure notes, file still renders; `prose` in a plan template refused | **1** |
| P4-4 | **Weekly review extensions** — ageing, completion rate, `source` counts, the archive nudge | `routines/weekly-review/run.ts` | the routine's existing tests, extended | **1** |

### What needs the owner

| Needed | For | Blocking |
| --- | --- | --- |
| `Me/profile.md` — timezone, `working_days`, `working_hours`, `daily_capacity_min`, `standup_days`, `standup_time`, `today_cap` | the gates and the capacity meter | P1-7, P2-4 — both degrade honestly without it, so nothing is *blocked*, but nothing runs either |
| `Me/Working Style.md` — the prioritisation prose and the standup shape | `{{ include }}` in the plan and standup templates | P1-7, and the seeded template ships with a placeholder |
| Accepting or editing the six seeded templates | everything rendered | P1-8 ships defaults; the owner edits them in Obsidian |
| A Mail account configured in Mail.app on the second instance, plus the Full Disk Access grant | the mail bridge | P3-1..P3-4 |
| The Gemini sender address and the travel-sender list | `mail-triage`'s allowlist | P3-4 |
| A Linear API key | `linear-state` | P4-1 |

---

## 12. What ships, in one paragraph

A task typed anywhere in the vault is a row within five minutes; it survives
`docker compose down -v`; the user's prose rules and a template they edit in
Obsidian decide what tomorrow's plan says; a routine renders it into a file
nobody else writes; the daily note embeds it; the morning brief carries it; the
standup is a draft in a file of its own; nothing ever edits a line the user
typed until the user, in their own editor or with their own click, asks for it.

---

## 13. Contradictions with the plan

Logged, not edited (`CLAUDE.md`, "report contradictions, don't route around
them").

**13.1 — "Never mirror status into markdown" and "Todos: never markdown lists
that rot."** `metistry-build-plan.md:1628-1631` and `:1720-1721` say Postgres
holds status and todos go to the `work` table or Reminders. §1 does the
opposite for the user's own tasks. **The owner ruled this way verbally on
2026-09-19 (R1 "agreed markdown is the source of truth")**, so the spec follows
the ruling — but the plan's sentence still reads the old way and the owner
should decide whether to amend §4.15 or leave the ruling standing alongside it.
The design is not a *mirror*: status is never written as a word, only derived
from a checkbox and a date (§1.3), so the specific failure the plan warns about
— a status word in prose that drifts — is unspellable here.

**13.2 — Three different daily-note paths.** The plan says
`Journal/Daily/<date>.md` (`:1710`). The shipped fold writes `Journal/<date>.md`
flat (`routines/knowledge-fold/run.ts:104`, `seed/assistant-prompt.md:40`). §5.1
keeps the user's note flat at `Journal/<date>.md` and moves the fold's output to
`Journal/Fold/<date>.md`. Ticket P1-9 is that change to shipped behaviour.

**13.3 — Q3 versus completing from the Today view.** "For now no assistant
writing user notes" (Q3). §2.2 has the console write one checkbox character into
a note the user owns, under `principal: user`, on the owner's own click. The
spec argues that is the user's hand and not the assistant's, with four
properties that make it enforceable; §15 Q2 asks the owner to confirm, because
it is the one place the spec interprets a ruling rather than obeying it
literally. Phase 1 ships nothing of it.

**13.4 — Invariant 1 versus durable `work` task rows.** `db/migrations/0008_tasks.sql:7-9`
says every column there is durable with no upstream source; invariant 1 says
Postgres is derived. Known and named as D6. This work sharpens it: it moves the
*majority* of tasks (the user's) onto the derived side and leaves only the
coordination rows durable — an argument for resolving D6 in this direction, and
still D6's to resolve.

**13.5 — Invariant 3 versus the reconciler's direct writes.** "No component
talks to Postgres directly (sole exception: the watchdog's liveness probes)"
(`CLAUDE.md`), versus `apps/reconciler/src/indexer.ts:173-200` and `:304-337`,
which already write five tables. `vault_tasks` and `vault_task_refs` are the
sixth and seventh. Pre-existing; widened here; the read path stays a named
query. The invariant's sentence says what it says and it is the owner's to amend
or to leave.

**13.6 — "Templates ship in `seed/`" is not true yet.** `metistry-build-plan.md:1726`
says they do; `seed/vault/` holds three files and `metistry init` creates one
vault directory (`packages/cli/src/init.ts:241-278`). Every default grant names
folders that do not exist (`.env.example:68`). Not a contradiction anyone
introduced — a gap, closed by P1-8.

**13.7 — The meeting-note filename.** The plan says
`Journal/Meetings/2026-08-29 <topic>.md` with a space (`:1713`); the owner's
ruling says `date-topic.md`. The owner's spelling wins (§5.1).

**13.8 — The frontmatter schema has no `template` type.** `type` is frozen at
`project│area│resource│technique│person│journal` (`:1645`) and CI validates
shape. A seeded `Templates/Daily.md` needs a type. The spec uses
`type: resource` with `tags: [template]` rather than widening a frozen schema;
if the owner prefers a seventh type, that is a one-line plan amendment and a CI
change.

---

## 14. What changed since the research note

The research note read the tree at `2aba1fb`; four of its findings have moved,
and the spec is built on the current state. Recorded here so nobody
re-implements a fix that shipped.

**14.1 — `ownershipRefusal`'s hole is closed.** PR #231 landed on 2026-09-19:
a note with no `source:` is now the user's, not ownerless
(`packages/mcp-brain/src/knowledge-write.ts:262-268`,
`docs/ops/knowledge-fold.md:93-106`), `seed/vault/now.md:1-3` ships
`source: assistant`, and `now.md` is the one named exemption. The note's §2.6
("fix it before any of this ships") is **done**. §5.1's file separation is
therefore belt-and-braces, as it should be.

**14.2 — `@monthly` is handled.** `scheduleToSeconds` covers it
(`packages/core/src/schedule.ts:20`). The note's "latent gap" is closed.

**14.3 — `full_disk_access` is already a declarable TCC grant.**
`packages/core/src/manifest.ts:30-36`. The mail bridge needs no core schema
change (§8.2).

**14.4 — Work has four children, not six.** Board · Projects · Artifacts ·
Rooms (`docs/product/app-ux-plan.md:170`). Today is the **fifth**, not the
seventh.

Three places where this spec deliberately departs from the note's
recommendation, rather than from a stale fact:

- **Line syntax** — English trailing tokens, not Dataview `[k:: v]` (§1.1),
  because of Q2.
- **Priority** — P1–P4 with aliases, not `high│normal│low` (§1.3), because of
  R9.
- **Prioritisation** — a deterministic field order declared in the template,
  with the user's prose included verbatim, rather than a weighted score with
  printed weights (§6.6), because of Q8.

And one the note flagged as the owner's and the owner has now ruled: Reminders
is out entirely (R11, Q5), so the note's phase 7 is deleted rather than
deferred.

---

## 15. Open questions

**Q1 — Priority scale.** §1.3 chooses **P1–P4** with `critical│high│normal│low`
as aliases and unset sorting as P3. The owner offered P1–P5 *or* the named
four. If P1–P5 is preferred, the only change is the parser's range and the
`coalesce(priority, 3)` default. Nothing else in the design depends on it.

**Q2 — Is completing from Work ▸ Today the user's hand?** §2.2 says yes and
makes it enforceable: an owner-only route that can produce exactly two byte
changes, no model anywhere, not in `ACTION_KINDS`, misuse-tested. This is the
one place the spec interprets Q3 rather than obeying it literally, and it is
worth an explicit answer before phase 2. **If the answer is no**, the Today view
stays read-only forever, the plugin becomes the only completion path outside
Obsidian, and the iOS app can never complete a task.

**Q3 — Gemini meeting notes that arrive as a Google Doc link.** §8.2 handles the
body-carries-the-notes case and, for a link, produces a proposal that says so.
Fetching the doc needs a Google bridge, Google credentials, and an assumption
about a shared account — a separate project against invariant 7. Is the
body-only flow enough for now?

**Q4 — Transcript reach.** §8.4 puts transcripts under `Journal/Transcripts/`,
outside every default grant, which means the assistant's own default area list
(`.env.example:68`) has to narrow `Journal` or exclude that prefix. And
retention: §4.12's rule for raw comms is "days, not years"
(`metistry-build-plan.md:1523-1526`), but a transcript committed to git is
forever. Both are the owner's.

**Q5 — `Templates/` in the vault.** §6.1 chooses it over `.metistry/templates/`
and answers the invariant-2 objection with `source: user` plus
`ownershipRefusal`. Worth confirming, because it puts a file that shapes system
output into a grantable vault area.

**Q6 — Should the plan ever be *composed* rather than ordered?** §6.6 keeps
invariant 4 intact by having the routine order deterministically and include the
user's prose rule verbatim. A model reading the rule and choosing the day would
be strictly better output and a real change in what decides. The mechanism
exists (`prose` in a fold-owned file, §6.3). The owner should say whether the
plan is somewhere a model may reason, or somewhere it may only annotate.

---

## Sources

**Repo, read at `origin/main` `47fe7c5`** — `CLAUDE.md`;
`metistry-build-plan.md` §§4.8, 4.12, 4.13, 4.15, 4.19, 4.20;
`docs/plan-refresh-2026-09-13.md` §4b (W5/W6 only);
`docs/product/app-ux-plan.md` §§3.1–3.3, 6, 6.1, 7.10;
`docs/product/design-system.md` §§3.15–3.16;
`docs/ops/{board,inbox,knowledge-fold,reply-feedback,instance-layout,reconciler,cli,actions}.md`;
`db/migrations/{0001,0002,0005,0006,0008,0011,0014}`;
`routines/{knowledge-fold,morning-brief,weekly-review}`;
`collectors/{inbox-drain,github-state}`;
`packages/{core,queries,tasks,cli,mcp-brain,mcp-eventkit}`;
`apps/{console,reconciler}`; `seed/{assistant-prompt.md,queries,vault}`;
`ops/scripts/{check-path-case.sh,audit-limits.mjs,prompt-lint.mjs}`;
`.github/workflows/ci.yml`.

**Prior work** — `docs/research/2026-09-19-daily-flow-and-tasks.md` (PR #227),
which carries the external sources this spec's decisions rest on: Obsidian Help
on block identifiers and embeds, the Obsidian Tasks format references, GitHub's
task-list docs, the Scrum Guide, Newport, Babauta and GTD. They are not
re-fetched here; §14 records only where this spec departs from that note.
