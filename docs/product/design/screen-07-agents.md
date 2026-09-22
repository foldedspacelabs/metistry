# Screen 7 — Agents

Round E, second. Mac first, light and dark. The board is `Agents`.

This is the only screen where the credential surface moves. Invariant 2 says a
grant is the user's hand; `ACTION_KINDS` deliberately excludes any change to
grants or autonomy, so nothing an agent emits can reach what this screen edits.
Everything here is therefore the owner acting, and the screen's whole job is to
make sure they know what they just did.

It is also where three debts land that other screens sent here: the escalation
ceiling nobody sees (C42), the tier trade the access card has to derive (C41),
and round C's **stale** — *is `github-state` still current* — which Activity
explicitly declined to answer.

## 1. The thing this screen is not

It is not a permissions matrix. A matrix is what the data looks like —
three levels, four kinds, three modes, plus a scope tier, plus an area list,
plus three §4.21 numbers — and rendering the data's shape is how you get a
screen that is correct and unreadable.

The question the owner actually arrives with is one of two:

- **"What is this thing doing right now?"** — the roster answers it without
  being opened.
- **"What is this thing allowed to do?"** — one row opens and answers it in
  words, with the controls beside the answer rather than instead of it.

So: one row per credential, expanding in place. No detail pane, no sheet. A
credential is small enough to state completely in a few hundred pixels, and
putting it in a second column would mean the roster is a nav bar rather than an
answer.

**P9 holds.** The list moves when you ask it to and not before — the same
sentence Activity uses for held rows. A row grows because *you* clicked it;
nothing arriving from the wire ever reflows the list under the reader, and a
presence change repaints a row in place without resorting it.

## 2. The roster

```
toolbar   Metistry · + · bell(4) · usage
sidebar   Today · Chat · Activity · Work ▸ · Knowledge ▸ · Agents*
pane      Agents                                    [+ New credential]
          ●  metis            the instance assistant   folders: 4    $0.31   now
          ●  drey-dev         an agent                 folders: 1    $0.04   12m
          ◌  taskuary         an agent · external      titles        —       41m
          ◌  research-crew    a crew                   folders: 2    $1.90   3h
             ⌃ Revoked · 2
```

### 2.1 Only two of the five presence states get colour

`agent_presence` computes `state` in SQL — `working · queued · interrupted ·
over-cap · idle` — which is exactly what P5 wants: the state is *reported*, and
the screen never infers presence from a timestamp.

Five states invites five colours. Four of them would be wrong. Tint carries
**something is wrong** and nothing else (ratified), and three of these five are
not wrong:

| State | How it reads | Channel |
| --- | --- | --- |
| `working` | a filled dot, and the claim named in the row | none — it is the normal case |
| `queued` | a filled dot, hollow centre, and the count | none — waiting is not a fault |
| `idle` | a hollow dot | none — **and no word.** An idle agent is the resting state and does not need to announce it |
| `interrupted` | `degraded` — *an expired lease still holds this claim* | tint |
| `over-cap` | `degraded` — *a bundle of its own is blocked for exceeding a cap* | tint |

An Agents screen with five colours on it is a screen where colour has stopped
meaning anything, which is the whole argument of P2 applied to a roster.
`interrupted` and `over-cap` are `degraded` rather than `failed` for the reason
C36 settled: `failed` means *this broke*, and a lease that lapsed while an agent
was thinking did not break.

### 2.2 The row's four facts, and why spend is one of them

`[state] [id] [role, in words] [scope] [spend today] [last seen]`

- **`id`**, mono, because it is the string stamped on every proposal and typed
  into every CLI call. `display_name` sits under it only when it differs.
- **the role in words** — `ScopeView.who`: *the owner · the instance assistant ·
  an agent · a crew*, plus the `external` trust marker. Rendered from
  `ROLE_LABEL`, never composed here, for the same reason the access card renders
  the scope triple as given: the CLI's column and this row must not disagree
  about what a crew is called.
- **the scope**, in the tier's own word — `none · titles · folders` — with the
  area count. Not the machine's `index` / `areas`.
- **spend today**, because it is the one number that answers *is this thing
  running away from me* and `agent_presence` already computes it. It is not a
  badge: Needs You is the only badge (P2). It is a value in a column.
- **last seen**, relative.

No count badges anywhere on this screen, including on the sidebar row that leads
to it.

### 2.3 Revoked credentials are on this screen, collapsed

`agent_presence` **excludes revoked agents** — `WHERE a.revoked_at IS NULL` —
so a roster built on it alone cannot show you what you revoked. That is the one
thing an owner will come looking for after an incident.

So the roster reads `listAgents` for the full set and `agent_presence` for the
live ones, and revoked rows sit in a collapsed group at the bottom: id, when it
was revoked, and the two consequences stated rather than implied — its pending
access asks were settled (`settleAccessRequests`) and its grant overrides went
with it (`ON DELETE CASCADE`, `clearGrantOverrides`). A revoked credential is a
fact about the past, so it gets `absent`, not `failed`.

## 3. One row, open

Three blocks, in this order, because it is the order of the question: what can
it see, what may it do, what is it doing.

### 3.1 Scope — the triple, then the parts

The first line is `current_scope.line` **verbatim** — the triple *role · access
· extras*, composed once by `describeScope` and identical in the CLI, the Needs
You card and here. One record, said one way.

Under it, the parts that line summarises, because this is the screen where you
change them:

| Part | Shown as |
| --- | --- |
| tier | three steps — `none · titles · folders` — as a segmented control |
| areas | the prefix list, mono, verbatim. Each removable |
| **approved in Needs You** | an area from `agent_grant_overrides` is marked, with the proposal it came from. It is the same grant, and it got there differently — the owner should be able to see which widenings they made in a queue at 7am |
| projects | membership, or *every project* |
| queries | a flag, and its own sentence: **a separate axis from the read path.** Approving an area never touches it |

**A crew's scope is not editable here.** It is re-synced from `scope:` in
`agents/<area>/<id>.md` on every crew sync, so a control would be a lie that
survives until the next one. The block shows the values, the path to the file,
and the reason. A crew also can never ask for access — `request_access` is in
`CREW_NEVER_TOOLS` — which is why the access card has a refusal for it.

### 3.2 Autonomy — the effective table is the answer

This is the part with a trap in it, and the trap is that there are two tables.

`autonomy` stores `{level, actions}`. `effectiveActions()` resolves them: **the
level is a ceiling**, so each kind's effective mode is the lower of the stored
entry and the ceiling. An owner can store `allow` on `comment` while the level
is `propose`, and the agent will still only propose. The CLI already resolves
this — `metistry agents autonomy <id>` "shows the effective table" — and if the
console shows the stored table instead, the two disagree about what an agent can
do, and the console is the one that is wrong.

**So the effective mode is the value.** Each kind is one row:

```
dispatch      propose     off-machine is a human decision by default
task_update   allow
comment       propose     you set allow · the level is the ceiling
capture       allow
```

Mode is drawn in the **weight** channel, not colour: `allow` filled, `propose`
outlined, `deny` hollow and dimmed. Never green-for-allow and red-for-deny — a
configuration is not a moral position, and red is spoken for by `failed`. It is
the same argument as the priority badge, and it holds for the same reason.

**Two different reasons a cell is not `allow`, and they must not read alike:**

| Reason | The line it carries | What it means |
| --- | --- | --- |
| **defaulted** | *off-machine is a human decision by default* | you set nothing; this is `ACTION_DEFAULTS` for this level. `dispatch` is the one kind that stays `propose` even at `act_within_scope` |
| **clamped** | *you set allow · the level is the ceiling* | you set something the level does not permit. The stored value is shown, dimmed, beside the effective one |

Blurring those two would hide the only case where the owner's own setting is
being overridden — which is the case they most need to see.

The three §4.21 fields — `may_dispatch_to`, `accept_from`, `max_open_bundles` —
sit below the table as plain values. They are part of the same record and a
`PUT` **replaces** it, so they are not on another screen.

### 3.3 What it is doing

Current claims with their lease expiry, interrupted claims, blocked review
bundles, spend today. All from `agent_presence`, all already computed.

An interrupted claim is the one actionable thing here, and its line says what
happened rather than what it is called: *the lease on #418 expired 20 minutes
ago and the claim is still held.*

## 4. Changing it — widening is a different act from narrowing

`autonomyWidenings(prev, next)` returns the widenings as strings — `level
observe → propose`, `actions.comment propose → allow` — computed on the
**effective** tables, so a change that raises a stored entry under an unchanged
ceiling is explicitly *not* a widening. The design does not compute
consequences; it renders that list.

| The change | What the screen does |
| --- | --- |
| a narrowing, or a no-op | applies on commit. No confirmation: taking room away needs no ceremony, and asking for one teaches the owner to click through the dialog that matters |
| **a widening** | a confirm step listing `autonomyWidenings`' strings verbatim, one per line. The button says what it does — *Widen* — not *OK* |
| a widening on a crew | refused, with the manifest path |
| a `409` | the editor was open while something else changed the record. **Nothing was sent.** The same treatment as a stale request card: the new values, and the edit offered again against them |

Every widening writes `agent_admin` / `autonomy_widened` and raises one Needs
You alert per change per 24h. The screen does not also show a success banner:
the row now reads differently, which is the receipt.

## 5. The escalation ceiling — C42's home

`request_access` refuses a third ask after two declines, at the tool, with *ask
the owner directly*. That refusal produces **no proposal row**, so Needs You
cannot show it: the owner's queue goes quiet and the quiet means the opposite of
what quiet usually means.

It belongs on the credential. The row carries one line —

> asked twice for `Areas/Finance` · declined both · it can no longer ask

— with the two prior requests linked. This is the same shape as the successful
collector pass that Activity could not show (§6.5 there): a fact that is
invisible because nothing writes a row for it, parked on the surface that owns
the object rather than on the timeline.

## 6. States

| State | Copy |
| --- | --- |
| empty | "No credentials yet." + *an agent gets a token here, and nothing else gives it one* — with the New credential action |
| absent · a crew with no manifest | "Its manifest is missing." + the path it looked for. Not `failed` — nothing broke, the file is not there |
| failed | "Couldn't load agents." + the error verbatim. **Nothing is known**, and the roster is not drawn empty |
| stale | presence is a snapshot; when the poll is behind, the age rides the header and the rows keep their last values (the pattern from round C: stale annotates, it never replaces) |

## 7. A pattern this screen shares, which belongs in the system

**A failed consequential operation leaves the request pending.** An action that
throws writes `payload.error` and the row stays pending — *"one action is one
service call, so nothing is half-applied"*, and there is deliberately no retry.
An access refusal does the same. I drew it once on the access card as though it
were a Needs You detail; it is a system-wide rule about how this product fails,
and it should be in `design-system.md` §2 beside the four states. (C45)

## 8. Keyboard

`↑`/`↓` move the selection · `→` opens a row, `←` closes it · `↩` opens the
selected row's first control · `tab` walks the open row's controls in reading
order · `⌘S` commits an edit · `esc` abandons an edit, having changed nothing,
and a second `esc` closes the row.

Opening a row never scrolls the list to recentre it: the row grows downward and
the header stays where it was.

## 9. VoiceOver

- "metis, the instance assistant, folders colon 4 areas, 31 cents today, working, claim on 418. Row, expandable."
- "taskuary, an agent, external, titles, idle, last seen 41 minutes ago. Row, expandable."
- "comment, propose. You set allow; the level is the ceiling. Stepper."
- "dispatch, propose. Off-machine is a human decision by default. Stepper."
- the revoked group: "Revoked, 2 credentials, collapsed. Disclosure."

The clamp is spoken because it is the reason the value is what it is, and a
dimmed stored value beside a live one has no accessible name of its own.

## 10. Data sources

| Element | Source |
| --- | --- |
| the live roster | `GET /api/q/agent_presence` — kind, last seen, projects, claims, blocked bundles, spend today, computed `state` |
| the full roster, revoked included | `GET /api/agents` / `listAgents` — `agent_presence` excludes revoked rows |
| the scope line | `describeScope(principal).line` |
| tier and areas | `agents.grants` |
| areas approved in a queue | `agent_grant_overrides` (migration 0023) |
| the effective table | `effectiveActions(agents.autonomy)` |
| the stored table | `agents.autonomy.actions` — shown only where it differs |
| why a cell is not `allow` | `ACTION_DEFAULTS[level]` (defaulted) vs `LEVEL_CEILING[level]` (clamped) |
| what a change widens | `autonomyWidenings(prev, next)` |
| writing autonomy | `PUT /api/agents/:id/autonomy` — replaces the record, `409` on a concurrent change |
| writing grants | `PUT /api/agents/:id/grants` |
| a crew's scope | `scope:` in `agents/<area>/<id>.md`, re-synced every crew sync |
| the escalation ceiling | **nothing** — the refusal writes no row (C42) |
| collector currency (round C's *stale*) | **nothing on this query** — see §11 |

## 11. What this screen found

1. **`agent_presence` cannot show a revoked credential** — §2.3. The roster
   needs two sources for one list.
2. **The effective table exists in `core` and nowhere in the interface.** The
   CLI resolves it, the console does not. Every surface that shows autonomy has
   to call `effectiveActions`, or they will disagree. (C46)
3. **Nothing flags the clamp.** `effectiveActions` returns the resolved mode and
   drops the reason, so the screen recomputes *defaulted vs clamped* from
   `ACTION_DEFAULTS` and `LEVEL_CEILING` to tell the owner which one they are
   looking at. A resolved table that carried its reason per cell would be one
   return-type change and would stop three surfaces guessing. (C47)
4. **Round C's `stale` still has no home.** It was parked on Knowledge and
   Agents, and *is `github-state` still current* needs a per-collector last-ok
   time. `agent_presence` has no collector notion at all, and `activity_feed`
   takes `collector_run` only `WHERE ok = false`, so a healthy collector is
   invisible in both. **The state the product talks about most is drawable on no
   existing query.** It wants a `collector_health` query — request C1. (C48)
5. **A credential's spend has no cap on this screen.** `spend_today_usd` is a
   number with nothing to compare it to; `over-cap` refers to review-bundle
   caps, not money. Either a per-agent budget exists somewhere I have not found,
   or the number is context-free and the row should not imply otherwise.
6. **`display_name` is `NOT NULL` and nothing enforces that it differs from
   `id`**, so most rows will carry the same string twice. Drawn as: show it only
   when it differs.

## 12. Requests for the developer

| # | Request |
| --- | --- |
| **C1** | a `collector_health` named query — per collector, last run, last `ok` run, and the error from the most recent failure. Without it `stale` is undrawable anywhere, on the fourth round of it being specified |
| **C2** | `effectiveActions` to return the reason per cell (`set` · `defaulted` · `clamped`) rather than the mode alone |
| **C3** | a per-agent spend cap, or a ruling that spend on this screen is context-free |
| **C4** | whether the escalation ceiling should write a row after all — a `proposals` row decided `expired`, or an `agent_admin` run — so that something, somewhere, records that an agent stopped being able to ask |
