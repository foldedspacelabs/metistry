# Screen 10 — Knowledge

New, 2026-09-22. Drawn while the owner slept, so every judgement call is named as
one.

## 1. The three questions

Knowledge is the vault, read. It answers three things, and they are not equally
well served by the wire:

1. **What is in here?** — `knowledge_pages` serves this completely.
2. **Is it current?** — **nothing serves this**, and it is the more important
   question. Four rounds of `stale` have been specified and drawn nowhere (C48).
3. **What links to what?** — `knowledge_page_links` serves this completely.

So the screen is ordered by the question, and the unanswerable one is at the top
rather than hidden at the bottom, because *is this current* is what makes the rest
trustworthy.

## 2. Sources — where `stale` finally lands

Round C specified **stale** — *it was answering and has not lately* — and parked
it on Knowledge and Agents. Agents could not answer it (`agent_presence` has no
collector notion) and Activity deliberately would not (`activity_feed` takes
`collector_run` only `WHERE ok = false`, so a **healthy** collector is invisible).
This is the surface that owns the question.

```
SOURCES                                          4 sources · 1 behind
 ●  github-state      checked 4 minutes ago
 ●  aws-costs         checked 3 days ago                      3d old
 ◌  slack-bridge      never configured
 !  devin-sessions    last succeeded 2 days ago · token expired
```

Four states, and they are the ratified four doing exactly the work they were
defined for:

| | Means | Mark |
| --- | --- | --- |
| current | checked recently and succeeded | nothing. The normal case says nothing |
| **stale** | succeeded, but not lately | the **age rides the name** — it annotates, it never replaces. The data is still the last true data |
| absent | never configured | neutral, and it names the variable rather than spending it |
| failed | it answered and the answer was an error | the error verbatim, and the last time it *did* succeed |

**`failed` carries two timestamps and that matters.** *Failed 2 hours ago* on its
own invites the reader to assume the data is two hours old. *Last succeeded 2 days
ago · token expired* says what is actually true: the data is two days old and the
reason it stopped is known.

## 3. Pages

Grouped by **area**, which is derived and not stored: the vault's TitleCase tree
*is* the grouping, and an area is a path prefix everywhere else in the system, so
the column is the first two segments under `Areas/` and the first segment anywhere
else. A root file like `now.md` has no area and says `NULL` rather than an empty
string, so *every area* can never collide with a real value.

The design follows that rather than inventing a taxonomy: **the folder tree is the
navigation**, and there is no second organising idea layered over it.

### 3.1 `conflict` is the first real instance of `partial` (C28)

`knowledge_files.status` is `clean | dirty | conflict`, and the query's own
comment is the design constraint: a conflict row "is a file the reconciler could
not settle, **so its title and mtime are not facts yet**."

That is a row whose *path* is known and whose *metadata is not* — which is exactly
the fifth state **C28 proposed and could not find a use for**: a row that parsed
partly. It is not `failed` (nothing broke), not `absent` (the file is right
there), and not `stale` (this is not about age).

So the row shows the path, and **where the title would be it says why there isn't
one** — not a blank, not the filename dressed up as a title:

```
Areas/Health/2026/sleep.md    ⚠ conflict — the reconciler couldn't settle this
                                 file, so its title isn't a fact yet
```

**Recommendation:** ratify `partial` on the strength of this, and let the row
vocabulary carry it. Four rounds of a state with no instance is a state that was
guessed at; one shipped instance is an argument.

### 3.2 A draft is invisible to the owner too, and that is deliberate

`status: draft` in frontmatter hides a page at **every tier** — including the
owner's own list — because the same `WHERE` clause `mcp-brain` applies is applied
here, "so the owner's list and an agent's index cannot disagree about what a draft
is."

That is unusual enough to state on the screen rather than leave as a surprise. The
count is shown and the pages are not: **"3 drafts, hidden here as they are hidden
from agents."** Hiding them silently would make the list look wrong; explaining it
once makes the consistency legible.

## 4. Links

`knowledge_page_links` gives, per page, `direction` (outgoing · incoming), the
**other** end's path, the link `kind` (wikilink · frontmatter · embed), and the
target's title.

Drawn as two lists rather than a graph. A graph answers *what does the whole vault
look like*, which is a question the owner does not have; two lists answer *what
points at this*, which is the one they do. `kind` is shown because a frontmatter
link and a wikilink mean different things about intent — one was structured on
purpose, the other was written in a sentence.

## 5. States

| State | Copy |
| --- | --- |
| empty | "Nothing in the vault yet." + *Metistry reads a folder you own; it does not keep a second copy* |
| empty · filtered | "No pages in `Areas/Health`." — names the filter, because other areas have pages |
| absent | no reconciler bridge — the variable named, not spent. **The list is not drawn empty**, because nothing is known |
| failed | the index could not be read, error verbatim |
| stale · the index | `indexed_at` behind `modified` — the page list says *3 pages changed since the last walk* and keeps showing what it has |

## 6. Data sources

| Element | Source |
| --- | --- |
| the page list | `GET /api/q/knowledge_pages` — path, area, title, description, status, modified, indexed_at |
| areas | derived, first segments — no column, and none wanted |
| a page's body | `GET /api/knowledge/page` via the reconciler. **Not a query**, because bytes are not derived state — the schema enforces it by having no column for a note body |
| links | `GET /api/q/knowledge_page_links` |
| **source freshness** | **nothing** — request C1, now four rounds old |
| drafts, and their count | the same `WHERE` the bridge applies; the count is **not** returned today |

## 7. Requests for the developer

| # | Request |
| --- | --- |
| **C1** | `collector_health` — per collector: last run, last **ok** run, and the error from the most recent failure. This is the fourth round `stale` has been specified without it. Two of those rounds concluded that some other screen owned the question; this one owns it and still cannot answer it |
| **D14** | a draft **count** on `knowledge_pages`. The rows are correctly withheld; the number is not a draft and withholding it makes the list look wrong |
| **D15** | `indexed_at` versus `modified` as a comparison the query makes, so *how far behind is the index* is a fact rather than arithmetic three surfaces repeat |

## 8. Judgement calls made without the owner

Named because they were made while he slept, and each is cheap to reverse.

1. **Sources at the top, pages below.** *Is this current* makes the rest
   trustworthy, so it leads. The alternative — pages first, freshness in a header
   — reads better as a browser and worse as an answer.
2. **No graph view.** Two lists per page instead. A graph answers a question the
   owner has not asked.
3. **`partial` recommended for ratification** on the strength of `conflict`, not
   introduced unilaterally: the row is drawn, and the proposal is logged as the
   argument for the state rather than as a decision already taken.
4. **The draft count is shown as a sentence**, not a filter chip. A chip implies it
   can be turned on, and it cannot.
