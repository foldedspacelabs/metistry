# The daily flow — tasks, capture, the fold, tomorrow's plan, standup (2026-09-19)

Research for the owner's brief of 2026-09-19: how todo items are captured,
tracked, prioritised, scheduled and collated, and what the daily rhythm around
them looks like end to end. Nothing here is built. This is the shape to build,
what each piece costs, and the decisions that are the owner's.

**The method.** Every claim about this repo cites `file:line` and was read at
`origin/main` `2aba1fb` (0.10.0). Every external claim carries a URL and the
date it was fetched (2026-09-19) or, where a local copy exists, the installed
SDK header, read the way `2026-09-19-keep-awake.md` reads Apple's. Where the
build plan and the code disagree I say so in §8 and change neither
(`CLAUDE.md`, "Report contradictions, don't route around them").

**The honest summary of where we start:** almost none of this exists. There is
a `work` table, a board over it, an inbox, a deterministic classifier, an
evening fold, a morning brief, a weekly review and a calendar bridge. There is
no task in markdown, no daily note, no meeting note, no template, no plan for
tomorrow, no standup, no mail, no Slack, no transcripts, and no `Journal/`
directory — `metistry init` creates exactly one vault folder, `Inbox/`
(`packages/cli/src/init.ts:270`). §1 is the full inventory and it is short.

---

## The short version

1. **One canonical home per task, and the line is drawn by *who does it*, not
   by where it was typed.** A task the **user** does lives as a `- [ ]` line in
   a vault note — git is the record, exactly as invariant 1 says. A task an
   **agent may claim** lives as a `work` row — because a lease, a dependency
   and a board column have no markdown representation, and the row already
   exists and works. A markdown task becomes a `work` row only by an explicit,
   one-way **promotion**, and nothing ever writes state back into the user's
   note (§2.1).
2. **The derived index is a new `vault_tasks` table the reconciler fills from
   its existing walk.** Fully derived — drop the database, re-walk the vault,
   it is back. That is what makes markdown-canonical *cheaper* than the status
   quo under invariant 1, not more expensive: `work` task rows are marked
   `-- durable` today (`db/migrations/0008_tasks.sql:8-15`) and a `down -v`
   loses them (§2.4).
3. **The line syntax is plain markdown plus Dataview-style inline fields, and
   the identity is an Obsidian block reference.** `- [ ] Draft the Q4 plan
   [due:: 2026-09-22] [project:: drey] ^mt-7x2k`. Emoji signifiers were
   rejected: they are unreadable in a git diff and in a terminal, and they bind
   the vault to one plugin's glyph table (§2.2, §2.3).
4. **`ownershipRefusal` has a hole that this design walks straight into.** A
   note whose frontmatter carries no `source:` is **writable** by the assistant
   — `if (!owner … ) return null`
   (`packages/mcp-brain/src/knowledge-write.ts:220-222`) — and
   `knowledge_write` is a **whole-file replace**. A hand-written daily note has
   no `source:`. So today the fold could read the user's daily note and
   re-emit it from a model, checkboxes and all. Fix it before any of this
   ships, and mind `now.md`, which the assistant must keep writing (§2.6).
5. **The fold and the daily note collide on one path.** The fold writes
   `Journal/<date>.md` (`seed/assistant-prompt.md:40`,
   `routines/knowledge-fold/run.ts:104`) — the exact file a human daily note
   wants. **Separate them by file, not by convention:** `Journal/<date>.md` is
   the user's and is never written by a machine; `Journal/Fold/<date>.md` and
   `Journal/Plan/<date>.md` are machine-owned, and the daily note **embeds**
   them (`![[…]]`, `obsidian.md/help/links`). One writer per file, enforced by
   `source:` and the ownership rule rather than by a prompt (§5.4).
6. **The runner cannot schedule a time of day or a weekday, and nothing should
   pretend otherwise.** `scheduleToSeconds` converts a schedule to an
   *interval* (`packages/core/src/schedule.ts:8-17`) and a test pins the
   refusal: `expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow`
   (`apps/console/test/manifests.test.ts:131`). Every new routine here is
   `@hourly` with a gate inside it, the pattern `knowledge-fold` already uses
   (`routines/knowledge-fold/run.ts:243-252`). Widening the cron parser is the
   rejected alternative and §5.2 prices it.
7. **Nothing decides. Metis proposes and the deterministic half schedules.**
   Extraction from notes and transcripts is an assistant turn that emits
   `suggested_work` proposals into the existing six-answer queue
   (`docs/ops/reply-feedback.md:12-21`); **Approve as Work** is already the
   click that creates the row (`apps/console/src/server.ts:1229-1241`). Slot
   assignment against calendar free time is arithmetic in a routine, no model
   (§4).
8. **Five routines, two of them new, one extended.** `plan-tomorrow` (new),
   `standup-draft` (new), `knowledge-fold` (extended to harvest tasks),
   `morning-brief` (extended to carry the plan and the standup draft),
   `weekly-review` (extended with an ageing report). Full table with schedule,
   inputs, outputs and what needs the user's hand in §5.1.
9. **Two-way sync exists for exactly one system: Apple Reminders — and the
   bridge cannot do it yet.** It lists only *incomplete* reminders, creates,
   and stops there: no complete, no update, no delete
   (`packages/mcp-eventkit/src/index.ts:80-95`,
   `helper/ek-helper.swift:64-100`). Apple also warns that
   `calendarItemIdentifier` is **not sync-proof** (EventKit SDK header,
   `EKCalendarItem.h:36-43`), so identity must live in the reminder's `url`
   field. Everything else is one-way in, with provenance in `external_ref`
   (§3).
10. **Mail, Slack, flights and transcripts do not exist in any form.** Not a
    bridge, not a collector, not a manifest, not a stub. The only mail work in
    the tree is PoC-13, whose verdict is *do not build the ingest*
    (`metistry-build-plan.md:1502-1521`). §3.4 compares the two smallest mail
    shapes and deliberately does not choose; §9 Q6 is the owner's.
11. **No new top-level section in the apps.** The daily flow is **Feed**, tasks
    are **Work ▸ Board**, proposals are the **bell**, quick-add is the **"+"**.
    One new *screen* inside Work — **Today** — and one new card type. The
    designer's list is §6.
12. **Phase 1 is three agent-days and proves the whole loop** without a model,
    without a new bridge, and without touching the live instance: parser +
    `vault_tasks` + one named query + the template. §7.

---

## Recommendation table

| # | Question | Recommendation | Confidence | Needs the owner |
| --- | --- | --- | --- | --- |
| R1 | Where does a todo live? | **Vault markdown is canonical for the user's own tasks; `work` is canonical for claimable work.** One-way promotion between them; never a mirror | high | **yes** — contradicts plan §4.15 deviation 2 (§8.1) |
| R2 | The derived index | New `vault_tasks` table, filled by the reconciler's existing walk, fully derived | high | no |
| R3 | Line syntax | `- [ ] text [key:: value] ^mt-<id>`; only `[ ]`/`[x]` load-bearing | high | preference only |
| R4 | Identity | Obsidian block id `^mt-<8 base32>`, minted by the template/quick-add, never re-minted | high | no |
| R5 | States | `captured → triaged → scheduled → done │ dropped │ deferred`, derived from fields, never a status word in prose | high | no |
| R6 | Who completes | The user, in Obsidian, by ticking. Agents propose; **Approve as Work** promotes | high | no |
| R7 | Daily note path | `Journal/<date>.md` is the **user's**; machine output goes to `Journal/Plan/` and `Journal/Fold/` and is embedded | high | **yes** — moves the fold's write path (§8.2) |
| R8 | Scheduling routines | `@hourly` + in-routine gate; do **not** widen the cron parser yet | high | no |
| R9 | Prioritisation | Deterministic score (due, age, explicit priority, carry-over count) + a ≤3 "today" cap; the user reorders and that wins | medium | **yes** — capacity/energy rules are theirs to state |
| R10 | Standup | Drafted into the plan note and the brief, on the user's stated days; **Metistry never posts it** | high | **yes** — days + format |
| R11 | Reminders | One-way out as a *surface* + completion read-back; identity in `EKCalendarItem.URL` | medium | **yes** — is a mirrored list acceptable at all (§9 Q5) |
| R12 | Mail | Build nothing until PoC-13's bar is re-run. If forced, read-only local `~/Library/Mail` beats IMAP | medium | **yes** (§3.4, §9 Q6) |
| R13 | Slack | One-way in, outbound-only-on-confirm later; not in the first three phases | high | **yes** — which workspace, and whether an app can be installed |
| R14 | `ownershipRefusal` | Treat "no `source:`" as **the user's**, with `now.md` seeded `source: assistant` | high | no — but it is a behaviour change |

---

## 1. What exists today — and what does not

### 1.1 What is built

| Piece | Where | What it actually does |
| --- | --- | --- |
| `work` table | `db/migrations/0001_init.sql:65-78` | `id, title, area, kind, status, external_ref, owner, due, created_at, updated_at`. `status` ∈ `open │ in_progress │ blocked │ closed`. **`due` is a date; there is no `scheduled_for`, no priority, no size, no energy** |
| Coordination columns | `db/migrations/0002_review_decisions.sql:37-40` | `claimed_by`, `lease_expires_at`, `depends_on bigint[]` |
| Task columns | `db/migrations/0008_tasks.sql:11-18` | `project`, `idempotency_key` (unique), `history jsonb` append-only, `created_by`, `closed_at`. Every one marked **`durable`** |
| `meta jsonb` on work | `db/migrations/0006_work_meta.sql:5` | collector-owned source metadata; the only free-form slot on a row |
| External ref uniqueness | `db/migrations/0005_work_external_ref_unique.sql:3` | partial unique index — **idempotent upsert by source id, already shipped** |
| Tasks service | `packages/tasks/src/index.ts` | `create/claim/renew/update/release/close`, two-armed `update` (holder vs board), every state change one atomic statement |
| Board view | `seed/queries/board.yaml`, `docs/ops/board.md:39-46` | six columns as a `CASE`, no fifth status; `escalated` = lapsed lease, blocked, or past due (`docs/ops/board.md:78-86`) |
| Console task routes | `apps/console/src/task-routes.ts:32-35` | `PATCH /api/tasks/:id`, `POST …/{claim,release,renew}`. **There is no `POST /api/tasks`** |
| The only human create path | `apps/console/src/server.ts:1229-1241` | **Approve as Work** on a proposal carrying `payload.suggested_work` |
| `suggested_work` | `collectors/inbox-drain/run.ts:122-140` | three deterministic cues: frontmatter `kind: todo│task`, a leading `@task …`/`todo: …`/`- [ ] …`, or the `todo` verdict from `TODO_RE` (`run.ts:50`) |
| Proposals queue | `db/migrations/0002_review_decisions.sql:21-33`, `0019_proposal_snooze.sql:27` | one table, six answers (`docs/ops/reply-feedback.md:12-21`), `snoozed_until` for *Later* |
| Inbox in the vault | `docs/ops/inbox.md:1-10`, `apps/reconciler/src/indexer.ts:292-297` | files at `Inbox/`, rows rebuilt from the files by the reconciler's walk — the precedent this whole design copies |
| Evening fold | `routines/knowledge-fold/run.ts`, `docs/ops/knowledge-fold.md` | model-free assembler → **one** assistant turn on thread `fold`; reads `proposals`/`work`/`artifact_versions`/`inbox`, never the vault |
| Morning brief | `routines/morning-brief/run.ts:244-277` | Schedule (EventKit), Today, Reviews, Needs You, Projects, System; D10 budget of 5 + 2 critical |
| Weekly review | `routines/weekly-review/run.ts:324-352` | six sections; "Next week" already joins `work.due` with a 7-day EventKit read |
| EventKit bridge | `packages/mcp-eventkit/manifest.yaml:10-20` | `list_events`, `list_reminders`, `create_event`, `create_reminder` — preview-then-confirm on the two creates (`src/index.ts:36-49`) |
| Vault bridge | `apps/reconciler/src/server.ts:155-215` | `/vault/{read,list,search,log,diff}`, `POST /vault/{write,delete,rename}`. `delete` and `rename` exist on the bridge and are **not** exposed to the assistant |
| Manifest preflight | `packages/core/src/manifest.ts:89-98`, `docs/ops/automation.md:44-52` | `requires: {env, reachable, engine}` — a routine that needs a bridge declares it and never spends a window without it |

### 1.2 What does not exist — precisely

- **No task in markdown, anywhere.** `grep` for a checkbox parser, a
  `vault_tasks` table or a `- [ ]` reader returns the classifier's one regex
  (`collectors/inbox-drain/run.ts:54`), which matches a leading `- [ ] ` on a
  *capture note* and throws the rest away.
- **No `Journal/`, `Templates/`, `Areas/`, `Me/` or `People/`.** `metistry
  init` creates `Inbox/` and the `.metistry/` config dirs
  (`packages/cli/src/init.ts:270-276`); `seed/vault/` holds exactly three
  files — `now.md`, `CLAUDE.md`, `Inbox/README.md`. The §4.15 tree is
  aspiration, not seed. The *grant default* names the folders
  (`.env.example:68`) but nothing creates them.
- **No daily-note or meeting-note template.** No Templater, no QuickAdd, no
  Periodic Notes config ships. Plan §4.15 says "Templates ship in `seed/`"
  (`metistry-build-plan.md:1727`); they do not.
- **No `scheduled_for`, priority, size or energy** on `work`. `due` is the only
  date.
- **No email of any kind.** No IMAP client, no `.emlx` reader, no bridge, no
  collector, no manifest. `~/Library/Mail` appears only in PoC-13's survey
  scripts (`docs/poc/poc13-comms/export.mjs:14-36`).
- **No Slack.** The word occurs four times in the tree and every one is prose:
  a "Slack or Teams bridge on that side if ever" (`metistry-build-plan.md:2540`),
  an `instances.yaml` resource-kind example (`packages/core/src/instances.ts:98`),
  and two research notes describing *other products*. There is no bridge, no
  manifest, no plan entry with a phase against it.
- **No flights, travel or itinerary handling.** Zero occurrences outside the
  phrase "in flight" about runs.
- **No meeting recordings or transcripts.** The only transcripts in the system
  are *agent session* transcripts (`metistry-build-plan.md:1990-2003`) and
  Claude Code / Cursor session captures (`metistry import-sessions`). Nothing
  reads audio, and there is no ASR anywhere.
- **No standup, no plan-for-tomorrow, no "today" screen.**

### 1.3 Two things that are not what the plan says

Logged here, expanded in §8: the fold writes `Journal/<date>.md` **flat**
(`routines/knowledge-fold/run.ts:104`) where plan §4.15 says
`Journal/Daily/<date>.md` (`metistry-build-plan.md:1710`); and `work` task rows
are marked durable (`db/migrations/0008_tasks.sql:8`) where invariant 1 says
Postgres is derived.

---

## 2. The task model

### 2.1 The decision: one canonical home per task, and where the line falls

**Recommendation.** A task's canonical home is decided at birth by **who is
going to do it**:

| | Canonical home | Record | Who writes state |
| --- | --- | --- | --- |
| **A task the user does** | a `- [ ]` line in a vault note | git | the user, in Obsidian |
| **A task an agent may claim** | a `work` row | Postgres (durable, D6) | the tasks service |

They are never the same task, and nothing is mirrored. A markdown task becomes
a `work` row by **promotion** — one-way, explicit, and visible in the note as a
pointer. There is no demotion and no write-back.

**Why the user's tasks belong in markdown.** Invariant 1 is not a slogan here;
it is a test the system passes or fails. The inbox failed it until 2026-09-16,
and the fix was to move the files *into* the vault:
"the inbox used to be the hole in it" (`docs/ops/inbox.md:9-10`). Tasks are the
same hole, differently shaped. `db/migrations/0008_tasks.sql:8` says it
outright: "Everything here is durable — it is agent-authored state with no
upstream source to rebuild from." For an agent's claim history that is true and
right. For *"call the dentist"*, typed by a human into Monday's note, it is
simply a design choice to keep the only copy in a database — and it is the
wrong one, because the note is already in git, already syncs to the phone via
Obsidian, already survives `down -v`, and is already the thing the user is
looking at when they think of the task.

**Why claimable work does not belong in markdown.** A lease has an expiry and a
holder (`packages/tasks/src/index.ts:326-330`); `depends_on` is an array with a
closure rule (`index.ts:150-155`); `history` is append-only with server-side
attribution (`0008_tasks.sql:13`). None of that has a markdown form that two
processes can safely edit, and the whole point of one atomic statement per
state change (`packages/tasks/src/index.ts:10-14`) dies the moment the state
lives in a file a human is also typing into.

**What promotion looks like.** The line keeps its text and gains a pointer; the
row keeps its provenance:

```markdown
- [ ] Draft the Q4 plan [project:: drey] [due:: 2026-09-30] ^mt-7x2k → work #418
```

`work.external_ref = 'vault:Journal/2026-09-21.md#^mt-7x2k'`. The partial
unique index on `external_ref`
(`db/migrations/0005_work_external_ref_unique.sql:3`) makes a second promotion
of the same line a no-op rather than a duplicate — idempotency for free, no new
column.

**Who writes the `→ work #418`?** Not a machine. Promotion happens from the
app (the Today screen's "hand to an agent" control) or from quick-add; the
app has the line and can offer to copy the pointer, and the user pastes it or
does not. **Nothing writes into the user's note, ever** — which is the same
answer the repo already gives about the inbox: "`delete` and `rename` are not
exposed to the assistant at all" (`docs/ops/inbox.md:207-211`). If the pointer
is missing, the index still has `work_id` and the app still renders the link;
the markdown is just less self-describing.

### 2.2 The line syntax

```markdown
- [ ] Call the dentist [due:: 2026-09-22] ^mt-7x2k
- [ ] Draft the Q4 plan [project:: drey] [scheduled:: 2026-09-22] [size:: L] [energy:: deep] ^mt-9k4p
- [x] Send the contract [due:: 2026-09-19] [done:: 2026-09-19] ^mt-2b8q
```

- **The checkbox is plain GFM.** "preface list items with a hyphen and space
  followed by `[ ]`. To mark a task as complete, use `[x]`" (GitHub Docs,
  *About task lists*, fetched 2026-09-19). Only `[ ]` and `[x]` are
  load-bearing. `[-]` is read as **dropped** if present — it is what the
  Obsidian Tasks plugin uses for cancelled (`- [-] #task Has a cancelled date
  ❌ 2023-04-18`, Obsidian Tasks docs, fetched 2026-09-19) — but nothing
  requires it and no other glyph means anything.
- **Attributes are Dataview-style inline fields**, `[key:: value]`, which is
  the Obsidian Tasks plugin's own alternative format: `- [ ] #task Has a due
  date [due:: 2023-04-16]` (Obsidian Tasks, *Dataview Format*, fetched
  2026-09-19).
- **Keys, and nothing else parses:** `due`, `scheduled`, `start`, `done`,
  `project`, `area`, `people`, `priority` (`high│normal│low`), `size`
  (`S│M│L`), `energy` (`deep│shallow│admin`), `source`, `repeat`.
- **Dates are `YYYY-MM-DD`.** Same as both Obsidian formats.

**Rejected: the emoji format** (`📅 2023-04-16`, `⏫`, `🔁`, `🆔`). It is the
Tasks plugin's default and renders beautifully in Obsidian, and it is a bad fit
here for three reasons the repo already cares about: a `git diff` of emoji
signifiers is unreadable and this repo's record *is* the diff (invariant 1); a
regex over emoji code points is a variation-selector trap where `[key:: value]`
is twenty lines of boring parser; and the glyph table belongs to a community
plugin whose meanings can change under us, where `due::` cannot. The honest
cost of the choice: **without the Dataview plugin installed, `[due:: …]`
renders as literal text in Obsidian**, where an emoji renders as itself. That
is a real ergonomic loss and it is the owner's to weigh (§9 Q2).

**Also rejected: frontmatter task arrays.** A YAML list of task objects in the
note's frontmatter is tidier to parse and completely wrong for the user: you
cannot tick a YAML entry, and the whole point is that the user completes tasks
where they are looking.

### 2.3 Identity

**An Obsidian block identifier, minted once, never re-minted.**
`^mt-<8 chars, Crockford base32>`, appended at the end of the task line.

Obsidian's own documentation: "place a blank space followed by a caret `^` and
the block identifier at the end of the line"; "for list items … the block
identifier can be placed directly on a bullet point"; and — the constraint that
decides the alphabet — "Block identifiers can only consist of Latin letters,
numbers, and dashes" (`obsidian.md/help/links`, fetched 2026-09-19). So
`^mt-7x2k9abc` is legal and `^mt_7x2k` is not.

What this buys, and why nothing else was worth considering:

- **It is native.** `[[Journal/2026-09-21#^mt-7x2k]]` links to the exact task
  line from a project note, a meeting note or a People page, with no plugin.
  The reconciler already extracts wikilinks into `knowledge_links`
  (`apps/reconciler/src/notes.ts:57-70`), so the task graph is the note graph.
- **It survives the move that breaks paths.** Plan §4.15's rename design turns
  on immutable `id`s and content-hash re-keying
  (`metistry-build-plan.md:1733-1750`); a block id moves with the line whether
  the line moves within a note or to another note.
- **It is what makes sync idempotent.** A Slack message, a transcript and a
  capture that all name the same task converge on one `external_ref`, and a
  re-run of any of them finds the existing row.

`work` rows keep the identity they have: `work.id`, plus `idempotency_key` for
caller-supplied dedupe (`db/migrations/0008_tasks.sql:12`) and `external_ref`
for the source of truth.

### 2.4 The derived index — `vault_tasks`

One new table, filled by the reconciler's existing walk, **entirely derived**:

```sql
-- 00NN_vault_tasks.sql — DERIVED in full (D6). Drop the database, re-walk the
-- vault, and every row here comes back from the markdown that produced it.
CREATE TABLE vault_tasks (
    path          text NOT NULL,          -- vault-relative, e.g. Journal/2026-09-21.md
    anchor        text NOT NULL,          -- the ^mt-… block id, without the caret
    line_no       integer NOT NULL,
    text          text NOT NULL,
    checked       boolean NOT NULL,
    dropped       boolean NOT NULL DEFAULT false,   -- `- [-]`
    due           date,
    scheduled_for date,
    start_on      date,
    done_on       date,
    priority      text,                   -- high | normal | low
    size          text,                   -- S | M | L
    energy        text,                   -- deep | shallow | admin
    project       text,
    area          text,
    source        text,                   -- provenance: meeting:…, slack:…, cal:…
    work_id       bigint,                 -- set on promotion; NULL for a plain task
    first_seen_on date NOT NULL,          -- for ageing: the day it first appeared
    last_seen_at  timestamptz NOT NULL,
    PRIMARY KEY (path, anchor)
);
CREATE INDEX vault_tasks_open_idx ON vault_tasks (scheduled_for, due) WHERE NOT checked AND NOT dropped;
```

- **Where it is filled.** `apps/reconciler/src/indexer.ts` already parses every
  markdown file it walks, hashes it, extracts links and upserts
  `knowledge_files` (`indexer.ts:181-197`); the inbox scan
  (`indexer.ts:292-337`) is the precedent for "the walk also maintains a second
  table". Adding a checkbox pass costs one function in
  `apps/reconciler/src/notes.ts` and one upsert.
- **Invariant 3 is not newly bent.** The reconciler already writes
  `knowledge_files`, `knowledge_links`, `embeddings` and `inbox`; the
  invariant's force is on the **read** path, and the read path here stays a
  named query (§4.3, §6). Worth a sentence in `docs/ops/reconciler.md` rather
  than a new argument.
- **`first_seen_on` is the ageing signal** and the reason this is not a pure
  projection: the *day a task first appeared* cannot be read off the current
  file. It can be recovered from git (`/vault/log` exists,
  `apps/reconciler/src/server.ts:189`), so a rebuild recovers it slowly;
  pragmatically, a rebuild that resets ageing to "today" loses a nudge, not a
  task. Label the column `derived (recoverable from git log)` in the migration
  so D6 has the honest answer.

### 2.5 States

**States are derived from fields. No status word is ever written in prose** —
that is precisely the "markdown lists that rot" failure the plan warns about
(`metistry-build-plan.md:1720`), and the answer is to make status unwritable,
not to ban the syntax.

| State | Derivation | Where it shows |
| --- | --- | --- |
| **captured** | an `Inbox/` file or a line with no `project`/`due`/`scheduled` | Needs You, as a `note` request |
| **triaged** | classified and either filed to a note or approved | the note it landed in |
| **scheduled** | `scheduled:: <date>` present, or promoted and on the board | the day's plan |
| **done** | `- [x]`, or `work.status = 'closed'` | the fold, the weekly review |
| **dropped** | `- [-]`, or `deny`/`skip` on its proposal | searchable, never deleted |
| **deferred** | `scheduled::` moved forward, or `proposals.snoozed_until` | ageing count rises |

Two properties worth naming. **Deferred is not a decision** — that is already
the ruling behind `Later`: "`decision` stays `pending` … a snooze NEVER ends a
proposal" (`db/migrations/0019_proposal_snooze.sql:9-12`). And **`blocked` is
the human-gated state** on the board and must stay so: "the one route back to
`open` is the unblock … Only your hand" (`docs/ops/board.md:44`).

### 2.6 Who may create, who may complete — and the hole to close first

| Actor | Create | Complete | How |
| --- | --- | --- | --- |
| **The user** | yes, anywhere | yes, by ticking | Obsidian, quick-add, the Today screen |
| **Metis (the assistant)** | **no** | **no** | emits `suggested_work` proposals; the click creates the row (`docs/ops/reply-feedback.md:60-82`) |
| **A crew / external agent** | a `work` row in its project, via `tasks_create` | closes only what it holds | `packages/tasks/src/index.ts`; `owner` has no agent surface (`docs/ops/board.md:155-163`) |
| **A collector / bridge** | a proposal, never a row | no | `POST /capture` + `Idempotency-Key` (`db/migrations/0014_capture_idempotency.sql:13-17`) |

This is invariant 2 as it already works, and it needs no new rule. What it
needs is one existing rule to actually hold.

**The hole.** `ownershipRefusal` treats a note with no frontmatter `source:` as
unowned and therefore writable:

```ts
export function ownershipRefusal(existing: string, callerId: string): string | null {
  const owner = frontmatterSource(existing);
  if (!owner || owner === callerId || owner === FOLD_SOURCE) return null;
  return `owned by ${owner}; propose instead`;
}
```
— `packages/mcp-brain/src/knowledge-write.ts:219-223`

A note a human typed in Obsidian has no `source:`. `knowledge_write` is a
**whole-file replace** (`seed/assistant-prompt.md:17`). So today, the fold
reading `Journal/2026-09-21.md` and writing it back — which the prompt
explicitly instructs it to do, "if it does exist, `knowledge_read` it and add to
it" (`seed/assistant-prompt.md:40`) — passes a model over the user's own
checkboxes and re-emits them. Compare-and-swap protects against a *concurrent*
edit; it does not protect against a faithful-looking rewrite that drops a line.

**The fix, and its one trap.** Invert the default: absent `source:` means **the
user's**, refuse. This is safe for everything the assistant wrote, because
`stampProvenance` stamps `source` on every markdown write
(`knowledge-write.ts:145-153`), so an unstamped note is by definition not one
of its own. The trap is `now.md`: the seed ships it with no frontmatter
(`seed/vault/now.md:1`) and the prompt requires the assistant to keep writing a
"last fold" line into it (`seed/assistant-prompt.md:46`). So the change is two
parts — invert the default **and** seed `now.md` with `source: assistant` —
plus a note in `metistry update` for instances whose `now.md` predates it.

§5.4's file separation makes this belt-and-braces rather than the only defence,
which is the right order: the structural fix first, the tool refusal behind it.

### 2.7 The alternative I rejected, and why

**Postgres-canonical with a rendered markdown mirror** — keep `work` as the one
record, write the day's tasks into the daily note as read-only rendered lines,
and treat a tick in Obsidian as decoration. It is simpler to reason about, it
matches plan §4.15 deviation 2 exactly, and it needs no new table.

It fails on one fact: **the user will tick the box.** A system that renders a
checkbox and then ignores it has taught the user that its own interface lies,
and no amount of "the box is read-only" in a `CLAUDE.md` is a control
(`CLAUDE.md`, "enforce at the tool, never by prompting"). The only way to make
it honest is to render tasks as non-checkbox lines — at which point the daily
note is a printout, the user keeps a real list somewhere else, and we have
built the thing the brief asks us to replace.

---

## 3. Capture paths

### 3.1 Every door

| Path | Exists today? | Shape | Direction | Source of truth |
| --- | --- | --- | --- | --- |
| **Daily note** `- [ ]` | **no** — no template, no parser | reconciler walk → `vault_tasks` | n/a | the note |
| **Meeting note** `- [ ]` | **no** | same parser, `source:: meeting:<path>` | n/a | the note |
| **Quick capture "+"** | **yes** — `POST /capture`, Shortcut, `/note` (`docs/ops/inbox.md:18-25`) | file in `Inbox/` + row; `inbox-drain` sets `suggested_work` | in | the capture |
| **Obsidian / `git pull`** | **yes** — the reconcile scan (`apps/reconciler/src/indexer.ts:292-297`) | a file with no row gets one | in | the file |
| **Calendar (EventKit)** | **read: yes** (`GET /events`, `src/index.ts:74-78`) | a new `calendar-state` collector upserts `kind: 'event'` rows on `external_ref = cal:<id>` | in (+ optional write) | the calendar |
| **Apple Reminders** | **read: partial; write: create only** (§3.3) | bridge verbs + a collector | **two-way, with limits** | contested (§9 Q5) |
| **Email** | **nothing** | §3.4 | in | the mailbox |
| **Slack** | **nothing** | a `slack` bridge, outbound-only on confirm | in (out later) | Slack |
| **Project plans** | partially — `Projects/` notes are just vault notes | the same checkbox parser | n/a | the note |
| **Meeting recordings / transcripts** | **nothing** | a transcript lands as a **capture** (`kind: transcript`), extraction is an assistant turn | in | the transcript file |
| **GitHub** | **yes** — `collectors/github-state/run.ts:120,140-155` | upsert `gh:owner/repo#n`, close rows that vanished | in | GitHub |
| **Devin / Cursor / Claude Code** | **yes** — `capture` on the brain bridge, `metistry import-sessions` | proposals | in | the session |

### 3.2 The sync rule

State it once, enforce it at each collector, and never negotiate it per source:

1. **Exactly one system owns each item's state**, and the owner is named in
   `external_ref`'s prefix. `gh:` → GitHub owns it; `vault:` → the note owns
   it; `cal:` → the calendar owns it; no prefix → we own it.
2. **Everything is one-way in, with provenance**, except a system that is
   *the user's own todo store*. Today that is Apple Reminders and nothing
   else.
3. **A collector never invents status** — "Collectors reconcile status from the
   source; Metis never invents it" (`metistry-build-plan.md:1286`), which is
   already how `github-state` closes rows that disappeared from the source
   (`collectors/github-state/run.ts:153-165`).
4. **A collected row is never claimable.** `CLAIMABLE_KINDS` is `task` and
   `review` only (`docs/ops/board.md:28-32`); an `issue`/`pr`/`event` row is
   visible and unclaimable, because "addressed to" and "in progress" would be
   lies about it.
5. **Idempotency is a key, not a heuristic.** `Idempotency-Key` on `/capture`
   (`db/migrations/0014_capture_idempotency.sql:13-17`), `idempotency_key` on
   `tasks.create` (`0008_tasks.sql:12`), `external_ref` uniqueness on collected
   rows (`0005:3`). No source needs a new mechanism.
6. **No inbound source may create a task.** Everything lands as a proposal;
   §4.12's rule stands — "Never auto-create reminders"
   (`metistry-build-plan.md:1499-1500`).

### 3.3 Reminders, honestly

Plan PoC-9 assumed create/update/delete on both stores
(`metistry-build-plan.md:507`) and the note next to it is the right instinct:
"Reminders is a *surface*, not a store" (`metistry-build-plan.md:513`). What
shipped is less than the PoC claimed:

```ts
if (key === "GET /reminders") {
  const r = await helper.request({ op: "list_reminders" });
```
— `packages/mcp-eventkit/src/index.ts:80-82`, and the helper's predicate is
`predicateForIncompleteReminders` (`helper/ek-helper.swift:66`). So:

- **Completed reminders are invisible.** A reminder the user ticked on their
  phone does not come back as "done" — it simply stops appearing. That is
  distinguishable from "deleted" only by keeping our own last-seen set.
- **There is no complete, update or delete verb** at all
  (`src/index.ts:74-96`; `helper/ek-helper.swift:101-119`).
- **The fields we read are five**: `id, title, list, due`
  (`helper/ek-helper.swift:67-69`). `notes`, `url`, `priority`, `isCompleted`
  and `completionDate` all exist on the Apple side and are not surfaced.

Apple's own caveat decides the identity question. From the installed SDK,
`EventKit.framework/Headers/EKCalendarItem.h:36-43`:

```
 @property   calendarItemIdentifier
 @discussion Item identifiers are not sync-proof in that a full sync will lose
             this identifier, so you should always have a back up plan for dealing
             with a reminder that is no longer fetchable by this property, e.g. by title, etc.
```

and `calendarItemExternalIdentifier` is worse for this purpose — "This
identifier will be different between devices for EKReminders" on Exchange
(`EKCalendarItem.h:68`).

**Recommendation.** Treat Reminders as a **surface with a completion
read-back**, not a peer store:

- Push **only** tasks scheduled for today, one Metistry-owned list, and write
  the identity into `EKCalendarItem.URL` — `metistry://task/<anchor>` — which is
  a plain writable property (`EKCalendarItem.h:80`) and survives a sync the
  identifier does not.
- A reminder that disappears from `list_reminders` **and** whose `url` we
  minted is treated as completed, and becomes a *proposal* to tick the
  markdown line — never an automatic edit of the user's note.
- Bridge work needed: `complete_reminder`, `update_reminder`,
  `delete_reminder`, a `include_completed` flag on the list, and `notes`/`url`/
  `priority` on both read and write. All `destructive: true` under the existing
  preview-then-confirm path (`src/index.ts:36-49`).
- The one real Apple constraint to design around: setting a due date on iOS
  requires a start date (`EKReminder.h:45-46`). macOS does not, but the
  reminders sync to the phone, so set both.

**If `EKReminderPriority` is ever used**, the mapping is 1 = highest, 9 =
lowest, 0 = none (`EKTypes.h:246-251`; "priorities of 1-4 are considered
'high,' a priority of 5 is 'medium,' and priorities of 6-9 are 'low'",
`EKReminder.h:74`). It is inverted from what a reader expects and from at least
one secondary summary I checked, which is why it is quoted from the header.

### 3.4 Mail — two shapes, compared, not decided

Nothing exists. Before either shape is built, note what the repo already
concluded: **PoC-13's verdict is "do NOT build the ingest"** — ~30% precision
over 200 real messages, and the single worst failure was a *recall* failure,
missing the highest-stakes item in the corpus while flagging OTP texts
(`metistry-build-plan.md:1502-1512`). The gate is "**≥80% precision on a
held-out labeled set, AND zero misses on a hand-labeled 'must-catch'
stratum**" (`metistry-build-plan.md:1513-1519`). That gate is about
*extraction*, not about *reading mail* — but a mail bridge with no extraction
is a bridge with no purpose, so the gate is effectively the mail gate.

| | **A. Local `~/Library/Mail` reader (TCC helper)** | **B. Read-only IMAP client** |
| --- | --- | --- |
| Credentials | **none** — the store is already on disk (`metistry-build-plan.md:1449-1451`) | an app password or OAuth per account, in the Keychain |
| Permission | Full Disk Access (a TCC grant, `runs_on: host`, invariant 6) | none |
| Shape | Swift bridge, like `mcp-eventkit`; `requires_tcc: [full_disk]` — **a new grant kind; `packages/core/src/manifest.ts` currently enumerates a closed set** | TypeScript bridge, containerisable, `runs_on` anywhere |
| Cloud portability | **fails invariant 7** — assumes this Mac's filesystem | passes |
| Coverage | whatever Mail.app has synced; nothing if the user switches clients | every account, any client |
| Volume | ~72k `.emlx` in 3 months on the owner's Mac (`docs/poc/RESULTS.md:568`) | same volume, over the network |
| Freshness | as fresh as Mail.app | as fresh as you poll |
| New dependency | none | an IMAP client library — **not pre-approved; ask first** (`CLAUDE.md`) |
| Second instance | needs Mail.app configured and the grant re-issued per Mac | works from either machine |

**What I would say if asked to pick, flagged as the owner's call (§9 Q6):** B,
read-only, one account, no bodies past the reducer. A is cheaper on day one and
is what the plan assumes, and it puts a Full Disk Access grant and a
macOS-filesystem assumption into a product whose invariant 7 says "nothing
assumes a shared filesystem". The plan's reason for A was "no IMAP credentials
needed"; that was a *convenience* argument, and it is outweighed by
portability and by the second instance.

**Flights** follow mail and only mail: an itinerary is a confirmation email and
(usually) a calendar event the airline or the user added. Build nothing
flight-specific. When the calendar collector lands, an all-day event whose
title matches a flight shape renders with a plane glyph in the plan; that is
the whole feature.

### 3.5 Transcripts

There is no source. Whatever produces them — a meeting recorder, a phone
recording, someone else's export — the integration is the one that already
exists: **a capture**. A `.md` or `.vtt` file into `Inbox/` with frontmatter
`kind: transcript`, which the reconcile scan picks up
(`apps/reconciler/src/indexer.ts:292-297`), and which the fold hands to an
assistant turn for extraction. Two rules come along for free and must be
stated, because a transcript is third-party content:

- **Reader/writer separation** (`metistry-build-plan.md:1476-1483`): the
  session that reads a transcript holds no vault-commit and no durable-memory
  tool. It emits proposals. This is architectural, not detective, and it is
  exactly right for a recording of other people talking.
- **The data policy applies.** Transcripts of meetings with named third parties
  are the most sensitive content the vault would hold, they are indexed for
  search and embedded by default (`apps/reconciler/src/embeddings.ts`), and
  they would be readable by any agent granted the `Journal` prefix
  (`.env.example:68`). **Recommendation: transcripts land under a prefix that
  is not in any default grant** — `Journal/Transcripts/` — and crews are
  granted it one at a time, the way `Me/` is excluded
  (`targets/local-crew/manifest.yaml:34`). §9 Q7.

---

## 4. Triage, prioritisation and scheduling

### 4.1 The frameworks, and what actually maps

| Framework | The claim | What we take | What we leave |
| --- | --- | --- | --- |
| **GTD** (Allen) — capture · clarify · organize · reflect · engage (gettingthingsdone.com/what-is-gtd, fetched 2026-09-19) | a trusted system beats memory | **the five steps are already the architecture**: `/capture` → `inbox-drain` → the note it lands in → the weekly review → the day's plan | contexts-as-lists. Areas are the contexts, and `area`/`project` already exist on `work` and in the vault tree |
| **Time-block planning** (Newport, calnewport.com, *Deep Habits: The Importance of Planning Every Minute of Your Work Day*, fetched 2026-09-19) — "A 40 hour time-blocked work week, I estimate, produces the same amount of output as a 60+ hour work week pursued without structure"; 10–20 minutes each evening, plan the next day from lists + calendar | **the evening plan for tomorrow, against the calendar's real free time** — this is the single highest-value idea in the brief and the cheapest to build, because the calendar read already exists | blocking *every* minute, and writing blocks back into the calendar. Propose the slot; do not take the slot |
| **MITs** (Babauta, zenhabits.net, fetched 2026-09-19) — three per day, chosen in the morning, done first; "If you put them off to later, you will get busy and run out of time to do them" | **a hard cap of three "today" items**, and the plan names them first. It is the same instinct as the shipped D10 budget of ~5 proposals (`routines/morning-brief/run.ts:12-15`) | the "do them before anything else" rule — that is a habit, not a mechanism, and the system cannot enforce it |
| **Daily Scrum** (scrumguides.org, fetched 2026-09-19) — "a 15-minute event for the Developers"; the Guide does **not** prescribe the three questions: "The Developers can select whatever structure and techniques they want" | **the *shape* of the answer** — yesterday / today / blockers — because that is the shape a standup actually takes | treating the three questions as canonical. They are not in the Guide; the format is the owner's to state (§9 Q4) |
| **Weekly review** (GTD "reflect") | a cadence, not a mood | **already shipped** — `routines/weekly-review/run.ts`, and its "Next week" section already joins `work.due` with the calendar (`run.ts:324-352`) | nothing |

### 4.2 What proposes, what decides

**Nothing decides.** The split is the one the repo already runs on, and no new
mechanism is needed:

| Step | Who | Model? | Where |
| --- | --- | --- | --- |
| Find candidate tasks in the day's notes and transcripts | the **assistant**, on the fold turn | yes | extends `routines/knowledge-fold` (§5.3) |
| Turn a candidate into a request | the fold turn → `capture`/`requests_create` with `suggested_work` | — | `proposals`, existing table |
| Answer it | **the user**, six answers | no | `docs/ops/reply-feedback.md:12-21` |
| Turn an approved request into a row | **the click** | no | `apps/console/src/server.ts:1229-1241` |
| Assign a day and a slot | a **deterministic routine** | **no** — invariant 4 | `plan-tomorrow` (§5.4) |
| Reorder the day | **the user** | no | the Today screen; the user's order is stored and wins |

The only new *idea* is that the fold gets a second job. The queue, the answers,
the idempotency and the audit row all already exist.

### 4.3 The scheduler — arithmetic, in a routine

`plan-tomorrow` runs after the fold, reads three sources through one named
query plus one bridge call, and writes one note. Every step is arithmetic.

**Inputs.** `vault_tasks` (unchecked, with `due`/`scheduled_for`/`priority`/
`size`/`energy`), `work` (open rows with `due`, plus anything `owner = 'me'`),
`proposals` (pending, un-snoozed — same predicate the brief uses,
`routines/morning-brief/run.ts:92-94`), and `GET /events?days=2` from the
EventKit bridge (`packages/mcp-eventkit/src/index.ts:74-78`).

**The score**, in the spirit of the brief's existing one
(`routines/morning-brief/run.ts:35-43`) — deterministic weights, auditable,
printed in the plan so the user can see why:

```
score = 100 if due <= tomorrow                (an explicit date the user set)
      +  60 if scheduled_for == tomorrow      (the user already chose the day)
      +  40 if priority == high
      +  20 * min(carry_over_count, 3)        (ageing: it has been pushed before)
      +  15 if blocking another task          (depends_on points at it)
      -  30 if start_on > tomorrow            (not yet startable)
```

**Explicit user dates are never overridden.** A `due::` or `scheduled::` the
user typed is a constraint, not an input to a ranking; the routine may add a
slot beside it and may warn that the day is over capacity, and it may not move
it.

**The slots.** Free time is the complement of the day's events between the
user's stated working hours. Fill largest-first by `size` (`L` ≈ 90 min, `M` ≈
45, `S` ≈ 15) and prefer `energy: deep` blocks before the first meeting. Stop
at the stated capacity; everything past it is listed under "not today" with its
score. **No event is created** — the plan is a note, not a calendar write. (The
bridge *can* create events, and it is preview-then-confirm; writing the user's
calendar automatically is a much bigger consent question and §9 Q3 asks it
rather than assuming it.)

**The cap.** At most three items are marked "today"; the rest are "if there is
room". This is the MIT rule and the D10 budget agreeing with each other.

**Roll-forward and ageing.** A task whose `scheduled_for` was yesterday and is
still unchecked is *not* silently re-dated — the routine cannot write the
user's note (§2.1). It appears in tomorrow's plan under **Carried over (3rd
time)**, and `carry_over_count` is `(today - first_seen_on)` bucketed by how
many plans have named it. At a threshold — 5 is a reasonable seed, and it
should be configurable — the plan asks the question instead of rolling again:
*"this has moved five times — drop it, shrink it, or give it a date?"* as a
`decision` request, which is what the queue is for.

---

## 5. The daily flow, end to end

### 5.1 The five routines

| Routine | Schedule + gate | Reads | Writes | Needs the user's hand |
| --- | --- | --- | --- | --- |
| **`knowledge-fold`** (extend) | `@hourly`, ≥18:00 local, once/day (already: `run.ts:243-252`) | + today's `Journal/<date>.md`, `Journal/Meetings/<date> *.md`, new `Inbox/` transcripts | one assistant turn; the turn writes `Journal/Fold/<date>.md` and emits task proposals | approve the task proposals |
| **`plan-tomorrow`** (new) | `@hourly`, ≥19:00 local, after the fold's anchor, once/day | `vault_tasks`, `work`, `proposals`, `GET /events?days=2` | `Journal/Plan/<date+1>.md` | read it; reorder; nothing is required |
| **`standup-draft`** (new) | `@hourly`, ≥06:00 local, **working days only**, once/day | yesterday's plan, yesterday's `done_on`/`closed_at`, today's plan, `status='blocked'` | a `Standup` section in `Journal/Plan/<today>.md` + one line in the brief | **edit and post it themselves** |
| **`morning-brief`** (extend) | `@daily` (already) | + today's plan note, + the standup draft | `outbound_messages` | answer the queue |
| **`weekly-review`** (extend) | `@weekly` (already) | + `vault_tasks` ageing, + completion rate | `outbound_messages` | the review itself |

Each new routine declares what it needs so it never spends a window
misconfigured (`packages/core/src/manifest.ts:89-98`):

```yaml
# routines/plan-tomorrow/manifest.yaml
name: plan-tomorrow
type: routine
schedule: "@hourly"
requires:
  reachable: [METISTRY_EVENTKIT_URL]   # degrades absent — the plan still writes, without slots
```

### 5.2 The scheduling constraint, and the alternative

The runner turns a schedule into an interval and nothing else:

```ts
export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  …
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, 0 */N hours, @hourly, @daily, @weekly`);
}
```
— `packages/core/src/schedule.ts:8-17`, and the refusal is pinned by a test:
`expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow(/cannot schedule/)`
(`apps/console/test/manifests.test.ts:131`). The manifest schema's cron regex
*accepts* five fields (`packages/core/src/manifest.ts:12-17`), so a
weekday-shaped schedule passes validation and then fails at the runner — which
is why the console "crash-looped once on an unparsed schedule"
(`packages/core/src/schedule.ts:5`). `loadSchedules` has no `try` around the
call (`apps/console/src/runner.ts:117-139`), so the failure is the console not
starting, not one routine being skipped.

**A latent instance of the same gap, noticed here and out of this note's
scope:** the manifest regex admits **`@monthly`**
(`packages/core/src/manifest.ts:15`) and `scheduleToSeconds` does not handle it
(`packages/core/src/schedule.ts:9-11`). No shipped manifest uses it, so nothing
is broken today — but a manifest that did (the dirs are env-pointable:
`METISTRY_ROUTINES_DIR` / `METISTRY_COLLECTORS_DIR`,
`apps/console/src/main.ts:293-294`) would validate, pass CI's manifest test,
and then stop the console from booting. Either add the case or drop `monthly`
from the regex; one line, its own PR.

So: **`@hourly` plus a gate inside the routine**, exactly as `knowledge-fold`
does and for exactly the reason it documents — "the runner marks a routine due
from its last `routine_run` row, so an `@daily` routine that skipped at 09:00
would be due again at 09:00 tomorrow and never reach the evening"
(`docs/ops/knowledge-fold.md:63-75`).

**The rejected alternative: widen the parser** to real cron with
time-of-day and day-of-week. It is the right end state and it is not this
work's to do. The cost is not the parser; it is that `scheduleToSeconds` returns
an *interval* that two callers use for two different things — the runner's
"is it due" (`apps/console/src/runner.ts:133`) and the watchdog's "has it been
silent too long" (`apps/watchdog/src/manifests.ts:49`). Real cron needs a
`nextFireTime(schedule, after)` and a silence budget derived from it, in both
callers, with the watchdog's alerting re-tuned. Call it **M**, its own PR, and
note that it would delete three gates from three routines when it lands.

### 5.3 The evening fold, extended

Two changes, both small, neither touching the fold's three rules
(`docs/ops/knowledge-fold.md:13-31`).

**1. The brief gains a fifth group: `notes`.** Today `newHandles` reads four
Postgres sources (`routines/knowledge-fold/run.ts:149-229`) and the routine
"never reads the vault, so it can never read its own output"
(`routines/knowledge-fold/manifest.yaml:3`). That property must survive. It
does, because the fold already gets vault handles without opening the vault:
`knowledge_files` has `path`, `mtime` and `content_hash`
(`db/migrations/0001_init.sql:92-98`), so the routine can select *paths changed
today under `Journal/` and `Inbox/`, excluding `Journal/Fold/` and
`Journal/Plan/`* — a SQL query over derived state, not a read. The assistant
then opens them with `knowledge_read`, which is how every other handle already
works.

**2. The fold turn's instructions gain a task job.** In
`seed/assistant-prompt.md`'s fold section, after the journal write:

> **Tasks you found.** For each unchecked `- [ ]` line in today's notes that
> has no `^mt-` anchor, and for each action item stated in a transcript or a
> meeting note, raise **one** request carrying `suggested_work` — title,
> `project` if a slug is named, and `refs` pointing at the note path and the
> line. Never write a task into a note. Never create a row. If you found
> nothing, say so in one line.

The `suggested_work` shape already exists and already drives the extra button
(`docs/ops/reply-feedback.md:60-82`); the fold turn is just a second producer
of it beside `inbox-drain`, which is explicitly allowed — "Crews may set the
same field on a report" (`docs/ops/reply-feedback.md:69-74`).

**Precision, not recall, is the bar** — the §4.12 lesson applies here verbatim:
"Small models find todos everywhere. Emit **proposals** into a review queue …
Never auto-create" (`metistry-build-plan.md:1497-1500`). The fold runs on the
`routine` tier (cheap, `routines/knowledge-fold/run.ts:276`), which is exactly
the model class that over-extracts. Two deterministic guards, in the routine,
not the prompt: **dedupe by normalised title** against open `vault_tasks` and
`work` before the request is written, and **cap the number of task requests per
fold** (5 is a reasonable seed) so one bad night cannot flood the queue.

### 5.4 Tomorrow's plan — and the `Journal/<date>.md` collision

**The collision.** The fold writes `Journal/<date>.md`
(`routines/knowledge-fold/run.ts:104`, `seed/assistant-prompt.md:40`). The
brief asks for a daily note at, naturally, `Journal/<date>.md`. Those are two
writers on one file — "the exact conflict scenario this design avoids"
(`metistry-build-plan.md:1681-1682`, about Obsidian Git).

**The fix is files, not conventions.** HTML-comment fences ("do not edit below
this line") are a prompt-shaped control and this repo does not accept those.
Three files, one writer each, and Obsidian's own embed syntax —
"Prefixing an internal link with an exclamation mark (!) allows you to embed the
linked content" (`obsidian.md/help/links`, fetched 2026-09-19) — makes them read
as one page:

| Path | Writer | `source:` | Contents |
| --- | --- | --- | --- |
| `Journal/<date>.md` | **the user only** | `user` | the day's notes, tasks, thoughts |
| `Journal/Plan/<date>.md` | `plan-tomorrow` (deterministic) | `plan-tomorrow` | schedule, today's tasks + why, carry-overs, Needs You, standup draft |
| `Journal/Fold/<date>.md` | the assistant's fold turn | `assistant` | what happened, what was decided, `decisions:` frontmatter |
| `Journal/Meetings/<date> <topic>.md` | the user (or a transcript-derived sibling) | `user` | attendees, decisions, action items |

The daily-note template's first two lines are `![[Journal/Plan/<date>]]` and
(at the bottom) `![[Journal/Fold/<date>]]`. The user opens one note. Three
processes never touch one file. `ownershipRefusal` (§2.6, once fixed) is the
backstop, not the mechanism.

**`plan-tomorrow` needs a write path the assistant's does not give it.** It is
a routine, so it calls no model (invariant 4) and holds no `knowledge_write`
tool. It writes through the reconciler bridge directly —
`POST /vault/write` with `expected_sha256` (`apps/reconciler/src/server.ts:196-209`),
the same door `captureToInbox` uses (`docs/ops/inbox.md:34-39`) — under its own
principal, `plan-tomorrow`, so `source:` is stamped from the credential and
ownership is a fact rather than a claim (`docs/ops/knowledge-fold.md:87-89`).

### 5.5 The daily note template — exact sections

Ships in `seed/vault/Templates/Daily.md` (and a `Meeting.md` beside it), stamped
by `metistry init`, which today creates neither the directory nor the file
(`packages/cli/src/init.ts:264-276`).

```markdown
---
id: {{id}}
type: journal
status: active
source: user
date: {{date:YYYY-MM-DD}}
area: ""
people: []
decisions: []
created: {{date:YYYY-MM-DD}}
updated: {{date:YYYY-MM-DD}}
tags: [daily]
---

# {{date:YYYY-MM-DD}} — {{date:dddd}}

![[Journal/Plan/{{date:YYYY-MM-DD}}]]

## Today

- [ ]

## Notes

## Captured

<!-- anything you type here that starts with `- [ ]` becomes a task -->

## Meetings

![[Journal/Fold/{{date:YYYY-MM-DD}}]]
```

Five properties of that file, each deliberate:

1. **`source: user` is in the template**, which is what makes §2.6's fix bite
   on day one rather than only for notes created after it.
2. **`type: journal`** matches the frozen frontmatter schema
   (`metistry-build-plan.md:1636-1658`), so CI's shape validation applies
   unchanged.
3. **`area` and `people` are present but empty** — the schema requires
   list-typed fields to stay lists even with one element
   (`metistry-build-plan.md:1659-1663`).
4. **The two embeds are the only machine content**, and they are transclusions
   of files this note does not own.
5. **Nothing in it is a status word.** Every state is a field or a checkbox.

And the plan note `plan-tomorrow` writes:

```markdown
---
source: plan-tomorrow
type: journal
status: active
date: 2026-09-22
tags: [plan]
---

## 📅 Schedule
- 09:30–10:00  1:1 with [[Ada]]  @ Zoom
- 13:00–14:00  Q4 planning  — with Ada, Sam, Priya
- (all day)  UA 447 EWR→SFO

## ✅ Today  (3 — your cap)
- Draft the Q4 plan · due Wed · 90m · best slot 10:15–11:45   → Journal/2026-09-21.md#^mt-9k4p
- Review PR #418 · blocking Sam · 30m · slot 11:45–12:15      → work #418
- Call the dentist · due tomorrow · 15m                        → Journal/2026-09-18.md#^mt-7x2k

## ↩︎ Carried over
- Renew the cert — 3rd time, first seen 2026-09-16

## 🔔 Needs you (4)
- #91 note · "Ada wants the brand deck by Friday"
- …one tap away in Needs You

## 🗣 Standup
**Yesterday:** …
**Today:** …
**Blockers:** …

## 🕓 If there is room
- …
```

### 5.6 The standup

**What it is.** A *draft answer*, in the plan note and in the morning brief,
which the user edits and posts themselves.

**What it is not.** Metistry does not post it. There is no chat integration,
and if a Slack bridge ever exists it is preview-then-confirm like every other
destructive tool (`packages/mcp-eventkit/src/index.ts:36-49`) — and even then
"the console's mutating surface is closed" (invariant 10) means posting to a
channel would be a new *action kind*, and the action enum is deliberately four
and contains no message-sending at all (`docs/ops/actions.md:16-24`: "no email,
no message, no git, no shell, no grant").

**How it is composed** — deterministic, three queries:

- **Yesterday:** `vault_tasks WHERE done_on = yesterday` ∪ `work WHERE
  closed_at::date = yesterday` ∪ merged PRs from `work` where `kind='pr'` and
  `meta->>'merged' = 'true'` (already collected,
  `routines/weekly-review/run.ts:56-58`).
- **Today:** the ≤3 items from today's plan.
- **Blockers:** `work WHERE status = 'blocked'` — the human-gated column
  (`docs/ops/board.md:44`) — plus tasks whose `depends_on` names an open row.

**The working-day gate.** `Me/profile.md` frontmatter, read through the
reconciler like any other note; `rules.yaml` *references* profile values rather
than duplicating them (`metistry-build-plan.md:1686-1692`):

```yaml
# Me/profile.md frontmatter
working_days: [mon, tue, wed, thu, fri]
working_hours: "09:00-17:30"
daily_capacity_min: 240
standup_time: "09:15"
standup_format: yesterday_today_blockers
```

Those five keys are the owner's to state and nothing can guess them (§9 Q4).
The gate is in the routine, for §5.2's reason, and it degrades honestly: no
`working_days` → the routine writes nothing and says so once in `runs`, rather
than guessing Monday-to-Friday.

### 5.7 During the day

Capture is the one part that mostly works. What is missing is the *task* shape
of it:

- **Quick-add with fields.** The "+" composer (`docs/product/app-ux-plan.md:220`)
  gains an optional task mode: title, due, project — which writes a capture
  whose first body line is `- [ ] …`, i.e. exactly the cue
  `suggestedWork` already recognises (`collectors/inbox-drain/run.ts:54`). **No
  server change at all** for the first version; the capture becomes a proposal
  with the Approve-as-Work button five minutes later.
- **Ticking a box in Obsidian** is picked up by the next reconcile cycle
  (`METISTRY_RECONCILE_INTERVAL_SEC`, default 300 —
  `docs/ops/inbox.md:199-203`). That is the latency, it is fine, and it should
  be *said* in the UI rather than papered over.
- **`/note`** stays the fastest path and needs nothing
  (`docs/ops/inbox.md:21`).

### 5.8 The weekly review tie-in

`weekly-review` already emits "Next week" from `work.due` plus a 7-day calendar
read (`routines/weekly-review/run.ts:324-352`). Three additive sections, all
SQL:

- **Completion**: created vs completed this week, from `vault_tasks.done_on`
  and `work.closed_at`.
- **Ageing**: the five oldest unchecked tasks by `first_seen_on`, with their
  carry-over counts — the "reflect" step of GTD given a number.
- **Where tasks came from**: counts by `source` prefix, which is how the owner
  finds out that 40% of their week arrives from one meeting series.

---

## 6. Where it shows in the apps

**No new top-level section.** The IA is settled at six sidebar rows — Chat ·
Feed · Work ▸ · Knowledge ▸ · Agents · Insights, with Pinned below
(`docs/product/app-ux-plan.md:614-624`) — and five iOS tabs maximum
(`app-ux-plan.md:606-612`). This adds one screen inside an existing row.

| Thing | Where it lands | Exists? |
| --- | --- | --- |
| The day's plan, the standup draft, "what happened" | **Feed** | the feed exists; the plan is a new row type |
| Tasks, the board, promotion | **Work ▸ Board** | exists (`docs/ops/board.md`) |
| **Today** — the day's ≤3 + carry-overs + slots | **Work ▸ Today** (new, 7th child of Work) | **new** |
| Task proposals | the **bell**, six-answer card, Approve as Work | exists (`app-ux-plan.md:563-569`) |
| Quick-add a task | the **"+"** composer, task mode | composer exists (`app-ux-plan.md:220`) |
| The daily / plan / fold notes | **Knowledge ▸ Pages** | phase E, sized at ≈7.5 agent-days (`app-ux-plan.md:479-499`) |
| Pin today's plan or a project board | **Pinned** | exists (`app-ux-plan.md:614-624`) |

**What the designer needs to know** (a list, not a design):

1. A **task card** that is not a board card: it carries a *slot* and a *reason*
   ("due Wed · blocking Sam · 90m") and is reorderable by drag, and the order
   the user leaves it in is authoritative.
2. **Two visually distinct task origins** — a markdown task (lives in a note,
   click-through opens the note at the block) and a `work` row (lives on the
   board, has an owner and a lease). They must not look identical, because
   their verbs differ.
3. A **carry-over chip** with a count, escalating in weight at 3 and again at 5.
4. A **capacity meter** for the day — minutes planned against
   `daily_capacity_min` — that shows over-capacity without refusing anything.
5. The **standup block** needs a one-tap "copy as plain text" and nothing that
   looks like a send button.
6. **Empty and absent are different states** (`design-system.md` §3.15) and this
   screen has three: no tasks, no calendar bridge, no working-day rules set.
7. **Promotion** is one control with a confirmation, and it is one-way — the UI
   must not imply a task can be demoted back.
8. A **relative-time honesty stamp** — the reconcile interval means a box ticked
   in Obsidian is up to five minutes stale, and the brief's existing "as of N
   min ago" convention (`metistry-build-plan.md:880-881`) covers it.

---

## 7. Phased plan

Sizes are agent-days, in the units `docs/product/app-ux-plan.md:479-499` uses.

| Phase | Contents | Size | Proves | Depends on | Who |
| --- | --- | --- | --- | --- | --- |
| **1. The line and the index** | checkbox + inline-field parser in `apps/reconciler/src/notes.ts`; `vault_tasks` migration; the reconciler upsert; one named query `day_tasks`; `seed/vault/Templates/{Daily,Meeting}.md`; `metistry init` stamps `Journal/`, `Journal/{Plan,Fold,Meetings}/`, `Templates/`; the `ownershipRefusal` fix + `now.md` seeding | **3** | a task typed in Obsidian is a queryable row in five minutes, and survives `down -v` | nothing | **agent, now** |
| **2. The plan for tomorrow** | `routines/plan-tomorrow` (score, slots, carry-overs, the note); `plan-tomorrow` principal on the vault bridge; `morning-brief` reads the plan note | **3** | the evening-plan loop, the highest-value idea in the brief | phase 1; EventKit bridge running (**degrades absent**) | **agent**, but the score's weights want the owner's eye |
| **3. The fold harvests tasks** | fifth handle group; `suggested_work` from the fold turn; dedupe + per-fold cap; prompt section | **2** | capture → proposal → Approve as Work, end to end, from a note the user wrote | phase 1; **an engine on the instance** | agent; **blocked on the second instance's engine** (`docs/plan-refresh-2026-09-13.md:420-440` W1: the fold is the only routine that enqueues a turn) |
| **4. The standup** | `Me/profile.md` schema + reader; `routines/standup-draft`; brief section; copy-as-text in the app | **2** | the morning answer, drawn from the plan | phase 2; **the owner's days, hours, capacity and format** | **owner first**, then agent |
| **5. Today, in the app** | Work ▸ Today; task card; quick-add task mode; promotion control | **4** | the flow without Obsidian open | phases 1–2; Mac app phase A client (`app-ux-plan.md:469`) | agent + designer |
| **6. Calendar in, properly** | `collectors/calendar-state` upserting `kind: 'event'` on `cal:<id>`; travel/all-day rendering | **2** | the plan's schedule comes from rows, not a live bridge call each time | EventKit bridge | agent |
| **7. Reminders as a surface** | bridge verbs (`complete`, `update`, `delete`, `include_completed`, `notes`/`url`/`priority`); push today's tasks; completion read-back as a proposal | **4** (half Swift) | the phone surface, without a second store | §9 Q5 ruled | agent; **owner rules first** |
| **8. Transcripts** | `kind: transcript` capture path; `Journal/Transcripts/` prefix out of default grants; extraction on the fold turn under reader/writer separation | **3** | meeting → action items, with the privacy boundary intact | phase 3; **a transcript source, which does not exist** | **owner** must name a source |
| **9. Slack** | one-way-in bridge (`runs_on` anywhere, outbound only on confirm) | **5** | work items from chat | a workspace + an app install | **owner** |
| **10. Mail** | §3.4's A or B | **5–8** | the largest ingest, the lowest precision | **PoC-13 re-run clearing its two-sided bar** (`metistry-build-plan.md:1513-1519`) | **owner rules the shape; the bar gates the build** |

**Buildable by an agent today, with no owner input: phases 1, 2, 6** — eight
agent-days that deliver the capture → index → plan → brief loop end to end on
the vault alone, with the calendar as a degrading extra. Phase 3 needs an
engine. Everything from 4 on needs the owner to say something only they know.

---

## 8. Contradictions with the plan

Logged, not edited (`CLAUDE.md`).

**8.1 — "Never mirror status into markdown" vs. tasks in the daily note.**
`metistry-build-plan.md:1628-1632`: "**Knowledge holds context; Postgres holds
status.** … Never mirror status into markdown; it drifts within a week." And
`:1720-1721`: "**Todos** — never markdown lists that rot: `/note` or capture →
triage → the `work` table or Reminders (§PoC-9), where status lives." §2.1
recommends the opposite for the user's own tasks. **The recommendation is not a
mirror** — it is a move of the canonical home, and mirroring stays forbidden —
but the plan's sentence is written broadly enough that this needs the owner's
ruling before a line of it is built. My argument is in §2.1; the plan's own
counter-argument is that a markdown list rots, and §2.5's answer is that status
is never *written*, only derived.

**8.2 — `Journal/Daily/<date>.md` vs `Journal/<date>.md`.** The plan says
`Journal/Daily/2026-08-29.md` and `Journal/Meetings/2026-08-29 <topic>.md`
(`metistry-build-plan.md:1710-1714`). The shipped fold writes
`Journal/<date>.md` flat (`routines/knowledge-fold/run.ts:104`,
`seed/assistant-prompt.md:40`, `docs/ops/knowledge-fold.md:22-23`). §5.4
recommends keeping the user's note flat at `Journal/<date>.md` and moving the
*fold's* output to `Journal/Fold/<date>.md` — which changes shipped behaviour
in the seed prompt and the routine, and is a product PR.

**8.3 — Invariant 1 vs `work` task rows.** `db/migrations/0008_tasks.sql:7-9`:
"Durability (open decision D6) … Everything here is durable — it is
agent-authored state with no upstream source to rebuild from." Invariant 1 says
Postgres is derived. This is a known, named gap — D6, "Decide before backup/DR
is built" (`metistry-build-plan.md:2660-2670`) — and this work makes it
sharper, because it moves the *majority* of tasks (the user's) onto the derived
side and leaves only the coordination rows durable. That is an argument for
resolving D6 in this work's favour, and it is still D6's to resolve.

**8.4 — PoC-9 claimed Reminders CRUD; the bridge has create only.**
`metistry-build-plan.md:507` ("Test create, update, and delete on both stores")
and `:301` (PoC-9 **PASS**, "Calendar + Reminders CRUD under launchd") versus
`packages/mcp-eventkit/src/index.ts:74-96`, which exposes four verbs, two of
them writes, neither of them update or delete. The PoC may well have proved it;
the shipped bridge does not do it.

**8.5 — The §4.15 vault tree is not created by anything.** The plan describes
`Areas/`, `Projects/`, `Journal/`, `People/`, `Me/`, `Templates/`
(`metistry-build-plan.md:1584-1602`) and says "Templates ship in `seed/`"
(`:1726`). `seed/vault/` holds three files and `metistry init` creates one vault
directory (`packages/cli/src/init.ts:270`). Every default grant names folders
that do not exist (`.env.example:68`). Not a contradiction anyone introduced —
just a gap, and phase 1 closes it.

**8.6 — The reconciler writes Postgres, which invariant 3 reads as forbidden.**
"No component talks to Postgres directly (sole exception: the watchdog's
liveness probes)" (`CLAUDE.md`), versus
`apps/reconciler/src/indexer.ts:181,197,316,326,337`. Pre-existing, four tables
deep, and `vault_tasks` adds a fifth. The invariant's force is on the read
path, which stays a named query — but the sentence says what it says, and it is
the owner's to amend or to leave.

---

## 9. Open questions (the owner's)

**Q1 — Does the canonical home move?** §2.1 recommends that a task the user
does lives in markdown and a task an agent may claim lives in `work`. This
contradicts plan §4.15 deviation 2 (§8.1). Nothing is built on either side of
this. **If the answer is no**, the fallback is §2.7 with non-checkbox rendering,
and the brief's "capture from a daily note" becomes "capture → triage → board",
which is roughly what exists.

**Q2 — Emoji or `[key:: value]` for task attributes?** §2.2 recommends inline
fields for diff and parser reasons and names the real cost: without the
Dataview plugin they render as literal text. If the owner installs the Obsidian
Tasks plugin and prefers its default, the parser reads both — it is one more
regex — but the *writer* (quick-add, the app) must pick one and only one.
Related: does the owner want Tasks' `#task` global filter, which would mean
only tagged lines count?

**Q3 — May `plan-tomorrow` write blocks into the calendar?** The bridge can
create events, preview-then-confirm (`packages/mcp-eventkit/src/index.ts:85-89`).
§4.3 recommends **no** — propose the slot in the note, never take the slot —
because a routine writing the user's calendar nightly is a much larger consent
question than anything else here. Worth an explicit answer.

**Q4 — The five keys nothing can guess.** `working_days`, `working_hours`,
`daily_capacity_min`, `standup_time`, `standup_format`. Also: is the standup
answer's shape yesterday/today/blockers, or whatever the owner's standup actually
uses? The Scrum Guide does not prescribe the three questions
(scrumguides.org, fetched 2026-09-19), so there is no external authority to
fall back on.

**Q5 — Is a mirrored Reminders list acceptable at all?** §3.3's shape means the
same task appears in two places, which is the thing §4.15 deviation 2 was
written to prevent. The plan's own line — "Reminders is a *surface*, not a
store" (`metistry-build-plan.md:513`) — supports a *push-only today list* with
completion read-back, and that is what §3.3 recommends. If the answer is "no
mirror at all", phase 7 is deleted and the phone surface is Obsidian plus the
PWA, which is a defensible answer.

**Q6 — Mail: local store or read-only IMAP, and when?** §3.4 compares them and
declines to choose. The *when* may matter more than the *which*: PoC-13's
two-sided bar has not been re-run, and until it is, mail ingest is "a research
task, not a build task" by the plan's own words
(`metistry-build-plan.md:1520-1521`).

**Q7 — Transcript privacy.** A transcript is a recording of other people. §3.5
recommends `Journal/Transcripts/` be outside every default grant and granted to
crews one at a time. That needs a ruling because it also means the *assistant's*
default area list (`.env.example:68`) would need `Journal` narrowed or
`Journal/Transcripts` explicitly excluded — and the grant validator's prefix
semantics make exclusion awkward (`seed/queries/knowledge_pages.yaml:28-34`).
Also: retention. §4.12's rule for raw comms is "days, not years"
(`metistry-build-plan.md:1523-1526`); a transcript in git is forever.

**Q8 — The ageing threshold.** §4.3 seeds "ask after 5 carry-overs". Is that a
constant, a `rules.yaml` key, or something the user sets per task?

**Q9 — Does Slack come before or after mail?** Both are phase 9/10 and both need
the owner. Slack is smaller, more precise (a message *addressed to you* is a
much better task signal than an email), and needs an app install the owner may
not be able to do. Mail is bigger, noisier, and needs no one's permission.

---

## Sources

**Repo** (read at `origin/main` `2aba1fb`, 0.10.0, 2026-09-19) —
`CLAUDE.md`; `metistry-build-plan.md` §§0, 4.1, 4.8, 4.9, 4.12, 4.13, 4.15,
4.19, 4.20, 5, 6; `docs/plan-refresh-2026-09-13.md` §§4, 4a, 4b;
`docs/product/app-ux-plan.md` §§2, 3.1–3.3, 6, 6.1, 7; `docs/product/glossary.md`;
`docs/ops/{board,inbox,knowledge-fold,threads,automation,actions,reply-feedback,instance-layout,capture-shortcut,console-api}.md`;
`db/migrations/{0001,0002,0005,0006,0008,0009,0011,0014,0015,0019}`;
`routines/{knowledge-fold,morning-brief,weekly-review}`;
`collectors/{inbox-drain,github-state}`;
`packages/{tasks,core,mcp-brain,mcp-eventkit,cli}`;
`apps/{console,reconciler}`; `seed/{assistant-prompt.md,rules.yaml,identity.yaml,vault,queries}`.

**Apple, read locally from the installed SDK** —
`MacOSX.sdk/System/Library/Frameworks/EventKit.framework/Versions/A/Headers/`:
`EKReminder.h` (due/start/completed/completionDate/priority),
`EKCalendarItem.h` (`notes`, `URL`, `calendarItemIdentifier` — "not sync-proof",
`calendarItemExternalIdentifier`), `EKTypes.h:234-251` (`EKReminderPriority`).

**External, fetched 2026-09-19** —
Obsidian Help, *Links* (`https://obsidian.md/help/links`) — block identifiers,
allowed characters, embed syntax.
Obsidian Tasks, *Tasks Emoji Format* and *Dataview Format*
(`https://publish.obsidian.md/tasks/Reference/Task+Formats/…`).
GitHub Docs, *About task lists*
(`https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-task-lists`).
Scrum Guide 2020 (`https://scrumguides.org/scrum-guide.html`) — the Daily
Scrum, and the absence of the three questions.
Cal Newport, *Deep Habits: The Importance of Planning Every Minute of Your Work
Day* (`https://calnewport.com/deep-habits-the-importance-of-planning-every-minute-of-your-work-day/`).
Leo Babauta, *Purpose Your Day: Most Important Task (MIT)*
(`https://zenhabits.net/purpose-your-day-most-important-task/`).
Getting Things Done, *What is GTD* (`https://gettingthingsdone.com/what-is-gtd/`).
