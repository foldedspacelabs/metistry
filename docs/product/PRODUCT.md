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
- Separation between contexts that is mechanical, not disciplinary: separate
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
  LiteLLM; `docs/research/2026-09-agent-proxy-routing.md`): "support any
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

