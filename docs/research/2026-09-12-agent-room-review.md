# Agent Room review — richer agent communication, and what we already have (2026-09-12)

Owner prompt, verbatim: *"agent-room offers richer agent communication than
our current plan. Let's see if we should consider allowing more communication
in a chat-type interface. More autonomy for agents could be a good thing when
allowed, especially as the agents get smarter and can make more decisions
themselves. We'll still need to be careful for when the right time to have a
human in the loop is."*

Reviewed: [agent-room-alkl/agent-room](https://github.com/agent-room-alkl/agent-room),
fetched 2026-09-12. Nothing here is built; the plan is not edited.

## What it is

Three things in one MIT repo: a **hosted service** (agent-room.com on Vercel +
Upstash Redis), an **MCP server** (11 tools, Streamable HTTP, stateless — every
POST builds a fresh server and the client carries room code, name and cursor in
tool arguments), and a **React web client** that is the human's window. A
[protocol doc](https://github.com/agent-room-alkl/agent-room/blob/main/docs/AGENT_ROOM_PROTOCOL.md)
exists but is v0.1 draft, last updated 2026-04-30 and already behind the code
(it lists five reply modes' worth of behaviour nowhere in it).

Maturity: 50 stars, 19 forks, created 2026-04-13, last push 2026-09-08, 168
commits on `main`, **no GitHub releases**, one dominant author (the contributors
endpoint attributes 72 of the 78 it lists to one account — it disagrees with the
commit count, so treat it as indicative). Room state is Redis with a **24-hour
TTL** by default; a Postgres adapter is opt-in
(`AGENT_ROOM_PERSISTENCE=postgres`). Several modules are ported from a
"commercial" sibling and from Bothread; `docs/KNOWN-GAPS.md` is an honest list
of MVP shortcuts still open (non-atomic CAS on participants, no code-collision
check).

## The communication model

- **One flat room per 9-character code** (`ABC-DEF-GHJ`). No channels, no
  sub-threads. Messages are an append-only list; `type: 'msg' | 'sys'`, plus a
  `kind: "status"` side channel that does not count as taking a turn.
- **Free text with markers.** `[DECISION]` `[TODO]` `[STATUS]` `[RESULT]` at the
  start of a line are extracted into `RoomArtifact` rows at export. Structure is
  a *convention inside prose*, recovered by a parser — not a typed message.
- **Broadcast by default, directed by `@Name`.**
  [`mentions.ts`](https://github.com/agent-room-alkl/agent-room/blob/main/packages/shared/src/mentions.ts)
  decides who a message wakes: `wakesAgent()` returns true on
  `metadata.targetAgentName` or an `@` match, and everything else rides along in
  the digest. The comment says why plainly: *"Presence is billed per turn …
  With no filter, one message woke every agent in the room — in a five-agent
  room, four of them read it, found nothing for them, and went back to
  waiting."*
- **Humans are participants**, not observers: the browser client speaks in the
  same transcript (`client: 'web'` vs `'cc'`), and the host holds moderation.
- **Five reply modes** — `open`, `sequential`, `moderator`, `consensus`,
  `debate` — shipped as a versioned prompt string
  ([`roomPolicy.ts`](https://github.com/agent-room-alkl/agent-room/blob/main/packages/shared/src/roomPolicy.ts),
  `ROOM_POLICY_VERSION = 4`) that rides on every `room_listen` result. Its own
  header calls it *"a protocol contract, not UI copy … what a joining agent is
  briefed under."* Server-side turn state is real (floor holder, deadlines,
  deputy hand-off), but the gate is soft: an off-floor `room_send` in moderator
  mode is **stored and re-tagged as a status side note**, not refused
  ([`api/_mcpTools.ts`](https://github.com/agent-room-alkl/agent-room/blob/main/api/_mcpTools.ts)).
- **Presence is first-class**: Listening / Online / Idle from `listenUntil` and
  `lastSeenAt`, because an agent that stopped looping is invisible otherwise.
- **Three ways to stay present**: a `room_listen` long-poll loop, Claude Code
  `Stop`/`SessionStart` hooks that fetch at turn boundaries, or an HMAC-signed
  webhook that wakes a sleeping resident agent.
- **Tools from messages**: none directly. Messages never trigger a tool; an
  agent reads the room and decides. The one structured action surface is
  `room_task` (`list`/`create`/`claim`/`submit`/`verify`/`reassign`) — a task is
  done only when a *different* agent verifies it, with 15-minute leases,
  holder-only renew/release, compare-and-swap and a receipt ledger
  ([`docs/task-turn-lease.md`](https://github.com/agent-room-alkl/agent-room/blob/main/docs/task-turn-lease.md)).
- **Identity is a tool argument.** `room_send` takes `name` and looks the
  speaker up by it. A signed A2A-style agent card with a fleet trust store is
  designed and default-on *in the doc*
  ([`docs/authenticated-room-members.md`](https://github.com/agent-room-alkl/agent-room/blob/main/docs/authenticated-room-members.md),
  unsigned only under `AGENT_ROOM_MEMBER_AUTH=legacy`) — but the README's whole
  pitch is a 9-character code and a name, and I could not verify which mode the
  hosted deployment runs.
- **Guards**: the `wakesAgent` filter (turn cost), a silence sweep that ends a
  room with no chat for a fixed interval and fails *open* when the window is
  unreadable, the 24-hour TTL, secret redaction at the text boundary, attachment
  risk classes, code execution off unless opted in. **No per-agent budget, no
  message rate limit, no approval step anywhere.**
- **Human intervention** = host controls: `set_mode`, `invoke`, `skip`,
  `reactivate`, kick, `room_end`, and `room_minutes --export` to freeze the
  transcript into a shareable report. The human interrupts a running room; the
  human never *gates* an action.

Its own non-goals are worth quoting: v0.1 does not define *"agent-to-agent
private messages … workflow orchestration … enterprise authorization models."*

## What Metistry's agents can say to each other today

More than the prompt assumed. The surface at `/mcp`
(`packages/mcp-brain/src/server.ts`, `TOOL_NAMES`) is: `capture`,
`requests_create`, `tasks_list`, `tasks_claim`, `tasks_renew`, `tasks_update`,
`tasks_release`, `tasks_close`, `tasks_create`, `knowledge_search`,
`knowledge_read`, `knowledge_list`, `knowledge_grep`, `knowledge_write`,
`artifacts_publish`, `artifacts_get`, `artifacts_list`, `artifacts_comment`,
`artifacts_resolve`, `artifacts_review`, `agents_delegate`, `queries_list`,
`queries_run`.

**A threaded agent-to-agent conversation already ships.** `artifact_comments`
(migration `0010`) has `parent_id` (NULL = thread root, one level of replies),
`path`/`anchor`, `state open|resolved`, `author_principal`, `author_kind`. Two
agents in a project argue about a specific version of a deliverable, resolve the
thread, and the console renders it (`apps/console/web/app.js` already lists
threads with an open/resolved count and a dispatch control).

And the loop guard the owner asked for is already the shipped default:
`pingPongDemotes()` in `packages/artifacts/src/policy.ts` — an agent reply that
would push the trailing agent-only run past `DEFAULT_PING_PONG_CAP = 10` **is
not stored**; the thread demotes to a `proposals` row (`kind = 'review'`,
`payload.reason = 'ping_pong_cap'`) with the transcript. A human comment resets
the run. That is "disagreement between agents unresolved after N turns
escalates to the owner", enforced at the tool, today.

Also present: per-agent `autonomy` narrowing (`may_dispatch_to`, `accept_from`,
`max_open_bundles` — `validateAutonomy` in `apps/console/src/agents.ts`, unknown
keys refused), the project `mode: autonomous | review` kill switch, per-project
daily budget that flips the mode, bundle caps that queue rather than drop, and
`dispatchRoute()` turning any out-of-boundary hand-off into a proposal.

**What is genuinely missing**, precisely:

1. **You must publish something to talk.** Every agent-to-agent message is
   anchored to an `artifact_id` + `version_id`. There is no way to negotiate
   scope *before* an artifact exists.
2. **One reply level.** `parent_id` references a root only; a three-way exchange
   flattens.
3. **No participant set.** A thread's participants are whoever happened to
   comment.
4. **No presence and no ambient wake.** Metistry agents are pull-based (claim a
   `work` row from a SKIP LOCKED queue); nothing "addresses" a running agent.
   This is a *feature* under invariant 9 and collaboration rule 4, not a gap.
5. **No thread rate or budget.** The ping-pong cap counts consecutive agent
   messages, not messages per hour or dollars per thread. A quiet thread stays
   open forever.

## Does chat add real capability over rows?

Split it honestly.

| Situation | Better as | Why |
| --- | --- | --- |
| Negotiating scope before work exists | **conversation** | Two turns of "does this include the migration?" has no artifact to hang on and no deliverable yet. Today this is either impossible or an abuse of `tasks_update` notes. |
| Clarifying an ambiguous brief | **conversation** | The brief is one-shot and immutable by design (`brief_sha`). A crew that finds it under-specified can only report and stop. |
| Dividing work between two agents | **rows** | `tasks_create` unassigned + `tasks_claim` with a lease already does this atomically, and claim-by-lease beats "I'll take the frontend" in prose. |
| Reporting partial progress | **rows** | `tasks_update` notes and `runs` rows are queryable; a `[STATUS]` line in a transcript is not. |
| Claims, decisions, deliverables | **rows** | A decision in prose has to be re-parsed by a marker regex. `proposals` and artifact versions are already typed and durable. |
| Reviewing a specific deliverable | **threads (shipped)** | `artifacts_comment` anchored to a version and a path is *better* than a room: it cannot lose which version it was about. |

So the real gap is narrow: **conversation before there is a deliverable, and
conversation to clarify a brief.** Everything else agent-room does in prose,
Metistry does in rows, with better queryability and an enforced escalation.

## A proposal that fits the invariants (for the owner, not a decision)

**The safety insight: a channel is safe exactly when it cannot address.**
Addressing *is* triggering. Keep triggering where the policy already lives
(`agents_delegate`, review dispatch — which already refuse a cross-kind directed
push per collaboration rule 4) and give the channel no `to_agent` field at all.
A Claude turn may then post to a thread any agent reads, and cannot `@`-address
a named non-Claude agent, **because the field does not exist** — enforced by
absence, the same way invariant 9 is.

**(a) Unanchor the thread, don't build a room.** Reuse `artifact_comments`
machinery against a second anchor: a `work` row. Additive migration — a nullable
`work_id` alongside `artifact_id`, one non-null enforced by a check constraint;
no rewrite. The task that will carry the work *is* the room. Participants =
project members (server-side, from the credential — never a tool argument;
§4.19). Every message is a durable row the owner can read. The ping-pong cap,
resolve semantics, `author_kind` reset and demote-to-proposal all apply
unchanged.

**(b) Autonomy as configuration, narrowing only.** A fourth key,
`autonomy.level: observe | propose | act_within_scope`, validated by the same
`validateAutonomy` (unknown keys already refused; absent = today's behaviour).
`observe` = read threads, no post; `propose` = post and create proposals, no
`tasks_claim`; `act_within_scope` = today. **Constraint the owner should know
about:** `autonomy` is *narrowing-only* by construction — a per-agent key can
never widen past the project default. "Lower the bar per agent as trust grows"
therefore means *removing* a narrowing, and the ceiling stays the project's
`mode`. Making `level` able to widen would break the one-way property that makes
the current model safe; I would not do it.

**(c) Escalation as a tool rule.** What should force a `decision` proposal, and
where it stands today:

| Trigger | Today |
| --- | --- |
| Agents unresolved after N turns | **Shipped** — ping-pong cap → `review` proposal. (Consider `kind: 'decision'` with options instead, so the owner answers rather than triages.) |
| Outside the agent's data policy | Partly — `checkBrief` **refuses** with violations and a `runs` row; it never offers the owner the chance to allow it. Adding "refuse, and optionally propose" is the change. |
| Spend over a threshold | Partly — the project budget flips `autonomous → review` and alerts; no decision proposal. |
| Irreversible action | **Vacuously satisfied.** There is no irreversible tool in the surface: `knowledge_write` has no delete or rename, artifact versions are commits, `capture` is additive. Worth writing down rather than building a guard for an empty set — and worth re-checking the day a bridge gains a destructive tool. |

**(d) Guards.** Add per-thread: messages-per-hour, a dollar budget from `runs`
rows stamped with the thread. **Do not auto-close a quiet thread yet** —
`commentResolve` releases the oldest queued bundle under the cap, so a sweep
that resolves stale threads would silently start queued work overnight. Auto-
close would need its own state (`stale`, not `resolved`) or the release path
made explicit.

**(e) What the owner sees.** The console already renders threads per artifact.
The addition is a cross-artifact view grouped by participants, with the
escalation line spelled out — `payload.reason` is already stored
(`ping_pong_cap`), it just is not rendered as a sentence.

## Verdict

**SKIP agent-room as a dependency.** Reasons, in order of weight: (1) identity
is a tool argument in the hosted path, which collides head-on with §4.19
(server-side identity, never self-declared) and invariant 8; (2) turn discipline
and role behaviour are enforced by a briefing string, which is precisely what
"enforce at the tool, never by prompting" forbids; (3) `@Name` addressing is the
mechanism collaboration rule 4 exists to prevent; (4) it is a third-party hosted
room with a 24-hour Redis TTL against invariant 1's "git is the record"; (5) 0.1
draft, no releases, one author, MIT but young. Self-hosting fixes (4) and not
(1)–(3). *(Rejected alternative: vendoring `packages/shared` for the marker
parser and mention matcher — the marker parser is the wrong direction for us,
since we type our decisions as rows rather than recovering them from prose.)*

**BORROW-LATER** (ideas, not code): presence as an explicit state rather than an
inference; the fail-open silence sweep (*"an unreadable window must fail towards
keeping the room open"* — the right default for any sweep we add); and the
insight behind `wakesAgent` — that waking an agent costs a full turn, which is
the argument for keeping Metistry pull-based.

**Phased proposal for our own richer communication** — smallest first, each
gated on the previous:

1. **PR-A — the room view, no schema.** Cross-artifact thread list in the
   console grouped by participants, with `payload.reason` rendered as a "why
   this came to you" line on demoted threads. *Proves:* whether the owner
   actually wants a conversational view before any table exists. Zero risk, and
   if the answer is "I never open it", PR-B is dead.
2. **PR-B — threads on a work row.** Nullable `work_id` on `artifact_comments`
   + check constraint; `artifacts_comment`/`_resolve` accept a work handle;
   no `to_agent` field. *Proves:* that scope negotiation before a deliverable is
   the missing capability, measured by threads opened on tasks and how many
   resolve without an owner turn.
3. **PR-C — `autonomy.level` + escalation.** The fourth key, plus `checkBrief`
   and the budget flip gaining an optional `decision` proposal. *Proves:* the
   human-in-the-loop bar is movable per agent without touching a prompt. Only
   worth doing once PR-B produces traffic to govern.

## Contradictions to flag

- **None with `metistry-build-plan.md`.** The plan's §4.21 risk table already
  names the ping-pong cap at 10, the bundle caps, the budget flip and
  `mode: autonomous | review` as "the user's kill switch is one toggle" — this
  review found those shipped and matching. PR-B's work-row anchor is an
  extension of §4.21, not a departure, but it is new scope and should be
  ratified before it is built (working style: don't build ahead of the plan).
- **With the compute note**
  (`docs/research/2026-09-11-local-models-openrouter-opencode.md`): none, and
  the design above is chosen to keep it that way. Collaboration rule 4 survives
  only because the proposed channel has no addressing field. Any future `@`
  syntax over these threads would reopen it.
- **Tension inside the owner's framing:** "the owner able to lower the bar per
  agent as trust grows" versus `autonomy`'s narrowing-only property (b above).
  A decision is needed, not a workaround.

## Sources (all fetched 2026-09-12)

- Repo, README, tree, commit list, contributors, releases (empty):
  <https://github.com/agent-room-alkl/agent-room> via `gh api`.
- Protocol v0.1: `docs/AGENT_ROOM_PROTOCOL.md` · Known gaps: `docs/KNOWN-GAPS.md`
  · Auth: `docs/authenticated-room-members.md` · Leases: `docs/task-turn-lease.md`.
- Source read: `packages/shared/src/{roomPolicy,mentions,roles,security,roomSilence}.ts`,
  `api/{mcp,_mcpTools}.ts`, `packages/upstash-client/src/turnState.ts` (grepped,
  not read whole).
- **Not verified:** which member-auth mode agent-room.com actually runs; the
  hosted room's real rate limits; anything in the separate `agent-room-mcp`
  npm package repo; the "commercial" sibling several modules were ported from.
  No fetch failed.
