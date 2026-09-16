# Taskuary — the same goal, with the human gate at the other end

Fetched 2026-09-16. Prior-art review of `ldbumble/taskuary` against Metistry's
loop (capture → inbox → deterministic drain → proposals → owner decision →
fold/crews → reports → owner triage).

## 1. What it is

A **product**, not a framework: a local-first task hub that turns an operator's
incoming message flow into organised work and hands it to coding CLIs. Python
3.10+/FastAPI + SQLite (stdlib bindings, no ORM), React 18 + Vite + MUI + xterm
+ assistant-ui + three.js front end in `website/src`, shipped as a PyPI package,
a single-file `Taskuary.exe`, a Docker image and a desktop window. MIT.

Maturity: created 2026-08-17, **1,139 commits in 30 days**, v0.3.4.12, 77 stars,
14 forks, 5 contributors (1,030 commits by `ldbumble` — effectively one
maintainer moving very fast), 8 open issues, a hosted demo, a Chinese README and
a launch push. Pre-1.0 and says so. There is no MCP *server* surface: `mcp.py`
is a hand-rolled stdio/HTTP **client** so a report can call someone else's MCP
tool. `docs/taskuary-agent.md` (CopilotKit/AG-UI) is marked "exploration only —
not a shipped feature"; do not read it as built.

The comparison is worth having because the code is unusually explicit about
*why* each control sits where it does — the comments are the design record.

## 2. The loop, end to end

**Collection.** Connectors poll: Outlook/Graph, Teams, Slack, Telegram,
WhatsApp (a Node bridge), iMessage, Discord, GitHub, GitLab, Jira, Sentry,
PagerDuty, plus SQL/AWS/Azure/Prometheus/Datadog/REST/RSS "report" sources.
Each connector carries **roles** — `trigger` (becomes work), `feed` (shows and
stops), `tool`, `notification` — so "what may create work" is per-connection
config, not a global switch. A poll reaches 5 minutes back past its own
watermark on purpose (eventual consistency in Graph's delta buried messages);
dedupe on `external_id` is the first line of ingest, so re-reading is free.

**Timeline.** A timeline item is **not** a task: `funnel.py` builds a projection
over messages, live agent sessions, pending reviews, calendar entries,
assistant-generated "ideas", and forgotten/wrapped items, each an `_item(key,
kind, lane, …)` with a stable key, sorted into five attention bands. Vocabulary
(word, role, mark per lane) lives in **one** file, `taskuary/lanes.json`, read
by both the server and the client. Rows show the **original** time under a
source label, and a task's raw lifecycle badge beside its action state, so
`task · waiting` + `agent waving` reads as two facts rather than a
contradiction.

**Auto-identification of work.** Eleven ordered steps in `ingest_message`; nine
are deterministic gates, two are model calls (`docs/product-guide.md`). The
verdict call answers `intent` (task | reply_only | fyi) **and** `kind` (coding |
general | task) in one JSON, reading an editable `TRIAGE.md` that *replaces* the
shipped prompt; `classify_intent` re-appends the field dictionary and the output
shape, because "the output SHAPE is a contract, not a judgement, and the
document is only entitled to the judgement" (`triage.py`). Everything not `fyi`
**creates a task row without asking**. Correcting a road on the Triage tab
writes the reason back into `TRIAGE.md`.

**Triage and execution.** No human triage step exists between arrival and work.
"Only `coding` is ever dispatched automatically" — and it is on by default
(`coder_auto_enabled` seeds `'1'`), so an inbound mail a model calls `coding`
opens a CLI session in a checkout it picks. Two gates stand in front, cheapest
first (`ingest.auto_code_ok`): the *kind* judgement, and a **stranger gate** — a
first-time sender's mail may become a task but may not start an agent. Sessions
are resumable, streamed, and have their own lifecycle: finishing a run never
completes an owner-controlled task and never sends anything.

**Review before anything leaves.** Replies, and agent-proposed actions, land in
a `review` row and wait. See §3.

## 2b. Discoveries and handoffs

Two objects, deliberately separated:
`blackboard.py` is the **wall** — who is in which checkout, which files they
have actually touched (read off git and the run trace, "never off a plan"),
composted nightly, injected into a new session's seed prompt via `briefing()`,
and a task likely to collide **queues behind** the one already working.
`handbook.py` is the **Hub** — durable posts by topic, `KINDS = gotcha |
decision | howto | system | people | technical_solve | new_idea`, written either
explicitly (`taskuary --learned "…"`) or extracted once at session close, read
back into the next agent's seed prompt by `block()` under a 1,600-char / 4-post
budget. Its two rules: "NEVER what you did … One is an event, the other is still
true next year", and only what somebody would otherwise rediscover. Moderation
is a vote: below zero it leaves the tab and the prompt, kept, never deleted.

## 3. Where the control actually is

This is the part worth copying. `taskuary/guard.py`:

> That promise was made in PROSE. `SOUL.md` says what the agents may do,
> `CODER.md` says not to push … **An instruction is not a control.**

So sessions run with an **agent token** in their environment, and a pure
`(method, path, why)` deny table is matched in middleware **before a handler
exists**: approving a review, opening a reply, starting an outbound message,
touching connectors/settings/policies/docs, and — explicitly — anything that
would widen the agent's own reach. "The deny list is this file, and this file is
code." Around it: DNS-rebinding `Host` checks, an `Origin`/`Sec-Fetch-Site`
check, and both tokens minted on first run. The module then states its own
limits plainly (an agent shares the OS user and can read the SQLite
credentials).

Three further mechanisms sit on the exit:

- **Safe outputs** (`proposals.py`): an agent emits `TASKUARY-PROPOSE {"action":
  "open_pr", …}` anywhere in its transcript; deterministic code parses it
  against a **closed table** of actions (each with required keys and a switch
  that must be on), caps at 5 per transcript, refuses malformed or unpermitted
  ones, and files a `review`. Approve is what executes it.
- **Staleness** (`verdicts.context_moved`): if the thread materially moved after
  a draft was written, the approve click **does not send** — it keeps the
  owner's edit for comparison, refreshes the draft, and asks again.
- **Proof of work** (`proof.py`): files from git, test counts parsed per runner,
  CI from the checks API, attempts and timings — and what is *missing*, said
  plainly, because "a claim we cannot substantiate is left OUT". Nothing here is
  generated prose.

Credential redaction is deterministic and applied at each of three exits (hosted
model, headless CLI, first agent prompt), never on the way in, and a reply still
carrying a placeholder is refused rather than delivered.

**Cost controls:** none beyond choice of brain (`triage_ai`: cloud connector,
your coding CLI, or local Ollama) and a few structural savings — deferred drain,
heuristic short-circuits, boilerplate stripping, a 6 KB body budget. No spend
accounting, no budget stop. **Security model:** single user, `127.0.0.1`,
credentials in plaintext SQLite, optional `X-Taskuary-Token` for LAN.

## 4. Against Metistry's loop, axis by axis

**(1) Timeline.** Metistry already has the ordered stream as a named query —
`seed/queries/activity_feed.yaml` unions `runs`, proposals created *and*
decided, `work.history` and outbound messages. What it does **not** union is
`inbox`: a capture is invisible until the drain (`*/5`) turns it into a
proposal. That is Metistry's only accidental latency in the loop. Taskuary's
"show first, judge next" — store the arrival, show it wearing a *triaging* pill,
classify after — costs nothing here because the row already exists. **ADOPT 1.**

**(2) Auto-identification of work.** Sharper than the brief suggests:
`inbox-drain` emits **only** `kind: 'knowledge'` proposals, and allowing one
does not create anything — the evening fold later writes a note. So Metistry has
no capture → `work` path at all; a todo captured on the phone ends the night as
a vault page. Taskuary's answer is a model call that creates and dispatches.
The §4.12-honest middle is not a `draft` work row written by the collector (that
*is* auto-creation, whatever the status column says — the invariant cost is
real and I would not pay it); it is making the click do the thing: a second verb
on a proposal whose classification carries `has_action`, **Approve as work**,
which inserts the `work` row. The human gate stays exactly where §4.12 puts it,
and the row appears in one gesture rather than never. **ADOPT 2.**

**(3) Review before actioning/sending.** Metistry is ahead on enforcement —
outbound goes through `targets` with `data_policy` checked in `dispatch.ts`,
principals are separated server-side, and the assistant has no shell (invariant
9). Taskuary adds three things Metistry lacks: approve *executes* (Metistry's
allow is inert for every kind but `improvement`); the staleness interrupt; and
an evidence card under the approve button. **ADOPT 3** (staleness) and **ADOPT
6** (executable `action` proposals) follow. Its gate is genuinely enforced at
the tool — middleware, not UI.

**(4) Discoveries.** Maps to `knowledge` proposals + the fold. Two deltas.
*Immediacy*: a Hub post is readable by the next session minutes later; an
accepted Metistry note waits for the ≥18:00 fold. *A read path*: nothing in
Metistry injects prior findings into a new run. The fix is not a new store —
it is a budgeted block in the brief. **ADOPT 4.**

## 4b. Axes 5–7

**(5) Notes for the next agent.** Metistry's crews are one-shot and "the brief
is the context transfer", which is the right shape; what is missing is anything
*in* the brief from earlier work in the same area. A `Knowledge/Areas/<area>/
_agent-notes.md` written by crews would break §4.11's one-writer rule, so:
crews keep reporting, the fold keeps writing, and the **brief builder reads**
— scope-filtered, capped at ~4 notes / 1.5 KB, the caps enforced in the builder
rather than asked for in a prompt. Taskuary's ephemeral half (the wall,
composted nightly, with collision-queueing) maps onto leases and is already
covered by A1/A2.

**(6) UI.** The intuitive part is not the framework, it is that **every row has
one word for its state and one mark for its source, from one file**, and that
the walk-through hands the owner a single item with its next action attached.
Metistry's Needs You has three answers (Approve/Revise/Decline) and no way to
say *not now*: `later` (back in 3h) and `skip` (back at 07:00) are states with
an `until`, not dismissals, and FYIs settle as one batch. **ADOPT 5.** The lane
vocabulary belongs in `packages/core` before MetistryKit copies the table
(Taskuary hit exactly this: "we built one idea and then it was changed… it's in
a bunch of places") — BORROW-LATER only because the board view is mid-flight.

**(7) Cycle speed.** Metistry's cadences are mostly fine: drain `*/5`, runner
hourly, fold gated to one evening turn. Slow **by design**: the fold, and it
should stay — an hourly fold would multiply routine turns ~10× to rewrite the
same journal page. Slow **by accident**: capture invisibility (ADOPT 1) and an
approval that does nothing until nightfall (ADOPTs 2/4). Taskuary is faster
because it has **one** gate (the exit) where Metistry has three (accept, fold,
dispatch) — not because it runs more often. Cadence is not the lever; the number
of gates is, and §4.12 is a statement about gates, not speed.

## 5. Ranked ADOPT list

1. **Timeline = `activity_feed` + an `inbox` branch + a `source` param**, and a
   `timeline` view beside `feed`. Additive SQL, no migration, no dependency.
   Serves invariant 3. Changes no decision.
2. **"Approve as work"** on a proposal whose `classification.has_action` is set:
   the click inserts the `work` row. §4.12 intact — a human still creates it.
   Needs a `work` insert path in the triage handler; no new table.
3. **Decide-time staleness check.** For proposals derived from state that can
   move, re-read at decision time and return the existing 409-carrying-the-
   winner envelope (O5) with the change instead of deciding. Serves invariant 2.
4. **Prior-work block in the crew brief** — ≤4 settled notes under the crew's
   `scope`, ≤1.5 KB, built by the brief builder. §4.11's one writer is
   untouched; crews still only report.
5. **`later` / `skip` as decision verbs** in Needs You (`proposals.snoozed_until`,
   additive migration) plus one-card batching for low-value groups. Fixes the
   queue's only failure mode: an item you cannot answer yet and cannot put down.
6. **Executable `action` proposals** — a closed table of actions, each with
   required keys and a switch, validated deterministically, executed on approve.
   *This one changes an existing decision:* today only `improvement` does
   anything on allow, and `action` is a dangling value in the console's view map
   that nothing emits. It widens the **console's** mutating surface (invariant 9
   constrains the engine, so this is not a violation — but it is new power and
   the owner should rule on it rather than inherit it from a PR).

## 6. SKIP, and BORROW-LATER

**SKIP.** Model-decided routing at ingest (invariant 4, and it is the control
§4.12 exists to keep). Auto-start of agent sessions from inbound messages
(invariant 2; their own `SECURITY.md` concedes "agents act with your
permissions"). Editable prompt documents as the policy surface — `TRIAGE.md`,
`SOUL.md`, `LEARNED.md` are prompting, and Taskuary's own `guard.py` explains
why that is not a control. `LEARNED.md`'s evidence-scored preference promotion:
elegant, but it is behaviour change without a PR. Vendoring anything: Python,
against the stack rule.

**BORROW-LATER.** The lane/kind vocabulary as one shared file in
`packages/core`. A `proof`-style evidence card (files, tests, what is missing)
under crew reports, once crews produce diffs. `occurred_at` on `inbox`, so a
timeline can order by when a thing *happened* rather than when it was captured.
Connector **roles** (`trigger` vs `feed`) as collector manifest keys. Lifting
Metistry's inline principal allowlist in `server.ts` into a pure, unit-tested
deny table — same enforcement, testable as data, and it pairs with R3.

## 7. Contradictions and notes

- None with `metistry-build-plan.md`.
- **Precision note:** the Needs You queue's six request types include `action`,
  but nothing in the repo emits `kind: 'action'` — it is a stub in the view
  layer (`apps/console/web/app.js`). ADOPT 6 would fill it; otherwise it should
  be dropped so the vocabulary is not larger than the system.
- `inbox-drain` emits only `knowledge` proposals. Descriptions of the drain as
  emitting the full kind set describe the *queue*, not the collector.
- Their tagline frames the product around a person's paid work; nothing here
  imports that framing.

## 8. Phasing

- **PR 1 — see it arrive.** `activity_feed` gains the `inbox` branch and a
  `source` param; a `timeline` view in the console; a paragraph in
  `docs/ops/console-api.md`. No migration, no dependency.
- **PR 2 — the click does something.** Approve-as-work, the staleness re-check,
  and `snoozed_until` (one additive migration). Gated on PR 1 making the
  arrivals visible enough to judge whether the verbs are the right ones.
- **PR 3 — the brief remembers.** Scope-filtered prior-work block with caps in
  the builder. Gated on PR 2 producing work rows to hand out.
- ADOPT 6 waits on the owner's ruling.

## 9. Could not verify

Not installed or run: every claim about screens comes from the README
screenshots, `docs/product-guide.md` and source names, not from use. Default
sync cadence (`poll_minutes`) not read — I confirmed a 30-second chat clock and
the 5-minute poll overlap only. Keyboard affordances in the React app: grepped,
not exercised. Test coverage of the `TASKUARY-PROPOSE` execution path not
audited. The ~500 KB `docs/processing-*.md` set (their unread/read-state
subsystem) was not read; it may hold more of the timeline's state model. Star
and commit counts are as of the fetch date.

## Sources (fetched 2026-09-16)

- Repo and metadata — https://github.com/ldbumble/taskuary (`gh api repos/…`,
  `contributors`, `releases`; shallow clone at `master`)
- `README.md`, `SECURITY.md`, `docs/roadmap.md`, `docs/product-guide.md`,
  `docs/task-lifecycle.md`, `docs/reports-and-assistant.md`,
  `docs/taskuary-agent.md` (exploration only)
- `taskuary/guard.py`, `proposals.py`, `proof.py`, `verdicts.py`, `triage.py`,
  `ingest.py`, `funnel.py`, `lanes.json`, `handbook.py`, `blackboard.py`,
  `store.py`, `channels.py`, `llm.py`, `outbound.py`, `server.py`
- Metistry: `collectors/inbox-drain/{manifest.yaml,run.ts}`,
  `seed/queries/activity_feed.yaml`, `apps/console/src/server.ts`,
  `apps/console/web/app.js`, `docs/ops/{crews,targets,knowledge-fold,
  reply-feedback}.md`, `metistry-build-plan.md` §4.11–4.12,
  `docs/plan-refresh-2026-09-13.md` §1/§4/§4b
