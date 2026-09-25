# Glossary

The one page to read before using Metistry. Eight nouns, one set of verbs.
Everything on every screen, in every notification, and in every brief is named
from this list — so a word means the same thing in the morning brief, in the
tool an agent calls, and on the button you tap.

Ratified 2026-09-09; updated 2026-09-23 for the design rulings C88–C98.
`metistry-build-plan.md` §0 carries the same table with the old→new map;
`design/design-system-amendments.md` §8 governs the casing.

---

## The nouns

**Metis** — the assistant: this instance's own, the one that holds your reach
and delegates to agents. **Metis** is the default name; you can rename it, and
every screen uses the name you chose. It is not an agent and is not listed on
Agents.

**Knowledge** — everything Metis keeps for you, in plain Markdown in
git. One file is a **page**. Areas are **folders**. You can open all of it in
Obsidian, or any text editor, forever; nothing is locked in a database.

**Capture** — the thing you dropped in without sorting it, and the verb for
dropping it. Share sheet, Shortcuts, the **+** in the window, the floating bar,
an agent's `capture` call: all the same door, all under five seconds.

**Request** — anything that needs *you*. The bell opens **Needs You**, which
lists requests — everything that needs you, whether Metis, an agent, or a
source Metistry reads (GitHub, Calendar, Mail, Linear) is asking. A request
from a source clears itself when you answer at the source. A request has one of
twelve types:

| Type | It is asking you to |
|---|---|
| **note** | keep something (a fact, a captured page, a draft to settle) |
| **report** | read what an agent found — a finding, a decision, a gotcha, progress |
| **review** | look at an artifact someone wants your eyes on |
| **question** | answer one or more questions an agent cannot continue without — pick from its choices, or say something else |
| **pull request** | review and approve code changes, or reply in a pull request's thread — posted to GitHub as you |
| **meeting** | settle a recorded meeting's notes and to-dos |
| **invitation** | accept, tentatively accept or decline a calendar invitation |
| **task** | take on a task a tracker assigned to you |
| **message** | reply to a message Metis thinks is waiting on you — drafted, never sent |
| **access** | grant an agent more than it has — including when the agent asked for a named folder itself |
| **improvement** | change how the system itself behaves |
| **action** | do one thing on your behalf — dispatch a brief, move a card, comment, capture |

Every request takes the same three answers, in this order
(`docs/ops/reply-feedback.md`):

- **Approve** — yes, do it / keep it. Where the request suggests work, it offers
  **Approve as Work**: yes, and put it on the board.
- **Revise** — nearly; here is what to change. (You say what; that reason is
  what makes the next one better.)
- **Decline** — no. It stays searchable; nothing is deleted.

And one that is not an answer:

- **Later** — not now. A snooze: the item leaves the queue and comes back by
  itself.

When you settle many at once, **Skip** is also offered — not this, and nothing
to say, without Decline's consequences.

**Task** — a row of work on one shared list that you and every agent work from.
A task is **claimed** with a lease, **renewed** while held, **released** or
**closed**, and you can tick it done wherever you see it. Where it came from shows as a chip: task · review · issue · PR.

**Artifact** — a versioned, reviewable output of agent work: a plan, a report, a
page, a mockup, a set of files. Artifacts have **versions** (nothing overwrites
silently) and **comments** (threads you or an agent can **resolve**). A task's
thread is its **room**, opened from the task.

**Project** — agents, tasks, artifacts and spend in one view. A project's mode
is either:

- **Autonomous** — members hand work and reviews to each other without you.
- **Review** — every agent-to-agent review queues in Needs You until you set it
  back. This is the kill switch, and it takes one tap. A project that reaches
  its budget is put in Review for you, and says so.

**Agent** — a worker with a job and a scope, which Metis delegates to. Its
role shows as a chip:

- **helper** — one you defined, with its own model, tools and read scope. Metis
  hands it briefs.
- **external** — someone else's agent, working with your instance through a
  token you minted and can revoke.

Each agent's **access** is one table: what it may do to each kind of thing,
each set **On**, **Ask** or **Off**. Anything not listed is not granted. For
knowledge, reading is by **Titles** (page titles and one-line descriptions) or
**Folders** (the folders you list, in full, nothing outside them).

**Routine** — work Metis runs for you on a schedule: an agent, a task and a
time. The **Morning Brief** is one; the nightly **fold**, which reads the day
and writes what it learned into knowledge, is another.

**Usage** — what your instance spends: money, tokens, time. The gauge beside
the bell.

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

The system is assembled out of collectors, bridges, services, modules,
targets, named queries, reconcilers, principals, grants, runs and crews. Those are builder words: they live in the code and in `docs/ops/`,
and they are deliberately absent from the interface. If one of them reaches a
screen, a notification or a brief, that is a bug — file it.
