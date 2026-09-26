# Screen 7 — Agents

Round E, rewritten 2026-09-21. The first attempt organised this screen around
`agents.grants` and `agents.autonomy` — which is drawing the data's shape, and it
produced a permissions matrix with a disclosure triangle on it. The owner
rejected it. This is the replacement.

## 1. What the screen is

**Metis is unscoped because it *is* the user.** It represents their intent and
holds their reach (`ASSISTANT_DEFAULT_AREAS` is the whole vault); it delegates
narrower work to things that are scoped. So:

> **Agents is what Metis delegates to, and what connects in. Everything on it is
> scoped, because none of it is you.**

That sentence is why permissions belong here and nowhere else, and it is why
**Metis is not on this screen** (C52). Drawing Metis with a grant would imply its
reach could be less, which is the opposite of what it is.

Two kinds live here, and they differ in **what you can do to them**, which is
what earns them separate treatment rather than a type column:

| | **Yours** | **Connected** |
| --- | --- | --- |
| where it comes from | you defined it — a markdown file in the vault | it authenticated in with a token |
| definition | yours to read and write | **none** — it is someone else's code |
| what it does | what you wrote, plus what a routine assigns it | whatever it asks to do |
| reach | base, plus what a routine grants for a task | base, granted by you |
| runs when | you ask · Metis delegates · a routine's schedule | it connects |

## 2. The roster

Three things per row. **Who it is, what it is, whether it's working.**

```
Agents                                                    [+ New agent]

YOURS · 3
●  collator            daily at 6:02 AM · Morning Brief              6m
◌  vendor-research     when Metis delegates                           3h
◌  inbox-triage        paused                                          —

CONNECTED · 2
●  drey-dev            Drey · you granted 1 folder                    12m
◌  taskuary            external · 1 folder                           41m

⌃ Revoked · 2
```

**Scope and spend come off the row.** `folders · 4` tells you nothing without
knowing *which* folders, so it was detail-view information pretending to be a
summary; and spend is a number with nothing on the row to compare it to (C3).
Both move into detail, next to the context that makes them mean something.

The **what it is** column carries the taxonomy in four words instead of a
section header: yours-and-scheduled names its routine, yours-and-delegated says
so, connected names its project. A paused agent says `paused` and nothing else,
because a paused agent has no schedule to report.

### 2.1 Presence: two colours, not five

Unchanged from the first attempt, and it survived review. `agent_presence`
computes `working · queued · interrupted · over-cap · idle` in SQL, so the state
is reported and never inferred (P5) — but tint carries *something is wrong* and
three of those five are not wrong. `working` and `queued` are filled dots,
`idle` is hollow **and carries no word at all**, and only `interrupted` and
`over-cap` take `degraded`. Five colours on a roster is a roster where colour
has stopped meaning anything.

### 2.2 Revoked, collapsed

`agent_presence` excludes revoked rows (`WHERE a.revoked_at IS NULL`), so the
roster reads `listAgents` for the full set. Revoked credentials sit in a
collapsed group with the two consequences stated rather than implied: pending
access asks were settled, and grant overrides went with it. `absent`, not
`failed` — a revoked credential is a fact about the past.

## 3. A local agent

### 3.1 The definition is a file, and only you may write it

It lives at `agents/<area>/<id>.md` — in the vault, so git versions it and every
change has an author. The console edits it **as the user's hand**, which
invariant 2 permits explicitly: *anything defining how the system behaves is a
human change*. The same invariant is why **Metis may never write this file**, and
the screen says so once, plainly, next to the editor. An assistant that can
rewrite its own delegates' instructions is the loop that invariant closes.

So the definition block is a **markdown editor**, not a form field: the agent's
behaviour is prose with structure, and a textarea that hides its own headings
teaches the user that this is configuration rather than writing. It shows the
file path, and it says *versioned in the vault* rather than *saved*.

### 3.2 Reach — and the access it only has sometimes

Base permissions, in the tier's own words (`none · titles · folders`), with the
area list verbatim.

Then the part that matters: **access this agent does not hold on its own.**

> During **Morning Brief** it can also read `Areas/Finance` and write
> `Journal/Digest/`.

A routine-granted permission is the most forgettable access in the system. You
granted it inside a routine's setup in March; this page says the agent reads
`Areas/Ops`; six months later it reads Finance every morning and nothing ever
told you. The marker is not consistency, it is the only thing standing between
the owner and that.

**Access always shows its provenance** — three routes, one vocabulary:

| Provenance | Marked as |
| --- | --- |
| base configuration | nothing. It is the default and a marker on everything is a marker on nothing |
| approved in Needs You | *approved in Needs You · #311*, linking the request |
| granted by a routine | *during \<routine\> only*, linking the routine |

### 3.4 Compute (C128)

The definition names its **model**, then **where it runs** (one of that model's places, with its tags and price), and its effort — all from Your Models in Settings › Compute (C131), or **Same as Metis**. Settings no
longer assigns models per agent.

### 3.3 Its routines, and what it did

The routines that assign this agent work, each linking to Routines — the deep
link in the direction the owner arrives from. Then recent runs: when, what it
produced, what it cost.

**No autonomy table here.** A local agent's permission to act comes from the
routine that assigns it, so a 3×4 action matrix on this page would be answering
a question nobody asked of it. It stays on the connected detail, where an
external agent proposing actions is the whole relationship.

## 4. A connected agent

No definition, so the page is shorter and honest about why: **you did not write
this and cannot read it.** What it shows instead:

- **How it connects** — when it first authenticated, last seen, `remote` or
  local, and its `trust` (`internal · external · user`).
- **Reach**, with the same provenance vocabulary as §3.2.
- **Project membership**, or *every project*.
- **Permissions** — see §4.1. The same table appears on a local agent, a
  connected agent and a routine.
- **The escalation ceiling** (C42) — *asked twice for `Areas/Finance` · declined
  both · it can no longer ask.* `request_access` refuses a third ask at the
  tool and writes no row, so Needs You goes quiet and the quiet means the
  opposite of what quiet usually means. This is where that fact lives.
- **Revoke**, with what it cascades stated before you press it.

### 4.1 Permissions — one line per resource, and absence is the denial

Revised 2026-09-22. The version before this gave each verb its own row with a
control in it, so `Knowledge` appeared twice and most of the table was furniture.

| Resource | Read | Write |
| --- | --- | --- |
| Knowledge | `Areas/Ops` · `Areas/Finance` *(Needs You #311)* | — |
| Work | All tasks | Update · Comment · Dispatch ⏱ |
| Artifacts | All | Comment |
| Inbox | — | Capture |
| ⧉ Jira | 3 projects | Comment ⏱ |
| ⧉ Confluence | 2 spaces | — |

*Ask — asks you first · ⧉ reached through Metistry · anything not listed is not granted*

**There is no On / Ask / Off control here.** Absence is the denial, which is
the same information in none of the space — and the honest shape, because the list
of what an agent *cannot* do is infinite. A verb that waits for the owner carries
one glyph; nothing else needs a state at all. Changing any of it is a single
**Edit** on the section rather than a control per cell.

Underneath, the wire's four kinds are still verbs on models — `comment` reaches
**two** models because its schema takes either `work_id` or `artifact_id` +
`version_id` (C53) — and that is why Work and Artifacts both list Comment.
`Dispatch` asks first by the wire's own default, because it hands the task
off-machine.

**Local agents get this table too.** The previous pass gave them knowledge only,
on the argument that a routine grants the rest. An agent Metis delegates to needs
Work and Artifacts like any other, and two permission surfaces for two kinds of
agent was the same mistake as two detail layouts. One table, everywhere
permissions appear.

**Provenance lives in the cell.** A marked line arrived some other way — approved
in a queue, or granted by a routine and held only while it runs. That replaces the
separate provenance section the earlier pass had.

## 5. Changing things

| Change | What happens |
| --- | --- |
| editing a definition | a vault write as the user, versioned in git. `⌘S` commits; `esc` abandons |
| narrowing reach, or any autonomy narrowing | applies on commit, no confirmation — taking room away needs no ceremony, and asking for one teaches the owner to click through the dialog that matters |
| **widening** | a confirm step listing `autonomyWidenings`' own strings verbatim. The button says *Widen*, not *OK* |
| a `409` | the record changed while the editor was open. **Nothing was sent** — the new values, and the edit offered again against them |
| revoking | states the cascade first: pending asks settled, grant overrides removed |

## 6. States

| State | Copy |
| --- | --- |
| empty · yours | "No agents yet." + *an agent is a markdown file describing how it should work* + New agent |
| empty · connected | "Nothing has connected." + *an agent gets a token here, and nothing else gives it one* |
| absent | a definition file that is missing — the path it looked for. Not `failed`: nothing broke, the file is not there |
| failed | "Couldn't load agents." + the error verbatim. **Nothing is known**, so the roster is not drawn empty |
| stale | presence is a snapshot; the age rides the header and rows keep their last values. Stale annotates, never replaces |

## 7. Keyboard

`↑ ↓` move · `↩` opens the selected agent · `esc` goes back · `⌘S` commits an
edit · `⌘⌫` revoke, confirmed. Opening never scrolls the roster to recentre.

## 8. Data sources

| Element | Source |
| --- | --- |
| the live roster | `GET /api/q/agent_presence` — five computed states, claims, spend |
| revoked rows | `GET /api/agents` / `listAgents` — presence excludes them |
| a local agent's definition | `agents/<area>/<id>.md` in the vault **— no endpoint reads or writes it yet (request D1)** |
| base reach | `agents.grants`, and `grant_source` (migration 0025) for where it came from |
| approved in a queue | `agent_grant_overrides` (migration 0023) |
| **routine-granted reach** | **nothing — the per-routine grant does not exist (request D2)** |
| what it may do | `effectiveActions(agents.autonomy)` |
| which routines use it | **nothing — a routine has no `agent` field (request D3)** |
| the escalation ceiling | **nothing — the refusal writes no row (C42)** |

## 9. Requests for the developer

| # | Request |
| --- | --- |
| **D1** | read/write for `agents/<area>/<id>.md` as principal `user`. The definition is the centre of this screen and nothing serves it |
| **D2** | a per-routine grant, additive over the agent's base, scoped to the run — and returned beside the base so a surface can mark it |
| **D3** | an `agent` field on a routine manifest, so a routine can name who runs it and the deep links have something to follow |
| **D4** | `effectiveActions` to carry its reason per cell (`set · defaulted · clamped`) rather than the mode alone — carried over from the first attempt, still true |

## 10. External MCP servers, proxied — the forward look

Not designed yet. What this screen commits to is the **structure**, because it
costs nothing now and would be expensive to retrofit: a proxied server is a
**Model** in the permissions table with one new provenance, *Through Metistry*.
No new primitive.

Three things follow from it that the design should hold to:

1. **The agent never holds the credential.** Metistry does. So this grid is the
   only thing between an agent and a work system, which raises the stakes on
   every marker on it.
2. **Reading your vault and acting in a shared system are not the same risk.**
   `Areas/Finance` is your own folder; a Jira comment is *acting as you where
   other people watch*. That is why Read is `On` and Comment is `Ask` in
   the drawn rows, and it is why a per-server grant cannot be one switch.
3. **The bridge contract already supplies the rules.** `CLAUDE.md` requires every
   bridge to do lazy tool discovery, **preview-then-confirm on destructive
   tools**, and secret redaction by default. A proxied server conforming to that
   contract inherits the behaviour this screen would otherwise have to invent.

The servers themselves are defined on **Resources** — `screen-09-resources.md`,
in **Settings ▸ Resources** (C57; this first said a new top-level row). One place holds the credential; granting a server to an agent
or a routine happens in the table above, like everything else.
