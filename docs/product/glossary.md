# Glossary

The one page to read before using Metistry. Eight nouns, one set of verbs.
Everything on every screen, in every notification, and in every brief is named
from this list — so a word means the same thing in the morning brief, in the
tool an agent calls, and on the button you tap.

Ratified 2026-09-09. `metistry-build-plan.md` §0 carries the same table with
the old→new map; `design-system.md` P10 governs the casing.

---

## The eight nouns

**Knowledge** — everything the assistant keeps for you, in plain Markdown in
git. One file is a **page**. Areas are **folders**. You can open all of it in
Obsidian, or any text editor, forever; nothing is locked in a database.

**Capture** — the thing you dropped in without sorting it, and the verb for
dropping it. Share sheet, Shortcuts, the Capture tab, an agent's `capture`
call: all the same door, all under five seconds.

**Request** — anything that needs *you*. The tab is titled **Needs You** and it
lists requests. A request has one of seven types:

| Type | It is asking you to |
|---|---|
| **note** | keep something (a fact, a captured page, a draft to settle) |
| **report** | read what an agent found — a finding, a decision, a gotcha, progress |
| **review** | look at an artifact someone wants your eyes on |
| **question** | answer something the assistant cannot continue without |
| **access** | grant an agent more than it has — including when the agent asked for a named folder itself |
| **improvement** | change how the system itself behaves |
| **action** | do one thing on your behalf — dispatch a brief, move a card, comment, capture |

Every request takes the same six answers (`docs/ops/reply-feedback.md`):

- **Approve** — yes, do it / keep it.
- **Revise** — nearly; here is what to change. (You say what; that reason is
  what makes the next one better.)
- **Decline** — no. It stays searchable; nothing is deleted.
- **Approve as Work** — yes, and put it on the board; only where the request
  suggests work.
- **Later** — not now. A snooze: the item leaves the queue and comes back by
  itself.
- **Skip** — not this, and nothing to say. Settles it without Decline's
  consequences, so skipping never revokes anything.

**Task** — a row of work on one shared list that you and every agent work from.
A task is **claimed** with a lease, **renewed** while held, **released** or
**closed**. Where it came from shows as a chip: task · review · issue · PR.

**Artifact** — a versioned, reviewable output of agent work: a plan, a report, a
page, a mockup, a set of files. Artifacts have **versions** (nothing overwrites
silently) and **comments** (threads you or an agent can **resolve**).

**Project** — agents, tasks, artifacts and spend in one view. A project's mode
is either:

- **Auto** — members hand work and reviews to each other without you.
- **Supervised** — every agent-to-agent review queues in Needs You until you
  set it back. This is the kill switch, and it takes one tap.

**Agent** — a worker with a job and a scope. Its role shows as a chip:

- **assistant** — this instance's own. The only one that writes knowledge.
- **helper** — one you defined, with its own model, tools and read scope. The
  assistant hands it briefs.
- **external** — someone else's agent, working with your instance through a
  token you minted and can revoke.

Each agent's **access** is one of three tiers:

- **none** — can only capture. It sees nothing.
- **titles** — page titles and one-line descriptions, nothing more.
- **folders** — reads the folders you list, in full. Nothing outside them.

**Activity** — what has happened. The feed, and the run behind every line of it.
Every tool call, every turn, every collector pass is one row you can read.

---

## The verbs

The same five on everything: **list · get · search · create · update**. Then
what is genuinely each object's own:

| Object | Its own verbs |
|---|---|
| knowledge | write |
| tasks | claim · renew · release · close |
| artifacts | publish · comment · resolve · review |
| agents | delegate |
| requests | approve · revise · decline |

An agent's tool names are these two lists put together — `knowledge_search`,
`tasks_renew`, `artifacts_publish`, `agents_delegate`, `requests_create` — so
knowing the vocabulary is knowing the API.

---

## Words you will not see here

The system is assembled out of collectors, routines, bridges, services,
modules, targets, named queries, reconcilers, folds, principals, grants, runs
and crews. Those are builder words: they live in the code and in `docs/ops/`,
and they are deliberately absent from the interface. If one of them reaches a
screen, a notification or a brief, that is a bug — file it.
