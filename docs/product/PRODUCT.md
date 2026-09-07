# Metistry — product context (living document)

> Not a launch document. This accumulates product/marketing-relevant context
> **as features, implementation, and guardrails are designed**, so the launch
> material can be written from a record instead of reconstructed from memory.
> Convention (see `CLAUDE.md`): when a decision in the build has product
> significance — a goal sharpened, a benefit proven, a safety mechanism
> shipped, a premium candidate identified — add a line here in the same PR.

## What it is

A local-first personal AI operating system: a persistent assistant + knowledge
graph that holds your context so sessions don't have to. Agents are
disposable; state is durable — markdown in git (what you know) and Postgres
(what's happening). Open source (Apache-2.0); each install is a private
instance the user owns entirely.

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
  churn.
- **A system one person can run for years.** Every dependency is a
  maintenance obligation; recipes over frameworks; small enough to understand.
- **Useful from any surface** — web app first, plus share sheet, Shortcuts,
  and (later) an iOS app — and to any agent the user runs, not just its own.
- **Predictable cost.** Deterministic routing, no-model fast paths, budgets
  enforced at the tool. (Idle cost is the #1 documented abandonment reason
  for personal AI in 2026 — Metistry's architecture is built against it.)

## Benefits (proven, not aspirational — keep receipts)

- Status questions answered in <200 ms with no model call (measured: 0.6 ms
  cached / 24 ms uncached).
- Free on-device classification tier (Apple FM, 2.2 items/sec measured);
  free local tier-scoring candidate (gemma4:e4b, 97.9% on eval fixtures).
- Sessions survive restarts; knowledge survives everything (git is the
  record — `docker compose down -v` loses nothing durable).
- Coordinates *other* agents (any vendor, via MCP): shared knowledge with
  scoped permissions, shared task list with atomic claims, capture from any
  AI tool the user works in.
- **The door opened 2026-08-30** (Phase 2 done-when, measured): a status
  question answered inline off the deterministic fast path with a
  freshness stamp and no model call; a real model turn round-tripped
  through the full stack (web API → durable queue → Agent SDK engine →
  reply) in 3.6 s on the cheap tier, with per-turn token/cost audit rows.
- Work/personal separation that is mechanical, not disciplinary: separate
  instances, separate repos, code flows down as releases, data flows nowhere.

## Safety considerations (the differentiator — record every mechanism)

The design principle throughout: **enforce at the tool, never by prompting.**
Measured basis: prompt-level guardrails failed every test in Phase 0 research
(a local model leaked a live OTP into a "safe" field despite explicit
instructions; input filtering missed memory-poisoning 9/10 times).

- Sole-writer vault via a restricted commit tool; sub-agents and external
  agents can propose, never write.
- Reader/writer separation: sessions that read third-party content hold no
  commit or memory-write tools (memory-poisoning defense, architectural).
- Deterministic redaction of model *output* before it's treated as safe.
- Scoped, default-deny, user-granted read tiers for external agents; grants
  server-side on tokens; every grant/read/decision audit-logged.
- Agent identity stamped server-side; an agent's message can never carry
  user authority.
- Preview-confirm on destructive actions shows canonicalized resolved
  targets (defense against the GhostApproval CVE class).
- TCC-privileged native bridges as stably-signed, single-purpose binaries;
  behavioral health probes (permission APIs lie; probes don't).
- A watchdog with zero model/API dependency that can tell the user the
  system is broken — including cost-runaway detection conventional
  monitoring can't see.
- Contrast for positioning: the category leader's ecosystem had 40k+ exposed
  instances, 341 malicious marketplace skills, and prompt-injection RCE in
  2026. Metistry's answer is structural, not reactive.
- **Open-design security (invariant 8):** built assuming adversaries — human
  and AI — read the source. No security through obscurity; boring standard
  primitives; misuse tests ship with every interface; and no implicit network
  trust — every request authenticates as if internet-exposed, because the
  category leader's worst incident (40k+ exposed gateways) was exactly a
  "the network will protect us" default.
- **Passkeys only — no passwords anywhere** (2026-08-29). Sign-in is Face
  ID / Touch ID; nothing for a server breach to spill, nothing to phish,
  nothing to reset. Enrollment and recovery root in the machine the user
  already owns (a one-time QR from `metistry init`); sessions are
  revocable per device; lapsed sessions re-auth in one tap without ever
  dropping a capture or silencing notifications.
- Hardened by pre-implementation review (2026-08-29): the engine has **no
  shell and no raw git** — its tools are its entire reach (invariant 9);
  host bridges authenticate every caller (loopback is not a trust
  boundary); management endpoints take the owner credential only, never an
  agent token, and every agent-authored field is output-encoded in the UI.
- **Bring-your-own routing:** the project exposes configured ports and
  suggests exposure patterns per hosting model (local + tailnet, reverse
  proxy, cloud, Docker) but never depends on any — a user benefit (host it
  anywhere) that is also a security benefit (no assumed-safe network).

## How to use (the story, current shape)

`npx metistry init` → name your assistant, get a private instance repo →
open its web app, share to it, ask it things → it remembers, briefs you each
morning, and coordinates your other AI tools. The knowledge is yours, in
your git, on your machine.

## Premium candidates (collect; decide later)

- **Native iOS app** (named by the user as the likely paid addition): share
  extension, real push, offline queue, widgets — against the same open API.
  Planning doc: `docs/product/ios-app-plan.md` (2026-09-01) — notably, the
  APNs relay a self-hosted instance needs is itself the first natural
  *hosted* premium component: the premium story funds its own infra.
- (speculative, unvalidated — record as they arise:) hosted/cloud profile
  management, premium coordination dashboards, managed signing/notarized
  bridge binaries.
- **Hosting tier matrix (owner direction, 2026-09-01):** (1) self-host
  free — the whole system, nothing withheld; (2) self-host + paid iOS
  app; (3) FSL-hosted instance with usage limits as a separate plan.
  E2E-encrypted throughout — even FSL's relay/hosting cannot read user
  content. "Hosted never means readable" is the positioning line.

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
  contract, so the instance split makes the work/personal boundary
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
