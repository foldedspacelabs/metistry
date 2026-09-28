# Metistry — product context (living document)

> Not a launch document. This accumulates product/marketing-relevant context
> **as features, implementation, and guardrails are designed**, so the launch
> material can be written from a record instead of reconstructed from memory.
> Convention (see `CLAUDE.md`): when a decision in the build has product
> significance — a goal sharpened, a benefit proven, a safety mechanism
> shipped — add a fragment under `docs/product/record/` in the same PR; the
> release folds it into the log below.

## What it is

A local-first personal AI operating system: a persistent assistant plus a
knowledge vault that holds your context so sessions don't have to. Agents are
disposable; state is durable — markdown in git (what you know) and Postgres
(what's happening; the index over the notes is rebuilt from them). Open source
(Apache-2.0); each install is a private instance the user owns entirely, run
on their own Mac, with no service operated by the maintainer anywhere in the
path.

**Current shape (2026-09-26; v0.11.0 plus `main`).** A signed Mac app that
installs and operates the system — bundled runtime, one background item, a
menu bar, settings, compute; the installed web app (PWA) as the daily client
on the phone and any other computer; the `metistry` CLI; and one MCP door that
every agent, the instance's own assistant included, works through. The app's
daily screens — Today, Chat, Activity, Needs You, Work, Knowledge, Agents,
Scheduled, Connections — are designed (design round 0, #263) and scheduled in
the approved build plan (`docs/product/design-build-plan.md`, PR #260,
approved 2026-09-26: 140 tickets in six waves, W0 freeze through W5
acceptance). The public description is `docs/product/website-brief.md`.

## The name — roots, for later storytelling

From the naming ideation round, the distillation worth preserving:
**actionable distilled knowledge, managed by a trusted advisor** — evolved,
as the project did, into the fuller archetype: the advisor who also **runs
the household of your work** — coordinates the helpers (agents, any vendor),
wrangles the chaos of capture and comms, and keeps you organized, efficient,
and effective day to day. Counselor *and* steward; chief-of-staff energy,
loyal to exactly one person. The root is the ancient word for *practical*
wisdom — not knowing everything, but cunning, situational judgment: turning
what's known into what to do. The `-try` suffix reads as a craft or practice
(artistry, chemistry, mastery) — metistry as *the craft of counsel and
coordination*. Public copy should **hint at this, never explain it** (the
README models the register: "a nod, not an acronym"); the myth-literate get
the reference, everyone else gets the ethos. Note the standing rule: the
assistant's default name lives only in an instance's `identity.yaml` —
naming lore in public copy stays about the *project*.

## Goals

- **Your context outlives any session, agent, or vendor.** The vault and
  operational state are yours, in formats (markdown, SQL) that survive tooling
  churn. The instance directory *is* the vault Obsidian opens (2026-09-17);
  the database beside it is an index and a ledger.
- **Nothing happens without the owner's say — enforced at the tool.** One
  decision function answers for every door; one queue, Needs You, holds
  everything that needs a person; approving runs the same code the owner's own
  click runs. A rule a prompt carries is not a control.
- **Private by construction.** No maintainer-run service and no telemetry;
  on-machine models are first-class; the confined processes — the engine and
  the vault's committer — reach only the hosts the owner's configuration names:
  the model provider and the backup remote (2026-09-19).
- **Predictable cost.** Rules the owner writes decide routing and always win;
  no-model fast paths; spending limits checked before the call. (Idle cost is
  the #1 documented abandonment reason for personal AI in 2026 — Metistry's
  architecture is built against it.) The router is deterministic today. The
  owner ratified an amended invariant 4 on 2026-09-26 (it lands in `CLAUDE.md`
  with ticket F-0): inside the rules, a local policy may choose operations and
  tier, every choice recorded with its reasons, wired only after an evaluation
  clears the bar he set (plan §2.8, T9).
- **The day organised from the owner's own notes.** A todo is a `- [ ]` line in
  any note; the plan, the fold and the standup render from templates the owner
  edits in Obsidian; nothing rewrites a line the owner typed (daily-flow spec,
  2026-09-20).
- **Useful from every surface, and to every agent.** One client API for the
  Mac app (the main and management client), the PWA and a future iPhone app
  (plan §2.1, ruled 2026-09-26); any MCP-capable agent from any vendor, each
  with its own revocable token.
- **A system one person can run for years.** Every dependency is a
  maintenance obligation; recipes over frameworks; small enough to understand.
  Eight third-party npm runtime packages across the whole product, plus
  Sparkle in the Mac app (counted at `0b20767`, 2026-09-26).

## Benefits (proven, not aspirational — keep receipts)

- Status questions answered in <200 ms with no model call (measured: 0.6 ms
  cached / 24 ms uncached).
- Free on-device classification tier (Apple FM, 2.2 items/sec measured);
  free local tier-scoring candidate (gemma4:e4b, 97.9% on eval fixtures).
- Apple's on-device model is a provider at cost 0 (PoC-19, 2026-09-16): 60 of
  60 requests succeeded and 40 of 40 structured answers validated, at 268 ms
  for plain text and 497 ms for a three-field classification, with 22.7 MB
  resident against 842 MB for a comparable 4B local server.
- Captures are triaged on the machine in ~150 ms against a closed list of
  sixteen intents, where the JSON round trip took ~500 ms; the confidence
  threshold is a number in the owner's own file (PoC-20, 2026-09-22, `main`).
- The vault answers questions phrased in your own words (2026-09-07): a query
  sharing no words with its note returns it at 0.724 against the next note's
  0.440 in 14 ms, where keyword search returns nothing; changing the embedding
  model is a 45-second, byte-identical rebuild.
- Sessions survive restarts; knowledge survives everything (git is the record
  — `docker compose down -v` loses no knowledge; tasks are indexed, never
  stored, so a dropped database comes back from the notes, 2026-09-20). Which
  operational rows count as durable is open decision D6.
- A clean Mac runs from the release artifacts alone (2026-09-10): no Docker,
  Homebrew or Xcode — bundled Node, Postgres 17.11 with pgvector and git (a
  177 MB runtime); 13 migrations applied, doctor 23 checks healthy, the engine
  confined the whole time.
- A live install moves between deployment shapes with its data intact
  (2026-09-10): rehearsed on a copy of the production database, every table's
  row count identical afterwards, and the move reversible.
- The assistant reads 944 fewer tokens before every reply — 19% of its tool
  list, 19,914 → 16,140 characters — with nothing it can do removed
  (2026-09-19); CI now refuses growth without a decision.
- Coordinates *other* agents (any vendor, via MCP): shared knowledge with
  scoped permissions, shared task list with atomic claims (five concurrent
  claims, exactly one winner), capture from any AI tool the user works in —
  Claude Code, Cursor and OpenCode sessions dedupe across four capture doors.
- **The door opened 2026-08-30** (Phase 2 done-when, measured): a status
  question answered inline off the deterministic fast path with a
  freshness stamp and no model call; a real model turn round-tripped
  through the full stack (web API → durable queue → Agent SDK engine →
  reply) in 3.6 s on the cheap tier, with per-turn token/cost audit rows.
- Separation between contexts that is mechanical, not disciplinary: separate
  instances, separate repos, code flows down as releases, data flows nowhere.

## Safety considerations (the differentiator — record every mechanism)

The design principle throughout: **enforce at the tool, never by prompting.**
Measured basis: prompt-level guardrails failed every test in Phase 0 research
(a local model leaked a live OTP into a "safe" field despite explicit
instructions; input filtering missed memory-poisoning 9/10 times).

**Who may do what**

- **One decision function** (2026-09-20). Fourteen rules across eleven files
  became one `may()` that every door asks and none second-guesses, with a test
  that greps for a rule growing anywhere else. Refusals carry machine-readable
  reasons; the whole refusal vocabulary is one reviewed file; the refusals that
  must stay uninformative are marked so in code.
- Agent identity stamped server-side; an agent's message can never carry
  user authority.
- Scoped, default-deny, user-granted read tiers for external agents — none,
  titles, or named folders; grants server-side on tokens; every
  grant/read/decision audit-logged. An agent can see what exists (titles and
  one-line descriptions) without reading a byte of it (2026-09-19).
- **One door per restricted read** (2026-09-19): a query file names the door
  that serves it; the generic door refuses a restricted query exactly as it
  refuses one that does not exist; no list reports a total, because a count of
  what was withheld is itself a disclosure.
- **Agents ask; only the owner answers** (2026-09-19): `request_access` names a
  folder and a reason and grants nothing; Approve widens by exactly that
  folder through the same path as the Agents panel; one escalation after a
  decline, then the area closes at the tool.
- **Executable actions from a closed set of four** (2026-09-16) — dispatch,
  card update, comment, capture — each a door onto a service the console
  already had, run as the owner with the asker as provenance; no mail,
  messages, git, shell or credential change (invariant 10).
- **Autonomy levels are ceilings** (2026-09-16): an absent level means nothing;
  `dispatch` stays human at every level unless the owner says otherwise; a
  raise writes its own audit row and alert. Every action mode shows *why* —
  set, defaulted or clamped — computed once in core (2026-09-22, `main`).
- Crew toolsets travel with the credential and are enforced by the server,
  not by the dispatching program (2026-09-20); crews get per-run credentials,
  burned after (2026-09-07).
- Management endpoints take the owner credential only, never an agent token,
  and every agent-authored field is output-encoded in the UI.
- A decision on a request that changed after the owner saw it is refused with
  the current row (2026-09-16). A room cannot address anyone — posting wakes
  nobody (2026-09-16). The board offers no drop the service would refuse
  (2026-09-16).

**The vault and the rules**

- One committer: the reconciler is the only process that runs git and holds
  the vault; sub-agents and external agents can propose, never write; only the
  owner's own assistant writes knowledge, through `knowledge_write`.
- **The owner's key** (2026-09-20): the files that define behaviour — agents,
  access rules, queries, the release pin, the assistant's instructions — are
  writable only with a key the CLI holds as the owner; the network-facing
  console never receives it; two enumerated exceptions (the prompt overlay on
  an approved improvement, compute from the pane); without the key nothing
  writes those files, the updater included.
- **Notes the owner wrote stay the owner's** (2026-09-19): a note with no
  `source:` is the owner's, and the assistant's whole-file write refuses it.
  **`Me/` is the owner's** (2026-09-21, `main`): refused at the tool for the
  assistant and every routine, the first write included.
- The assistant refuses to start rather than answer under a placeholder
  identity (2026-09-18).
- Reader/writer separation: sessions that read third-party content hold no
  commit or memory-write tools (memory-poisoning defense, architectural).
- Deterministic redaction of model *output* before it's treated as safe.
- Drafts are invisible to every agent at every tier.

**The machine**

- The engine has **no shell and no raw git** — its tools are its entire reach
  (invariant 9) — and on the Mac-native shape it runs under a `sandbox-exec`
  profile proven by misuse tests that launch the real process (2026-09-07).
- **The committer is confined too** (2026-09-19): it can write the vault and a
  scratch directory, exec node and git only, and has no shell; the push
  credential reaches git through a 14-line askpass helper, never an argument
  list; an SSH remote is refused under confinement, with a visible file as the
  only opt-out.
- **One door off the machine** (2026-09-19): confined processes reach the
  network only through a local proxy that allows the configured model
  provider and the vault's backup remote, refuses everything else with a
  record of who asked, and never decrypts what passes.
- Secrets live in the login Keychain and never reach argv, a log line, a
  remote URL or `.git/config` — asserted negatively by test (2026-09-07).
- Host bridges authenticate every caller (loopback is not a trust boundary).
  TCC-privileged native bridges are stably-signed, single-purpose binaries;
  behavioral health probes (permission APIs lie; probes don't).
- **Keep-awake only with consent** (2026-09-19): an install nobody asked holds
  nothing; each choice states its cost; lid-closed is never faked; the
  assertion ends when the install stops, however it stops; doctor reports a
  night the Mac slept anyway.
- Release integrity: an update verifies sha256 before unpacking and cannot
  half-apply; the previous release is kept for rollback (2026-09-07).
- Migration scripts refuse to guess which database they touch, and print the
  target without connecting (2026-09-19, after an incident).

**Money and failure**

- Spending limits checked **before** each call, not reported after: a warning
  at 80%, then record-and-continue, stop, or critical-only; a stop pauses
  scheduled work rather than filling the queue (2026-09-16).
- Collectors never call a billable model — CI refuses one in a collector
  manifest, and the call throws rather than degrading into spending
  (2026-09-16).
- Scheduled work admits failure: preflight before a run, a stop after repeated
  failures, one Needs You item per fault signature (2026-09-15).
- A watchdog with zero model/API dependency that can tell the user the
  system is broken — including cost-runaway detection conventional
  monitoring can't see.
- Shadow runs of a candidate model cannot execute anything: they are handed
  recorded answers and nothing to call (2026-09-16).

**Sign-in and exposure**

- **Passkeys only — no passwords anywhere** (2026-08-29). Sign-in is Face
  ID / Touch ID; nothing for a server breach to spill, nothing to phish,
  nothing to reset. Enrollment and recovery root in the machine the user
  already owns (a one-time QR from `metistry init`); sessions are
  revocable per device; lapsed sessions re-auth in one tap without ever
  dropping a capture or silencing notifications. The Mac app's local owner
  token is decided from the TCP socket alone and refused from any other
  address, byte-identically to an unknown token (2026-09-10).
- **Open-design security (invariant 8):** built assuming adversaries — human
  and AI — read the source. No security through obscurity; boring standard
  primitives; misuse tests ship with every interface; and no implicit network
  trust — every request authenticates as if internet-exposed, because the
  category leader's worst incident (40k+ exposed gateways) was exactly a
  "the network will protect us" default.
- **Bring-your-own routing:** the project exposes configured ports and
  suggests exposure patterns per hosting model (local + tailnet, reverse
  proxy, cloud, Docker) but never depends on any — a user benefit (host it
  anywhere) that is also a security benefit (no assumed-safe network).
- Preview-confirm on destructive actions shows canonicalized resolved
  targets (defense against the GhostApproval CVE class).
- Contrast for positioning: the category leader's ecosystem had 40k+ exposed
  instances, 341 malicious marketplace skills, and prompt-injection RCE in
  2026. Metistry's answer is structural, not reactive.

**Planned in the approved plan** (`docs/product/design-build-plan.md`, PR #260)

- Routes that change the boundary itself — minting an agent's credential, a
  routine's actor and grants, rollback, purge — answer only the local owner
  token on the Mac: *a remote client may act inside the boundary; only the Mac
  may change it* (§2.3, F-13).
- Secrets per instance only, filled in at egress against a host list,
  redacted on the way back, never shown to a model (§2.14, W1).
- Connections proxied to agents with per-tool On · Ask · Off; an Ask never
  runs unattended; destructive tools default to Ask (§2.6, W2–W3).
- The vault's git: one commit per act, never a force-push, a conflict stops
  and raises one request, and every restore or rollback waits for Approve and
  is refused to every agent principal (§2.21, W1–W3).
- Pull-request reviews posted through a separate owner-only credential,
  checked against the head commit the owner saw (T2-13, W3).
- Live events carry ids, never bodies, so the stream opens no new read path
  (§2.20, W1).
- Recording is started only by the owner's hand; re-review returns text,
  never audio, to a model on an on-machine tier; audio is deleted after
  filing plus 7 days, never more than 30 (§2.15, W3–W4).
- Extension code never runs inside the console: a process extension runs as a
  sandboxed child behind the egress allowlist (§2.7, §5).

## How to use (the story, current shape)

1. **Install.** Download the Mac app — a signed, notarized DMG on GitHub
   Releases. The first run copies the bundled runtime,
   creates the instance and asks you to name your assistant, connects a private
   GitHub repository by device flow, asks whether to keep the Mac awake, and
   sets up compute — a cloud provider with its key typed into a secure field, a
   local model, or none yet. From a terminal instead:
   `npx @foldedspacelabs/metistry-cli init <dir> --name <name>`, then
   `metistry up`.
2. **Open the folder in Obsidian.** The instance directory is the vault.
3. **Use it from the phone.** Install the web app to the Home Screen and
   enroll a passkey with the one-time code: chat, Needs You, the board, and
   notifications you can answer. On the Mac today the app shows status,
   settings and compute; its daily screens arrive in the plan's waves.
4. **Capture from anywhere** — the share sheet and Shortcuts, `+`, `/note` —
   and `metistry connect cursor | claude-code | opencode | devin` so your other
   tools capture into it and read what you grant.
5. **It remembers.** The evening fold writes the day into the vault,
   tomorrow's plan renders from your template, and the morning brief and
   weekly review arrive as messages.

After the approved plan (W1–W4) the Mac app is the daily surface: Today with
the Morning Brief at 7:00 and the Standup at 8:00 on working days, Close the
Day, the fold at 9:00 PM and Tomorrow's Plan at 11:00 PM; connections with
per-tool On · Ask · Off; the capture bar and meeting capture. The knowledge is
yours, in your git, on your machine.

## Log

- 2026-08-28 — document created. Phase 0 complete (16 PoCs), Phase 1
  substrate started, plan carries: product/instance split, flexible compute,
  external-agent capture + read tiers, coordination hub, management API,
  web-app-first / iOS-later-premium.
- 2026-08-28 — invariant 8 added: open-design security + network-agnosticism (bring-your-own routing layer).
- 2026-08-29 — design refresh: hosting-agnostic framing ("local-first in
  ownership, not local-only in deployment"); user profile centralized in
  Knowledge/Me/ (init interview; never externally readable); one unified
  knowledge interface for all agents; /model tier shortcuts; daily-flow
  templates story; user-extensible connectors via local registry entries +
  `metistry create` scaffolder (a key OSS adoption feature).
- 2026-08-29 — naming roots recorded and evolved: counselor AND steward (distilled counsel + coordination/chaos-wrangling ethos); hint-don't-explain register for public copy.
- 2026-08-29 — pre-implementation review (four staff-level reviews,
  synthesized in `docs/plan-review-2026-08-29.md`) ratified and propagated:
  **web app is the interface** (iMessage dropped entirely — too insecure,
  not rich enough; web push for notifications, iOS later as the premium
  candidate); keyword recall moved up to Phase 2 (time-to-value); Swift TCC
  bridges with a wire-level contract; product/instance config overlay; one
  unified proposals queue with a soft daily-review budget (respect the
  user's attention: ~5 decisions/day surfaced, full detail one tap away);
  security posture hardened (no-shell invariant, bridge caller auth,
  owner-vs-agent credentials).
- 2026-08-29 — owner authentication decided: **passkeys only** (WebAuthn),
  host machine as root of trust, 30-day-idle/1-year-max device sessions
  (user-configurable). "No passwords anywhere" is both the simplest UX and
  a positioning line — the web door ships with modern auth by default.
- 2026-09-01 — Phase 3 capture live (/note, inbox-drain proposals, routine
  runner) + the Apple FM bridge: free on-device classification behind the
  wire contract, verified end-to-end on the Studio. Collector/model ruling:
  free on-device tiers permitted case-by-case. iOS app planning doc added.
- 2026-09-01 — UX direction recorded (`docs/product/ux-direction.md`):
  expressive, discoverable interaction — buttons/menus over memorized
  syntax, structured question-answer dialogues, actionable notifications
  (answer from the push), visible model selection; slash commands stay as
  the power layer; one design language across web + iOS. APNs relay
  privacy bar raised to launch-blocking: payload-free, provably leak-proof,
  open source.
- 2026-09-06 — `github-state` verified live (open issues/PRs reconciled
  into `work`, Projects section in the brief) and `aws-costs` collector
  added: daily spend per service from Cost Explorer via a ~50-line SigV4
  signer over `fetch` (verified against AWS's published test vector) — no
  SDK dependency tree for one signed request every six hours. Phase 4's
  "see your own spend" now has the AWS half; `claude-usage` is the other.
- 2026-09-06 — `claude-usage` collector: the assistant's per-turn `runs`
  rows rolled into daily token/cost metrics by model tier (Phase 4's
  "see your own token spend split by tier"), derived from local data only.
  On a subscription the cost figure is headroom consumed, not money
  billed — labeled that way in the query so the dashboard never lies.
  Collectors now carry a real-database test alongside the fake-db unit
  tests, after a partial-index ON CONFLICT bug slipped past the fake.
- 2026-09-06 — Incident: the console crash-looped on restart because the
  runner rejected aws-costs's `0 */6 * * *` schedule (unit tests never
  loaded real manifests). Fixed: every-N-hours cron added; a CI test now
  loads every shipped collector/routine manifest through the runner, so
  an unparseable schedule fails the PR, not the deployment.
- 2026-09-06 — **one review list across every repo** (owner request):
  github-state now records author, url, and review requests on each PR
  (`work.meta`, additive migration 0006), `prs_for_review` serves the
  cross-repo "waiting on my review" list to the status page, and the
  brief gets a 👀 section. "Needs my review" (ruled 2026-09-06): in the
  configured repos, any open non-draft PR I haven't approved — which
  covers PRs an agent opened under my own account — computed from the
  token's identity, never guessed. Today section tightened to in-progress/blocked/due items so
  open issues don't flood it.
- 2026-09-06 — Artifact Server (plannotator) reviewed as inspiration
  (`docs/research/2026-09-artifact-server-review.md`). Two additions to
  the plan: **composable modules** (§4.20 — tasks, artifacts, knowledge as
  standalone npm packages with one shared contract set: principal,
  idempotency, action record, project scope, handles, text boundary; "use
  any piece alone, or all of it as one system" becomes a product claim)
  and **artifacts** (§4.21 — versioned, commentable agent output with
  git as the version store, review bundles dispatched back to the agent
  that made it, honest delivery-evidence tiers; agent-to-agent review
  flows unprompted inside a per-agent autonomy boundary the user declares
  and the tool enforces — teams collaborate, the user monitors). Differentiator noted:
  they needed an object store and a five-installer deployment matrix to
  get immutable versions; the instance repo gives Metistry that for free.
- 2026-09-06 — **external-agent registry** (Phase 4 management surface):
  agents are registered from the console (id, name, kind), get a per-agent
  bearer token shown exactly once (stored as a hash), and carry read
  grants (`none | index | areas[]`, TitleCase `Knowledge/` prefixes) and
  project membership. Safety mechanism: **agent identity is server-side**
  — the principal is resolved from the credential, grants attach to the
  token and are never asserted by the agent, an agent token reaches
  `/capture` only (uniform 403 elsewhere), captures carry `source_agent`
  provenance into the proposal at external trust, and every mint / grant /
  revoke / rotate lands in `runs`. Misuse tests ship with it (CRIT-7).
- 2026-09-06 — **`metistry` Claude Code plugin shipped** (`plugins/claude-code/`,
  §4.11's zero-effort external-capture door): a `metistry-capture` skill
  that POSTs decisions/findings/notes to `/capture` with provenance in the
  note's frontmatter (`source: claude-code`, session id, host, repo, cwd),
  and an opt-in `SessionEnd` summary hook (`METISTRY_CAPTURE_ON_STOP=1`)
  that exits 0 on every path. Config is env-only; tokens are redacted from
  all output; no server change — it rides the existing owner-token
  contract, so the instance split makes the boundary between contexts
  mechanical. Installable from this repo as a marketplace
  (`/plugin marketplace add foldedspacelabs/metistry`).
- 2026-09-06 — **tasks module shipped as a standalone package** (Phase 5's
  first piece, §4.20): `@foldedspacelabs/metistry-tasks` is one TypeScript
  service over any pg-shaped client — atomic claim (one `UPDATE`, WHERE is
  the policy), leases with heartbeat, dependency gating with auto-unblock,
  idempotent create, append-only history, every mutation a `runs` row
  stamped with server-side agent identity (§4.19 trust rule enforced by
  the signature: the adapter must supply it; no payload field is read).
  Proven on Postgres: five concurrent claims, exactly one winner. A
  stranger can `npm i` it, `ensureSchema()`, and run a shared task list
  with no console anywhere (additive migration 0008 inside Metistry).
  Adapters (MCP tools, console routes) come next.
- 2026-09-06 — **Phase 4 dashboard** in the PWA: one tab instead of four
  places — last-24h health tiles (runs ok/failed, turns, captures, spend
  from the `runs` ledger), reviews waiting on you, a per-area projects
  rollup (same aggregation as the brief), **assistant spend split by
  tier** with per-day × tier detail (labelled API-equivalent: on a
  subscription it is headroom, not a bill — the Phase 4 "done when"), and
  AWS spend by day and service ("no data yet" until the collector is
  configured). Every panel is a named query (two new seeds,
  `projects_overview` + `runs_summary`), loaded independently and
  freshness-stamped from the `{rows, as_of}` envelope; every value is
  output-encoded (CRIT-7). Seed queries now execute against the migrated
  schema in CI, so a column typo fails the build, not the dashboard.
- 2026-09-06 — **Weekly review routine** (Phase 5; plan §5 maintenance
  cadence): one `@weekly` message covering the last 7 days — projects
  (tasks and PRs opened/closed per area, blocked items with age), the
  decisions you made (by outcome, top denied reasons from your feedback),
  what is still pending as a count and a link (D10: never the full list),
  agents (reports, tasks claimed/closed, tool calls, spend, last seen —
  identity stamped server-side, never self-declared), spend (assistant
  by model tier, labelled API-equivalent; AWS total and top services),
  system health (collector runs, silent collectors flagged, watchdog
  alerts, inbox backlog), and next week (due dates, calendar when the
  EventKit bridge is connected). Unlike the daily brief it always goes
  out — the user asked for a cadence — and an empty section says so in one
  honest line. The first review of each month adds last month's spend by
  tier: §5's subscription-headroom check. Model-free end to end
  (invariant 4); proven against real Postgres in CI.
- 2026-09-06 — **Compute-target registry + first target (Phase 5, §4.18),
  and a safety mechanism shipped: the data policy is enforced at the
  dispatch tool.** A target is a directory with a manifest whose
  `data_policy` block (`allow` vault prefixes, `deny_sources`,
  `max_brief_bytes`) is a required, structured declaration — CI validates
  every manifest in the repo. The console's `dispatch()` is the one path a
  brief takes off the machine, and it refuses — with a machine-readable
  reason, and a `runs` row so the refusal is visible — any brief that cites
  a vault path outside `allow`, carries a denied provenance marker (comms),
  or exceeds the byte cap. "Comms-derived content never leaves the machine"
  is now code, not a prompt. First target: GitHub issues (§6 decision 4) —
  a separate write-only PAT, issue body = brief + return footer, the task's
  `external_ref` binds it, and `github-state` already closes the task when
  the issue closes. Every dispatch logs a `runs` row with the target's cost
  profile, so per-target spend is one named query away.
- 2026-09-06 — **`mcp-brain` shipped: the one MCP surface every external
  agent uses** (§4.11 unified interface, §4.19 hub tools, §4.20 adapters).
  `@foldedspacelabs/metistry-mcp-brain` mounts at the console's `POST /mcp`
  (Streamable HTTP, stateless, per-agent bearer → principal from the
  registry) and exposes eleven eager tools: `capture` + `report` in,
  `tasks_*` (seven thin adapters over the tasks module) for shared work,
  `knowledge_search` + `knowledge_read` out under the user's grant tiers.
  Safety, enforced at the tool: identity is stamped from the credential
  (no tool has an agent argument); tasks outside the caller's projects
  are `not_found` — never listed, never claimable, never a dependency;
  tier `none` is told "not granted", never "not found"; draft notes are
  invisible at every tier; every string rendered to an agent passes a new
  core sanitizer (bidi/zero-width stripped, no leading `/`); every call —
  refusals included — is one `runs` row on the agent; reports are
  idempotent and near-duplicate-suppressed; secret-named fields never
  reach the queue. Tool-result nudges (§4.21) give pull-only agents an
  attention channel with no model involved. Any MCP client can now work a
  Metistry instance's task list and propose to its knowledge with one
  token — a capture-only agent needs no grant at all. Note contents are
  not yet readable in the container (`knowledge_read` → `not_available`
  until the knowledge module lands); the index is.
- 2026-09-06 — **D5 resolved: one committer.** The reconciler is the
  only process that runs git and the only holder of the vault; everything
  else reaches knowledge through a host-side vault bridge over HTTP with
  write-with-intent commits. Safety mechanism: no git credentials in any
  container, the engine still has no shell and no git, and a write is
  visible to readers immediately while commits batch behind it.
- 2026-09-06 — **Watchdog closes the quiet-failure gap** (§4.9, PoC-11's
  "collector staleness" duty; three follow-ups noted during Phase 3–4).
  `silent-collector` reads every collector/routine manifest and alerts
  when the last `runs` row is older than 3× its schedule (never-ran counts
  from watchdog start, so a fresh install stays quiet); `bridge-degraded`
  calls every configured bridge's `/check` with its own token and reports
  *down* (nothing speaks the contract) distinctly from *degraded* (the
  bridge's own behavioral probe says no, in its own words); and
  `fm-tier-never-fires` catches the failure that looks like success — the
  apple-fm bridge is healthy but inbox-drain's proposals show only the
  deterministic tier, i.e. the console container can't reach it. Alert
  texts carry the fix and never a changing number, so the existing dedupe
  holds; `absent` (not configured) never pages. Still model-free; still
  no Anthropic anywhere in the path. `scheduleToSeconds` moved to core so
  "due" and "silent" can never disagree about an interval.
- 2026-09-06 — **The assistant gets its tools through `mcp-brain`, as the
  first internal agent** (§4.11 "one knowledge interface for ALL agents",
  now literally true). The engine mounts exactly one MCP server — the
  console's `/mcp` over the compose network, bearer from
  `METISTRY_ASSISTANT_TOKEN` — and its `allowedTools` is the eleven brain
  tools and nothing else: built-in tools disabled, foreign MCP config
  ignored, the list locked to the bridge's manifest by test (invariant 9
  as code). The console registers `agents.id = 'assistant'` (`kind =
  internal`) from the same token at startup — idempotent re-sync of hash,
  grants and projects from the environment, revoked when the token is
  absent — so the assistant authenticates, is scoped, and is audited
  exactly like a foreign agent, with one documented difference: an
  internal principal with no project list is a member of every project
  (the hub's voice sees the whole shared list). Every turn's `runs` row
  now carries `meta.tools_used`; every tool call is already its own row.
  A seed system prompt (`seed/assistant-prompt.md`, templated from
  `identity.yaml`) tells it what each tool is for. Not a control — the
  surface is. Known gap, reported: the grant validator refuses bare
  `Knowledge/`, so root-level notes (`now.md`) sit outside the widest
  valid grant. Ops: `docs/ops/assistant-tools.md`.
- 2026-09-06 — **reconciler shipped: the instance repo's sole committer
  and vault bridge** (D5 ratified; `apps/reconciler`, `runs_on: host`,
  port 7812, `docs/ops/reconciler.md`). One process holds the working tree
  and runs git; everything else — console, `mcp-brain`, the engine — goes
  over HTTP with a bearer (read/list/search/log/diff/write/delete/rename),
  so no container ever mounts the vault or holds a git credential and the
  engine keeps having no shell (invariants 7 + 9 by construction). Safety,
  enforced at the tool: every write carries a commit intent and the author
  is stamped server-side from the principal (a request cannot name one);
  §4.7 protected paths (`identity.yaml`, `rules.yaml`, `queries/`, …) are
  `forbidden` for every principal but `user`; `..`, absolute paths, `.git`,
  `instance-migrations/`, symlinks, and case-mismatched `knowledge/` are
  refused outright; compare-and-swap on the content hash turns a lost
  update into a `409`. A write is readable by the next request and
  committed on the next 30 s flush — one commit per intent group, `git
  add` scoped to the touched paths, `Brain-Source` trailer. The §4.13 loop
  now exists: content-hash (not mtime) indexing of `knowledge_files` +
  `knowledge_links`, renames by hash, Obsidian/Syncthing conflict copies
  flagged once as a `proposals` report and never served, and out-of-band
  Obsidian edits swept into `user` commits (PoC-12 closed in code).
  `knowledge_read` in `mcp-brain` now returns note contents when the
  bridge is configured. 45 tests, all misuse shapes included.
- 2026-09-07 — **`metistry init` + `metistry doctor` shipped**
  (`packages/cli` → `@foldedspacelabs/metistry-cli`, `docs/ops/cli.md`).
  `npx @foldedspacelabs/metistry-cli init <dir> --name <assistant>` is now
  the documented first step — the instance repo the 2026-09-06 bootstrap
  made by hand, stamped from `seed/` with the name in `identity.yaml` and
  nowhere else, the reconciler token minted and *printed* (never written
  into a repo the user may push). `doctor` is the promise plan §4.16 made
  in Phase 1 paid off: generic over manifests, it validated all 14
  shipped components and probed every bridge/service/container/launchd
  job through the one `check()` contract — 24/24 ok on the Studio on
  first run, `failed` (exit 1) versus `degraded`/`absent` (exit 0) so a
  missing optional bridge is a finding, not an outage. 26 tests, fakes
  for every status plus the real-db migrations count.
- 2026-09-07 — **The assistant can write knowledge: `knowledge_write` is
  `brain-commit`** (§4.7 layer 1, D5's "thin call to write-with-intent",
  §4.11 one writer). One more tool on the same `mcp-brain` surface, and
  the engine still has no shell and no git. Safety mechanism, three
  refusals deep and none of them a prompt: only the `kind: internal`
  principal (the owner's own assistant) can call it — every sub-agent and
  external agent gets the uniform "not granted" and keeps `report`; the
  path must be `Knowledge/...` inside the assistant's own read grant, and
  the reconciler refuses the §4.7 protected set (`identity.yaml`,
  `rules.yaml`, `queries/`, `agents/`, …) behind that, so the assistant
  cannot edit its own constraints or its routing; and every markdown
  write is stamped with provenance from the credential (`source:
  assistant`, `updated: <today>`) merged into the frontmatter without
  touching another byte. Compare-and-swap (`knowledge_read` now returns
  the hash) turns a race with an Obsidian edit into a `conflict` the
  assistant re-reads through instead of clobbering; every call is a
  `runs` row and every landed write a commit in its name. Grant rule
  (owner decision, implemented as the recommended default): a `kind:
  internal` row may hold the bare vault grant `Knowledge/`, now the
  assistant's default, so root notes like `now.md` are readable — the
  gap reported 2026-09-06 is closed by test. Deletes and renames stay the
  user's hand.
- 2026-09-07 — **Artifacts: reviewable agent output** (plan §4.21, built
  as a §4.20 module — `packages/artifacts`, `0010_artifacts.sql`, console
  routes + PWA tab, six `artifact_*` tools on `mcp-brain`). An agent's
  plan/report/page is now a versioned artifact in the instance repo
  (`Artifacts/<project>/<slug>/`, ONE commit per version through the
  reconciler — asserted with the repo's history in the console's
  integration test against a real in-process bridge), and every publish
  hands back `artifact` / `version` / `review` links. Safety, enforced at
  the tool: compare-and-swap on the current version (a stale agent gets
  `409`, never a silent overwrite), idempotent publish, author stamped
  from the credential, one `runs` row per mutation. The review loop
  closes: threads on an exact version, one-level replies, resolve/reopen,
  and a review bundle that is one claimable `review` task on the shared
  list — `addressed` is inferred from thread states, nothing writes it.
  The autonomy boundary ships as code: an agent dispatches to another
  agent only when both are members of the artifact's project, otherwise
  the dispatch becomes a `proposals` row for the user; a thread of
  consecutive agent-only replies is capped (10) and demotes to the user
  with its transcript. Untrusted HTML never renders on the console
  origin: the PWA shows it in an opaque-origin `sandbox=""` iframe with a
  CSP (decision #14, locked by test), and the raw-file route serves only
  images/PDF natively under `no-store`. 53 new tests across package,
  mcp-brain, and console.
- 2026-09-07 — Proxy/routing-layer research (Quotio, CLIProxyAPI,
  LiteLLM; the note was withdrawn before the repo went public): "support any
  agent" is already true through the one MCP door — no adapters, ever;
  the product-facing addition is `metistry connect <client>`. Provider
  gateways stay declarative config that can pool accounts but never pick
  a tier (invariant 4). Third-party proxies that re-present subscription
  OAuth sessions are explicitly not adopted — a user-protection stance
  worth stating in launch material. A budgeted gateway is the hosted
  tier's metering layer.
- 2026-09-07 — **`metistry up` and `metistry update` are real** (plan
  §4.16 "code flows downward as releases"; `docs/ops/cli.md`). One command
  takes a checkout + `.env` to running (compose, every launchd job rendered
  and bootstrapped from the shipped templates, doctor as the verdict) and
  one moves it forward (fast-forward pull, build, migrations under a
  Postgres advisory lock shared with the zero-dependency `migrate.sh` —
  two racing runners proven by test to apply once — restart only the host
  jobs whose built code changed, pin `metistry.lock` in the instance repo
  *through the reconciler as `user`* because it is the sole committer).
  Safety, enforced at the tool: no shell anywhere (argument arrays only),
  `--dry-run` is the same code path with execution off, a failing step
  stops everything after it, and the lock is never written behind a
  running reconciler. The maintenance story is now a runbook section, not
  a memory. 55 new CLI tests.
- 2026-09-07 — **§4.21 controls shipped — agent-to-agent review needs no
  human in the loop, and the user keeps one switch** (`0011_projects.sql`,
  `packages/artifacts` policy + service, console routes + panel,
  `docs/ops/projects.md`). A project is now a row with the user's three
  decisions on it, created lazily the first time its slug is used. The
  kill switch is one toggle: `mode: review` routes every agent-to-agent
  bundle to the proposal queue without touching membership. Per-agent
  (3) and per-project (20) open-bundle caps make the overnight
  task-explosion failure impossible by construction — over cap a bundle
  is queued as a blocked task, never dropped, and released when one is
  addressed. A daily soft budget over `runs.cost_usd` flips the project
  to review exactly once per transition, with one deduped alert and a
  `runs` row the morning brief and weekly review read. Manifest narrowing
  (`may_dispatch_to` / `accept_from`) can only restrict below "project
  members". Markdown artifacts render through a hand-rolled renderer
  that escapes first and whitelists (only `https://` and `#/` anchors),
  locked by a hostile-input test. Every control is enforced in the
  dispatch tool, with its reason on the row.
- 2026-09-07 — **Crews: manifest-defined sub-agents with their own
  toolsets, dispatched locally** (plan §4.11, §4.18.B `transport: local`,
  Phase 5 "crew definitions with their own toolsets"). A crew is one file
  in the instance repo — `agents/<area>/<name>.md`, frontmatter validated
  by core's `agent` schema, body = its operating prompt — naming a model,
  tool GROUPS, a read scope, projects, a turn cap and a per-run budget.
  Safety, enforced at the tool, not by prompting: (1) the schema has no
  group that contains `knowledge_write` or `agents_delegate`, so no manifest
  can grant a sub-agent the writer's or the dispatcher's tools (sub-agents
  never write knowledge — one writer holds); (2) **briefs are policy-checked
  before anything leaves the assistant** — `agents_delegate` reuses the
  existing dispatch enforcement against the crew's `scope` ∩ the local
  target's `allow` list, refuses with the violations named, and writes no
  work row on a refusal; (3) **crews get scoped, per-run credentials** —
  the registry row's grant is the manifest's scope through the external
  validator, and the runner mints a bearer for each run and burns it after,
  so no crew credential exists between runs (a second run gets a new one;
  the first no longer authenticates — locked by test). Dispatch is durable
  (a `work` row the assistant container drains, restart-safe with leases
  and a retry cap); results return only through the crew's own `report` /
  `tasks_*` calls plus a `crew_run` row on the crew's id with cost, tokens
  and tools used — the dashboard's runs-by-component view is where a crew
  is watched. `seed/agents/example/researcher.md` ships as the template;
  `docs/ops/crews.md` is the operator's page. No migration. 36 new tests
  across core, console and the assistant.
- 2026-09-07 — CodeGraff reviewed (`docs/research/2026-09-codegraff-review.md`)
  for the single-pane-of-glass overlap. Desktop decision: the premium
  native client becomes **one SwiftUI app for macOS + iOS**; the
  installed PWA is the desktop client everywhere else, today. Lifted:
  an activity feed as the home page, explicit agent state chips backed
  by lease liveness and delivery-evidence tiers, collapsed tool activity
  under every reply, drag-to-dispatch with the autonomy boundary shown
  as the reason for a refusal. Not lifted: a second engine, Electron, or
  a coding workbench. Plan in `docs/product/desktop-app-plan.md`.
- 2026-09-07 — Distribution direction: the premium app is the installer.
  Bundled runtime, `metistry init` on a chosen folder, GitHub repo
  connected by device-flow OAuth with the token in the Keychain,
  secrets minted into the Keychain, services registered via
  SMAppService, passkey enrolled in-app, updates from signed releases
  through `metistry update`. The app fronts the CLI; it never
  re-implements it. Opened decision #15: a Docker-free macOS shape.
- 2026-09-07 — **Strategy: fully open source, everything free.** The
  premium iOS app and the FSL-hosted plan are dropped. The Mac app
  (one SwiftUI codebase with iOS) is the primary distribution channel:
  it installs, configures, connects, and updates the system, ships
  through GitHub Releases as a signed, notarized DMG, and auto-updates
  from a release-backed appcast — no FSL server anywhere. Decision #15
  (Docker-free macOS shape) ratified. The payload-free push relay
  becomes a small free community service with self-host support.
  Rationale: the AI tooling landscape moves too fast for a paywall to
  be the moat; openness is.
- 2026-09-07 — Release signing runbook (`docs/ops/apple-signing.md`):
  Developer ID Application cert, TCC re-grant after a helper's signing
  identity changes, notarization credential setup, and Sparkle EdDSA
  key generation — the prerequisites the signed/notarized DMG and
  auto-update pipeline (`docs/product/desktop-app-plan.md`) build on.
- 2026-09-07 — Desktop window, step 1 shipped: the `activity_feed` and
  `agent_presence` seed queries, and the PWA's new `feed` tab as the
  home page (kind icon, actor, subject, relative time, agent/project
  filters, 10s auto-refresh) plus presence chips (working / queued /
  interrupted / over-cap / idle, last seen, today's spend) on the
  agents tab. No migration — both queries read `runs`, `proposals`,
  `work`, and `outbound_messages` as they stand. The desktop app's data,
  landed in the web client first, per `docs/product/desktop-app-plan.md`
  "Sequencing" step 1.
- 2026-09-07 — **The release pipeline is real, so "no FSL server" is now
  a shipped property rather than a plan.** A `v*` tag builds versioned
  artifacts on GitHub Releases: a runtime pack per os-arch (the built
  product, production dependencies included, runnable with no checkout,
  no `pnpm install` and no compile step — the thing the Mac app will
  bundle as a resource), npm packages with provenance, ghcr container
  images, and `checksums.txt`. `metistry update` consumes exactly those:
  it verifies the sha256 before unpacking, keeps the previous release,
  and `--rollback` is a symlink flip. One version numbers the whole
  product (changesets in fixed mode), so `metistry.lock` names one
  coordinate. Safety line for the record: a tampered or truncated
  download aborts the update with both digests and leaves the running
  release, the containers and the lock untouched — the update cannot
  half-apply. The DMG and the Sparkle appcast are disabled stubs with
  their secrets documented; the appcast generator refuses to emit an
  unsigned feed. Runbook: `docs/ops/releases.md`.
- 2026-09-07 — Safety mechanism shipped: **the engine runs sandboxed on
  the host.** Decision #15's Docker-free shape is built
  (`deployment.yaml`: `compose | launchd`), and with it the mitigation
  it owed. Under the launchd shape the assistant is not a container, so
  a `sandbox-exec` profile takes that role — deny by default; read its
  own code and runtime, write only its own state directory, exec only
  node (no shell), reach only the console on loopback and TLS. Misuse
  tests launch a real process under the real profile and prove the four
  denials rather than asserting them in prose. The one-click Mac
  install now costs the user nothing in isolation compared with Docker,
  which is what makes "no Docker Desktop" an honest claim rather than a
  trade. `docs/ops/deployment-shapes.md`.
- 2026-09-07 — Two review-follow-up fixes: **PR status now distinguishes
  merged from closed-without-merge** — `github-state` fetches the
  single-PR endpoint only for rows it is actually closing, so the weekly
  review's Projects section says "N merged" and "N closed" instead of
  lumping abandoned PRs in with shipped ones — and **crew `autonomy:` is a
  validated part of the manifest contract**, not an accepted-then-dropped
  field: the schema is strict for the agent type (an unknown key, in
  `autonomy` or at the top level, is refused with a reason) and the
  registry sync maps a valid block onto `agents.autonomy` through the same
  normalizer the hand-set `PUT /api/agents/:id/autonomy` route uses.
- 2026-09-07 — Safety mechanism shipped: **secrets live in the Keychain
  and are never printed.** The two install verbs the Mac app will drive
  are built and terminal-first: `metistry connect-repo` points the
  instance repo at a private remote and leaves a credential the
  reconciler can push with unattended (login Keychain + the
  `osxkeychain` helper, obtained by GitHub's device-authorization flow,
  a PAT on stdin, or an ssh key), and `metistry secrets` makes the
  Keychain the canonical store (`metistry:<VAR>`) with `.env` generated
  from it. No secret ever reaches argv, a log line, a remote URL or
  `.git/config` — the tests assert that negatively, scanning every line
  of output and every subprocess argument for the token, and `secrets
  list` has no code path that can read a value. `docs/ops/cli.md`.

- 2026-09-07 — Benefit proven with numbers: **the vault answers questions
  you can only phrase in your own words.** Phase 6's embeddings ship —
  the reconciler embeds notes as it reconciles (local Ollama, nothing
  leaves the machine), and search gained `keyword | semantic | hybrid`
  with hybrid the default once vectors exist. Measured on the real model
  and real pgvector: a query whose words appear nowhere in the note —
  "how much should I ease off running in the final weeks so my legs are
  fresh" — returns the taper note at 0.724 against the next note's 0.440
  in 14 ms, where keyword returns nothing at all. Two properties make it
  safe to depend on: with the embedder down every search still answers
  (in keyword, saying so) and every note is still indexed and committed,
  and the model choice stays reversible — model and dimension travel on
  every row and a rebuild reproduces byte-identical chunks, so changing
  models is 45 seconds, not a data migration. For agents the mode changes
  the ranking and never the grant: the area filter lives inside the vector
  query, so the closest chunk in the vault stays invisible to an agent
  whose grant does not cover it. `docs/ops/knowledge-search.md`.
- 2026-09-08 — AgentSwarms reviewed (`docs/research/2026-09-agentswarms-review.md`).
  Convergence worth quoting at launch: a data-platform team and a
  personal-assistant team both landed on "governance in the tool,
  answers with receipts, data you own". Taking: a hash-chained action
  record (D6 addendum), a turn id that joins a reply to the tool calls
  it made, and named queries exposed to the assistant as checkable
  answers. Leaving: the lakehouse, BI, ML, graph canvas, and the Elastic
  License.

- 2026-09-08 — **Any agent can now ask the same questions the dashboard
  answers.** `queries_list`/`queries_run` put invariant 3's one read path
  — named, parameterized queries, never free-form SQL — on the mcp-brain
  surface: an agent lists what's available (name, description, param
  types/defaults) and runs one, capped at 200 rows. The instance's own
  assistant always has it; an external agent needs an explicit `queries:
  true` grant, a separate axis from the knowledge tier. Every mcp-brain
  tool also now takes an optional `turn_id`, so one reply's tool calls
  group together in the `activity_feed` — the first step toward a
  per-reply audit trail a user can actually read. `packages/mcp-brain/README.md`.

- 2026-09-08 — Safety mechanism shipped, and a goal sharpened: **the system
  learns from a thumbs-down without ever teaching itself.** A 👍/👎 sits
  under every reply; daily, whenever there is new 👎 since its last pass, a
  model-free routine turns the 👎 —
  with the prompt, the reply, the user's note and that turn's tool calls —
  into **one** proposal carrying a *suggested* edit to the assistant's own
  prompt. It is never applied: the user allows it in triage, and only then
  does the console write the overlay through the vault as principal `user`,
  as a reviewable commit in the user's name, picked up on the next restart.
  The prompt overlay is a protected path, so the assistant cannot reach it
  even through a bug elsewhere. The same PR made the second half true:
  **one list, "Needs You"** — knowledge, agent reports, elevation grants,
  improvements, and now the assistant's own blocking questions (a reply
  ending in a `decision` block becomes a queue item, answerable in chat,
  from triage, or from a notification) are all rows in one table with one
  triage endpoint, one push path, one brief section. The answer to "can
  every decision I owe the system live in one place" is yes, and the
  interface says so. `docs/ops/reply-feedback.md`.

- 2026-09-08 — Goal sharpened: **one design language across the PWA, Mac
  and iPhone, written down before the native app exists.**
  `docs/product/design-system.md` turns the UX direction into something
  buildable: ten principles each tied to a rule the system already has
  (agent text is data ⇒ never styled as UI chrome; silence-default ⇒
  calm surfaces; enforce-at-the-tool ⇒ every destructive action confirms
  with the reason shown), 27 semantic colour roles in light and dark
  whose 58 declared text pairs are checked against WCAG AA by a
  generator rather than by eye, a type scale mapped one-to-one onto
  Apple's Dynamic Type styles with no webfont anywhere, and 17
  components specified with anatomy, states and both renderings
  (SwiftUI/HIG and PWA element). `docs/product/design/tokens.json` is
  the single source; `tokens.css` and the inlined tokens in
  `preview.html` are generated from it, so the palette cannot drift
  between the spec, the page and the app. The product bet it protects:
  the SwiftUI app copies a settled interaction instead of inventing one,
  which is what makes the Mac app a distribution channel rather than a
  second product.

- 2026-09-08 — Goal sharpened, from owner review of the design system:
  **the chat is modelled on iMessage on purpose, and the transcript never
  moves under the reader.** Three principles were added rather than left
  implicit. P8 names the reference (bubbles aligned to their sender,
  timestamps on demand, one `+` for every action, tapbacks as the feedback
  affordance) so the native app inherits an interaction people already
  know instead of one we invented. P9 makes scroll stability a rule: a
  poll is a repaint, not a navigation — an arriving reply raises a
  "↓ New Reply" pill instead of dragging the viewport away from the
  paragraph the owner was re-reading while typing. P10 fixes
  capitalization (Title Case names things, sentence case says things,
  identifiers stay as-is) so a reader can tell at a glance which strings
  on a row are machine keys and which are human labels. Component §3.6
  became the **composer actions menu** — a collapsed `+` on every
  platform, with ⌘K as the Mac and wide-web equivalent — because on a
  phone a pinned command strip costs two or three lines of transcript at
  exactly the moment the reader needs them.

- 2026-09-08 — Benefit shipped: **the console now looks like a product,
  and two of its tabs work again.** The PWA is restyled onto the design
  system's tokens — one media query turns the same `<nav>` into a bottom
  tab bar on a phone and a sidebar on a desktop, so the installed app is
  a real desktop client on Windows and Linux and not a narrow column;
  light appearance works for the first time (it was dark-only); buttons
  have roles (primary / quiet / outlined-destructive) instead of one
  accent fill on everything; focus is visible, touch targets are 44pt,
  and reduced motion is honoured. The restyle also surfaced a markup bug
  worth recording: `<section id="agents">` was never closed, so the
  dashboard and artifacts tabs parsed as its children and rendered blank
  whenever they were selected. One tag, two tabs back, and a test that
  now counts section opens against closes so it cannot recur.

- 2026-09-08 — Benefit shipped, from the same review: **the console's chat
  stops fighting the reader.** `loadMessages` used to force
  `scrollTop = scrollHeight` on every 2.5s poll, so re-reading an earlier
  answer while typing the reply was impossible — the next tick threw you
  back to the end. It now measures whether the reader is at the bottom,
  restores `scrollTop` across the re-render when they are not, and raises
  a "↓ New Reply" pill instead; focus moves with `preventScroll`. The
  commands that were pinned above the keyboard collapse into one `+`
  button — a native `<details>`, so it works before JavaScript and `Esc`
  closes it — holding Quick Actions, the slash commands, the agents read
  live from the registry, and attach. Two tests hold both: the pill and
  the collapsed menu must ship in the served markup, and the nav labels
  and section headers must be Title Case.

- 2026-09-08 — **The composer completes as you type, and the menu is
  clickable** (owner review of the design system). Typing `@d` suggests
  `@drey`, typing `/` lists the commands and narrows them keystroke by
  keystroke — and every row of the actions menu, quick actions and agent
  tags included, *inserts itself at the caret* rather than being typed.
  Two properties make it a product claim rather than a nicety. It is
  **generated, never hand-maintained**: agents come from the instance's
  registry and commands from its own `rules.yaml`, so an instance that
  adds a tier or an agent gets it in the composer with no front-end
  change, and a command the instance has not configured is listed
  *disabled with the reason* rather than hidden. And the ranking is
  **deterministic** — prefix, then substring, then recency — the same
  discipline invariant 4 applies to the router, so the same keystrokes
  give the same list every time on every surface. A tapped command and a
  typed one produce the identical string, which is what keeps the
  power-user layer and the discoverable layer from drifting apart.
  ⌘K stays as the rich version wherever there is a desktop keyboard.
  (Known gap, flagged in code and in `ux-direction.md`: there is no
  `rules.yaml` commands endpoint yet, so the PWA ships a short static
  list marked for deletion.)
- 2026-09-08 — **Reply text is optimised for density on a phone**
  (design-system §4). The assistant's reply is the longest text in the
  product and the thing most often read on the smallest screen, so it
  gets its own token group (`--mt-reply-*`) rather than the control type
  scale: 15pt on a phone and 16pt on a Mac instead of 17, line height
  1.45 instead of 1.5, and a 12px paragraph margin instead of a blank
  line. That is roughly a third more of the reply on screen at once,
  which is the difference between reading an answer and scrolling
  through one — and it is why the previous turn is still visible while
  you read the current one. Nothing was traded for it: 15pt is Apple's
  `.subheadline`, still a Dynamic Type style, so the whole thing still
  scales with the user's accessibility setting, and the four grounds a
  reply can sit on (`surface`, `accent-quiet`, `agent-quiet`, `sunken`)
  are now contrast-checked rather than assumed — worst case 12.79:1 for
  body text, 6.36:1 for metadata. The contrast table went from 58 pairs
  to 74, all passing.
- 2026-09-08 — **Feed titles are Title Cased at render, and only ours
  are.** P10 says a card title takes Title Case; P1 says agent text is
  data and data is not case-corrected. The two are reconciled by a
  closed allow-list of `activity_feed` kinds whose subject the console
  itself composes — never in the database, never for a kind whose
  subject can carry agent-authored text, never for identifiers inside
  one. The general principle is the reusable part: *"is this string
  ours?" cannot be answered by looking at the string, only by looking at
  where it came from* — so the safe default is to leave text alone.
- 2026-09-08 — **The console composer now completes as you type, and the
  reply is dense enough to read on a phone.** The design-system decisions
  above, shipped in the PWA rather than described. Typing `@d` opens a
  ranked list of the instance's own agents (live from `/api/agents`);
  typing `/` filters the commands. Every row of the actions menu inserts
  itself **at the caret** — a half-written reply survives the tap, and a
  tapped command produces the same string a typed one does. Nothing in
  either surface sends. The reply body moved onto the `--mt-reply-*`
  tokens, and a blank line in a reply is now a 12px margin instead of an
  empty line box — a ~200-word answer that needed a scroll on an iPhone
  now fits on one screen with the previous turn still visible. Feed
  subjects are Title Cased at render for the eleven `activity_feed` kinds
  the console composes, and left exactly as stored for `turn`, `tool` and
  `dispatch`, whose subjects can carry agent-authored text. Two guards
  ship with it: the paragraph splitter has a misuse test (hostile input
  in, only its own `<p>` out), and the token generator now writes *both*
  copies of `tokens.css` — the docs one and the console's — so the PWA
  cannot silently drift from the source of truth.
- 2026-09-09 — Stash reviewed (`docs/research/2026-09-stash-review.md`).
  Taking its memory curator's three rules for our evening fold (read only
  what is new, write only in reserved paths, never read your own
  output), session summaries as an opt-in capture source, filesystem
  semantics for agents over the vault, webhook ingress for collectors,
  and a candidate list of work-instance sources. Leaving full-transcript
  recording by default and chat over Slack/Telegram.
- 2026-09-09 — **The vault now writes itself in the evening, under three
  rules that are enforced rather than promised.** `routines/knowledge-fold`
  reads only what is new since its last successful fold (accepted
  proposals, closed work, published artifacts, captured sessions), turns it
  into one ≤4 KB brief of handles, and enqueues exactly **one** assistant
  turn on thread `fold`; the assistant — the one writer — composes
  `Knowledge/Journal/<date>.md` and the entity pages it owns. The routine
  calls no model (invariant 4) and never opens the vault, so it cannot read
  its own output; the ownership rule is a refusal in `knowledge_write`
  (`forbidden: owned by user; propose instead`) rather than a line in a
  prompt, so a note the user owns can only ever change through a proposal.
  This is the step that turns captures into a vault: everything before it
  produced rows, and this produces linked pages the user can read in
  Obsidian. The morning brief says what happened overnight in one line
  ("folded 6 item(s) into the vault last night (3 note(s) written)").

- 2026-09-09 — **Coding sessions are now a capture source: opt-in,
  summarised, never full transcripts.** `metistry import-sessions`
  back-fills this machine's Claude Code sessions and the plugin's
  `SessionEnd` hook posts the same shape live: a deterministic summary —
  turns, duration, files touched, tools with counts, models, first prompt
  and last response, both clipped — as `kind: session`, classified by
  `inbox-drain` and listed in Needs You for the coming `knowledge-fold`
  to give prose. No model touches it, nothing runs unless the owner runs
  it, and the transcript itself never leaves the machine. Two dedupe
  layers ship with it (a local ledger keyed by session + mtime, and an
  `idempotency_key` in the frontmatter that both doors compute alike), so
  a re-run is a no-op rather than a duplicated inbox.
- 2026-09-09 — **Agents can now navigate the vault like a filesystem, not
  just search its index.** `knowledge_list` (breadth-limited directory
  listing) and `knowledge_grep` (regex over settled note content, with a
  keyword pre-filter and a worker-thread timeout guard against
  catastrophic patterns) join `knowledge_search`/`knowledge_read` on the
  same grant tiers, and every settled note is also reachable as an MCP
  resource (`metistry://Knowledge/<path>`) for clients that browse
  resources instead of calling tools. The two new tools push
  `tools/list`'s definition size from ~4.9k to ~5.3k tokens — just over
  the >5k line docs/research/2026-08-tool-discovery.md set for switching
  to lazy discovery; flagged, not acted on, in the PR (measured by a new
  test rather than assumed).

- 2026-09-09 — **One vocabulary, end to end.** Eight nouns (knowledge/page ·
  capture · request · task · artifact · project · agent · activity) and one
  verb set per object, now identical on the screen, in the notification, in
  the brief and in the tool an agent calls: Needs You lists **requests** of
  six types answered **Approve / Revise / Decline**, a project is **Auto** or
  **Supervised**, an agent is **assistant / helper / external** with access
  **none / titles / folders**, and the brain's tools read `requests_create`,
  `tasks_list {filter}`, `tasks_renew`, `artifacts_*`, `agents_delegate`.
  `docs/product/glossary.md` is the one page a new user reads. Two things
  make it cheap rather than disruptive: no stored value changed (the same
  rows, decisions and modes, read in one voice), and the eleven old tool
  names keep working for one release, resolved at call time so the discovered
  surface did not double: 22 tools, 17,611 chars ≈ **4.4k definition tokens**,
  measured by test. Folding `tasks_list_ready` and `tasks_mine` into one
  `filter` axis paid for `knowledge_list`/`knowledge_grep`, and the shorter
  names and descriptions took the definition budget back under the >5k-token
  line those two tools had crossed — the axis that actually gates lazy
  discovery.
- 2026-09-09 — Bundled runtime ratified: the Mac app ships Node,
  Postgres 17 + pgvector, git, the Claude Code CLI and the signed helpers
  inside the bundle; Ollama and Tailscale are optional; no Docker,
  Homebrew, or build tools ever. Install = download, open, sign in,
  name the assistant, approve two permissions.
- 2026-09-09 — **The runtime ships with the product: a clean Mac needs no
  Homebrew, no Docker, no Xcode.** `ops/release/build-runtime-deps.sh`
  builds `runtime/` — Node 22.23.2, a relocatable Postgres 17.11 +
  pgvector 0.8.6 compiled from source, and a minimal git 2.54.0 — as its
  own release asset (177 MB; 46 s for Postgres and 9 s for git on an M-series
  Mac, and both are cached in CI on the one file that pins every version and
  source sha256). Relocatability is proved, not asserted: the build copies
  the tree somewhere else and runs `initdb`, `pg_ctl start`, `CREATE
  EXTENSION vector`, `pg_dump` and a `git commit` from the copy before it
  will pack it, and the test suite repeats that through the same code
  `metistry up` uses. `metistry up` on the launchd shape and `metistry
  update --channel release` fetch and sha256-verify it through the same path
  as the product pack, so the last two things a first-run user had to
  install themselves are now downloads.
- 2026-09-09 — Cost discipline from Anthropic's own guidance
  (`docs/research/2026-09-cost-optimization.md`): byte-stable prompts
  for caching, (model, effort) tiers, fresh sessions at task boundaries,
  Batch routing for deferred turns on API billing, a prompt lint, and
  cache hit rate on the dashboard. For subscription users this is
  headroom; for API users it is the bill — the same design serves both.
- 2026-09-09 — TCC grants now survive rebuilds: the Swift helpers ship as
  minimal signed app bundles (TCC keys bundled code by bundle identifier
  and designated requirement, not by code hash) with the hardened-runtime
  entitlement Calendars access silently requires. Proven on the Studio:
  one approval, then two unattended rebuild-and-restart cycles kept full
  access. The last manual permission step is now a one-time step.
- 2026-09-09 — Cost-optimisation instrumentation shipped (the "measure
  first" half of docs/research/2026-09-cost-optimization.md): every turn's
  `runs` row now carries cache read/write tokens from the SDK's usage,
  `claude_usage_daily` reports `cache_hit_rate` per model-day, and it shows
  on the dashboard's spend panel and the weekly review's Spend line. A new
  `ops/scripts/prompt-lint.mjs`, in CI alongside `check-path-case.sh`, makes
  "nothing volatile in the system prompt" and "no known prompt anti-patterns"
  enforced rather than just written down — the seed prompt already passed
  clean.
- 2026-09-09 — **Tiers became (model, effort) pairs, and sessions now end at
  task boundaries.** Following Anthropic's cost guidance
  (`docs/research/2026-09-cost-optimization.md`, decisions 2 and 3), a tier in
  `rules.yaml` names both halves of the choice — the shipped menu is
  `fast` haiku/low, `default` haiku/medium, `deep` opus/high, `routine`
  haiku/low — and crews declare their own `effort`, defaulting to **low**
  because the crew shape that pays is "read a lot on a cheap model, report one
  page". Effort changes only at turn boundaries *by construction* (one SDK
  query per turn, options built once and never mutated), which is what keeps
  the cached prompt prefix intact: a break costs up to 50x the cache-read
  price per token. Sessions now roll on an event rather than a cadence — a
  blocking decision answered, or a task the assistant held closing — logged as
  a `session_roll` run with the turn count the session reached, and fold turns
  and crew runs never resume one at all. The user-visible promise: **the same
  answers for less of your usage allowance, and you can see per turn which
  tier paid for it.**
- 2026-09-09 — **The Mac app exists, and it is the installer.** `apps/macos`
  is a SwiftUI app (SwiftPM, no Xcode project) built into a Developer ID
  signed, notarized, stapled DMG by the release workflow, with an
  EdDSA-signed Sparkle appcast published beside it — the distribution
  channel ratified 2026-09-07, with no FSL-run server anywhere in the path.
  The scaffold ships the two things that make it worth downloading: a
  **Status** panel that is `metistry doctor` at a glance plus a menu-bar
  glyph showing the worst fault, and a **first-run flow** that walks the
  plan's install steps — locate the runtime, `init`, connect a GitHub repo
  by device flow, sync secrets to the Keychain, bring the services up —
  each one a real `metistry` verb with its exact argument array shown
  before it runs and its own output streamed. The design rule that makes
  this safe is enforced by the code's shape, not by a comment: the app
  opens no database connection and runs no git, so the terminal path and
  the app are one tested path (invariant 3, plan §4.20). The user-visible
  promise: **download, open, and never touch a terminal — and see exactly
  what was done to your machine while it happens.** Steps 6 and 7 (passkey,
  Claude token) are on screen as "not yet" with what they are waiting on,
  because a screen that pretends to enrol a passkey is worse than one that
  says it cannot.
- 2026-09-09 — **An instance directory is self-contained.** Everything about
  one install now lives in its own directory: the vault and config as before,
  plus the derived `.env` at `<instance>/state/.env` (it used to sit in the
  product checkout, which quietly tied one checkout to one install), the
  Postgres data and the assistant's transcripts already under `state/`, and a
  minted `instance_id` in `identity.yaml`. The login Keychain follows the same
  line: one table in code decides whether a secret belongs to the **instance**
  (filed under its `instance_id` — the database password, every bridge token,
  the push keys, the repo PATs) or to the **person** (the Claude login, your
  own AWS keys, shared by every instance on the Mac), and `metistry secrets
  purge --instance <dir>` removes exactly one instance's items with a preview
  first. Migration is one command and destroys nothing: `secrets sync --to env`
  carries the old file over and copies — never moves — Keychain items into
  their new account. The user-visible promise: **the Mac app can hold several
  instances on one machine — a real one and two test ones — and deleting a
  test instance's folder leaves nothing of it behind.** One at a time still,
  because launchd labels and ports are fixed; running them concurrently is a
  recorded follow-up.
- 2026-09-09 — **The app configures itself where a Mac user looks, and the
  menu bar can fix things.** Three additions to `apps/macos`, all of them the
  same rule made visible: **every setting is a front for a file the CLI owns,
  never app-private state.** *Settings* is the `Settings` scene (⌘, and the app
  menu) with six panes — Instance, Services, Connections, Secrets, Updates,
  Advanced — and the app persists exactly three pointers behind them (which
  install it is looking at, the recents, and a developer runtime override),
  which a unit test enforces over the whole preferences domain rather than by
  convention. The assistant's name is read from `identity.yaml` and shown with
  no field to edit it, because that is a protected path; secrets are listed by
  name and scope through `metistry secrets list`, which has no code path that
  can print a value. The old product-directory preference is *removed*: a
  downloaded app's product is the runtime inside its own bundle, so there is
  nothing to ask. A *first-launch wizard* replaces the tab group with one step
  at a time and, for every choice, both sides of it — a new instance or a
  folder you already have, a repository now or later, device flow or SSH,
  Docker or launchd, which bridges to turn on — with "you can change all of
  this later in Settings" on screen throughout, and a test that fails if a
  choice is ever offered without its cost stated. The *menu bar* stops being a
  list and becomes a control panel: components grouped the way doctor groups
  them, each with a status dot and Restart · Stop · Start · View Log, plus
  Restart All, Stop All and an update offer when there is one. The
  user-visible promise: **when something is wrong you can see it and restart it
  from the menu bar, and everything you can configure is one place you already
  know how to find.** What the app still cannot do it says on screen, and each
  one now names the CLI change it is waiting on rather than being a shrug.
- 2026-09-10 — **The Mac app's first run is finished, and the one thing it
  still cannot do is a distribution problem, not a bug.** All seven steps act:
  step 1 copies the bundle's read-only runtime into a writable product
  directory (`metistry runtime install`), which settles the open question about
  where a bundled install's `metistry update` writes — the bundle is a seed,
  `~/Library/Application Support/Metistry/product` is the install; step 5
  previews a deployment shape and then *sets* it (`metistry deployment
  set-shape --yes`), with the confirm button dark until the preview has been on
  screen; step 7 opens `claude setup-token` in a real terminal — it is
  interactive and the app gives every child an empty stdin on purpose — and
  then watches `metistry secrets list --json` for the token's *name* to become
  set, so the app never handles the value. Settings gains a working **Start at
  login** (`SMAppService.mainApp`: one call, one approval, no plist), and every
  value it shows is now a verb rather than a file — `identity --json`,
  `version --json`, `secrets list --json` replace a hand-rolled YAML reader, a
  `metistry.lock` reader, a `package.json` read and a parser of `secrets
  list`'s table that had already gone stale. The Instance pane can finally show
  the **instance id** it previously had to report did not exist.
  **Step 6, measured rather than assumed.** A native passkey enrolment
  (`ASAuthorization`) was tested against `127.0.0.1`, `localhost` and a tailnet
  name from a Developer ID build signed with this project's own identity. All
  three give the same answer — `AuthorizationError 1004: the calling process
  does not have an application identifier` — and hand-signing the entitlement
  in gets the process killed at launch. So native passkeys are blocked by the
  *distribution channel*, not by the local origin: an application identifier
  comes from an embedded provisioning profile, and a Developer ID DMG from
  GitHub Releases has none. The app says so on screen with the system's own
  words, offers an "Ask macOS" button so the claim is checkable rather than
  asserted, and falls back to the console's own enrolment code — open it here
  or type it on the phone. The user-visible promise: **the app tells you what
  it cannot do and why, in the words of whatever refused it, and always leaves
  you a route that works.**


**2026-09-10 — the Mac app can install itself, and a Mac can hold more than
one Metistry.** Two things landed together because proving the first needed
the second. **The Docker-free macOS shape is no longer a design; it ran.**
On a real Mac, from the v0.4.0 release artifacts and nothing else — no
Docker, no Homebrew, no pnpm, no Xcode — a fresh install came up with a
bundled Postgres 17.11 + pgvector under its own state directory, 13
migrations applied, and console, assistant, reconciler and watchdog as
launchd agents running the bundled Node, with `doctor` reporting 23 checks
healthy and the console answering on its own port. The assistant ran under
its sandbox profile the whole time, and a live probe confirmed what the
profile claims: it cannot read the vault, cannot write outside its own
state directory, and cannot reach anything on the network but its own
console and its own database. **The user-visible promise: download the app,
open it, and everything it needs is already inside it — and the largest
first-run hurdle, installing Docker Desktop, is gone.** The decision that
makes updates work was settled at the same time: the app bundle is a *seed*
that is copied once to a writable product directory, so an app install and
a terminal install update through exactly the same tested path rather than
two. Five defects came out of running it that no amount of reading would
have found — including a space in `~/Library/Application Support` silently
killing four background jobs, and an update that would have migrated the
wrong database — all fixed with tests. And because the trial had to run
beside a live install without disturbing it, **several instances can now
run on one Mac at once**, each with its own jobs, ports and logs: the
groundwork for the app holding a real install and a test install side by
side.

**2026-09-10 — the app signs in without a ceremony, and the door proves it.**
The Mac app is the same package as the CLI, on the same machine, running as
the same person; asking it to perform a passkey ceremony against a local
origin was theatre, because anything that could impersonate it could also
read the passkey's own storage. So a **local owner token** now authenticates
the app to a console on this machine as the *same principal* a passkey
session yields — one predicate in the code gates both, so they cannot drift
— and it is refused, with an audit line, from any address that is not this
machine. Remote clients (a browser, the phone) are unchanged: they still
enroll passkeys. The safety mechanism is that the rule is decided from the
TCP socket and nothing else — `X-Forwarded-For` and friends are the caller's
to write and are never read — and the refusal is byte-identical to what an
unknown token gets, so a prober learns nothing from holding the real secret.
Proven live, including the container case a compose install actually has:
the host reaching the published loopback port succeeds, a sibling container
on the same network holding the same token gets 401. **The user-visible
promise: the app shows "signed in as owner" the moment it opens, `metistry
doctor` now reports a real authenticated health read instead of a hopeful
401, and a leaked token still cannot be used from off your Mac.** A passkey
misconfiguration also stopped looking like a broken console: an origin
mismatch answers 401 naming the origin it expected and the one it got,
instead of HTTP 500.

**2026-09-10 — moving a running install to the Docker-free shape is one
verb, rehearsed, and reversible.** The launchd shape was proven end to end
on a scratch instance; what was still missing was the thing an existing
user actually has to do — move an install that is *already running*, with
years of history in it. `metistry migrate-shape launchd` is that move: it
quiesces the writers, dumps the live database through the running
container and **verifies the dump before it stops anything**, stops the
containers without touching the volume, initialises the new Postgres,
restores *before* migrations run (the dump carries the migration record,
so the next update applies none), and then **compares every table's exact
row count and fails by name if a single row did not come across**.
`metistry migrate-shape compose` puts it back — the old volume is
untouched, which is what makes the rollback real rather than theoretical.
Rehearsed on a scratch copy of the Studio's own install with the
production database restored into it, running beside the live one the
whole time and never touching it: exit 0, doctor 23 ok / 0 failed, every
row count identical, `0 applied, 13 total` migrations afterwards, and the
console answering the same named query with the same data. **The
user-visible promise: leaving Docker behind is a single command you can
read the plan of first, that refuses rather than half-finishes, and that
you can undo.** Four refusals fire while the old shape is still running —
including a release too old to carry the assistant's sandbox profile,
which would have produced an install whose engine could not start at all.
Five more defects came out of running it that a green test suite had not:
a verification query the bundled Postgres cannot execute, rows written
into the gap between the dump and the stop, a bridge re-render that sent a
second install looking for the *first* install's port, and a final health
verdict that raced the jobs it had just started — a false failure being
precisely the thing that makes someone roll back a cutover that worked.

**2026-09-10 — the app cashes that in: "Signed in as owner" on screen, and no
token in the app at all.** The Mac app now shows who the console takes this Mac
to be — in the Status header, in Settings → Connections and beside the console
row in the menu bar — and it gets there without ever touching the secret: it
runs `metistry console whoami --json` and renders the answer, because the CLI
is the one place that knows where the token lives. A test walks the app's own
source and asserts it, rather than trusting a comment: one file uses
`URLSession`, no file sets an `Authorization` header, no file names a Keychain
API, and no file opens a file at all. When it *cannot* say "signed in" it says
which of five things is true and, for the two that have one, the exact command
— including telling a 401 apart by deployment shape, so a compose install is
pointed at the Docker-gateway rule and a launchd install at a console that
needs restarting with the token it was given. **The user-visible promise: the
first-run wizard stopped asking your Mac to enrol a passkey.** Step 6 is
optional now and says so — "your Mac is signed in automatically; enrol a
passkey only for browsers and your phone" — with the enrolment code kept intact
for exactly those, and the `ASAuthorization` probe moved to Settings → Advanced
where a diagnostic belongs. One less ceremony in the install, and one less
credential that had no reason to exist.

**2026-09-10 — the project's own Claude Code sessions get a router, and it is
allowed to say "don't."** `.claude/skills/token-efficient-agents` turns
`docs/research/2026-09-cost-optimization.md`'s ruling — tiers are `(model,
effort)` pairs — into something a session actually runs. It classifies the task
(shape, bulk, is there a checker, cost of error), recommends a model and effort
for its *own* seat and waits, because a session cannot change its own model
mid-flight and pretending otherwise is theatre, then routes each subtask to the
cheapest tier that can genuinely do it: four tracked agent definitions
(`scout` on Haiku, `digest` on Sonnet/medium, `implement` on Sonnet/xhigh,
`deep` on Opus/xhigh), with inline model overrides as the fallback outside this
checkout. The routing data is a dated table with a 30-day staleness stamp, so a
new model release or a changed effort range reaches it by refresh rather than by
a code change. **The part that makes it honest:** the measured finding is that
an orchestrator only beats a single model when the work genuinely exceeds one
context window — on one dependent chain the coordinator's model alone at lower
effort wins every time — so the skill's third step is a gate that can conclude
"do it yourself at lower effort," and it is instructed to say so out loud. A
fan-out skill that always fans out is a cost centre, not a router. It also
calls the context boundary — the end of a phase is the cheapest moment to shed
a transcript and the most expensive to keep it — and recommends *which* of
compact, clear, or a fresh session, rather than reaching for compaction by
reflex: where the conclusions fit on a page, writing a handoff file and
clearing beats compacting on fidelity and on tokens both, and a transcript
whose bulk is failed attempts should never be compacted at all, because the
summary carries the failures forward faithfully and at length. The
definitions are prompts like any other, so CI's `prompt-lint` now scans
`.claude/` too, and `ops/scripts/install-claude-assets.sh` symlinks them into
`~/.claude` so every session on the machine gets them, not just this repo's.

**2026-09-10 — one background item, and it is called Metistry.** macOS lists a
"background item" for every launchd agent an app installs, and names it after
the program it runs — so the Mac-native shape was about to introduce itself to
new users as four strangers called "postgres", "node", "node" and "sh", each
with its own alert the first time it appeared. It now installs **one**, named
**Metistry**, which runs the database, the console, the reconciler and the
assistant as its own children; the two macOS permission helpers are named
"Metistry Calendar Access" and "Metistry Apple Intelligence" where the Privacy
pane shows them. **The user-visible promise: everything Metistry installs
carries the Metistry name, and there is one thing to say yes to.** It buys more
than a name — one supervisor means the database is up before the console tries
to use it, a service that keeps dying is *reported as crash-looping* instead of
respawning silently forever, and `metistry restart console` works on a process
launchd cannot even see.
- 2026-09-11 — Research: **one phone, two instances, and backends that
  sleep** (`docs/research/2026-09-11-multi-instance-and-offline-client.md`).
  An instance on the phone is `(origin, instance_id)`; existing per-origin
  passkeys and per-instance owner tokens already cover N instances with no
  server change beyond a public `GET /api/identity`. A closed laptop does
  not wake for the network, so the phone queues — appends only (capture,
  feedback), never claims or decisions — behind an `Idempotency-Key`
  contract on `POST /capture` and `since` cursors on the polled lists.
- 2026-09-11 — **The server side of "the backend is not always there" shipped
  before the phone app exists.** `GET /api/identity` (public: `instance_id`,
  name, icon, version), an `Idempotency-Key` contract on `POST /capture`
  that returns the original row on replay — one inbox row even under a
  race — `409` with the winner for an already-settled decision, and opaque
  `since` cursors on the messages and proposals lists so a reconnect is one
  bounded pull per list (`docs/ops/console-api.md`). Small on purpose: these
  are the only server changes the offline design needs, and the PWA gets
  them today.
- 2026-09-11 — Research: **local models, OpenRouter and OpenCode — and
  the pivot to configurable compute**
  (`docs/research/2026-09-11-local-models-openrouter-opencode.md`).
  Anthropic's Agent SDK docs say third parties may not offer claude.ai
  login for their products unless approved, so a distributed Metistry
  cannot ship the subscription path. Decision: all AI compute — the main
  agent included — is user-configured by provider and model in one
  instance-owned `compute.yaml` (providers, per-tier and per-crew
  assignments, budgets), edited by the CLI and the app through the
  protected-write path and hot-reloaded. Two engines behind one interface:
  Claude Agent SDK on an API key, and an OpenAI-compatible loop over the
  console's own `/mcp` for OpenRouter, OpenCode Zen, LM Studio, Ollama and
  Apple FM (which grows a `/v1` surface). Claude never routes to non-Claude
  models; every provider's agents collaborate through `/mcp`. Cost lands
  on every `runs` row with budgets enforced before the call; non-ZDR
  providers warn, never block. The subscription path leaves the product
  repo entirely; an instance re-adds it privately through a mechanism the
  product never names.
- 2026-09-12 — Research: **Rivet agentOS and the rivet-dev org**
  (`docs/research/2026-09-12-rivet-agentos-review.md`). Their VM is a V8
  isolate plus a Rust syscall broker, not a machine — a fit for untrusted
  code, which Metistry does not run, so it is read rather than depended on
  (0.2.x beta, and a 132 MB third-party binary the Mac app would have to
  notarize). Three of their habits are worth copying and cost nothing:
  warn at 80% of a budget rather than only refusing at 100%, make every
  refusal name the config field that would permit it, and fail CI on any
  limit constant not wired to config. Flagged for the owner: the engine's
  outbound allowlist is documentation, not enforcement — `sandbox-exec`
  filters by port — and App Sandbox may not fix that, which would make a
  loopback CONNECT proxy the real path to hostname-level egress control.
- 2026-09-12 — Research: **Agent Room, and the agent-to-agent conversation we
  already have** (`docs/research/2026-09-12-agent-room-review.md`). Reviewing a
  chat-room-for-agents project found most of it already shipped as rows:
  threaded `artifact_comments` with resolve state, a ping-pong cap that
  escalates an unresolved agent-vs-agent argument to the owner after 10 turns,
  per-agent autonomy narrowing, project budgets and a one-toggle kill switch —
  where theirs enforces turn discipline and role behaviour with a briefing
  string and accepts identity as a tool argument. Skipped as a dependency. The
  one real gap is conversation *before* a deliverable exists, and the safety
  finding worth keeping: a channel between agents is safe exactly when it
  cannot address, because addressing is triggering.
- 2026-09-12 — Research: **Hermes Agent's Kanban board** (Nous Research;
  `docs/research/2026-09-12-hermes-agent-review.md`). Their board is the
  strongest confirmation yet that Metistry's coordination model is right:
  on every axis of their own "Kanban vs `delegate_task`" table — durable
  rows over fork/join, leases, peer claim, human-in-the-loop, per-attempt
  audit — we already chose the side they argue for, and `agents_delegate`
  is that shape. Skipped as a dependency (Python-first; a second source of
  truth for tasks; unauthenticated plugin routes). Adopted as a **view**:
  the pending / assigned / working / blocked / done board the owner asked
  for is derivable from today's `work` table with no migration and no new
  status value, and the cross-project board that Hermes's per-board
  isolation structurally forbids is a `GROUP BY` for us. Proposed as three
  PRs, read-only first.
- 2026-09-12 — Research: **Hermes Agent part 2 — profiles, automation,
  skills, architecture, security**
  (`docs/research/2026-09-12-hermes-agent-review-2.md`). The one area where a
  30-adapter, 70-tool competitor is plainly ahead of us is *scheduled-work
  failure handling*: it preflights a job so "a misconfigured job never spends
  tokens", dedupes repeat failures by error signature, counts a failure
  streak, and ships a `cron doctor` that exits non-zero — where our runner
  records a failed run and surfaces it as one number on a tile. Four cheap
  ADOPTs close it. Everything else — messaging bots, installable skills that
  can widen the credential surface, in-process plugins — is skipped on
  invariant grounds, and its eight-layer shell-safety stack mostly argues for
  the invariant that means we have no shell to protect.
- 2026-09-12 — Research: **Atomic Agent** (MIT, TypeScript;
  `docs/research/2026-09-12-atomic-agent-review.md`). The first prior-art
  project to publish a *controlled* local-model agent benchmark with raw
  artifacts on our own hardware class — GAIA L1 69.8 % vs 58.5 % for Hermes,
  both driving the same 4-bit Qwen MoE on the same `llama-server` on an M4
  Max, deterministically scored. Their throughput claims (+30-50 %, 6.4× KV)
  are unmeasured marketing for a llama.cpp fork, and the head-to-head
  controls that fork *out* — so the gap is harness design, which is free:
  tool names baked into the sampling grammar so a hallucinated tool is
  unsamplable, one inference emitting a batch of tool calls, results
  compressed rather than pasted back, and a no-progress veto. Corrects two
  of our assumptions: the strongest published local-agent result on Apple
  silicon is llama.cpp + Metal, not MLX; and gemma-4 passing PoC-16 as a
  single-shot *scorer* does not transfer to an agent loop (their gemma-4-12b
  scored 45.3 % at twice the wall time). Their eval harness — one capability
  axis per fixture with an axis→fix map, six trace columns separating a wrong
  answer from planner churn, and a judge from a third model family that fails
  rather than passes when unavailable — is the shape of the bake-off the
  local-main-agent path needs at stage 0.
- 2026-09-13 — **Plan refresh** (`docs/plan-refresh-2026-09-13.md`, with dated
  edits to `metistry-build-plan.md` and both product plans). Consolidates a
  week's decisions into one record: all compute — the main agent included —
  configured by the user in `compute.yaml`; one OpenAI-compatible engine with
  Claude reached through OpenRouter, the Agent SDK and the subscription path
  scrubbed from the product; budgets enforced before the call, with a stop that
  also pauses routines; a bundled, signed `llama-server` making local inference
  a no-install default rather than a third app to install; and the phone's
  offline contract (queue appends, never queue answers). It also resolves five
  contradictions the day's reviews raised and leaves seven questions openly
  marked as the owner's. **Next is a PoC, not a PR:** a bake-off on 50
  owner-authored fixtures that picks the seed model *and* the local server on
  measured numbers — pass rate per quality axis, tool-call agreement, tokens/s,
  cost per turn against a Sonnet bar the cost note estimates at ~$29/month — with the rule that Claude
  is the bar and never the training data.
- 2026-09-13 — Research: **SAM, Sovereign Agent Mesh** (Apache-2.0, Go;
  `docs/research/2026-09-13-google-sam-review.md`). A libp2p mesh with an OIDC
  →Biscuit control plane, evaluated as a replacement for tailnet + the console's
  `/mcp`. **SKIP as a dependency**: it buys reachability and network-layer
  identity, both of which one tailnet and a per-request-authenticated `/mcp`
  already supply for one person's two instances, while costing a Go daemon the
  Mac app must sign under the one-background-item rule, an OIDC IdP beside
  passkeys, a control plane to host, a Datalog policy language beside
  `grants`/`data_policy` — and, decisively, *coarser* authorization: "the
  service is the unit of authorization … mesh policy does not filter individual
  MCP tools inside a service." Threshold to revisit is a count of
  administrators, not of agents. Five registry ideas are worth borrowing now —
  capability advertisement on `GET /api/identity`, approve-before-enroll for
  remote agents, `agent@instance_id` identity, an `instances.yaml` peer
  registry, a `runs` export. Separately, SAM's sandbox design contradicts R1's
  premise that a spawned CLI honours `HTTPS_PROXY`.
- 2026-09-15 — Research: **Devin and Cursor as Metistry surfaces**
  (`docs/research/2026-09-15-devin-cursor-integration.md`). Verified that three
  of the four integrations the owner's second instance needs require **no product
  code**: Devin takes custom Streamable-HTTP MCP servers with an
  `Authorization: Bearer` header at *personal* scope, so it can be an external
  agent at the console's `/mcp` with today's `POST /api/agents`; Cursor mounts
  the same `/mcp` from `~/.cursor/mcp.json` and resolves `${env:…}` inside
  `headers`, so the token never touches disk. Cursor also has a `sessionEnd`
  hook and *loads Claude Code's own hooks*, so the plugin pattern ports. The
  two that need code are a collector (Devin Knowledge + DeepWiki → inbox) and
  an `http` dispatcher (`dispatch()` supports only `github` and `local` today).
  Ruled `collectors/devin-knowledge` over a `packages/mcp-deepwiki` bridge on
  repo evidence: the assistant mounts exactly one MCP server
  (`apps/assistant/src/brain.ts`), so a foreign bridge would have no caller.
  Named a new pattern — *the same external system as both compute target and
  authenticated principal*, which closes `github-issues`' open
  `TODO(report-queue)` content-return gap. Nothing here waits on compute PR 1.
  Two risks are the owner's plan, not the design: an enterprise PAT policy is
  **disabled by default**, and on Teams **only an admin** can opt out of
  training on dispatched briefs.
- 2026-09-15 — **A second instance runs with no engine credential.** The assistant
  is the only component that needs a model, so without one `metistry up` leaves
  it out of the supervisor's children (rather than crash-looping), `doctor`
  reports `assistant: absent` and still exits 0, and the watchdog stops paging
  about an undrained queue. Captures, `inbox-drain`, tasks, search, the console
  and the reconciler are the product on day one on a new machine; the evening fold's
  turn waits in the inbox until a credential exists, and one `metistry up` later
  the child is back. Proves the degradation story the plan claims — every
  component absent-degrades — for the one component it had never been true of.
- 2026-09-15 — Research: **Vercel Eve reviewed; six adopts, two of them budget
  mechanisms** (`docs/research/2026-09-15-vercel-eve-review.md`). Eve is not a
  dependency (beta, ~3 releases/day, Nitro + `@workflow/*` beta underneath), but
  it independently reached Metistry's crew isolation model — brief-as-context-
  transfer, no grandchild delegation, delegation is not an approval boundary —
  and it answers two budget questions we had left open: a spend cap refuses
  differently depending on whether a human can be reached (a chat turn is offered
  one more window; a routine or crew fails at once with a named error), and a
  delegated agent gets a *share of the dispatcher's remaining* budget rather than
  its own independent per-run cap, so N helpers can no longer outspend the day.
- 2026-09-15 — **One door per external dev tool: `metistry connect <tool>`.**
  Cursor, Devin and Claude Code each get their own agent row, their own bearer
  and their own revocation, from one generic verb: `connect cursor` merges
  `mcpServers.metistry` into `~/.cursor/mcp.json` (0600, other servers
  preserved) naming the bearer as `${env:…}` so it stays in the login Keychain
  rather than on disk; `connect claude-code` mints the token the plugin docs
  had the owner mint by hand; `connect devin` prints the three fields Devin's
  web form needs, because no API can write them. Idempotent (the agent id is
  the tool name), and a re-run never prints a secret — the console returns a
  bearer only when it mints or rotates one. Grants stay default-deny and no
  flag can grant `knowledge_write`: an external principal cannot reach it at
  the bridge, so "read-only unless granted" is a property, not a setting. The
  benefit is switching cost: adopting or dropping a tool is one command, and
  a second instance's tools are separate rows with separate tokens.
- 2026-09-15 — **A dev session records itself whichever tool it happened in.**
  `plugins/cursor` adds a Cursor `sessionEnd` hook beside the Claude Code
  plugin's: same `kind: "session"` frontmatter, same `idempotency_key` formula,
  so three doors (two hooks and `metistry import-sessions`) dedupe against each
  other and `inbox-drain` needed no change to classify the third. Both plugins
  are held to one 300-line file in `packages/core` by a byte-equality test,
  which is how duplicated logic stays honest in a repo one person maintains.
  The capture-never-drops rule reaches a hook for the first time: with
  `METISTRY_CAPTURE_DIR` set, an unreachable console means the note is written
  to disk, and because the key is a pure function of the session id the later
  retry is an exact no-op rather than a second note. Also a product decision
  worth naming: the note says **what it could not capture**. Cursor's transcript
  format is undocumented, so the file is not read and each note carries a
  `## Not captured` line — a gap the user can see beats a summary that quietly
  reads thinner than the other tool's.
- 2026-09-15 — **Another organisation's knowledge arrives on its own.**
  `collectors/devin-knowledge` pulls Devin (Cognition) Knowledge notes and
  private-repo wiki pages into the inbox as captures with `source: devin`
  provenance, and the evening fold organises them into the vault — replacing
  organising those docs by hand. The benefit is that a second instance stops
  being empty on day one: the context an existing agent already holds about a
  codebase, its process and its culture becomes searchable vault pages without
  anyone copying a page. Two properties make it safe to leave running: every
  capture is idempotent on `(collector:devin-knowledge, <kind>:<id>:<version>)`,
  so a re-run inserts nothing and an edited item lands exactly once more; and a
  `429` is backoff-and-stop rather than a failed run, with the watermark held so
  nothing is skipped. Outbound-only, so it needs no inbound exposure — the shape
  that works on a machine behind no tunnel.
- 2026-09-15 — **The assistant can ask another agent a question, and the answer
  is triaged rather than believed.** `targets/devin-sessions` is the first
  compute target that is not GitHub and the first whose *content* comes home:
  a brief becomes a Devin session, and the session's structured answer
  (`{answer, sources[], confidence, open_questions[]}`, held to a Draft-7
  schema Devin validates before the session may end) lands as a `report`
  proposal in Needs You, which the evening fold files into the vault once the
  owner accepts it. The new `knowledge_research` brief kind is the shape that
  matters — "what does Devin know about X" — because it turns a question the
  assistant cannot answer into a citable vault page instead of a guess. Three
  properties make it safe to point at a third party: the shipped data policy
  allows **no** vault path at all (an instance widens it to its own areas in an
  overlay; a brief citing anything else is refused before a byte leaves, with
  the refusal recorded as a run), the budget is a real per-session ACU ceiling
  written to the runs row at dispatch and reconciled with the spend Devin
  reports, and dispatch is the owner's action only — the collaboration rule
  that a non-Claude agent is never pushed to by name is enforced by there
  being no tool for a model turn to do it with. Devin publishes no completion
  webhook, so the return is a five-minute poll collector, and every terminal
  state that is not an answer blocks the work row and says why.
- 2026-09-15 — **Which model answers, and what it may spend, is one file the
  owner edits.** `compute.yaml` names providers (any OpenAI-compatible
  endpoint: a local server, OpenRouter, anything with a base URL), assigns a
  pinned `<provider>/<model>` to each tier and crew, and records a daily or
  monthly budget per provider and for the instance. The product benefit is
  that compute stops being a build-time decision: the same install can run
  entirely on this machine at zero marginal cost, or reach a frontier model
  for the work that earns it, and moving between them is one command rather
  than a rebuild. Three properties make it safe to hand someone: a refusal
  always names the field that would permit it, so a bad edit is
  self-explaining; an API key is read from stdin into the Keychain and can
  never reach the repo, an argument list or a log; and an invalid file saved
  while the system is running keeps the last good configuration instead of
  falling back to nothing. The controls that spend money — the engine, the
  budget check before each call — are deliberately not in this change: the
  file and its verbs land first so the surface is settled before anything
  bills against it.
- 2026-09-15 — **Automation that admits when it is broken.** Scheduled work
  now has a failure model: a collector that fails five times in a row stops
  being run at all until it succeeds again, a component whose declared
  prerequisites are missing never starts a run (so a misconfigured one costs
  nothing rather than an API call an hour), and one fault raises one **Needs
  You** item a day instead of one an hour — deduped by a signature that
  survives the ids, paths and timings that change between two occurrences of
  the same error. `metistry doctor` gained a `schedules` section that says,
  per component, when it last ran, whether it worked, how many failures are
  open and whether the runner has given up on it. The benefit is the sentence
  that did not exist before: a token that expires on holiday used to show up
  as a slightly lower number on a tile, and now says "this has failed 168
  times — here is the variable that fixes it". Nothing here counts dollars;
  it is the cheap half of not wasting them. `docs/ops/automation.md`.

- 2026-09-16 — **Approve can now *do* the thing, and how much an agent may do
  on its own is a table you raise deliberately rather than a property of the
  code.** The two accepted decisions that widen agent autonomy under enforced
  gates, shipped together because neither is safe alone. **Executable actions**
  (`docs/research/2026-09-16-taskuary-review.md` ADOPT 6): a request may now
  carry `{kind, args}` from a **closed set of four** — dispatch a brief to a
  target, patch a card, comment, capture — and allowing it runs the action
  through the *same service call the owner's own click makes*, as the owner,
  with the asking agent recorded as provenance and the result written onto the
  request. What is absent is the design: no mail, no messages, no git, no
  shell, no credential or grant change. Every kind is a **door onto something
  the console could already do**, with the audit row it already wrote — so the
  new power is a gesture saved, not a reach extended, and a failure leaves the
  request pending with the error rather than half-applied, because one action
  is one service call. **Autonomy levels** (agent-room A3; the narrowing-only
  rule that blocked it was the owner's to overturn and was overturned the same
  day): every agent carries `observe | propose | act_within_scope` plus a
  per-kind table, and the level is a **ceiling** — the effective answer is the
  lower of the two, which is what makes "it only ever acts unprompted at the
  top level" arithmetic rather than a rule a later edit could forget. The
  defaults are the product position: an absent level means *nothing*, so the
  release widens nobody; and `dispatch` stays human at **every** level unless
  you say otherwise, because that is the one kind that leaves the machine.
  Trust is raised by hand, in one of exactly two places, and a raise is never
  silent — it writes its own audit row and puts one alert in the queue that
  needs you. The agent's tool follows the same instinct twice over: it is opt-in
  per crew like the room tools, and an agent you have given no room is not even
  *shown* that it exists — which, as a side effect, kept the shared tool surface
  under the definition-token budget without paying the extra round trip a
  lazy-loading index would have cost.

- 2026-09-16 — **A second instance can be named, described and let in —
  without a mesh.** Evaluating Google's SAM agent mesh produced a SKIP on the
  dependency (a Go daemon per node, an OIDC provider, a public control plane
  and a second policy language, to authorize one person's two instances) and
  five registry ideas small enough to build: `GET /api/identity` now
  advertises coarse tool *groups* so a phone or a peer can name what an
  instance offers before sign-in — never a tool name or a count, with the
  full tool list still behind a token; an agent enrolled `--remote` holds a
  token that authenticates **nothing** until the owner approves it, refused
  indistinguishably from an unknown token, which puts the credential surface
  in the user's hand by construction rather than by policy; agent identity
  gains the portable `agent:<name>@<instance_id>` form at the boundaries it
  crosses; `instances.yaml` makes the peer list a protected file rather than
  a service; and `metistry runs export` streams the audit ledger as redacted
  NDJSON so two instances' timelines merge. The honest headline is the
  proportion: the one thing a mesh would have added that Metistry lacked was
  discovery, and discovery turned out to cost a few endpoints and one YAML
  file.

- 2026-09-16 — **The model the Mac already runs became a provider, and the
  first unattended job to use one cannot spend a cent.** Apple Foundation
  Models now answers `GET /v1/models` and `POST /v1/chat/completions` on the
  `apple-fm` bridge, under the same bearer as every other route: a JSON
  schema supplied at request time is enforced at generation time, usage comes
  from the model's own tokenizer, and a prompt or schema that would overrun
  the 4096-token window is refused with a `400` that names the field instead
  of failing halfway through. Cost 0, and ~23 MB resident against 840 MB for
  a comparable local GGUF server — the weights are already in RAM for the
  operating system. `inbox-drain` moved onto it and, in doing so, made
  "collectors never call a billable model" mechanical: the collector names
  one pinned model in its manifest, CI refuses a billable provider there, and
  the call itself throws rather than degrading quietly into spending.

- 2026-09-16 — **Apple's on-device model can be driven by whatever shape the
  caller asks for, which makes a free provider a real one.** The open question
  was whether Foundation Models only answers in shapes compiled into the
  binary; it does not — `DynamicGenerationSchema` builds a schema per request,
  so Apple Intelligence can serve an ordinary `/v1/chat/completions` with
  `response_format: json_schema` and appear in `compute.yaml` as just another
  provider at cost 0. Measured on a Mac Studio (PoC-19): **60 of 60 requests
  succeeded and 40 of 40 structured responses validated against the schema the
  caller sent**, at 268 ms for plain text, 497 ms for a three-field
  classification and 1.46 s for a nested shape with arrays — competitive with a
  4-billion-parameter local model that costs 842 MB of resident memory, against
  22.7 MB here because the weights are already in the operating system. Two
  limits are now numbers rather than guesses: the schema is charged to a
  4096-token window (~32 tokens per described field, ~40 fields before latency
  decides it for you) and identical runs return identical *values* in
  non-identical key order, so anything downstream parses rather than
  string-matches. Both are checkable before the call, which is where a refusal
  belongs.

- 2026-09-16 — **The board moves work now, and the direct-manipulation UI made
  "enforce at the tool" prove itself.** Dragging a card writes through four new
  console routes (`PATCH /api/tasks/:id`, `claim`, `release`, `renew`) that are
  a thin adapter over the same `TasksService` every agent uses — until now
  `dispatch` was the *only* task route the console had — and the rule the whole
  feature is built on is that **the board offers no drop the service would
  refuse**: the panel draws a target only where a `WHERE` clause in
  `packages/tasks` would succeed, and when the two disagree the statement wins
  and the card snaps back carrying the server's own sentence, never one the UI
  invented. Building it closed the three gaps the Hermes review named, the
  first of which was a real hole: `UpdateInput.status` was
  `Exclude<TaskStatus, 'open'>`, so **a blocked row could not be moved forward
  by anything in the system** — "Needs You" was a state with no exit. `update`
  now has two arms and the *fields* pick which, never a flag a caller passes:
  addressing, renaming and unblocking a card need no lease (nobody holds a card
  that is stuck), while status changes stay claim-gated, and mixing them in one
  call is refused naming both fields so the looser gate can never carry the
  stricter arm's write. The safety property that matters commercially is again
  an absence: a human may address a card to any crew, and **no agent surface
  can address one at all**, because the agents' `tasks_update` schema has no
  `owner` key — collaboration rule 4 holding without a rule to run. Ten
  route-level misuse tests ship with it (agent token → 403, owner token → 403,
  every refusal's sentence asserted), plus one drop mapping per row of the
  table. Cards now open the room hanging on them rather than nothing, which is
  the first place two ideas the board and the threads work landed separately
  compose into one gesture.

- 2026-09-16 — **The board: the state was always durable; what was missing
  was one view onto it.** A read-only Kanban over the task list — Backlog,
  Assigned, In Progress, Needs You, Done, Reported — built with **no
  migration and no fifth status value**, because every column is a `CASE`
  over columns the `work` table already carried. That is the claim worth
  making about the architecture rather than the panel: delegating to agents
  had been producing durable rows for months, and the whole feature is two
  named queries and a page. Two states it makes visible that nothing else
  did: **"assigned but not started"** (a row addressed to an agent nobody has
  claimed — the state a person actually means when they ask "did anything
  pick that up?"), and **Done vs Reported**, so a closed task that produced a
  finding no longer looks identical to one that produced nothing. The
  cross-project board is the differentiator: products that make a board the
  isolation unit — its own queue, its own store, no links across — cannot
  show one at all, while here the project is a column on the shared table and
  the view is a `GROUP BY`. It ships deliberately read-only: every task
  mutation is still a tool call, so the panel has no drag, no drop target and
  no mutating control, and a test asserts that — the rule for when the drags
  do land is that **the board offers no drop the service would refuse**,
  which is enforce-at-the-tool in direct-manipulation form. Holding the
  writes until the read-only view has been lived with is the product
  decision, not an unfinished feature. Worth remembering for how it was
  built: the design note it came from proposed reading "waiting on a human"
  from a pending proposal citing the task, and checking the code showed no
  proposal kind carries a task id at all — so the column was re-grounded in
  the state that is real and the gap written down in `docs/ops/board.md`
  rather than papered over.

- 2026-09-16 — **Three ways the system can no longer quietly drift, plus the
  one that already bit.** A test harness that loaded the product checkout's
  `.env` was handing CLI verbs a running install's reconciler URL and bridge
  token, so a `compute providers add` case whose `--instance` was a temp
  directory committed into the operator's real instance repo;
  `@foldedspacelabs/metistry-core/test-env` now allowlists
  `METISTRY_DB_*` and deletes the rest, pins `METISTRY_PRODUCT_DIR` at a
  sandbox, and fails any test whose verb resolves a path outside
  `os.tmpdir()` — proved by running the whole CLI suite with the operator's
  environment simulated. Alongside it, `ops/scripts/audit-limits.mjs` fails
  CI on a cap that lives only as a literal (forty on main; two became
  `METISTRY_MAX_BODY_BYTES` and `METISTRY_COMPOSE_TIMEOUT_MS`, thirty-eight
  now say why they are fixed), a `packages/core` conformance test requires a
  stdio component to put nothing but protocol frames on stdout, and every
  refusal on the console's owner surfaces names the field that would permit
  it — while the door stays uniform, because a 401 that explains itself is an
  oracle.

- 2026-09-16 — **You can see what each turn costs, and cap it before it is
  spent.** The engine now dials whichever provider `compute.yaml` assigns —
  any OpenAI-compatible endpoint, so a local model, OpenRouter or anything
  with a base URL — and writes the provider, the model, the tokens, the cache
  hits and the dollars onto every run. Where the number came from is recorded
  too: the provider's own charge, a published price list, zero because it ran
  on this machine, or *unknown*, which is shown as $0 and named rather than
  quietly guessed. On top of that ledger, a daily or monthly budget is checked
  **before** each call rather than reported after it: at 80% you get one
  warning per window, and at 100% the instance either records and carries on,
  stops, or keeps only the work you marked critical. A stop is not silent —
  chat offers you one more window with the exact line to edit, scheduled work
  simply does not start (so a paused engine cannot sit behind a scheduler
  filling the queue with refusals), and a helper agent's task parks with the
  reason. Three smaller things ride along, each of them a control rather than
  a suggestion: a run that keeps asking the same question and getting the same
  answer is stopped at five repeats and made to answer with what it has; a
  provider that does not promise zero data retention warns once a day and
  still works, because that is the owner's choice to make; and the assistant
  cannot hand work directly to a helper running on a different kind of engine,
  though it can always write the work down for anyone to pick up.

- 2026-09-16 — **A local model server in the box, and the one you already run
  works too.** llama.cpp's `llama-server` is built from pinned source into
  the runtime pack: one 11 MB Metal-enabled binary, signed like the bundled
  Postgres and git, verified from a moved copy, loopback-only by
  construction. LM Studio and Ollama stay first-class peers, discovered over
  the same `GET /v1/models` and reported by `doctor`; `metistry compute
  models list` volunteers a running-but-unconfigured server with the one
  command that wires it up. Every model download is checked against the
  digest Hugging Face publishes; absent is never a failure. The local half of
  the bake-off (PoC-18) now has a server to run on.

- 2026-09-16 — **The bake-off harness: choosing the default model becomes an
  experiment with numbers instead of a preference.** `packages/eval` — private,
  unpublished, TypeScript, no new dependency — turns "is a local model good
  enough to be the assistant?" into five measurable axes (tool calls, knowing
  when to stop, triage judgment, voice, writing), one owner-authored fixture
  per axis, and one JSONL row per case carrying pass, score, tokens, cost,
  latency, TTFT and six churn counters that separate a wrong answer from a
  model thrashing. Three things are enforced at the tool rather than asked for
  in a prompt: a fixture may not mix two axes, so a failure names the component
  to fix; the three judgment axes are scored by a model from a *third* family —
  neither the candidate's nor the reference's — and a judge that is absent or
  same-family **refuses the run** rather than quietly passing the cases it
  cannot score; and the candidate is shown the console's real tool definitions
  while every call is stubbed record-only, so an evaluation can never touch the
  vault. Runs are resumable, parallelism is 1 by default so throughput is
  measured rather than the queue, and the report ends in the line the whole
  exercise exists to produce — `≥ bar on all axes: yes/no` — stated as the
  fixtures half of the promotion gate, with two weeks of shadow agreement named
  as the other half. Reference models are the bar and never the source: no
  model's output is a fixture, an expected answer or training data.

- 2026-09-16 — **The inbox is in the vault, and what you type by hand is
  first-class.** Captures used to land in a gitignored folder beside the
  vault: invisible in Obsidian, absent from every backup the repo provides,
  and gone after a rebuild — the one hole in "git is the record". They now
  live at `Knowledge/Inbox/`, inside the vault Obsidian already opens, and
  they are committed like everything else. The benefit is a sentence that
  could not be said before: **the capture you made on your phone at the
  airport is a file you can open, edit and search on the laptop, in the same
  app as the rest of your notes, and it is in the backup.**
  The other half is the promise underneath it. A note you add to that folder
  by hand, or an edit you make to a capture that is already there, is noticed
  by content hash and goes back into triage — a refinement is treated as new
  information rather than ignored, while a "no" you already gave stays given.
  And the assistant's only write path into the vault can no longer replace a
  file it has not read: omitting the content hash now means *create only*, so
  a correction you make in Obsidian while the assistant is mid-thought wins
  and the assistant is told to re-read. That is a safety mechanism shipped,
  not a prompt asking it to be careful — the difference the whole product
  rests on.
  Large captures (over 5 MiB) go to a `.large/` folder the repo does not
  carry: visible in the vault, out of the history, stated as a trade-off
  rather than a surprise. An instance created before today moves with one
  verb, `metistry migrate-inbox`, which also handles a second instance that
  had already moved its inbox under a different spelling.
  `docs/ops/inbox.md`.

- 2026-09-16 — **A third dev tool can now read the vault and write its sessions
  back, and neither half needed the assistant's name or a new concept.**
  `metistry connect opencode` mints OpenCode its own external-agent row and
  merges one `mcp` entry into its global config, with the bearer left in the
  Keychain and named in the file as `{env:…}` — verified live: the header
  arrived at a probe server as `Bearer <the variable's value>`, so nothing
  secret reaches disk. `plugins/opencode` is the other half: one
  `kind: "session"` note per finished session, the same frontmatter and the same
  `idempotency_key` formula as the Claude Code and Cursor plugins, so four
  capture doors dedupe against each other server-side with no change to
  `inbox-drain`. The proof it is the same door, not a lookalike: a real session
  ran end to end against a stand-in console and landed with `turns: 1 user, 3
  assistant`, `read × 2`, `glob × 1`, the file it touched, the first prompt and
  the last response — and its recorded transcript is now the test fixture, so
  the shapes asserted are the ones OpenCode sends rather than the ones we wish
  it sent. The honest part is the limit: OpenCode has no session-end event, so a
  quiet window stands in for one (default 90 s, configurable), and a headless
  `opencode run` cannot be captured at all — the process exits 17 ms after the
  idle event, `beforeExit` never fires and hook promises are not awaited, all
  three measured rather than assumed, and written down in the docs so the gap is
  a known shape instead of a silent drop. What this buys the owner is
  portability of the record: the inbox no longer depends on which editor the
  work happened in, which is the premise the whole capture surface rests on.

- 2026-09-16 — **The product record stops being a merge conflict.**
  `docs/product/record/` fragments — one file per PR, never an edit to
  `docs/product/PRODUCT.md` itself — are the changesets fix applied to the
  one file every product-significant PR used to append a line to, which made
  any two such PRs open at once conflict there by construction.
  `ops/scripts/fold-product-record.mjs` folds every fragment into
  `PRODUCT.md`, in filename order, as part of `release:version`, so the file
  only changes on a release branch; `--check` (wired into both
  `release.yml`'s `verify` job and the PR `ci.yml`) refuses a fragment that
  doesn't open `- 20`, and the fold is idempotent — no open fragments leaves
  `PRODUCT.md` untouched. This entry is itself the first fragment written
  under the new rule.

- 2026-09-16 — **The product's path to a model is now one line of
  configuration, and nothing else.** The Claude Agent SDK and the
  claude.ai-login token path leave the repo entirely (owner's decision,
  `docs/plan-refresh-2026-09-13.md` C2/C3): one engine remains — the
  OpenAI-compatible loop — and Claude arrives through OpenRouter like any
  other cloud model, so the default install brushes no vendor's login or
  branding terms and the person's bill is theirs, itemised, from a provider
  they chose. What replaced the fixed `CLAUDE_CODE_OAUTH_TOKEN` is the real
  benefit: **compute is configurable, and the credential has no fixed name.**
  `compute.yaml` says which provider serves a turn and which Keychain item
  buys it, so the engine's environment allowlist is now "the static keys plus
  exactly the secrets THIS install's file names" (`assistantEnvKeys`) — a
  provider key sitting in the operator's shell that the file does not name
  still cannot reach the engine and spend on somebody else's account. One
  seam answers "is there an engine at all" for `metistry up` (whether the
  assistant is a supervisor child), `metistry doctor` (the `assistant` row),
  the routine runner's preflight (whether a turn would be answered) and the
  watchdog (whether a waiting queue is a fault) — core's `engineStatus`,
  taking the resolved file and the environment — so the four can no longer
  disagree, and when one of them says no it names the half that is missing
  and the command that fixes it. **An install with no engine stays a
  supported shape, not a failure**: captures, `inbox-drain`, tasks, search
  and the console all run while queued turns wait, on both deployment shapes
  now — the compose file no longer refuses to start without a credential.
  The Mac app's seventh first-run step becomes **Compute**: a provider
  template, a model, and an API key pasted into a secure field that goes to
  `metistry compute providers add`'s *stdin* — never argv, never a file the
  app writes, never a log — with the field cleared before the process runs
  and a test asserting both halves; "Skip: no engine yet" is a button with
  its consequence written beside it. The sandbox profile's outbound host list
  stops naming one vendor and is derived from the providers in the file, and
  the honest limit is restated where it lives: it is documentation until App
  Sandbox, while the engine's own `fetch` reaching exactly one base URL is
  the enforcement that is real today.

- 2026-09-16 — **A thing you captured is visible the moment you capture it, a
  task you meant to make is one click away, and "not now" is finally an
  answer.** Four findings from `docs/research/2026-09-16-taskuary-review.md`,
  which compared the loop against a fast-moving product that puts its one human
  gate at the *exit* rather than at capture. The **timeline**: `activity_feed`
  unions `inbox`, so a note taken on the phone appears immediately wearing its
  own status instead of surfacing five minutes later as a proposal — the review
  found this to be the loop's only accidental latency, and it cost nothing to
  close because the row already existed. Every row carries a coarse `group`
  decided in SQL, which the panel reads as filter chips; one vocabulary, not one
  copy per surface. **Approve as Work** answers the sharper finding — that there
  was no capture → `work` path *at all*, so a todo captured on the phone ended
  the night as a vault page and nothing else. The honest middle was not a
  `draft` row written by the collector (that is auto-creation whatever the
  status column says); it was making the click do the thing. A `todo`-shaped
  capture — matched deterministically, **no model**, the on-device classifier's
  `has_action` deliberately not an input — carries a suggestion, and accepting
  it inserts the task, owner-less so any agent may claim it. §4.12 is intact
  because a human clicked, and nothing that goes unclicked ever becomes
  anything. **Decide-time staleness**: a decision now carries the timestamp of
  the row the client painted, and if the row moved after that — payload
  rewritten, its linked task touched, a message in that task's room — the answer
  is refused with the current row rather than applied to a question that
  changed. **`later` and `skip`** fix the queue's one failure mode, an item you
  cannot answer yet and cannot put down: `later` is a snooze that never ends a
  proposal (it leaves Needs You *and* the 07:00 brief, or the verb would be a
  lie), `skip` declines with nothing to say and fires none of Decline's per-kind
  consequences — skipping an enrolment request does not revoke the agent, and
  its marker is excluded by value from every path that carries a decline's
  words. Multi-select applies them to many rows, all-or-nothing **per row**, so
  one item answered on the phone thirty seconds ago does not refuse the other
  nine. Not adopted: executable action proposals, which would widen the
  console's mutating surface and are the owner's ruling to make, not a PR's.

- 2026-09-16 — **A competitor that puts the human gate at the other end, read
  closely.** Taskuary (MIT, 1,139 commits in its first month) reaches the same
  goal by a mirrored route: a model decides on arrival whether a message is
  work, creates the task and starts a coding session unasked, and puts the
  owner's single approval on the *exit* — where it is enforced in middleware by
  a pure deny table matched before any handler runs, because "an instruction is
  not a control". Read against Metistry's loop, that is one gate where we keep
  three, which is the real reason their cycle looks faster; cadence is not the
  lever. The review takes the exit-side mechanisms and leaves the entrance
  alone: an approval that does something (a click that creates the work row,
  rather than a note that waits for the evening fold), a refusal to send a
  draft the world has moved past, and a budgeted block of what earlier work in
  the same area learned, carried into the next brief. It also names the one
  accidental slowness we had: a capture is invisible until the drain turns it
  into a proposal, which one `inbox` branch in an existing named query fixes
  with no migration. `docs/research/2026-09-16-taskuary-review.md`.

- 2026-09-16 — **Agents can now talk before there is anything to show — on a
  channel that cannot summon anyone.** A comment thread can hang on a `work`
  row, not only on an artifact version (migration `0018`, one nullable
  `work_id` and a check constraint: exactly one parent), so two agents can
  settle "does this include the migration?" before a deliverable exists — the
  one capability `docs/research/2026-09-12-agent-room-review.md` found
  genuinely missing after crediting everything Metistry already did in rows.
  The safety property is an **absence**, not a rule: there is no `to_agent`,
  no `@name` and no addressee column anywhere on the path, so a message wakes
  nobody and triggering stays with `agents_delegate`, where its policy already
  lives — the collaboration rule survives by construction, and a test asserts
  `tasks_comment`'s schema has three keys and none of them is a recipient.
  Reusing `artifact_comments` rather than adding a table means the shipped
  escalation applies unchanged: ten consecutive agent turns and the eleventh
  is *not stored* — the room becomes an owner item carrying its transcript,
  and a human message resets the run. Resolving is the owner's hand alone (no
  tool, one route, no sweep — an auto-close would have fired the queued-bundle
  release and started work overnight). Two things fall out of it: the Rooms
  tab finally renders `payload.reason`, stored since the cap shipped, as the
  sentence *"ten agent turns went by without a human — this is where it came
  to you"*; and a room **is** the prior-work record, so a crew claiming the
  row gets the last of it in its brief under a byte budget
  (`METISTRY_BRIEF_THREAD_BYTES`, default 4096, clipped again by the size
  policy already allowed), with the included message ids on the run row.
  `proposals.work_id` — set server-side, never as a tool argument — closes the
  gap the board named: "which proposal is about this card" now has an answer.
  Watch item, measured not guessed: the eager tool surface is now ~4.9k of the
  5k-token line that would force lazy discovery. The next tool added to
  mcp-brain makes that a decision rather than a note.

- 2026-09-17 — **Choosing where your thinking happens is now a settings pane,
  not a YAML file.** The Mac app's Compute pane drives every `metistry compute`
  verb: add a provider from a template with the API key typed into a secure
  field that reaches the CLI's standard input and no argument list, test it
  live, assign a model and an effort to the default and to each tier, set a
  daily and monthly budget, and pull or load a local model — with the four
  local servers (LM Studio, Ollama, the bundled llama-server, Apple's own
  Foundation Models) discovered rather than configured, and RAM headroom shown
  as the estimate it is. A provider off the machine that claims no zero data
  retention is badged and never blocked. The app writes nothing itself: every
  button is a CLI verb that validates `compute.yaml` before it saves it, so the
  terminal path and the app path stay one tested path, and an install with no
  engine says so where it can be fixed rather than failing quietly.

- 2026-09-17 — **The thing running in the background is Metistry's, and there
  is a switch for it.** macOS shows one background item per launchd agent, and
  an item installed by `launchctl bootstrap` belongs to nobody: it sat in
  System Settings › General › Login Items *beside* the app, and the only way to
  turn it off was a terminal — which, for a product whose whole distribution
  premise is "download a DMG and never open one", is the gap between plausible
  and shippable. Two earlier changes fixed how it *read* (one agent instead of
  five, its program a symlink named `Metistry`, the bundled node signed under
  the Folded Space Labs identity so the attribution is a real company); neither
  could make it the app's. Now the app registers it itself, through
  `SMAppService.agent(plistName:)` on a plist sealed inside the bundle at build
  time: **one row, "Metistry", with the agent nested underneath**, and the same
  switch in two places — System Settings, and Settings → Services → "Run
  Metistry in the background" — meaning the same thing. Two rows, deliberately,
  because the two registrations are constantly confused and each one's sentence
  says which it is: *Start at login* opens a window, *Run in the background*
  runs the install. **The terminal path did not move an inch**, and that is the
  part worth keeping: a CLI-only install still bootstraps the same agent
  itself, both registrars are first-class, and what keeps them from ever
  installing it twice is that `metistry up` asks launchd who owns it before
  doing anything — live state, not a marker file that would go stale the moment
  someone dragged the app to the Trash and leave the install silently not
  running. `metistry doctor` names the owner. The app still installs nothing,
  writes nothing, and runs one `metistry` verb per step; all it gained was the
  right to say on/off about a registration macOS keeps.

- 2026-09-17 — **The CLI's `--json` is now a real wire contract, not a
  convention.** The Mac app's Compute pane found several verbs writing their
  own progress notes onto the same stdout stream as the `--json` result, so
  the app had to parse a trailing object out of a run of prose. Every verb
  across `compute`, `instances`, `restart|stop|start`, `doctor`, `identity`
  and `secrets` now writes exactly one JSON document to stdout under
  `--json`, with every human line moved to stderr — enforced in each verb's
  own case, not remembered — so a client (the app, a script, `metistry
  console call`, the new scripting seam behind `console whoami`) can trust
  the whole buffer parses.

- 2026-09-17 — **One engine, configurable compute, and the second-instance-first
  queue: caught up in a single day.** A docs status pass over
  `docs/plan-refresh-2026-09-13.md` and `metistry-build-plan.md`'s Queue
  refresh block, reconciling both against the 2026-09-15/17 merges
  (#141–#171): 49 rows across the decisions log, the small-adopts table, the
  refreshed queue and §4b's W1–W7 move to `done`, and the autonomy-widening
  question (OPEN-2) is resolved — the owner overturned the narrowing-only
  rule the same day #170 shipped it as executable action proposals plus
  autonomy levels. The headline the numbers add up to: the product now
  speaks exactly one engine (`openai-compatible`, no vendor SDK), compute is
  a file the owner edits rather than a rebuild, and every second-instance-
  first item that does not wait on a `v0.8.0` release (W1, W3–W7) is built.
  What remains genuinely open is now a short, named list — OPEN-1 and
  OPEN-3 through OPEN-7, crew descriptions (H8), the grammar/slot adopts
  (T1, T5), and the owner's fixtures that gate the bake-off itself — rather
  than a queue nobody had re-read since 2026-09-13. A companion note
  proposes one addition to `CLAUDE.md`'s invariants, closing the console's
  own mutating surface the same way invariant 9 already closes the
  engine's; that edit is the owner's to make.

- 2026-09-17 — **Four open questions answered in code, and three of the four
  answers are subtractions.** The named list the plan-status pass left behind
  loses OPEN-4, OPEN-5, OPEN-7 and H8. The seed ships **one** cloud template:
  a seeded provider is a standing promise to keep somebody else's base URL,
  price table and retention claim true, so OpenCode Zen's template is gone and
  Zen is reached the way `compute.yaml` always allowed — a block you write, or
  `--base-url` over the nearest template. `critical: true` now has a policy
  instead of a placeholder: it sits on `assignments.default`, so when a budget
  hits `critical_only` the turn the owner is waiting on still gets answered
  while routines and delegation stop — the first budget behaviour that
  distinguishes *someone is sitting here* from *a scheduler fired*. The board's
  **Assigned** column is read **Addressed to**, because `work.owner` is a name
  on a card and the lease is `claimed_by`: the label was making a claim the row
  had not made, and the derived value underneath it did not change. And
  `agents_delegate` now carries the **roster** — every registered helper with
  the `description:` its own manifest wrote, in the tool definition rather than
  a prompt line, capped so a large registry cannot quietly double the
  assistant's definition budget. Writing one sentence in a manifest is now how
  the owner steers which helper gets the brief, in place of the assistant
  learning the registry by refusal.

- 2026-09-17 — **A second instance has a written, end-to-end path now, and it
  runs on zero cloud.** `docs/ops/second-instance.md` is the checklist: install
  from a checkout (v0.8.0, the first release with the compute changes, has not
  cut yet), `init` on the launchd shape, `up` with `assistant: absent` and
  everything model-free still running, then `compute providers add --from
  lmstudio|llamaserver` and `compute assign default` — the second Mac thinks
  with no cloud credential at all, proving §4b W1/W7 as a real sequence rather
  than a claim. Every command in it is grepped against `docs/ops/cli.md` and
  `packages/cli/src/main.ts` rather than invented, and it names two real gaps
  along the way: `metistry init` prints a compose-shaped
  `METISTRY_RECONCILER_URL` and no `METISTRY_ORIGIN` at all on a launchd
  install (`docs/ops/deployment-shapes.md`'s own "still missing" #4), and
  `main.ts`'s printed `--help` for `compute providers add --from` has fallen
  behind `COMPUTE_TEMPLATES` (`llamaserver`, `applefm` are missing from the
  string, present in the code). Connecting Devin, Cursor and OpenCode, and
  Devin's own knowledge-in/dispatch-out round trip, follow the same order the
  plan refresh set: what an operator does with a second Mac is now a document,
  not a memory of one session.

- 2026-09-16 — **The interface has a design plan, and an honest inventory of
  why it needed one.** `docs/product/app-ux-plan.md` starts the work of making
  the product manageable rather than merely installable. The inventory is the
  useful half: the Mac app ships **one of the design system's ten
  destinations** (Status), and 2,644 of its 9,763 Swift lines are settings, the
  wizard and first-run — so "verbose settings and a status page" is a
  measurement, not an impression. Sixteen of the seventeen §3 components exist
  in HTML/CSS only; the token pipeline is in better shape than expected
  (`tokens.json` already generates `tokens.css` twice, `design-tokens.swift`
  and the preview page, CI-checked at every PR), and the real drift is at the
  call sites: nine literal px values in the PWA's CSS, four `window.confirm()`
  calls where §3.17 specifies a `<dialog>`, a nav that grew to eleven flat tabs
  in a scrolling strip, a model picker specified and built nowhere, and
  `reply`/`elevation`/`motion` tokens that never reach the Swift. Two
  architecture gaps matter more than any of that: **compute can only be managed
  on the Mac** (no `/api/compute` route at all), and **knowledge — the
  product's first noun — has no client read path**, so captures go into the
  vault and nothing comes back out to any surface. The plan proposes seven
  sections instead of ten destinations, three renderings of them, the
  native-vs-embedded decision laid out with tradeoffs rather than settled, and
  a phase order that makes the window useful at phase A instead of phase F.

- 2026-09-16 — **You can try a cheaper model on your own real work before
  trusting it with any of it.** Name a candidate and a share of turns —
  one in ten, say — and after each of those turns has already been answered
  and delivered, the same turn is quietly run a second time on the candidate.
  Both answers are stored side by side with a number for how closely they
  agreed; the candidate's answer is never shown to you, never continues a
  conversation, and has no route to your phone. Its tool calls are the point
  of care: they are written down and never performed, and where the real turn
  made the identical call the candidate is handed that real result, so it is
  judged on the same facts without a second write to your notes, a second
  message sent, or a second anything. That is true by construction rather than
  by instruction — the shadow is handed a list of tool names and a set of
  recorded answers, and has nothing it could execute a call against. The
  comparison is charged honestly: a shadow run is a run, so it asks the same
  budget question first (and is the first thing skipped when the month's money
  is spent), and its cost is billed to the provider that was actually paid
  rather than folded into the turn's. Nothing about it can cost you the turn —
  a candidate that is offline or misconfigured leaves a note on the record and
  the answer you already had. The agreement measure is deliberately dull:
  same tools in the same order, plus how much the two answers' words overlap.
  No model grades it, so two weeks of it is evidence rather than an opinion,
  which is exactly what deciding to switch models should rest on.

- 2026-09-17 — **The folder Metistry makes is the folder you open in
  Obsidian.** The owner ruled that the instance directory *is* the vault, and
  the layout followed: your notes sit at the root — `Journal/`, `Me/`,
  `Inbox/`, `now.md` — and everything that is not knowledge moved into a
  single `.metistry/` folder, which Obsidian does not render because it
  starts with a dot. There is no `Knowledge/` subfolder to explain and no
  second directory to keep in step: you point Obsidian at the instance and
  see exactly what you would have put there yourself. What the assistant may
  never touch got simpler in the same move — it is now a *place* (everything
  under `.metistry/`, plus the instructions file you write for it) rather
  than a list of filenames each part of the system had to remember, which is
  one rule the tool can enforce instead of seven a prompt could miss. The
  instructions file itself stays out of the search index: it is what the
  assistant is told, not something it should find and quote back to you.

- 2026-09-17 — **One command moves an instance you already have.** The new
  layout was only half the story: an instance created before it still had the
  old shape, and nobody should have to move thirty files by hand to get the
  clean folder. `metistry migrate-layout` does it in one step — and, more to
  the point, shows you the whole thing first. `--dry-run` prints every file it
  would move and every database row it would touch, and runs none of it; the
  real run makes one commit you can read, or undo, like any other. It works
  out the entire plan before it moves a single file, so if anything would
  collide it stops and names both sides while your instance is still exactly
  as it was. It refuses to run over uncommitted work, and if the part of
  Metistry that writes to your instance is still running it says so by name
  rather than quietly racing it. Nothing is restarted behind your back: the
  command finishes by telling you the one line to run when you are ready. It also fixes up the
  definitions of your sub-agents as it goes, so the permissions you gave them
  survive the move rather than quietly reverting the next time the system
  re-reads them — and it edits those files surgically, leaving your own
  comments and formatting exactly as you wrote them. Before it commits, it
  tells you which folders are about to become searchable notes, so nothing
  ends up in your knowledge base that you did not put there. The
  Mac app understands both shapes in the meantime, so an older instance is
  still adopted rather than rejected — it just says, once, which command
  brings it up to date.

- 2026-09-17 — **The app you will actually use is now decided, not proposed.**
  The interface has one map on every screen — Chat, Feed, Needs You, Work,
  Knowledge, Agents, System — and Knowledge, the thing the product is *for*,
  finally has a home in it. Capture stops being a place you navigate to and
  becomes a hotkey, a share sheet and a button in the composer, because
  something that promises to take five seconds cannot ask you to go somewhere
  first. The Mac and iPhone apps are **native**, built with the platform's own
  controls rather than a web page in a window, so they feel fast and behave the
  way the rest of the machine does; the browser version stays the full client
  for every non-Apple computer. The Mac app talks only to the instance running
  on that same Mac, over the loopback interface — nothing leaves the machine
  and there is nothing to sign into — and running a second instance means a
  second Mac with its own copy, which is simpler than a switcher and honest
  about where your data is. The queue you answer every day is settled at six
  answers rather than three: Approve, Revise, Decline, Approve as Work (which
  turns a suggestion into a task with one click), Later (a real snooze that
  leaves the queue and the morning brief and comes back by the clock), and Skip
  (declining with nothing to say — and nothing in the system is allowed to read
  it as feedback). A designer is engaged for the design language and a real
  brand identity, replacing the placeholder icon. And the one thing the plan
  could not yet size — reading and searching your own vault from the app — is
  now measured against the code: the search that matters, with every result and
  a tap into the whole page, is about three days of work and needs no database
  change at all, because the vault bridge has served keyword, semantic and
  hybrid search since Phase 6 and nothing was ever plugged into it.

- 2026-09-17 — **The two things you do most often stopped being places you go
  to.** Reading the first wireframes, the owner ruled a second time the same
  day, and every change is a removal from the map. Writing something down is
  now a single **"+"** that floats in the same corner of every screen — bottom
  right on the phone, the toolbar and `⌘N` on the Mac — opening a small
  composer that writes to the inbox and closes. There is no capture screen to
  navigate to any more, which is the only version of a five-second promise
  that survives contact with a tab bar. The queue of things that need a
  decision from you moved onto a **bell with a count**, top right, on every
  screen: tap it and the requests open over whatever you were doing, answer
  one, and you are back where you were. It is the same queue your phone
  already shows you as a notification, so there is one list with two doors
  rather than two lists to keep in step — and it is still the only badge
  anywhere in the product. What is left is six sections — Chat, Feed, Work,
  Knowledge, Agents and **Insights** — where Work and Knowledge open in place
  so the board, your projects, your pages and your searches are one click
  away instead of two. Below them the Mac sidebar is **yours**: pin a
  project, a page, a saved search or an agent, drag them into the order you
  want, unpin what you stop using. The old System section, which was the
  machine and the meter in one, split honestly: everything you *configure* —
  status, compute providers and budgets, devices — is in Settings where
  settings belong, the first-run setup is in the app menu where a once-only
  thing belongs, and everything you *read* — what things cost, what ran, how
  the smaller local models compare against the big ones — is a section of its
  own you can actually find.

- 2026-09-18 — **Your assistant answers as the assistant you named, and
  refuses to start if it cannot tell.** On the shape that runs without
  containers — the one the Mac app installs — the engine was looking for the
  file that holds your assistant's name, voice and model choices relative to
  the wrong folder: the product's own, not yours. Every candidate path missed,
  and it fell back silently to the placeholder identity that ships with the
  software. Nothing looked broken; replies arrived, under a name you never
  chose, with the model assignments and the routing rules you had written
  going unread. The fix is at the root rather than at the symptom: every
  service is now told where your setup lives and resolves its config from
  there, absolute, so no component's behaviour depends on which directory it
  happened to be started in — and it works the same on a setup that has not
  yet moved to the new folder shape. The safety mechanism is the second half:
  rather than degrade to the placeholder, the assistant now **stops with an
  explanation** when nothing tells it where your identity file is. Answering
  as someone else is the one failure you cannot see from the outside, so it
  is no longer possible to reach by accident. The confinement the engine runs
  under was widened by exactly four files, each granted by name — your
  identity, your prompt, your rules, your model assignments — and by nothing
  else: your notes are still unreachable from it, which a test proves by
  trying to read one from inside.

- 2026-09-18 — **Where your work runs, and what you have written, are now
  reachable from whatever you happen to be holding.** Two of the most useful
  things Metistry knows were stuck on one Mac. Choosing which model answers
  you, setting a spending limit and checking that a provider key still works
  could only be done at a terminal on the machine that holds your notes — so
  from the phone you could see that a reply had cost forty cents and could do
  nothing about it. And your own notes, the whole point of the thing, were
  searchable by the assistant and by the tools you plug in, and by no screen
  of yours: there was no way to search your vault or open a page from the app
  at all. Both are now ordinary parts of the API every client speaks, which
  means the phone, the Mac app and the browser all get them at once rather
  than one at a time. Choosing a model and setting a budget go through exactly
  the same code the command line uses — the same check that the file is still
  valid before a single byte is written, the same hand-written comments left
  untouched, the same "this is your change, in your name" recorded against it
  — so the two ways of doing it cannot quietly come to mean different things,
  and a mistake is refused in the same words wherever you make it. **Keys stay
  where keys belong.** Adding a provider still means typing its key at your
  own machine, never sending one over the network; what the app can see is
  that a key of that name exists, and nothing more. Search tells you the
  truth about itself, too: when the part that understands meaning rather than
  words is unavailable, results come back anyway with a note saying they are
  word matches this time, rather than a spinner or an error. And the app can
  only ever open your actual notes — the machinery folders, your settings
  file, the assistant's own instructions and anything holding a password are
  not notes and cannot be opened as one, from any client, by anyone,
  including you. Finally, the slash-command menu now lists *your* commands
  rather than a hard-coded guess: it is built from your own routing rules, so
  it shows what your instance actually does, and a test checks that every
  command the menu offers is one the system really acts on.

- 2026-09-18 — **Your existing setup keeps working until you choose to move
  it — and the promise is now tested rather than asserted.** The new folder
  shape came with a sentence saying an older setup would keep running until you
  ran the one command that moves it. Checked against a copy of a real older
  setup, it wasn't true: the app was looking for your settings in the new place
  and quietly falling back to the defaults it ships with, so it reported no
  model provider while your own file named one, could not tell you the
  assistant's name, and would have started a second, empty database beside your
  real one the next time you brought the system up. Two of those were safety
  rather than inconvenience: on an older setup the files that define how the
  system behaves had fallen out of the protected set, so the assistant could
  have edited its own rules, and the same files — plus the whole of the working
  directory the database lives in — were being swept into your searchable notes.
  Both are closed, and closed the way this project closes things: at the tool,
  so the write is refused rather than discouraged. Everything that reads your
  setup now checks which shape it is in first, one look at the folder, and the
  answer holds for both. And because compatibility nobody tests is not
  compatibility, the update command now stops — before it downloads anything —
  if it is about to move an unmigrated setup onto a version past the line that
  was tested against it, and prints the single command that brings it up to
  date. The move stays yours to make, on your own day.

- 2026-09-18 — **The desktop app can now read and change everything the
  system holds, and the secret that lets it never enters the app.** Until this,
  the Mac window could ask one question — "am I signed in?" — and everything
  else about your own work lived in the browser. It can now reach all of it:
  what happened, what is waiting on you, the board and its cards, the rooms,
  who is working and under what autonomy, where the money goes, your notes and
  a search across them. The way it reaches them is the part worth keeping: the
  app does not hold your credential. It asks the command line to make each
  request, and the command line is the only thing on the machine that knows
  where the secret lives — so a screenshot of the app, a crash log from it, or
  a copy of its memory contains nothing that would open the door from
  somewhere else. That is checked by a test that reads the app's own source and
  fails if any file sets a credential header, names a keychain, or opens a
  file at all; the test passed before this change and passes unchanged after
  it, which is the difference between a rule and a promise.
- 2026-09-18 — **A pane that cannot reach the system says so and keeps what it
  last knew.** Three habits are now properties of the code rather than notes
  for whoever draws the next screen. A refresh that fails leaves the previous
  answer on screen and marks it old, instead of blanking a working page. A
  background refresh is not allowed to become a spinner — only a first load,
  with nothing to show yet, earns one. And while nothing is answering, every
  button that would decide something refuses in a sentence *before* sending,
  rather than looking live and failing somewhere you cannot see. Reconnecting
  after a gap asks only for what changed, and a request you answered on your
  phone thirty seconds ago leaves the queue rather than sitting in it twice.

- 2026-09-18 — **The same prompt costs a tenth the second time, and the bill
  says so.** Every turn re-sends the same system prompt and the same tool
  list; on a provider that can cache them, paying full price for that twice is
  just waste. The cloud template now ships with caching on, so the engine asks
  for it on every call without anybody configuring anything — and only on a
  provider that has actually said it supports it, because a setting sent to an
  endpoint that has never heard of it is noise, not thrift. What came back
  cached is recorded on the turn beside what was fresh, and priced at the
  cache's own cheaper rate, so the saving shows up in your own spend history
  rather than in a vendor's marketing: you can see how much of each turn was
  cached and what it cost. The total prompt size is still reported whole, so
  the cached share is extra detail rather than a number that makes two
  columns disagree. Anything more aggressive — hand-placing the cache
  boundaries for a few percent more — waits on a measurement over real turns,
  because a saving nobody measured is a claim.

- 2026-09-18 — **You can browse your notes from any client now, not just
  search them.** Until this, the only way to see what was in your vault from
  the phone or the app was to think of a word that appeared in it: search
  worked, browsing did not exist. The list of pages — every note, grouped by
  the area it lives in, with its title, its one-line description, when you
  last changed it and whether the system has caught up with that change yet —
  is now something any client can ask for and page through. It costs nothing
  to run: the list comes out of the index the software already keeps of your
  vault, not out of opening files, so a vault of ten thousand notes answers as
  fast as one of ten. The reason it took a separate piece of work rather than
  arriving with search is the rule the system holds itself to: anything
  countable has exactly one route into it, written down, reviewable, and the
  same one every surface uses — so this list is a file you can read, change
  for your own install, and see honoured by the phone, the app and the CLI
  alike. Three things about it are deliberate and worth knowing. Notes you
  have marked as drafts never appear, at any tier, for you or for an agent —
  one rule, so your own list and an agent's index can never disagree about
  what a draft is. Filtering by an area gets that area and nothing that merely
  starts with the same letters: asking for `Health` does not quietly hand over
  `Healthcare`, which is the way a filter like this usually leaks. And the
  list never reports a total. That sounds like a missing feature and is a
  safety one: a count of everything would tell someone with narrower access
  exactly how many pages they are not allowed to see, so the list simply ends
  when it ends, and nothing about what was withheld travels with it.

- 2026-09-18 — **A retry from the Mac app no longer risks a second note.**
  `metistry console call` — the app's entire authenticated door onto the
  console — could not set a request header, so `POST /capture`'s
  `Idempotency-Key` was reachable from a curl command and nowhere else. The
  verb now takes `--idempotency-key <key>`, checked to the server's own shape
  before the request ever goes out, and folds a replay (the console's own
  `idempotency-replayed` header, which the verb otherwise prints no trace of)
  into `--json` output or a one-line stderr note. `MetistryKit`'s transport
  carries the same optional key through to the CLI invocation, so a future
  capture route on `ConsoleAPI` inherits the safety rather than needing its
  own.

- 2026-09-19 — **You can follow the links between your notes from any
  client, in both directions.** Ask for a page and you get what it links to
  and, just as usefully, what links *to* it — the backlinks that turn a pile
  of notes into a thing you can move around in. It costs nothing to compute:
  the connections are already worked out each time the system reads your
  vault, so this is a lookup, not a scan, and a note with two hundred
  backlinks answers as fast as one with two. Links to notes you have not
  written yet are included and marked as such, the way Obsidian shows them,
  because the intention to write something is part of how a vault gets
  written and hiding it would quietly lose it. Two things never appear:
  anything you have marked a draft, at either end of a link — so a draft
  cannot be found through the back door after being kept out of the front one
  — and any connection to a page the asking credential is not allowed to see.
  That last one is checked at *both* ends, which is the part that is easy to
  get wrong: a page you can see is allowed to link to one you cannot, and the
  answer simply does not mention it. As with the list of pages, the answer
  never reports a total, because a count of what was hidden is itself a
  disclosure.

- 2026-09-19 — **One door per thing you can ask for, and it is the door that
  checks who is asking.** The list of your notes is answered by one endpoint,
  and that endpoint filters it: it hands back only the parts of your vault the
  credential making the request is allowed to see. There was a second way to
  the same list — a general-purpose "run this query by name" address the
  dashboards use — and it did no filtering, because it cannot: it does not
  know that one of the columns it is passing along is a path into your notes.
  Nothing had gone wrong, but the shape was wrong, and one credential made
  that concrete: the small token you put in a phone shortcut so it can send a
  note in is not allowed to browse your vault, and could have listed every
  page in it by name. That is now closed, and closed in the way the system
  prefers: the query file itself says which door serves it, so the rule lives
  beside the thing it governs, travels with it into your own install, and
  cannot quietly disagree with a list kept somewhere in the software. The
  refusal is also deliberately dull — asking the general address for a
  restricted query gets exactly the answer you get for a query that does not
  exist, so nobody can map what is behind the wall by knocking on it. And the
  filter on the surviving door no longer assumes it is you: it reads what the
  credential is allowed to see and narrows to that, which is what makes it
  safe to ever hand a narrower one out.

- 2026-09-19 — **A fifth of what the assistant reads before every reply was
  bookkeeping.** Every tool it can use is described to it at the start of each
  turn, and one line of that description — an id for grouping a reply's
  actions in your activity feed — was repeated in all twenty-five of them:
  **944 tokens, 19% of the whole list**, for something the assistant should
  never have been thinking about in the first place. It is now attached to
  each call by the software rather than written by the model, which is both
  cheaper (19,914 characters down to 16,140, measured) and more reliable —
  the grouping used to depend on the assistant remembering a convention, and
  now it cannot be forgotten. Nothing it can do changed. The room this frees
  is deliberately not being spent: the tool list is the thing a smaller,
  local model has to hold in its head to pick the right action, so the build
  now measures that list on every change and refuses to let it grow without a
  decision. New things to look up arrive as saved questions, which cost
  nothing until asked.

- 2026-09-19 — **It can keep your Mac awake, and it asks you first.** Metistry
  only works while the Mac is awake: a note sent from your phone, a collector
  due at three in the morning and the assistant's own queue all wait while it
  sleeps. It can now hold the machine awake for you, and the whole of the
  design is in how it is asked for. Setup poses one question with four answers,
  each printed with what it costs you rather than only what it does: keep it
  awake while it is on power (the recommendation — a laptop away from a charger
  sleeps normally and the install pauses with it); keep it awake on battery too
  (that drains the battery faster); never, which means your own sleep settings
  decide and Metistry waits; and, offered last and marked against, even with
  the lid closed. An install nobody asked holds nothing at all — the mechanism
  overrides the sleep timer you set in System Settings, and taking that from
  somebody who never agreed to it is exactly the thing not to do. The fourth
  answer is where honesty cost something: no program can keep a Mac awake with
  the lid shut, so rather than quietly doing the lesser thing, the option
  exists, does everything it can, and says in plain words that the last part
  needs an administrator change you make yourself. Your screen still sleeps
  throughout, a keep-awake app you already use is untouched and cannot be
  undone by this one, and nothing outlives the install: the moment Metistry
  stops, however it stops, the Mac is its own again. And it checks its own
  promise. If the Mac slept anyway — a closed lid, a scheduled sleep, some
  other policy winning — the health check says when, for how long, and offers
  the stronger setting with its battery cost stated, instead of leaving you to
  notice that a night went missing.

- 2026-09-19 — **Typing `metistry` now actually works, once you link it
  once — on every Mac this system runs on, no-Docker shape included.**
  Every release before this one left `metistry` unreachable by name: there
  was no Homebrew formula, no npm global, nothing on your `PATH` at all, so
  running the tool from a terminal — or the Mac app finding it before you
  had opened the app even once — depended on a wrapper only the person who
  built this system had written for themselves. Bringing an install up now
  writes that same kind of wrapper for you, in the one place both the CLI
  and the Mac app already agree to look, and prints the exact one-line
  command that puts it on your `PATH` — never doing that part itself,
  because what is on your `PATH` is your call, not the software's.
  `metistry doctor` now says, plainly, whether typing `metistry` would work
  right now, and hands you that same line back if it would not.

- 2026-09-19 — **One scope rule for every knowledge read, on both doors.**
  Closing the unfiltered way to your page list last week left the same gap
  open on the other surface: the one your helper agents talk to. Agents get a
  read tier you set — nothing, titles only, or a named area — and separately a
  switch for running the saved questions your dashboards run. The second was
  quietly bigger than the first, because the list of your notes *is* one of
  those saved questions: an agent you had told nothing, that could not learn a
  single note title the ordinary way, could ask for it by name and page
  through your whole vault index and every link between your notes. That is
  closed the same way, and now there is exactly one function anywhere in the
  system that decides whether a path may be shown to a caller — your own
  clients and every agent ask it, so the two can no longer drift apart. Every
  door also refuses the same way it refuses a question that does not exist, so
  nothing can be mapped by knocking. What the agents keep is the part that was
  wanted: **an agent can see what knowledge exists without being able to read
  it.** Titles and one-line descriptions, anywhere in your vault, and not a
  byte of a note — so a helper can find that `Areas/Health/sleep.md` is there
  and come back and ask you for that area, instead of either being blind or
  being handed the lot. Asking is a note in your Needs You queue; widening is
  your hand in the Agents panel. The listing got stricter for everyone at the
  same time: it now knows that the machinery folders in your vault are not
  knowledge, which it had never been told before.

- 2026-09-19 — **`up` starts it and returns; `down` stops it.** Starting your
  assistant hands the processes to the operating system and gives you your
  terminal straight back — the daemon outlives the window you typed in, which
  is the whole point of it — and stopping it is now one word rather than a
  list of services you have to remember. `metistry down` stops everything and
  then goes and looks, telling you what is actually gone rather than assuring
  you it worked; it stops containers without removing them and never touches
  your data. Starting is also noticeably quicker: the start-up used to ask the
  system sixteen separate questions about jobs that have not existed on a
  migrated install for months, wait a full second at a time for a database
  that comes up in a fraction of one, and run its closing health checks one
  after another when every one of them is independent of the rest. None of the
  checks got weaker — a slow-but-healthy component is still given its full
  time to answer — they just stopped queueing. And the last two lines now say
  where the seconds went, section by section, so "that felt slow" is a thing
  you can read rather than guess at.

- 2026-09-19 — **The command line reads like something that was designed.**
  The verbs an operator actually lives in — is my install healthy, what
  version am I on, what is this update about to do — now answer in a shape
  the eye can skim: rows grouped by what they are, one icon and one colour
  per status, the fix for a broken check wrapped directly under the check
  rather than pushed into a column that runs off the screen, and the long
  steps showing a spinner instead of a silent terminal. Colour is decoration
  and never information: every line says its status in words too, so the
  output is identical to anyone who turns colour off, pipes it into a file,
  or cannot separate red from green. It is a closed vocabulary — five status
  words, seven icons, no emoji — held to by its own tests, and a terminal
  that cannot draw `✓` is given `[ok]` rather than a box. The machine-readable
  half is untouched by all of it: `--json` turns colour off at the source, so
  what the Mac app parses is the same byte for byte, which is what makes this
  a presentation change rather than a wire change. The one notice that used
  to shout — a deprecated `.env` still being read, printed before the answer
  you asked for — is now a dimmed line after it.

- 2026-09-19 — **An agent that is boxed in can now ask, and only you can
  answer.** A scoped agent could already be told that a page exists and
  refused its contents; what it could not do was say which folder it needed.
  It can now: one tool, `request_access`, which takes a folder and a reason
  and writes a single request into Needs You. It grants nothing — it is a
  row in your queue, beside everything else that needs you, and you answer it
  with the same three words you answer everything with. Approve widens the
  agent's grant by exactly the folder it asked for; Revise widens it by a
  narrower one you choose instead; Decline moves nothing at all. The widening
  runs through the identical code path, the identical validation and the
  identical audit row as editing that agent's grants by hand in the Agents
  panel — which is what makes this a second door onto your own decision
  rather than a new power the queue quietly acquired. The safety that matters
  is what the asking tool cannot do: it cannot name a folder the grants form
  would refuse (the machinery, the artifacts, a traversal, a lowercase path,
  the whole vault), it cannot ask twice while you have not answered, it
  cannot ask on behalf of anyone but itself, and it cannot answer itself —
  triage is your session and nothing else reaches it. A revoked agent's
  pending asks are declined along with its token. Your own assistant may ask
  too, from the same day's follow-up ruling: its scope is a line in your
  configuration file, so each approval for it is recorded beside the request
  you answered and merged back at every start — configuration stays the
  floor, and a grant that reverted on restart would have been a promise the
  system could not keep.

- 2026-09-19 — **An agent that is told "no" can say why it matters, once.**
  The access-request loop shipped with one answer per ask and no way to read
  the answer: a declined agent could only file the same row again. It now
  gets the decision back at the tool — declined, when, the owner's note — and
  exactly one escalation, `escalate: true` with a fuller reason, which arrives
  in Needs You flagged *asked again after a decline*. A second decline closes
  the area at the tool; what is left is a report in words. The ladder is three
  rungs and enforced in code, so "don't nag" is a property of the mechanism
  rather than a line in a prompt — and the same change let the owner's own
  assistant onto the loop, with each approval recorded so the next restart
  cannot quietly undo it.

- 2026-09-19 — **The assistant can no longer overwrite a note you wrote by
  hand.** `knowledge_write` is a whole-file replace, and it decided who owns
  a note by reading `source:` out of its frontmatter — but a note you write
  yourself, in Obsidian or any other editor, never carries `source:` at all.
  The original rule read that absence as "nobody owns this yet, so it's free
  to write", which meant a model turn — the evening fold reading your notes
  to write its own — could silently re-emit and replace one you wrote by
  hand. No `source:` now means the note is yours, the same as an explicit
  `source: user`; the assistant still writes and updates its own notes and
  the fold's freely, and can still create anything new, but an existing note
  with no stated author is refused rather than assumed available. The one
  named exception is `now.md`, the single note the assistant is required to
  keep current every day, seeded with its own provenance from here on so a
  fresh instance never needs the exception at all, and closed permanently the
  first time an existing instance's copy is written under the new rule.

- 2026-09-19 — **The migration scripts refuse to guess which database
  they're about to touch.** `ops/scripts/migrate.sh` and
  `ops/scripts/test-db.sh` now track where their target database's name
  actually came from — a caller's explicit override, a checkout `.env`, or
  the install's own `.metistry/state/.env` — and refuse rather than proceed
  whenever that provenance says something a person almost certainly did not
  mean: a shell that already has a scratch database name set (a test shell,
  by definition) touching a different database by omission, or a target that
  traces back to a live install's own configuration with nobody confirming
  that is really the machine. Both scripts take `--print-target`, which
  resolves and reports the same decision without ever opening a connection —
  which database a command is about to touch is now something you read
  before running it, not something you infer from an incident afterward. It
  follows a real one: a shell carrying a leftover test-database name ran
  `migrate.sh` with no explicit target, fell through to the built-in
  default, and applied a migration to the live install (reverted by hand).
  The same shell today gets refused, in words, before it touches anything.

- 2026-09-19 — **Prompt caching now reports on itself, in one command.**
  `metistry compute cache-report` reads the run ledger and says, per provider,
  model and tier, what fraction of each prompt was served from the cache
  rather than sent again — and what that was worth, netting the discount the
  reads earned against the premium the writes paid, so a prefix being rebuilt
  every turn shows up as a negative number instead of hiding inside a total.
  Caching is the single largest lever on what an assistant costs, and until
  now the only way to know whether it was working was to read a database by
  hand. It answers in a table with one verdict line under it, and it calls no
  model to do it: everything it reports was already recorded by the turns you
  already took. The reading it refuses to fake is the useful one — a provider
  that reported nothing about its cache is shown as silent rather than as a
  cache that missed, because the first is a wiring problem and the second is a
  prompt problem, and being sent to audit the wrong one costs an afternoon.

- 2026-09-19 — **The sole committer runs confined, and every child's egress
  passes one allowlisting door.** One process in Metistry holds your notes as
  actual files and is the only thing allowed to commit them. It is the part
  that would matter most if anything ever went wrong with it, and until now it
  was also the part with the fewest limits: nothing stopped it reading your
  Documents folder or your SSH keys, because nothing had ever told it not to.
  It now runs inside a boundary the operating system enforces rather than one
  the design intends — it can write the vault and a scratch directory and
  literally nothing else on the disk, it can run exactly two programs (the
  runtime and git), and it has no shell at all. The guarantee that "only this
  one process can change your knowledge" stopped being a promise about how the
  code is arranged and became something the kernel refuses to break. The
  assistant has had this since the start; this is the other half. And the
  boundary keeps the thing that matters working: your notes still back
  themselves up to your private repository, unattended, every hour, with the
  token still living in the Mac's own Keychain and never written to a file
  anywhere. That took finding a door in a wall — the ordinary way git asks
  for a password needs a shell, and the whole point was to take the shell
  away — so the part of Metistry that is still outside the boundary fetches
  the credential once when it starts everything up and hands it in, and a
  fourteen-line helper inside passes it to git when asked. It never appears
  in a command line, where anything else running on your Mac could read it.
  One arrangement genuinely cannot survive the boundary: a repository reached
  over SSH, because serving it would mean handing your private keys to the
  one program this is all about fencing in. Setup says so in plain words when
  it sees one, and there is a single documented switch for anyone who would
  rather have the old arrangement back — a visible file that says "allow
  everything", never a silent absence. The second half is about
  where things can *reach*. The confinement macOS offers can say "one port"
  but cannot say "openrouter.ai", so for a year the list of servers Metistry
  was allowed to contact was documentation sitting next to a rule that
  actually permitted any encrypted connection anywhere. There is now one door
  in the wall, and a doorman on it: every outbound connection from a confined
  part of Metistry goes to a single local checkpoint that knows the handful of
  names this install legitimately talks to — your model provider, from your
  own configuration, and your notes' backup remote, from the repository itself
  — and refuses everything else, writing down what was refused and which part
  asked. It never opens the envelope: it learns a destination and passes
  encrypted bytes through untouched, so it can tell you where your data went
  without ever being able to read it. Measured on a real Mac: the permitted
  destination answers normally, an unlisted one is turned away at the door,
  and with the door removed the operating system refuses the connection
  outright.

- 2026-09-20 — **A crew's toolset is enforced at the door.** When you define a
  helper agent, you say which kinds of tool it may use — read the notes,
  report, work the task list, speak in a room. That list was being applied by
  the program that hands the helper its brief: it offered only those tools and
  refused the rest. Real, because nothing else holds that helper's credential
  — but it was a promise one program was keeping, not a rule the system
  enforced, and five of the eight kinds had nothing else standing behind them.
  The list now travels with the credential itself, and the server refuses
  anything outside it before the work starts, with the same refusal every
  other boundary gives and a line in the record saying what was tried. The
  helper is told what it does hold, so it reports what it needed instead of
  guessing at the next tool. Widening one is still what it always was: you
  edit its definition file, in your own hand. A helper whose definition can't
  be read gets nothing rather than everything — the safe way round — and the
  program that dispatches it still hides the tools it cannot use, so the
  helper doesn't waste a turn learning that. Nothing changed for you or for
  any other agent: every other refusal is word for word what it was, checked
  against a list of them that a person approves.

- 2026-09-20 — **A new instance starts with a daily note, plan, fold,
  standup and meeting template the user owns.** `metistry init` now stamps
  the journal tree, `Templates/` and `Me/` alongside the seeded vault, so
  the daily flow (`docs/product/daily-flow-spec.md`) has somewhere to render
  into from the first commit rather than a gap closed by hand later.

- 2026-09-20 — **A todo is a plain English line, and Metistry reads it.** A
  task is a `- [ ]` line in your own note, typed the way you would say it:
  `Draft the Q4 plan due friday p1 size l type planning +drey`. The fields are
  a run at the end of the line, so the first word that is not one of them ends
  it — `Ask @Jim about the pricing deck` assigns the deck to nobody, and your
  sentence survives intact. Everything Metistry works out from that line — the
  date behind `due friday`, the person behind `@Jim`, the four-level priority
  behind `critical` — it works out on read and keeps in its own index; the
  bytes in your note are never touched, so there is nothing to opt out of. A
  field it cannot read is never guessed: `due nextweek` produces one visible
  line in the day's plan naming the token, not a date you did not mean. If you
  already use Dataview or the Obsidian Tasks plugin, their syntax is read too,
  and never written back. The same day's second piece is the filter language
  the plan, the app and the plugin all share — `due <= today or overdue` — so
  a view you build in one place can be pasted into another. It compiles to
  bound parameters of a single named query and is refused outright if it is
  anything but the vocabulary: a filter carrying SQL never reaches the
  database as text, because the code that would have to quote it does not
  exist.

- 2026-09-20 — **Every todo in your vault is findable within a reconcile.**
  The pass that already walks your notes and hashes them now also reads every
  `- [ ] …` line in them, so a task you typed in a meeting note three weeks
  ago is as findable as one you typed this morning — with due dates,
  priorities, who it is waiting on and how long it has been carried — and
  without a single copy of it living anywhere but the line you typed. Nothing
  is written back into your notes: the parser reads loosely, resolves
  `due friday` and `@Jim` against the day it read the line and the people in
  your vault, and puts the answer beside the line rather than in it. The
  identity degrades honestly, which is what makes the index safe to trust
  before there is any plugin minting ids: change a date on a line and it is
  the same task, re-type the words and it is a new one, and the clock that
  says how long something has been sitting survives both a re-walk and a
  rename. The files that merely *show* your todos — tomorrow's plan, the
  fold, the standup — hold none of them, decided by the same ownership rule
  that stops the assistant overwriting a note you wrote, so nothing is ever
  counted twice. And an agent waiting on something only you can do now says
  so on its card, while still being free to do everything else: the wait is
  visible and it never blocks.

- 2026-09-20 — **One place now decides what anything is allowed to see.**
  Fourteen separate rules, spread across eleven files, used to answer the
  question "may this agent read this note, run this query, touch this task" —
  and a single ordinary read passed through five to seven of them, each
  written out by hand at the place it was needed. They agreed, but only
  because someone had kept them in step; the first one to drift would have
  been a silent hole rather than a bug anyone would notice. They are now one
  function, in one file, that every door asks and no door second-guesses, with
  a test that greps the code to prove no part of the system has quietly grown
  a rule of its own again. Nothing a person or an agent can do changed by a
  single byte — the refusals are asserted word for word against what they said
  before — but two things that were invisible became legible: every refusal
  now carries a machine-readable reason, so an agent that is told "no" can
  tell "you lack the grant" from "that does not exist", and where a remedy
  already existed the refusal carries it in a form a program can act on
  ("ask for this folder", "raise this permission"). And the complete list of
  everything the system can say when it refuses is a single reviewed file, so
  changing the words an assistant reads is now a deliberate edit somebody
  approves rather than a string changed inside a handler nobody opens.

- 2026-09-20 — **One scope vocabulary everywhere; the owner is never refused
  their own vault.** What an agent is allowed to see used to be described in
  four different sets of words: the console's Agents panel said one thing, the
  approval card in the queue said another, the tool descriptions an assistant
  reads said a third, and the command line said nothing at all — there was no
  way to ask, from a terminal, what any agent held. There is one set of words
  now, written once and rendered everywhere: a single line reading *role ·
  access · extras*, so "an agent · folders: Areas/Health · queries, autonomy:
  propose" is the same sentence whether you meet it in the panel, in the card
  you are answering, or in `metistry agents list`, which is new. Refusals got
  the same treatment: the system used to say "no" in five different dialects —
  an empty message, a bare "not granted", a sentence naming an environment
  variable, a sentence naming a web route and a command — and now says one
  sentence per kind of refusal, each one naming what would unlock it and who
  decides. The refusals that must stay uninformative — a task in a project you
  are not in, a page you could not already see exists — are now marked as such
  in the code itself, so nobody can make one of them chatty by accident and
  turn a refusal into a way of discovering what is there. And the owner's own
  rule finally has no exception: "the owner has access to everything" used to
  be true in intent and false in two places, where a check written to narrow
  agents was being applied to the person whose vault it is. The fix was to
  separate *what a file is* from *who may see it* — an artifact, the
  machinery, or a note — so a door that does not serve artifacts can say "that
  is an artifact; here is the door that has it" instead of "that does not
  exist". The owner is refused nothing, and a door still only serves what it
  is a door to: asking the knowledge index for the secrets file gets an honest
  answer and not a single byte.

- 2026-09-20 — **The files that decide how Metistry behaves can no longer be
  written by anything that merely says it is you.** A handful of files in your
  vault are different from your notes: they are the rules the system runs on —
  which agents exist, what they may read, what the assistant is told, which
  version is installed. The promise has always been that those are yours alone
  and no machine changes them. Until now that promise had a soft middle. Every
  request to change a file said, in its own words, who it was from, and the
  part of Metistry that holds your files believed it — so the check was really
  "did this request claim to be the owner", and one shared password reached it.
  Nothing ever abused that. But the whole design of this system is that a rule
  should be something the tools are incapable of breaking, not something
  everything happens to respect, and "nothing does" is a weaker sentence than
  "nothing can". Now the answer comes from *which key* a request arrives with,
  and a request cannot choose its own key. There are two: one the command line
  on your own Mac holds, which is you — it lives in the Mac's Keychain, and
  the command line can reach it because it *is* you, running as you — and one
  everything else holds, which can write your notes, your captures and your
  agents' work, and simply cannot write the rules, no matter what it puts in
  the message. The long-running part of Metistry that faces the network and
  speaks for every agent is deliberately never given the first key; that is
  enforced where its environment is built, not left to good behaviour. Exactly
  two exceptions are written down in the open, and both are things you do on
  screen and would otherwise have to do from a terminal: extending the
  assistant's own instructions when you approve a suggestion, and moving a
  model or a budget from the Compute pane on your phone. Everything else — the
  agent definitions, the access rules, the queries, the installed version, the
  assistant's operating instructions in your repository — is out of reach of
  anything but your own hand, and any attempt is written down with the name of
  what tried. If the key is missing, nothing gets to write those files at all,
  including Metistry's own updater; it fails closed and tells you the one
  command that fixes it. Updating mints the key for you, so an existing
  install needs to do nothing at all.

- 2026-09-20 — **The tasks in your notes are indexed, never stored.** A todo
  you type as `- [ ] Call the dentist due friday` in any note is now readable
  state — due dates, priorities, who it is waiting on, how long it has been
  carried — without a single copy of it living anywhere but the line you
  typed. The database holds a projection of your markdown and nothing else:
  drop it entirely, let the walk run once, and every row comes back from the
  notes that produced it. That is what makes the checkbox on disk the record
  rather than a mirror of something else's opinion, and it is enforced by the
  shape of the schema rather than promised by a convention — there are two
  constraints deliberately absent from it, because a derived table that can
  refuse to be rebuilt is not derived. Reading it is one query, which is the
  same query the filter chips in the app, the `where:` line in your template
  and the plugin's suggester all turn into — one filter language with three
  faces instead of three that drift apart within a year. Everything it
  returns that names a path or quotes a line you wrote is reachable only
  through a door that checks who is asking; the one thing that travels freely
  is the count, and it is grouped so that a count can never carry a path.

- 2026-09-20 — **The daily note is rendered from a template you edit.** The
  plan, the standup and the fold are produced from markdown files in your own
  vault (`Templates/`), which you edit in Obsidian like any other note — eight
  directives that fill in the day's date, your tasks in the order you asked
  for, tomorrow's calendar, what an agent is waiting on you for, and your own
  prioritisation prose included verbatim. What the engine cannot do is built
  into its shape: a filter never becomes SQL text, a routine rendering a file
  never calls a model, an included file's own directives are never evaluated,
  and a recurring task is written into your note only by your own hand. A
  directive that cannot be satisfied renders one visible line naming the
  template and the line number, and the rest of the file still renders — a day
  with no plan because the calendar was down is the worst possible outcome.
  Every rendered file ends by naming the template and version that produced
  it, and `metistry templates check` tells you whether the edit you just made
  reads, without waiting for the next run.

- 2026-09-20 — **The fold has its own file; your daily note is yours.** The
  evening fold used to write straight into `Journal/<date>.md` — the same
  file you write in by hand. It now writes `Journal/Fold/<date>.md` instead,
  and the ownership rule that already refused an assistant write to a note it
  does not own (`source:` neither its own nor the fold's) now backs that up
  at the tool: nobody, not even the fold, edits your daily note again. When
  you have stamped `Templates/Fold.md`, the fold renders it itself — dates,
  your requests, an included section verbatim — and only asks a model to fill
  the handful of prose slots the template marks as its own, in one turn, over
  a rendered skeleton it cannot touch anywhere else. An instance that has not
  stamped that template yet loses nothing: the fold writes the same freeform
  note it always did, still at the new path, with one visible line saying why
  there was no template to render.

- 2026-09-20 — **Tomorrow's plan is written for you, from your own template.**
  Once an evening, Metistry renders the plan file in your vault from
  `Templates/Plan.md` — a markdown file you edit in Obsidian like any other
  note — into `Journal/Plan/<tomorrow>.md`: tomorrow's events, the tasks your
  template asked for in the order it asked for, what an agent is waiting on
  you for, and your own prioritisation prose included word for word. No model
  is anywhere in it: the ordering is a field list you wrote, and your
  prioritisation *rule* is prose the plan carries for you to read, not
  something a model is asked to apply. It writes exactly one file and never a
  note you own — a plan file you have taken over is left exactly as it is, and
  a recurring task is listed for tomorrow rather than written into a note,
  because nothing but your own hand puts a task line in your notes. It plans
  after the day end you stated in `Me/`, on the eve of a day you work, and if
  you have not told it those things yet it writes nothing and says so rather
  than guessing your week. Everything it could not reach — a calendar that was
  down, a filter it could not read — is one visible line in the plan and the
  rest of the day still renders, because a day with no plan because the
  calendar was down is the worst possible outcome. Every file ends by naming
  the template, its checksum and the version that produced it.

- 2026-09-21 — **`Me/` is yours — the assistant can no longer write it.** A brand-new page under `Me/`, or a fresh `Journal/<date>.md`, used to slip past the one rule that was supposed to stop it: `knowledge_write`'s ownership check only ever looked at a note that already existed. It is refused now at the tool itself, for the assistant and for every routine's own commit, whatever grant either holds — `Me/` is discovered, never assumed, and the daily-flow ruling that your journal is yours alone now holds for the first write, not just every one after it.

- 2026-09-22 — **The owner can see when their own setting is being overridden.** Every action mode the CLI, the console and the Mac app show now carries WHY it is what it is — set by hand, defaulted from the level, or clamped to the level's ceiling — computed once in `core` and read the same way everywhere, so the one case that matters (your own choice for a kind being overruled by a lower autonomy level) is never indistinguishable from an ordinary default.

- 2026-09-22 — **Captures are triaged by what they say, locally, and the decision is a number in your own file.** A note the inbox's rules could not place used to wait for a 500 ms round trip to an on-device model that answered in JSON; it is now scored in about 150 ms by a single answer token over a closed list of sixteen intents, with a confidence that comes from the model's own distribution rather than from its prose. Nothing about that is the model's decision: which intents justify which kind of proposal is a table in the product, and how sure the classifier must be before anything moves is `min_confidence` in `.metistry/rules.yaml` — your hand, your risk tolerance, one line. It does not turn on by itself, it costs nothing when it does (an off-machine provider is refused at load, not at the bill), every verdict including the ignored ones is readable back off the proposal and the `runs` row, and with it unconfigured the inbox behaves byte-for-byte as it did before — which is a test, not a promise. The threshold is fitted on your own labelled messages by `metistry-eval intents`, never guessed: a number nobody measured is not a risk tolerance.

- 2026-09-26 — **One API for every client, and the console cannot serve a route the contract does not list.** The Mac app, the PWA and a future phone now build against one published table — every route's reach, which credentials it admits, how a retry behaves, what a conflict says — held to the running console by a test that probes every route with every kind of credential. The console checks the table before it dispatches anything, so a new door cannot ship undocumented, and a client can tell which contract version it is speaking to from any response, refusals included. The live-changes vocabulary (ids, never bodies, owner-only) is frozen in the same place.

- 2026-09-26 — **What an integration may do is a closed list the product owns, and the refusals are in the schema.** Every connection Metistry will reach — a calendar, a mailbox, Linear, an MCP server — is now described by a `connection-type` manifest, and the same registry loads Metistry's own units and the owner's extensions, so a plugin is never a second-class path. What a plugin cannot do is enforced where it is read, not asked of its author: a mail provider that declares `send` is refused by name, because nothing in Metistry sends mail; a calendar capability outside `read`, `write_own`, `rsvp` is refused; an OAuth client with a `client_secret`, or a loopback redirect without PKCE, never loads — which is what lets Metistry ship one public Google client that no user has to register and no Metistry server sits behind. A connection names its secrets and never holds one; a tool's default is Ask; and a unit that fails any of it is skipped with the reason while everything else keeps running.

- 2026-09-26 — **The Mac app talks to its console in about a millisecond and a half, and still never holds the token.** Every request used to be a whole `metistry console call` process — about 141 ms median on a scratch instance — which is fine for a script and wrong for a board that repaints. The app now keeps one `metistry console session --stdio` child per instance: JSON lines in, JSON lines out, matched by id, ~1.5 ms median for the same request (100 sequential calls, 0 failures). The CLI still resolves the owner token, once, refuses any console that is not this machine's loopback before reading a line, and redacts the token out of every line it writes — so the app gained speed without gaining a credential. A child that dies fails what was in flight rather than hanging it, and the next request starts a new one; an install whose CLI predates the verb falls back to one process per request. The same child carries the live-changes stream (§2.20) once the console serves it, and a conflict's reason and the row as it stands now reach the app whole.

- 2026-09-26 — **Every Mac screen can now be built before its route exists, against what the console really says.** MetistryKit has one store protocol per domain and one method per client-API route — 114 methods over fourteen stores — and a recorded fixture for each: 64 recorded from a scratch console (the real server and handlers, the scratch database, nothing leaving the machine), 50 written from the contract for the routes still ahead of their tickets. A test drives every method with the request its fixture was made from, so a store that sends a field the console would refuse fails before a view is written on it — the old typed client's dispatch call, which omitted the required `brief`, is exactly that kind of bug and the store's version sends it. When a ticket serves one of the frozen routes, the recorder refuses a recording whose shape does not match the contract fixture unless the ticket says why — so "the view was built against the right shape" is checked by the tool, not remembered. The Mac's non-API surface is closed at the type as well: a management command can only be one of the eighteen CLI verbs §2.2 lists.

- 2026-09-26 — **The contrast check reads the ground a colour is painted on, not the one somebody declared.** Three chips once shipped below AA while CI passed them, because it checked them on `surface` and they were drawn on a tint (review-00 §3.4). `build-design-tokens.mjs --check` now fails when a stylesheet rule paints a token on a ground `tokens.json` does not declare, when a quiet fill is not declared under its own ink, when a hex colour in the web CSS or the design mockups is not a token, and when anything maps the pinned brand accent to the user's system accent — so a new chip, a new mockup or a new Swift view cannot introduce a colour the contrast table has never seen.

- 2026-09-26 — **A stolen browser session can no longer mint a key.** Registering an agent or rotating its token creates a credential that works from anywhere, so it now takes the owner *on the Mac the console runs on*: the local owner token, which the console accepts only over a connection from that machine. A passkey session — the phone, the PWA, even a browser on the same Mac — is refused with a sentence that names the Mac app, and the attempt is written to the ledger. The rule is read off the client API's route table at the gate, before any handler runs, so a future route marked `local` is enforced the moment it is served, and the conformance test checks every route's reach for every kind of credential. `metistry connect` works as before.

- 2026-09-26 — **Every surface calls a request by the same word, from one table.** The kind → type mapping the owner reads (twelve types, each with one body from a closed set and its own primary verb) lives once, in core; the Needs You query and the morning brief read it instead of keeping copies, which had already drifted into calling an agent's request to act a *note*. A request kind the table does not know is shown as a report the owner can only dismiss — it can never be approved into a consequence nobody reviewed.

- 2026-09-26 — **A test can no longer reach your install's database.** Every database-backed test in the product used to build its own connection, most without a port and all with a fallback database name — so on a Mac running Metistry, a shell with just the database password set sent a test run at the live install's Postgres (it failed on authentication; nothing was touched). There is now exactly one way a test opens Postgres, and it refuses unless it has been given a scratch database by name, refuses any name that is not unmistakably scratch or that an install on the machine is configured with, and — once connected — asks the server which database it is really in before handing the connection over. CI fails any test that builds a connection of its own.

- 2026-09-26 — **The privacy policy describes the architecture instead of promising over it.** The draft for metistry.ai (`docs/product/website/privacy-policy.md`) can say "we can't see your data" because nothing exists to see it with: the maintainer runs no service that receives user data, the code carries no telemetry, and the only doors off the machine are the ones the owner configured — which the confined processes cannot get around (2026-09-19). Its one uncomfortable sentence is the true one: with a cloud model chosen, the context a turn needs — calendar details included — goes to that provider under the owner's own account. Beside it, `docs/product/website-brief.md` turns the record into the site's copy source for the designer: eight pillars, a 123-row feature inventory marked built or planned by wave, a sourced comparison with the neighbours the research studied, four diagrams, and the homepage and policy requirements Google's OAuth verification sets for Calendar — so the site can ship before the app's daily screens, and say which parts are previews.

- 2026-09-26 — **Answering an agent's ask for access can only ever give less, and an agent that has run out of asks is no longer invisible.** Revising an access request used to check only that the new folder was well-formed, so the narrowing gesture could grant a wider or unrelated folder than the agent asked for. The console now refuses any revision that is not the asked folder or one inside it, and the refusal changes nothing: not the grant, not the request card. Granting more is a separate decision the owner makes on Agents, with the whole credential in view. The answer also reports the tier the agent held before, so a client can say plainly when Approve swaps "every title in the vault" for "one folder". And when an agent hits the two-decline ceiling, the tool's refusal writes a record that the Agents panel lists beside that credential, instead of the refusal leaving no trace the owner could see. Tests cover a wider folder, a sibling, a look-alike name and a folder elsewhere, and check that nothing is written for any of them.

- 2026-09-26 — **Activity shows what the schedule did, and only when it did something.** A routine's run was invisible on the timeline, so the plan the system wrote overnight left no trace there. Routines now have their own Activity group and chip. A run that acted names what it wrote, a run that skipped names why, and a run that failed shows as failed. That state comes from the run's own `ok` column, never from reading the English in its detail. A tick that found nothing to do is not a row, because a timeline that reports every tick of a scheduler is one nobody reads. That rule is a `WHERE` clause with a test, not a display preference.

- 2026-09-26 — **What an agent may do is now one table, drawn from the door itself, and printed the same everywhere.** Every agent — the assistant, a crew, an external tool — resolves to one actor, and its permissions are a Resource × Read × Write table (Knowledge, Work, Artifacts, Inbox, Queries, Agents, then connections) in which a cell is filled only when `may()`, the one decision function every door asks, would say yes; an empty cell is a dash and anything not listed is not granted. Each tool's cell is data beside the set of ruled tools, pinned by a test to that set and to the document describing it, so a tool added later cannot silently go undrawn. The CLI, the console and the Mac app print the same strings, held together by tests on one recorded fixture. Two doors closed on the way: minting a second "assistant" credential over the API is refused before anything is written (only external agents are minted there), and a crew's definition — its prompt and its model, now named in the definition itself — is edited only by the owner's hand (`metistry agents define`, refused when stale), never by the assistant.

- 2026-09-26 — **The board says what a card waits on, and only the owner can read that.** The board now has five columns, and each label is the word the server sends (Backlog, Assigned, In Progress, Blocked, Done). A label can no longer drift from its value, and "Needs You" names only the request queue. Whether a report came back is a mark on a Done card rather than a column nobody could drag to. A card blocked on one of the owner's own todos shows that line, *waiting on you: …*, from the same predicate Today uses, so the two screens can't disagree. Adding that line made the query owner-only: the owner's words travel only through the owner's door, and an agent asking by name gets the answer it would get for a query that doesn't exist.

- 2026-09-26 — **An answer that did nothing never reads as an answer.** Every button in Needs You that changes something — applying a prompt improvement, running an agent's action, turning a suggestion into work, letting an agent in, granting it an area — now fails the same way: the request stays in the queue with the reason written on it (`payload.error`: what failed, which answer, when), so every device shows a failure rather than a decision and the owner still has one to make. There is no silent retry, and a crash stores no detail. Before this only one of those doors wrote the reason, and approving an agent that had since been revoked quietly closed the request while letting nobody in. Each door now has a test that breaks it — a refusing service, a throwing one — and checks the row, not the response.

- 2026-09-26 — **Deferring a task in the app writes the owner's own words, in English, and nothing else.** *Tomorrow*, *Next Week* or *Someday* on Today writes one `do <date>` or one `someday` onto the line the owner typed — the same spelling the grammar reads and `formatTaskLine` writes, never the Tasks plugin's `⏳` or a `#someday` tag (K6), so the note stays readable in a diff and in any editor. It is the Tick door's safety carried over whole: the line is judged in the note against what the owner saw, an edit in Obsidian a moment earlier wins, a line the door cannot prove it changed by exactly the day is refused, and nothing in it is reachable by an agent or a proposal. `due` — a date the owner set — is never moved. *Someday* is now a real state rather than a missing date: the filter vocabulary gains a `someday` flag, so a template or a view can find everything deferred to no day.

- 2026-09-26 — **A secret goes only to the servers you listed for it, and comes back as its name.** Every outbound call that uses an owner-named secret passes one door in the product's core, just before the connection is encrypted: the request is written with `{{ secret.name }}` still in it, and the door fills the value only when the destination is exactly a host on that secret's *Sent only to* list, the caller holds a grant for it, and the call is over https. Look-alike hosts, another port, a redirect, a secret in a URL, and — for a request to a model provider — a secret anywhere in the body are all refused before the Keychain is read or a byte is sent, each with a code that names the secret and the host and never the value. On the way back the value is replaced by `***REDACTED secret.<name>***` in the response, its headers and any error, including when a server echoes it JSON-escaped, URL-encoded or split across two chunks of a stream — so a model never receives a value, and a transcript still says which secret was there. Each call that sent one stamps the name on its run, which is where the Secrets list's *last used* comes from.

- 2026-09-26 — **A request that mirrors something elsewhere is one card, and it stays until the thing itself changes.** A pull request waiting on the owner's review, an invitation, an assigned issue: each is now a request with a `source`, and the database holds one pending row per subject — a sync that sees the same PR on every pass, or an agent that raises it again, gets the first row back instead of adding a copy. Such a mirror no longer expires after 14 days like everything else in Needs You (a review is still owed on day 15); it leaves only when its source changes, as *resolved at source*. Both rules are enforced by the table — a unique index and a shape CHECK that refuses a source that could slip past either — not by each sync remembering to check. Rows can also share a group now, which is what lets a meeting's notes and to-dos be answered as one card.

- 2026-09-26 — **Renaming the assistant is a setting, and changing how the system behaves always leaves a trace.** The owner can now change the assistant's name, mention and mark with one verb (the Settings pane's *The Assistant* fronts it), through the same protected door as every other behaviour file — validated first, refused whole, nothing half-written. And every change to a protected file that the reconciler accepts now lands in Activity as a record of its own, whichever door made it: the CLI, the Compute pane, the prompt overlay, an update. A setting that changes how the system behaves is never silent.

- 2026-09-26 — **You can push to your vault from anywhere, and Metistry never forces.** Until now the reconciler's hourly push was a bare `git push`: the first time the owner pushed from another clone or edited on GitHub, every later push failed as non-fast-forward, forever. Now every push fetches and integrates first — a fast-forward, a rebase of only the reconciler's own never-published acts, or a merge that leaves the owner's commits exactly as they were — and the whole result is built off the working tree before a single file moves, so a conflict is known before anything is touched and there is never a half-done rebase to abort. A conflict pushes nothing, overwrites nothing, keeps local commits flowing, and raises exactly one Needs You report naming the files and both sides; the next clean sync clears it. The ban is enforced at the tool: the reconciler's git wrapper refuses every force, hard reset, deleting refspec and history-rewriting subcommand before git is ever exec'd, and a test records every argv it runs to prove it.

- 2026-09-26 — **Keeping a closed Mac awake is the owner's administrator change — explained, warned against, stored, and never made for them.** The keep-awake setting is now a switch with two sub-switches (`{ enabled, sleep_on_battery, sleep_lid_closed }`) beside the four values every existing install already has, and both sub-switches default to the safe answer, so nothing keeps a laptop awake on battery or in a bag unless the owner asked. Asking for the lid prints the one command that delivers it (`sudo pmset -a disablesleep 1`), how to undo it, and why it is not recommended — it is the whole Mac, every app, across restarts — then stores the answer and runs nothing; doctor reads `pmset -g` and says whether the owner's change is in effect, "unknown" rather than "off" when it cannot tell. The guarantee is a test, not a promise: every `pmset` argument list the product may pass is a named read, and a sweep of every package, app and the Mac app fails the build on any other.

- 2026-09-26 — **The Knowledge screen can show what the assistant learned last night, and the owner's drafts are the owner's again.** The evening fold has been written to `Journal/Fold/<date>.md` every night since Phase 6 and could only be read by opening Obsidian; now the app finds the newest one, and the pages it names, in one read. Drafts — hidden from every agent door by the same rule that hid them from the owner too — are now listed for the one person who can settle them, and for no one else: the route refuses any principal that is not the owner before it runs anything, and the generic query door and `/mcp` answer the name as if it did not exist, even to an agent granted the very folder the draft sits in. Areas come back described (their index page's line) and with *why* they are in front of the owner — last changed, named by last night's fold — as facts, never a score.

- 2026-09-26 — **A screen hears about a change when it happens, and the channel it hears on cannot carry the change itself.** Every client used to poll — Chat every second or two, Activity and the board every ten — and a Mac view would have been one more poll. The console now streams what changed: seven database triggers say which row moved (never what is in it), one listener in the console turns that into typed events, and every open client refetches the thing through the route that already decides who may read it. A tool call in a chat turn reached a subscriber in 273 ms on the scratch instance, against a one-second target. The stream is the owner's alone — an agent's key and the capture token are refused at the door — and it is *incapable* of carrying a body: every event passes a guard of exact fields, each an id, a name or a count, before it is numbered, so nothing the routes would withhold can leak through it. A client that drops and comes back gets exactly what it missed, or is told to refresh when too much has; a revoked session stops hearing within one heartbeat. A daily Update Check now tells every open client when a newer release is out, without ever installing it.

- 2026-09-26 — **The Mac window has its eight rows, and its one badge never pulls the floor out.** The sidebar is Today · Chat · Activity · Work ▸ · Knowledge · Agents · Scheduled, with Needs You above them only while something is waiting — the product's only badge, mirrored on the Dock. The row leaves on the owner's next navigation after the count reaches zero, never before: answering the last request leaves them on *Nothing needs you* with the row still there, a count answered from the phone does not shift the sidebar under a pointer about to click, and a count the app could not read is treated as unknown, not as zero. Every shortcut is a menu item built from one closed table, so a screen can light up an item that exists but never invent one, and the single-letter keys (Approve is *A*) exist only while a list has focus — a dimmed menu item would still swallow the letter from a text field, so the key is not attached at all. Labels carry the configured name and a test reads every label and every string in the shell's source for the word "assistant"; another puts each view in a real window and walks the tree VoiceOver reads, failing on a control that says nothing.

- 2026-09-26 — **No secret is shared between instances any more, and moving off the shared scope loses nothing.** Keys the owner once kept once per Mac — a compute provider's, Devin's, AWS's — are copied into each instance as its own named secret, by the next `metistry update` or by `metistry secrets migrate-scope`; a key the instance already has wins, and rerunning changes nothing. The migration cannot delete a Keychain item — the tests hand it a Keychain that refuses — and the shared originals are removed only by `metistry secrets purge-shared`, which previews first and removes an original only once every instance on the Mac holds its own copy. An instance that has not migrated keeps running exactly as before; `metistry doctor` names the one command to run.

- 2026-09-26 — **"Decisions are never queued" is now a property of the Mac app's transport, not of each screen.** Every request any Mac screen makes passes one gate: the newest answer from the console is recorded as whether it is reachable — no timer decides it — and while it is not, every decision (an answer, a claim, a move, a grant, Run Now, a message — 53 of the 114 routes the app speaks) is refused before it leaves the process, with the sentence the disabled control shows under itself. Reads keep going, because a read is how a console that came back is noticed, and the four things O3 lets a client keep — a capture, a tick, a defer, a rating — still go. A route added later is a decision unless it is named as an append, so the strict rule is the default. A test drives all 114 store methods with the console unplugged and holds the split exactly: no decision reaches the transport, every read and append does, and nothing re-opens the gate but an answer. The Mac-only management verbs sit outside the gate on purpose — restarting a console that is down is exactly when the owner needs them.

- 2026-09-26 — **The vault's history reads as a list of what happened.** Every commit is now one act — a single write, one reply from the assistant, one routine run, or one sweep of edits made in Obsidian — instead of whatever landed in the same 30-second window. `git log` on the instance reads *Morning brief*, *Edits from Obsidian: Alpha, Beta*, *Note from chat*, and each assistant commit carries the turn and the `runs` rows that made it as trailers, so any change in the vault joins back to the activity feed that explains it. The ids are checked at the bridge, so a request cannot forge a trailer; this is also the ground rollback (T10-4…T10-6) stands on — reverting one act means reverting one commit.

- 2026-09-26 — **A secret belongs to one instance, and a second instance cannot reach it.** Owner-named secrets — the GitHub key a connection uses, a provider's API key — live in the Mac's login Keychain under the instance's own id, with their policy (which servers the value may be sent to, which connections and agents may use it, when it expires) in the instance's `secrets.yaml`, never the value. The store the product uses is bound to one instance when it is made and has no way to name another's item, so two instances on one Mac cannot bleed into each other — tested on one shared Keychain, with the second instance holding a word-for-word copy of the first's policy file. The phone and the Mac read the list through `GET /api/secrets`, which cannot carry a value: the console is handed a presence check and nothing that reads one. Setting, replacing and removing a value stays on the Mac (`metistry secrets`), the value on stdin, never an argument; removing one first names everything that references it.

- 2026-09-26 — **The first edit to the owner's own profile is one they approve, line by line.** When the standup runs is now the Standup routine's, not a fact in `Me/profile.md` — so the two old keys move, once, onto the routine, and the profile is only tidied if the owner says so: one Needs You request shows the file before and after, Approve writes exactly that "after" in the owner's name, and a file that changed since is refused rather than merged. Decline leaves the lines, ignored, with one line in doctor. Nothing the assistant or a routine runs can write `Me/` — the reconciler refuses every principal but the owner — so the approval is the only way anything but the owner's own editor changes it, and the session fold's learned facts will arrive through the same door.

- 2026-09-26 — **A 👍/👎 no longer belongs to chat alone.** Rating a reply worked only because a reply is an `outbound_messages` row; a meeting briefing, Next Up's one line, a revision explanation had nowhere to carry a judgement. Rather than teach each new prose surface its own id, the rating keys on `runs.id` — the one id every model turn already logs, wherever the prose it produced. One feedback door, one sibling table, no new id-minting scheme, and the reply's own rating is untouched. Closes design review C33 (B7) in the sibling-table direction it named, not the wider-`reply_feedback` one.

- 2026-09-26 — **On a phone the PWA has one badge, the bell, and five fixed tabs.** The eleven-button strip is gone, emoji included. The count of what waits for the owner now appears in exactly two places: the bell in the header, and at desktop width a Needs You row that appears only while something waits. No tab ever shows a number, so nothing competes with the one signal that means "you are needed". Tests hold both rules against the shipped markup and the painting code: the five tabs, no count inside the tab bar, and the bell showing and speaking the count.

- 2026-09-26 — **Nothing Metistry loads is a list in code any more, and an owner can add their own without touching code.** Collectors, routines, dispatch targets, compute provider templates and connection types are now each a registry built from the directories that hold them: the product's units and the owner's own go through the same loader, an owner's unit with a product unit's name replaces it until they remove it (Reset to Default), and a unit that is wrong is skipped with the reason while everything else keeps running. `metistry extensions add` is the one door, and it is data-only by construction: it copies a manifest and its notes, refuses anything that could run — a script, an executable, a link, a nested tree — and refuses any unit its registry would refuse, so an extension can pick a new schedule for a product collector or add a private model server as a template, but can never add an action kind, a capability, a TCC grant or a field kind, and never brings code into the console. The closed vocabularies stay the product's; the open ones became directories.

- 2026-09-26 — **The vault's remote cannot change how the system behaves.** Syncing with the remote (T10-3) made "push from anywhere" work — and, for a day, made the remote a write path into configuration: a commit on GitHub touching `.metistry/deployment.yaml` or `CLAUDE.md` would have fast-forwarded into the running instance. Now every fetch is diffed against the merge base before anything moves; a protected path in it — all of `.metistry/`, the root instruction files, case-folded spellings that land on them on macOS — refuses the whole fetch, holds the push, and raises one Needs You report per offending commit naming who changed what and how to undo it (revert on the remote, or take it by hand in a terminal). Configuration stays the owner's hand, enforced at the tool: no prompt, no config line, and no remote can route around it.

- 2026-09-26 — **Every routing decision is on the record before anything is allowed to make one.** The console now writes one audited row per message it routes — which rule served it, the counts a policy would read (length, thread size, recent failures, whether it is the same question again), and what a local policy would have chosen instead — with no message text in it. It runs in shadow, after the reply is already on its way: a policy that answers, fails or hangs changes nothing the owner sees, and the tests hold that byte for byte at the door. `metistry compute route-report` reads it beside the rules' own baseline, so the two weeks of evidence the owner asked for before any policy may serve start accumulating from this release, with the policy's latency, its disagreements with the owner's own overrides, and its outcomes all counted.

- 2026-09-26 — **Scheduled speaks the owner's language, and refuses what it cannot apply.** Every routine and sync now has a name a person reads (*Morning Brief*, *Inbox Sort*, *Usage Rollup*), and every field Scheduled shows carries where it came from — *default*, *from your profile*, *yours* — resolved over the manifest, `Me/profile.md` and the owner's `scheduled.yaml`, with the next run beside it. Housekeeping (Inbox Sort every 5 minutes, Usage Rollup hourly) sits with the routines; the rest are syncs whose Needs You rules are declared toggles. A change the owner's file makes that the manifest does not allow — a config key a routine does not take, a raise rule a sync does not declare, an entry in the wrong section — holds that component and says why, instead of being silently ignored. And the console gained exactly one protected path, `.metistry/scheduled.yaml`; a test walks every other protected path and proves it still cannot write any of them.

- 2026-09-26 — **Routines run once, at their time — and a Mac that slept owes one run, not three.** The runner had no notion of time of day, so the evening fold and tomorrow's plan ran hourly with clock gates inside them. It now fires every routine at its slot (`nextOccurrence`, hand-rolled over `Intl`, both daylight-saving nights tested in four zones including Lord Howe's half-hour jump) in the owner's own zone — the schedule's, then `Me/profile.md`'s, then `METISTRY_TZ`, and never UTC by default. Slots missed while the lid was shut coalesce into one run on waking for the latest slot, launchd's own rule, and a late run plans from its slot: tomorrow's plan caught up at 07:30 Monday plans Monday. The owner's `scheduled.yaml` is read on every tick; a file that does not validate holds what it names instead of silently un-pausing it, and a schedule the runner cannot place says so once a day rather than guessing Monday to Friday. The acceptance test is a week of ticks, one a minute: every shipped routine fires exactly at its §2.5 default, once per slot.

- 2026-09-26 — **Metistry can keep the owner's daily note current without being able to touch the rest of it.** The daily note is the owner's page, and until now the only safe rule was that nothing else wrote it. The reconciler now has one narrow door into it: a section between two marker lines, which the Morning Brief fills at 7:00 AM and Close the Day rewrites. The door replaces those bytes and nothing else — it proves every other byte of the note is exactly what the writer last read, re-checks its own output, and refuses with a sentence naming the line when the markers are broken, doubled or quoted in a code block, rather than guessing where the owner's text ends. Only the two writers the design names may use it; the assistant and every agent are refused at the bridge, so generated prose cannot reach the owner's note however it is asked. Checked over 400 generated notes and 1,600 successive writes: the bytes outside the markers never changed.

- 2026-09-26 — **Every conversation is kept for a month, redacted at the tool, and then it is gone.** Each turn the assistant finishes — a chat, a fold, a routine's turn — is archived with the system prompt exactly as it was sent, what was said, and every tool call with what it was asked and what it answered, so Run detail can show the working conversation itself and the session fold has something to learn from. Arguments and results go through the same redaction pass as everything else before the row is written, inside the store, so no caller can forget; the row expires in 30 days on the database's clock; and a daily purge deletes what has expired — unfolded or not, because the fold must read a session before it goes, and a purge that spared unread rows would make a stopped fold into an archive that never empties. Purge Now is the Mac's alone and cannot delete by accident: without an explicit confirm it only answers what it would cost, naming the sessions the fold has not read yet.

- 2026-09-26 — **The Mac app's shared components check their own colours and refuse a bare confirmation.** Every word and mark the shared components draw — agent prose, the agent chip, the facet row, the permissions table, the request bodies, the states, the stale band, Undo and confirm — declares the ground it is painted on, and a test holds each one to 4.5:1 (3:1 for a glyph or an outline) against that ground in light and dark. On its first run it caught a real fault the token checker could not see: the outline every control uses measures 2.94:1 on the stale band's grey (2.62:1 in dark), so that band's one action is drawn without an outline. An irreversible act's confirmation cannot be built unless it names what is lost and its button names the act — no *OK*, no *Are you sure?* — and every reversible act gets ten seconds of Undo instead of a dialog. The assistant is called by the name the owner gave it in every chip and attribution; the permission words live in one place, so the pending choice between *Allow · Ask First · Never* and *On · Ask · Off* is a one-line change.

- 2026-09-26 — **A tick in the app is the owner's hand, and provably nothing more.** Ticking a task on Today writes the owner's own note — the first time the app edits a line the owner typed — so the door is built to be incapable of anything else: it takes a key and a boolean, never a patch; it finds the line in the note (not the index, which can be five minutes behind) and refuses with the line as it stands if the text is not what the owner saw; it writes with the note's hash so an edit in Obsidian a moment earlier wins; and the edit itself re-parses its own output and refuses any line where more than the box and one `done <date>` would change. Undo is the same door in reverse and gives back the note byte for byte. Nothing in it is reachable by an agent or a proposal, and no model is anywhere in it. `Idempotency-Key` makes it safe for the PWA's offline outbox to replay.

- 2026-09-26 — **A variable can never hold a secret, and never a schedule.** Variables are the plain values an owner shares across connections and agents' instructions — a team name, an org, a list of repositories — referenced as `{{ variable.name }}`. Because agents read them, the tool refuses anything that would turn one into a leak: a value that looks like a key, token or password is refused with *Store as Secret*; so is a value equal to one of the instance's own secrets (compared on the Mac, naming only the secret), a secret's name, and a value that tries to template a secret in. The refusals hold when the file is read as well as when it is written, so a hand-edited file carrying a key does not load anywhere, and no error ever repeats the value. Per the owner's ruling that timing lives on routines, a variable also refuses a schedule or a time — `standup_time`, a timezone, `09:15`, a cron line. Set on the Mac (`metistry variables`); the Mac and the phone read the list, with where each one is used, through `GET /api/variables`.

- 2026-09-26 — **The owner can see where the vault stands against GitHub, and choose when it syncs.** Until now the reconciler pushed on an hourly timer set by an environment variable, and nothing anywhere said whether the vault on this Mac matched the one on the remote. The sync policy is now a two-line block in the instance's own `deployment.yaml` — push after every commit, on an interval, or never on its own; pull on an interval, with no way to switch it off while a remote exists — set with `metistry vault settings` through the same protected write as every other configuration change, and picked up without a restart. One status (ahead, behind, the last commit and push, any conflict, the policy in force) is read by the app, doctor and the API alike, and the console relays it through a strict schema, so the route can never carry a note's content. While a conflict stands the schedule pushes nothing and keeps pulling, so the next clean integrate is what resumes it.

- 2026-09-26 — **A card can say what it is about, and only the owner can rewrite that.** Work rows gain a short description, the first thing the card detail shows, so context no longer has to be crammed into titles. Whoever creates a card may describe it once. After that only the owner edits it, from the board, even while a crew holds the card. The agent tool that updates a task has no description field at all, so an agent that filed a card can never quietly change what the card claims to be. The limit sits in the tool, not in a prompt.

- 2026-09-27 — **"Projects" stopped meaning two different things on the same screen.** The dashboard's Work ▸ Projects sheet showed the real per-project rollup — mode, budget, cap — beside a second list that was really `work` grouped by area, both unlabelled and both implicitly "Projects" (C82). The area rollup is now `areas_overview` (`projects_overview` stays loaded as an alias for one release so nothing calling it by the old name breaks), and the dashboard panel and the morning brief's section both say **Areas**.

- 2026-09-26 — **Every version of a note can be looked at again, and nothing but the owner can look.** The vault has always been a git history, but nothing the owner holds could read it: the app had no way to ask what a note said last Tuesday, or which of the assistant's acts changed it. A note's history is now two read-only routes — its commits, newest first and followed across renames, each naming who it was written for and the run or turn behind it; and the note as it stood at any one of them. They are the base restore and roll back are built on. The guard is at the tool, twice: the console and the reconciler each refuse anything that is not a note (`.metistry/`, artifacts, the root instructions) and any revision that is not a plain commit id, so no ref or option ever reaches git, and no agent credential reads a note's past — a history holds what an edit since took out.

- 2026-09-26 — **A request on the Mac can only be answered as it was shown, and a card never claims more than it knows.** Every Needs You answer carries the moment the owner saw the request; if the request moved meanwhile nothing is sent, the card redraws the current version under one sentence saying so, and the owner's typed words survive. A meeting's Accept All and Decline All wait ten seconds behind Undo before anything goes — there is no verb that takes an answer back, so the only honest Undo sends nothing until the window closes — then answer one part at a time, in order, and report *4 of 5 accepted* with the reason for the fifth rather than "failed". Revising an agent's access request composes the folder under the one it asked for, so the control cannot express a wider grant at all; the console still refuses one. A body the request cannot fill is drawn as partial with the reason, never invented, and an answer the app cannot deliver yet is a control that says why it is off. The card reads the type, the word and the answers from the server, so a new kind of request renders the day the server learns it.

- 2026-09-26 — **The Mac's Needs You list cannot bulk-approve, and cannot decide anything while the instance is unreachable.** Selecting many requests offers exactly three verbs — Later, Skip, Decline — because the type the selection is answered through has no case for Approve: an `action` approved in bulk would run five briefs on one gesture, so the verb does not exist here rather than being hidden. Decline is always a `deny` with its consequences, and Skip lives only on a selection. When the console stops answering, every verb, the band's Retry and the menu's single-key shortcuts go dim with the reason printed under them, and the list refuses before anything is asked — a decision is never queued. A partial batch is reported as what it is (*2 of 3 declined*, one answered elsewhere, one still pending and still selected) with a Retry that re-sends exactly the unapplied rows and the reason the owner gave. The list reads the owner's word for each request from the console's one type table, so a stored kind never reaches the screen.

- 2026-09-26 — **A project can now hold its own read grant, refused by the exact same rule an agent's grant already is.** `PUT /api/projects/:slug` takes a `grants` field — `{tier, areas, queries?}` — and runs it through the console's `validateGrants`, the identical function `PUT /api/agents/:id/grants` uses: the bare vault is refused (that spelling is the internal assistant row's alone) and every area must be vault CONTENT, so `.metistry/`, `Artifacts/…` and a traversal are refused before anything is written. No new validator, no second place a "what's grantable" rule could drift from the one agents already trust (migration 0032). The column sits unread until T4-7 unions it into a member's effective reach, "via project" — this ticket is the table and the door alone.

- 2026-09-26 — **Any agent can now ask the owner several questions at once, and the answers can be in the owner's own words without ever becoming instructions.** Until now only the assistant could ask, one question at a time, and the server accepted nothing but the options it offered; other agents could only file reports — one of whose kinds was also called `decision`. Now the assistant's decision block and every agent's `requests_create` (kind `question`, no new tool) ask up to five pick-one or pick-any questions, each ending in *Something else…*; the owner's answers are stored per question and checked against the questions as stored, and no answer — an option or free text — is ever executed (C105). At the same time the answer door stopped keeping its own list of what a request may be answered with: it reads the one request table, so a report can only be dismissed or acted on, never "approved" into something it was not. The report kind for a decision made is `decided`; the old name is still accepted (C104).

- 2026-09-26 — **The assistant's router can now propose how to handle a message — and can only propose inside the lines the owner drew.** A table in the owner's own `rules.yaml` reads cheap facts about each message (its length, the thread's size and recent failures, whether it is the same question again) and, on-device and only when the table asks, what the message says and how much it asks for; the first matching row picks an operation from a closed list and a tier from the owner's allow-list, within the owner's caps. The table is checked when it loads, every refusal naming the line to fix; at run time a choice that would switch a live conversation to another model, or reach a query or crew that isn't loaded, is held back, and a scorer that is down, slow or off-machine leaves the message on the route it takes today. It runs in shadow: every choice is recorded beside what was actually served, with no message text, and nothing the owner sees changes until the two weeks of evidence and the confirmatory eval say it should.

- 2026-09-26 — **The standup writes itself, on your working days, and only then.** At 08:00 on a working day the Standup routine renders your `Templates/Standup.md` into `Journal/Standup/<date>.md` — yesterday's done lines, today's, what is blocked — with no model involved, and Today swaps *Standup at 8:00 AM* for the file the moment it lands. With no working days in `Me/profile.md` it writes nothing and says so rather than guessing Monday to Friday; it never overwrites a standup file you have taken over; and the seeded template's *Yesterday* list, which a filter slip had kept permanently empty, now shows what you actually finished.

- 2026-09-27 — **Activity on the Mac answers "what happened while I was away" without forty tool calls.** A reply's tool calls fold under the reply, which says its model, time and cost; new rows wait behind a *12 new* pill instead of shifting the list you are reading; a failed run is marked on its glyph from the run's own `ok`, never guessed from its wording; and the plan a routine wrote this morning shows with the spark and opens as prose, while a routine that could not run says so without looking broken.

- 2026-09-27 — **Today can say who is in a meeting and open that meeting's own note, and the invite's dial-in codes never leave the Mac's calendar.** Every calendar now lands in one table, one row per occurrence, so a Monday standup's note is that Monday's and moving a one-off meeting keeps its note. Each attendee arrives with an address and an answer, and links to a person page only when exactly one page the owner wrote claims that address. *Open notes* renders the owner's own meeting template as the owner's hand, once per meeting; a second tap, a restarted console, or two taps at once all return the first note, and the door never overwrites a file. The invite body is kept out by construction, not by instruction: the bridge never asks for it and drops it if sent, the table has no column for it, and both calendar reads are refused on the door agents use.

- 2026-09-27 — **A capture from the Mac is never written twice and never silently lost while the app runs.** The composer behind the + mints one idempotency key when the owner presses Capture and carries it on every resend — the offline queue's, Retry's, Capture pressed again on words that came back — and the console answers a key it has already written with the original row, so a reply lost after the write replays as the same capture with the same inbox id instead of a duplicate. The popover never waits for the instance: the words move into a pending receipt, closing cancels nothing, and Esc keeps an unsent draft. No answer at all is a queue that resends itself as soon as the instance is reachable; an answer that refuses is shown in the console's own words with the text back in the field. The receipt is exactly what came back — the inbox id and the vault path — never a classification the endpoint has not made yet.

- 2026-09-27 — **Chat on the Mac never moves the text you are reading, and never attributes a tool call it cannot prove.** A reply that lands while you are scrolled up is appended silently and announced once; the only thing that moves the transcript is you — your own send, or pressing *↓ New Reply* — which a test holds in a real window by scrolling up, delivering a reply, and checking the viewport did not move a point. The working indicator falls silent as facts arrive: three dots only until a tool name exists, then the tool, the count and the seconds, and at a minute with nothing back it says exactly that, never "stuck"; under Reduce Motion the dots hold still and the count carries the liveness. Each turn's tool calls are joined to the message that started it through the id the engine stamps, never by guessing from timing — so a reply the screen did not watch shows no strip rather than someone else's. Sending is a decision: it is refused with the reason while the instance is unreachable and a failed send keeps your words; Stop is drawn and says the console has no way to cancel a turn yet, instead of pretending.

- 2026-09-27 — **Closing the day writes the owner's daily note, and cannot write anywhere else in it.** Close the Day puts what the day did — what was done, what moved and to when, and the owner's own line for tomorrow — into the one Metistry section of `Journal/<date>.md`, between its two markers, through the section operation that is incapable of touching a byte outside them; then tomorrow's plan renders at once instead of at 11 PM, and again on a second close. When the owner has deleted or broken the markers, Metistry does not guess where their text ends: nothing is written into the note, a Needs You request says exactly what is wrong and on which line, and the rest of the close still happens. It is facts only — no model is anywhere in it — and a tick made a moment before the close still counts, because the doors' own record is read beside the index.

- 2026-09-27 — **A provider's key is this instance's secret, and the engine still never touches the Keychain.** `metistry compute providers add` stores the key through the same code as `metistry secrets set` — under this instance's own Keychain account, recorded in `secrets.yaml` as sent only to the provider's host — and `compute.yaml` holds a reference, `{{ secret.openrouter_api_key }}`, never a key; nothing in `metistry compute` reads the old per-user account. The engine (no shell, sandboxed) reads the key from its environment as `METISTRY_SECRET_<NAME>`, which only the owner's `metistry secrets sync --to env` writes, from this instance's item, and only for secrets a provider references — a console door that handed out values was the alternative, and "a value never crosses the API" rules it out. Existing installs keep working through the update: old files load, `migrate-scope` rewrites the reference, and a running engine keeps reading the line it started with for one release. Providers also gain a switch — switched off means not searched, not offered, and not assignable, refused by the schema so "off" can never mean "still answering turns" — and `billing: subscription`; and the catalogue is searched by model, one row per model with a line per place it runs, where an id the identity table cannot map stays its own row rather than being merged on a guess.

- 2026-09-27 — **Metistry can reach the owner's MCP servers, and the file is the allowlist.** A connection is one file the owner writes with `metistry connections add` — an MCP server by URL or by command — and Metistry holds one pooled client per connection. Every tool the owner has not listed is refused before anything is dialled: no command is started and no request leaves the machine for it, and a tool at *Never*, or at *Ask First* without the owner's approval, is refused the same way. The agent's own credential is never forwarded to the server — the transport's headers and a command's environment are built from the connection file and nothing else, so no install token, database password or agent bearer can reach a third-party process — and a secret is filled only at the moment it leaves, only for a host on that secret's *Sent only to* list, and redacted from whatever comes back. A key pasted into a connection file where a name belongs is refused rather than stored, and the Mac and the phone list connections by name, status and tool mode without ever seeing a value. New connections start with the owner's defaults: reads allowed, changes and anything that starts an agent asked first, and nothing offered to agents until the owner says so. One gap is stated rather than hidden: a server started as a local command is not yet network-confined.

- 2026-09-27 — **Agents reach the owner's services without ever holding the key, and the tool list stops growing with them.** Two tools on `/mcp` stand in front of every connection the owner will ever add: one lists what the caller was lent, the other calls a tool of it through Metistry's own client, which fills the credential only at egress and redacts what comes back. A connection's own tools are fetched when asked for and never listed up front, so a forty-tool server costs every turn nothing. Lending is two decisions the owner wrote down — the connection offered to agents, and granted to this agent (a crew must also name the `connections` group) — and a connection the caller was not lent answers exactly like one that does not exist. This release runs Reads set to Allow and says why it refuses the rest; every call, refusals included, is a line in the audit.

- 2026-09-27 — **What needs the owner arrives where the owner looks.** A routine that failed, a secret that stopped half the collectors and a sync conflict in the vault each used to show only on its own screen, or as a push that said so once a day. Each is now a request in Needs You: the failed routine with when it last worked, when it failed, and Try Again; the missing secret as one request naming everything it stopped; the conflict with both versions side by side, ready for Keep Mine or Take the Other. None of them piles up — one per fault, never twice while it waits, not again once answered until the thing has recovered — and each leaves the queue on its own the moment the routine runs, the secret is set or the copy is gone.

- 2026-09-27 — **The owner's Linear issues arrive on their own, and the key cannot go anywhere but Linear.** A Linear connection is a personal API key and one `metistry connections add`; every fifteen minutes the Linear sync reconciles the issues assigned to the owner into Metistry's work list — state, priority and a link back — and raises one Needs You task for each, which clears by itself when the issue is closed or handed to someone else, and returns if it comes back. *Add to Today* turns one into a task line for today through the capture service, and pressing it twice gives back the first capture rather than a second line. The key is filled only at the moment a request leaves, only for `api.linear.app`, only when the owner has granted it to that connection: a connection pointed at another host, a request to another origin and a redirect are each refused before anything is sent, and anything that comes back is redacted. The sync can read and nothing more — a request that is not a read query is refused before it leaves — and no path of it writes the owner's own notes.

- 2026-09-27 — **The Mac hears what changed instead of asking every 30 seconds.** One event stream per instance tells the app which store changed — ids and counts, never bodies — and only that screen refetches, through the route that already decides who may read it; the Needs You badge and the Dock move the moment a request is raised or answered. When the stream drops, every screen falls back to polling on its own clock at once and the stream resumes from the last event it heard, so a dropped connection costs freshness for a few seconds, never a missed change: the console replays the gap or says *resync* and everything visible refetches.

- 2026-09-27 — **A meeting knows its note, and an attendee can reach their person page, without any guessing.** The walk now keeps two small derived maps: a calendar event to the meeting note that names it, and an email address to the People page that lists it. A person is matched only on an address the owner wrote on a page of their own. The walk ignores names, titles, and pages an agent created, and an address two pages both claim matches neither. The owner's rule was that a wrong person page on a briefing is worse than none, and that rule now lives in the tool rather than in a prompt. Only the owner can write into the meeting-notes folder, so no agent can plant a note that claims the owner's meeting.

- 2026-09-27 — **One Morning Brief, and the model can only touch the lines it was asked for.** At 7:00 on a working day the Morning Brief writes its own file from your `Templates/Brief.md` — the standup embedded by reference (it lands at 8:00; nothing is regenerated), today's meetings under Next Up, what is waiting on you — and keeps the Metistry section of your daily note current between its markers, model-free, never creating the note and never guessing past a broken marker. The routine calls no model: every generated line — the brief's paragraph, each meeting's prep line — comes from one assistant turn with its cost in Usage, and the tool that writes it compares the file with what the routine wrote and refuses any change but those pending lines, each one line of prose, each left marked as written rather than retrieved. Generated text cannot reach your own note: the section's writer list never includes the assistant, and a test fills every slot and checks the note byte for byte.

- 2026-09-27 — **Tomorrow's Plan waits for the fold, and closing the day gives you one early.** The plan now runs at 11:00 PM on the eve of a working day — two hours after the 9:00 PM Knowledge Fold — and links tonight's fold with the decisions it recorded, straight from the fold's own header, with no model involved. Close the Day renders it early, so it is there when you stop; the 11:00 PM run replaces that early copy with the fold's context, and closing again simply re-renders. Friday and Saturday evenings plan nothing and say why (`not_a_working_eve`), and the plan's "tomorrow" is read in your configured zone, never the container's UTC.

- 2026-09-27 — **Joining a project is a grant, and leaving one takes it back — enforced at the door, drawn with its source.** Every agent in a project now inherits the project's own read grant: its reach is its own grant ∪ its projects', computed per request where its bearer is resolved and never copied into its row, so removing it from the project removes the inherited folders on its very next call (asserted end to end on `/mcp`: the knowledge read and `queries_list` go from allowed back to refused). The permissions table on every surface — the CLI, the console, the Mac app — marks each inherited line *via project <slug>*, so access that arrived through a project never hides among an agent's own (screen 13: "the one place inheritance could otherwise hide one"). The instance's assistant inherits nothing: its reach stays its configuration.

- 2026-09-27 — **The phone stops asking and starts hearing.** The PWA subscribes to the console's live-changes stream, and a new request, an agent's reply or a card that moved reaches the screen when it happens instead of on the next 2.5–30 second poll. The stream still carries only ids and counts: the view refetches through the route that already decides what it may read, so it opened no new read path. Polling did not go away — it became the fallback, held by a test that runs the clock for ten minutes on a healthy stream and counts zero poll ticks, then drops the stream and counts them all coming back. Checked in a real browser against a stub console: no chat fetch in five seconds live, three in seven and a half with the stream refused, none once it was back; the browser's reconnect carried `Last-Event-ID`, and a stream it gave up on reopened fresh and reloaded what was on screen.

- 2026-09-27 — **The phone answers what it can read, and opens what it can't.** Today and Needs You reach the PWA as the Mac draws them: the day as a spine with the Morning Brief on top, and every request with its type's own answers. Swiping a request on the phone approves or declines it — but only where that answer is a plain decision on the row, and never on a card with Before and after: an access grant, an edit to `Me/`, a knowledge conflict opens instead, because approving a consequence you have not read is not a decision. The rule is one function the list reads, held by a test that drags a finger across such a row and sees nothing sent. A question is answered by choosing, never by a swipe; a mouse drag never answers; Decline sits in the neutral surface, not red. Ticking a task from the phone goes through the same Tick door as everywhere else — the line's text as seen, a replayable key, and the line as it stands if the note moved.

- 2026-09-27 — **The phone's Move to… lists the moves it will not make, and says why.** Work on the PWA is one board column at a time, and a drag becomes an action sheet: every other column is listed, a move the task service would accept is a button, and one it would refuse is shown disabled with the reason — *nothing claims a blocked card — unblock it first*, *drey-dev holds it — only the one holding a card closes it*. The rule is read off the service's own statements, and a test walks every card shape against a model of their WHERE clauses both ways: nothing offered is refused, nothing refused is offered. That also retired a lie the old board told — Done and Release were offered on any card and refused by the server unless you held it. Knowledge arrived on the phone (the fold, what needs your eye, the areas), an artifact's comments sit on their lines as counts, and an agent's permissions read as one row per resource with its Read and Write lines; defining an agent stays on the Mac, so the phone no longer offers the two doors a passkey session could never open.

- 2026-09-27 — **A sync conflict is settled with one press, and neither side is lost.** When two devices edit the same note, the sync tool keeps both and Needs You shows them side by side. Keep Mine or Take the Other now settles it from the Mac app or the phone: one note is written in the owner's name, the copy goes, and the review leaves the queue. The side given up is committed to the vault's history first — a copy the sync tool made was never in git, and would otherwise be gone for good after the ten-second Undo — so it is always one history view away. A press made against an old view (the note edited since, or the conflict already settled on another device) changes nothing and shows the conflict as it now stands.

- 2026-09-27 — **A note can be put back as it was, and only the owner's Approve does it.** Asking to restore a note to an earlier version writes nothing: it raises one Needs You request showing the note now and the note then, answerable from Knowledge or the queue. Approve writes the old version back as a new commit in the owner's name, so the history keeps every version — including the one it replaced — and nothing is ever rewritten. The guards are at the tool: a note that changed since it was looked at is refused rather than overwritten, twice (at the ask and at Approve); configuration and artifacts are refused even for the owner, because rolling back how the system behaves is the CLI's; and no agent credential can raise a restore or approve one — a restore-shaped request any other writer planted restores nothing.

- 2026-09-27 — **A day of agent writes can be rolled back, and the rollback undone — history keeps both.** `metistry vault rollback --to <day>` (or one commit, or one file) previews what it would undo, raises one Needs You request, and on Approve makes a single new commit in the owner's name that puts the files back; rolling that commit back restores the day exactly. Nothing is ever reset, rebased or forced — the reconciler's git layer cannot run those commands at all — and an uncommitted edit or a later change to the same lines refuses the rollback rather than being overwritten. The guards are at the tool: only the `user` principal can roll back, whichever credential asks; the route is local-only, so a stolen phone session cannot reach it; and configuration is never rolled back by the console — it is left as it was and named, and only the owner's own terminal, with `--include-config` and after Approve, can put it back.

- 2026-09-27 — **Everything recurring can be seen and changed from any client, and nothing but the owner's own file changes.** Until now a routine's time lived in a product manifest and a pause meant editing YAML on the Mac. Scheduled now lists every routine and sync with where each setting came from — the product's default, the owner's profile, or the owner — when it runs next and what it did last, and lets the owner move a time, pause, resume, reset to default, change a sync's cadence or run anything now. The guard is at the tool: every change is one validated edit of `.metistry/scheduled.yaml`, written as the owner through the reconciler with their comments kept, refused before anything is written if it would not fit the routine; no door can name a manifest; a broken file is never overwritten; and what a routine *runs* — its actor, task and read-only grants — changes only from the Mac, never from a phone's session. Run Now respects a pause (and says so) and the spending limits, so asking twice or asking over budget costs nothing.

- 2026-09-27 — **A card never acts on something the owner didn't see.** Every request in Needs You now carries a fingerprint of what it is about, as it stood when the card was drawn — a pull request's head commit, a task's own words, the work row an action would change — and an answer given to a card whose subject has since moved is refused before anything happens: no action runs, no grant moves, nothing is written, and the card comes back showing what is there now. It is narrow on purpose: a new comment on a pull request is not a new question, a new commit is. Held by a test per subject that changes it under an open card and sees nothing sent.

- 2026-09-27 — **Anything that keeps failing stops, and says so once.** A routine or a sync that fails three times in a row is no longer run — no more calls, no more spend — and the owner gets one request about it, not one per failure: a routine's existing failure card turns into *stopped after 3 failures* with Try Again, and the next clean run clears it by itself. The same for money: when a spending limit set to Stop is reached, every routine that would have spent is paused and one request says so, names what it paused, and offers Raise; it clears itself when the window resets or the limit moves. Both are held by tests that count the rows — one per fault per streak, one per budget window — against a real database.

- 2026-09-27 — **Today is served, and the order you drag is kept — but only for the day it is.** The Mac and the phone read one route for the day: your notes' open lines owed on or before it, what an agent is waiting on you for, your meetings in your own zone, and whether the brief, standup and plan exist yet. What Today shows is a `where:` filter like any other (`due <= <date> or do <= <date>`), compiled by the same parser the templates and the All view use, so the list is one you could paste into a template and get back. Your drag order is stored server-side, and the door that stores it refuses — by name, writing nothing — any key the day does not hold: a line owed tomorrow, a work row that is the Board's, a key nobody has. The table can only ever hold an arrangement of rows you were shown.

- 2026-09-27 — **The Mac's Today is organised by when, not by what kind of thing.** The day is one column hung on the clock — meetings at their time, your own lines placed in the gaps where you would actually do them, in the order you dragged them into — with a NOW line that stays put as you scroll and the morning folded to one line, so opening Today at 2 PM shows 2 PM. What doesn't fit before the day ends is shown, never refused, and a bar in the header measures the calendar against your working hours in one sentence. Ticking stays one click with Undo; if you edited the line in Obsidian meanwhile, the app shows the line as it now stands and writes nothing — a test holds that it makes exactly one call and no retry. The order you drag survives a reload because it is stored whole, and a test proves it against a fresh window. All shows the vault through the same `where:` language a template uses, copyable both ways; two saved views the language cannot yet express are drawn dimmed with the reason rather than approximated.

- 2026-09-27 — **The Mac's Today now starts and ends the day.** The morning opens on the brief — one paragraph, marked as written rather than retrieved, with the standup a click away to copy — and the brief folds to a line once read so it never crowds the day. Half an hour before a meeting, Next Up shows who is in it and what you owe them, tickable in place. When the calendar leaves no room to focus, it offers one move and names who will be told before anything changes. At the end of the day, Close the Day sends each open line to tomorrow, this week or someday and writes the day into your note — and if your note's section is broken it says so and shows the request, instead of pretending it worked.

- 2026-09-27 — **What compute cost this month is one click away, and it never guesses.** The Mac's Usage gauge opens the month against your spending limit, a bar per day up to today, who spent it (chat, each agent, each routine), the cache rate, AWS kept apart from compute, and the calls nothing could price counted as $0 rather than hidden. At a limit it says what actually happened — stopped, critical calls only, or still running — with Raise one click from the setting. There is no "on pace for" figure anywhere: the popover reports what was spent, not what might be.

- 2026-09-27 — **The repository is ready to be read by anyone.** Identifiers
  that belonged to one install (a tailnet host, a home directory, a personal
  domain, the owner's name in fixtures) became example values, and the
  owner's runbook (`docs/ops/going-public.md`) removes them from history too,
  rehearsed on a clone with every count at zero. The release path is locked
  down for outside contributors: CI runs read-only on `pull_request`, the
  signing and notarization secrets are readable only by the four jobs that
  declare the `release` environment and only after the owner approves the run,
  and only the owner can create a `v*` tag. Security reports go to GitHub's
  private vulnerability reporting (`SECURITY.md`). Positioning: invariant 8 —
  security that survives full code visibility — now has the code visible.

- 2026-09-27 — **One command updates everything the owner runs, the app
  included.** `metistry update` used to move the product under the Mac app
  and leave the app itself on whatever Sparkle last installed, so a terminal
  update could leave a new product behind an old front end. On a launchd Mac
  it now installs the same release's DMG too, under the same gate as the
  runtime pack — sha256 against the release's `checksums.txt`, then bundle
  id, version and (signed builds) codesign and Gatekeeper on the exact copy
  that lands — and swaps it in with the previous bundle kept for
  `--rollback`. Safe to leave running because every edge is a refusal with a
  test rather than a prompt: it never escalates privileges, never quits a
  running app unasked, never downgrades, never trades a signed app for an
  unsigned one, and never fails the product update it rides on. Doctor's
  `app` row makes "the app is behind the install" a visible, one-verb fix.

- 2026-09-27 — **An update's fixes land in the update that installs them.**
  The owner's move to 0.14.1 took three runs: the `metistry` shim runs the
  release an update is leaving, so every step after the switch — migrations,
  restart, the owner bearer, the lock — was the old code, and a fix to any of
  them waited for the next update. `metistry update` now hands everything
  after the switch to the release it just installed (a re-exec of that
  release's own CLI, same flags and environment), so from 0.14.2 on one run
  is enough. Safe to leave running because every edge is a refusal with a
  test: an environment marker refuses a second hand-over, a release whose CLI
  predates it is never handed to, and a new CLI that cannot start is told
  apart from one that failed by a handshake file — the old code then
  finishes the update, exit 1, with the exact rollback command. The same run's
  other two surprises are gone too: a newly minted owner bearer restarts
  only the reconciler that reads it (over the supervisor's control socket,
  never the supervisor itself), and a reconciler slow to come back defers
  the lock write with the one command instead of failing the update.

- 2026-09-28 — **Running out of credits says so, once, where the owner looks.**
  The owner's 0.14.2 instance hit OpenRouter's `402 … requires more credits`:
  the turn was tried again, failed quietly as *that turn failed*, and nothing
  said what would fix it — while the ask behind it was the model's whole
  65,536-token window, not the answer's size. Now a provider that refuses the
  account (402, 401, 403) is never retried; it raises one Needs You report
  per provider and error class naming the top-up page and how many turns are
  waiting, pauses that provider (turns are held, not sent) until the report
  is dismissed or a turn gets through, and tries one held turn every ten
  minutes so a top-up is enough. Every call now asks for at most the tier's
  `max_output_tokens` (default 8192). The same report found a second silent
  failure: the instance's `Me/Profile.md` was invisible to a product that
  reads `Me/profile.md` exactly — the bridge now answers *Me/Profile.md
  exists*, and `metistry update` renames such files to the seed's spelling
  in two commits, touching nothing the seed does not ship. Safe to leave
  running because each is a code path with a test: rules and budgets still
  decide first, the pause only stops asking a provider that already said no,
  and a rename the reconciler cannot commit is put back.
