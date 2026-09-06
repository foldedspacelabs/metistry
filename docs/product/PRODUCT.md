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
