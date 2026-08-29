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
**actionable distilled knowledge, managed by a trusted advisor.** The root is
the ancient word for *practical* wisdom — not knowing everything, but the
cunning, situational judgment of the counselor archetype: close to one
person, loyal, turning what's known into what to do. The `-try` suffix reads
as a craft or practice (artistry, chemistry, mastery) — metistry as *the
craft of counsel*. Public copy should **hint at this, never explain it**
(the README models the register: "a nod, not an acronym"); the myth-literate
get the reference, everyone else gets the ethos. Note the standing rule:
the assistant's default name lives only in an instance's `identity.yaml` —
naming lore in public copy stays about the *project*.

## Goals

- **Your context outlives any session, agent, or vendor.** The vault and
  operational state are yours, in formats (markdown, SQL) that survive tooling
  churn.
- **A system one person can run for years.** Every dependency is a
  maintenance obligation; recipes over frameworks; small enough to understand.
- **Useful from any surface** — iMessage, share sheet, web app, Shortcuts,
  (later) iOS app — and to any agent the user runs, not just its own.
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
- **Bring-your-own routing:** the project exposes configured ports and
  suggests exposure patterns per hosting model (local + tailnet, reverse
  proxy, cloud, Docker) but never depends on any — a user benefit (host it
  anywhere) that is also a security benefit (no assumed-safe network).

## How to use (the story, current shape)

`npx metistry init` → name your assistant, get a private instance repo →
text it, share to it, ask it things → it remembers, briefs you each morning,
and coordinates your other AI tools. The knowledge is yours, in your git, on
your machine.

## Premium candidates (collect; decide later)

- **Native iOS app** (named by the user as the likely paid addition): share
  extension, real push, offline queue, widgets — against the same open API.
- (speculative, unvalidated — record as they arise:) hosted/cloud profile
  management, premium coordination dashboards, managed signing/notarized
  bridge binaries.

## Log

- 2026-08-28 — document created. Phase 0 complete (14 PoCs), Phase 1
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
- 2026-08-29 — naming roots recorded (distilled counsel / trusted-advisor ethos; hint-don't-explain register for public copy).
