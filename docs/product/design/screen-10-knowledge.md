# Screen 10 — Knowledge

Drawn 2026-09-22 and rebuilt the same day. The first pass organised itself around
`knowledge_pages` and `collector_health` and came out a file browser with a status
header. §5.1 of `design-system-amendments.md` — written the night before — names
that exact mistake, so this rewrite is the rule applied to the surface that broke
it. The owner's words: *the question we should ask ourselves is what the user's
intent is when visiting this page.*

## 1. What the screen is for

Knowledge is **where the owner reads what the system learned, and settles what it
could not decide alone.** It is not a file browser; Obsidian is the file browser,
and it is better at it. Five intents, in the order they arrive:

| Why the owner opened it | What answers it |
| --- | --- |
| *What did it learn last night?* | **The fold**, in prose, at the top |
| *Is anything waiting on me?* | **Needs your eye** — drafts, conflicts, suggestions |
| *What is in here, roughly?* | **Areas**, each with a written line |
| *How does this even work?* | One architectural rule per section, in situ |
| *Are the feeds alive?* | One line, folded, until one isn't |

The last one led the first pass. It is last because **a source that is working
should be ignorable** — and the four states are still drawn, inside the fold-out,
where they earn the space.

## 2. The fold — prose the assistant wrote, surfaced

`routines/knowledge-fold/run.ts` already writes `Journal/Fold/<date>.md` nightly,
from `Templates/Fold.md`, in the assistant's own voice, as its own commit. It is
the one template where `{{ prose }}` is legal (D14), and the routine never reads
its own output. So *summaries of new knowledge areas* is not a thing to invent —
it is a file that today can only be read by opening Obsidian. **Surfacing it is
the whole of the change** (C65).

Drawn in the agent wash, in the system serif, with `Journal/Fold/2026-09-22.md`
shown beside the label. Three rules hold here harder than anywhere, because this
is the longest stretch of agent text in the product:

- **P1.** Every control in the card is the reader's — *Open The Fold*, *Earlier
  Folds*, the thumbs. The prose itself offers nothing to press.
- **The one exception is a page name.** Wikilinks inside the fold render as links,
  because a path is a reference, not an action — following one goes to a page and
  changes nothing.
- **It is judged like any generated answer.** The thumbs are the transcript's
  feedback control, unchanged.

**Under it, the rule it depends on:** *Metis writes here, in its own voice, as its
own commit. In your daily note it writes only its own section, between its
markers; the rest of the note is yours* (C102, 2026-09-25).

## 3. Needs your eye — and why this is not a second queue

Four kinds of item, one row each: **Draft**, **Conflict**, **Suggestion**. Each
row is *what it is · which page · why it is here · the verb*.

```
NEEDS YOUR EYE  4
 ✎  Draft       Areas/Fsl/vendors.md      Metis rewrote the vendor summary…  Review →
 ✎  Draft       Areas/Health/protein.md   New section on the cost basis       Review →
 !  Conflict    Areas/Health/2026/sleep.md You edited it while the fold wrote Resolve →
 ✦  Suggestion  Areas/Health/            Metis thinks these four notes are…  Read →
```

**The count sits in the section header, never in a badge.** P2 gives the product
one badge and it belongs to Needs You — and these items *are already* requests
there. A second badge would count the same pending thing twice.

### 3.1 Decide in Needs You, edit on Knowledge

A draft settlement is a `review_decisions` row — `kind: draft_settle`, alongside
`knowledge | report | grant_elevation | action` — and the migration's own comment
says a note's `status: draft` frontmatter marks the same row. **One pending thing,
read from two places**, which is only honest if the screen says so:

- **Needs You** asks *yes or no*, in a queue the owner works down.
- **Knowledge** gives the prose reading width, the captures behind it, and an
  **Edit First** button — because a draft that is nearly right should be
  corrected, not declined.

The card says it in as many words: *this arrived as a request, so answering it
here answers it there.*

### 3.2 A draft is hidden from agents, not from the owner (C66)

`knowledge_pages` drops `status: draft` rows using the same `WHERE` clause
`mcp-brain` applies, "so the owner's list and an agent's index cannot disagree
about what a draft is." The intent is right — **a draft is never served to an
agent** — but the owner is not an agent. The first pass repeated the query's logic
as product intent and printed *a draft is invisible to you too, and that is
deliberate*. That was wrong: hiding a draft from the owner hides it from the only
person who can settle it. Drafts belong in the review section, which is where they
are.

**Under the section, the rule:** *A draft is never served to an agent. Marking a
note `status: draft` is how you keep it from your own agents until you have read
it.*

## 4. A conflict, resolved in place

`knowledge_files.status` is `clean | dirty | conflict`, and the query's comment is
the design constraint: a conflict row is a file the reconciler could not settle,
**so its title and mtime are not facts yet** — a row whose path is known and whose
metadata is not, which is the fifth state C28 proposed and could not place.
**Recommendation restated: ratify `partial`.** Two surfaces need it now.

The owner asked to resolve conflicts *interactively*, so the row is a doorway:

1. **Who wrote what, and when.** *You edited this at 9:12 PM. The fold wrote to it
   at 9:14 PM.* Named, not inferred.
2. **Neither write was lost.** The reconciler stopped rather than choosing.
3. **The diff**, with the existing `diff()` component — `-` is yours, `+` is the
   fold's.
4. **Three verbs: Keep Mine · Take The Fold's · Merge In Obsidian.** No
   auto-merge and no fourth button: a three-way merge inside the console is the
   console mutating the vault by inference, which invariant 10 closes. Obsidian is
   the editor; this screen is where the decision is made.

**Under it, the rule:** *One writer per file is what makes the vault safe to share
with agents. A conflict is that rule holding — the alternative is a silent
overwrite.*

## 5. Areas — described, not counted

One row per area: the path, **a written line**, and why it is in front of the
owner.

```
AREAS                              Why it is here, not how much of it there is
 Areas/Fsl      Drey, the business setup, and the vendor thread…  Named by last night's fold
 Areas/Health   Sleep, labs, and the protein blend                Changed by you 2 hours ago
 Areas/Ops      The lease, the studio, and the things with dates   Behind work #418
 Journal        Your daily notes, and the fold's own file beside them  Linked from 6 pages
```

**Nothing writes that middle column yet (C68).** A file count is available and is
not an answer — it tells the owner *how much*, and they asked *what*. The routine
that can write it exists and already writes prose (C65).

**The right-hand column is the relevance answer, and it is provenance rather than a
rank.** *Changed by you 2 hours ago* is `knowledge_files.mtime`; *named by last
night's fold* is the fold's own wikilinks; *behind work #418* is
`knowledge_page_links` reached from the task; *linked from 6 pages* is a count. P5
forbids a computed score, and the facts do the same job better: when one is wrong,
the owner can see why.

**Under the section, the rule:** *A folder is a permission boundary: a grant names
a path prefix, so organising your vault is also configuring what an agent can
reach.*

The page table — path, title, mtime — still exists, **behind an area and behind
search**. It answers *what is in here* with data, which is the right answer once
the owner has chosen where to look.

## 6. Sources — one line, until something is wrong

```
 ○  4 sources · freshness unknown                                            ›
```

*Until the per-collector last-ok time exists (C1, C64), the line cannot say
"all current" — that would be an inferred ok (P5). It reports what it can, and
becomes "4 sources, all current" the day the wire answers.*

Expanded by a fault, not by a click:

```
 ●  4 sources · 1 behind                                                      ⌄
    ●  aws-costs        checked 3 days ago                            3d old
    !  devin-sessions   last succeeded 2 days ago · token expired
```

The two rules kept from the first pass, unchanged because they are right:

- **Stale annotates; it never replaces.** The age rides the name, the value stays.
- **Failed carries two timestamps.** *Failed 2 hours ago* invites the reader to
  think the data is two hours old. *Last succeeded 2 days ago · token expired* is
  what is true.

And the standing request: **nothing in the wire can answer *is this current*.**
`agent_presence` has no collector notion; `activity_feed` takes `collector_run`
only `WHERE ok = false`, so a healthy collector is invisible. Request C1, four
rounds old (C48, C64).

## 7. Links — two lists, on a page

Outgoing and incoming, with `kind` shown, because a frontmatter link and a
wikilink mean different things about intent and an **embed** is a third thing
again. No graph: a graph answers *what does the whole vault look like*, which is
not a question the owner has. These live on a page, not on this screen — *what
points at this* is a question you have while reading something.

## 8. What the rebuild dropped, and what it asks for

**Dropped:** the top-level page table (it answered a meaning question with data);
the sources block as a section (folded to a line); the claim that drafts are hidden
from the owner (C66, corrected).

**Kept intact:** the four states inside the sources fold-out, the `conflict` row as
the argument for `partial`, and the two link lists.

**Asks of the build, in the order they unblock this screen:**

1. **A query for the newest fold** — body and outgoing links (C65). Without it the
   top of the screen is a file the owner must open Obsidian to read.
2. **A drafts-for-the-owner read** (C66) — or an owner flag on `knowledge_pages`.
3. **One written line per area** (C68), from the fold or a sibling routine.
4. **A per-collector last-ok time** (C1/C48/C64), still.
5. **Ratify `partial`** (C28), on the strength of the conflict row.

## Corrected 2026-09-23 (review 01)

- A draft is answered **Approve · Revise · Decline** (amendments §8.1), not
  *Accept · Edit First · Discard*.
- The sources line reads *freshness unknown* until the wire can say otherwise
  (§6, P5).
