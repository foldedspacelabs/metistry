# UX direction — expressive, discoverable interaction (2026-09-01)

> Status: **direction, not design.** Recorded now so the eventual UX
> improvement plan (to be built with a frontend UX dev + designer) starts
> from the owner's intent instead of reconstructing it. Applies as one
> design language across **web and Apple (macOS + iOS)** — the desktop client is the same SwiftUI codebase as the phone (`desktop-app-plan.md`, 2026-09-07).

## The theme

The user should never have to *remember* the interface. Slash commands,
`@agent` references, and tiers all remain — as the **power-user layer** —
but every one of them gets a discoverable, expressive surface:

- **Buttons and menus over memorized syntax.** A composer affordance that
  exposes commands (`/note`, `/status`, `/deep`, `@agent …`) as tappable
  choices; typing `/` or `@` opens the same menu inline for the halfway
  power user.
- **Rich request–response dialogues.** When the assistant needs input, it
  asks with a structured prompt — options, defaults, a free-text escape —
  in the style of Claude's question-answer flows, rather than expecting
  the user to phrase a reply correctly. Proposal triage, elevation grants,
  and clarifying questions all fit this shape.
- **Actionable notifications.** Simple questions, prompts, and permission
  grants answered from the push itself — quick-action buttons, never
  requiring the app to open. (Web push actions where supported; APNs
  categories on iOS. The API contract: any outbound prompt carries its
  answer-options as structured data, so every surface can render them.)
- **Easy model selection.** Tier choice as a visible, tappable control
  (with the instance's own tier menu from `rules.yaml`), not a memorized
  `/model` incantation — which stays for power users.

## Quick links & targeted actions (owner addition, 2026-09-01)

Everything the assistant surfaces should be a **door, not a dead end**:

- **Deep links from the brief and notifications** — a project mention links
  to its status panel; a knowledge reference deep-links to the note
  (`obsidian://` or the console's knowledge view); dashboard links for
  metrics; source/news links where an item came from outside.
- **Quick actions on any topic** — "summarize this", "what's the latest on
  X" as one-tap asks that dispatch a targeted request to the assistant,
  pre-scoped to the item the user is looking at.
- Mechanically this extends the structured-prompt payload: outbound items
  carry `links[]` and `actions[]` alongside the text, and every surface
  (PWA, notification, iOS) renders what it can.

## Design consequences to honor when the plan happens

- **Structured prompts become an API shape**, not a UI trick: outbound
  messages need a `prompt` payload (question, options, default, deadline)
  that the PWA, notifications, and iOS all render — one contract, three
  surfaces. This slots into the existing `outbound_messages.kind` design.
- **Discoverability is generated, not hand-maintained**: the command menu
  should render from live `rules.yaml` + the agent registry (OPT-3's
  generated `/help`, promoted to UI).
- **Answers carry no more authority than a typed reply** — a quick-action
  tap on a grant prompt goes through the same server-side authz as the
  management API (CRIT-7 rules apply to notification actions too).

## APNs relay privacy bar (owner emphasis, same date)

The FSL push relay (see `ios-app-plan.md`) must ship with a **strong,
provable privacy argument**: **end-to-end encrypted and private — even the
relay cannot see your content.** Concretely: payload-free wake-and-fetch
as the baseline, and where any payload ever rides a push, it is encrypted
to a key held only by the user's devices (the relay transports ciphertext
and an opaque device token, nothing more). Open relay source, and a design
that makes leakage structurally impossible rather than policy-forbidden —
the same enforce-at-the-tool bar as everything else. Launch-blocking for
the relay, not a nice-to-have.

## Hosting & monetization tiers — SUPERSEDED 2026-09-07

The three-tier plan below was replaced by a single strategy: **fully
open source, everything free.** The Mac app is the primary distribution
channel (it installs, configures, connects, and updates the system —
`desktop-app-plan.md`), shipped through GitHub Releases with auto-update;
the iOS app is free too; there is no hosted plan. The privacy claim
stays the through-line: the open-source core proves the design, and the
payload-free push relay — now a small free community service with its
code in the repo, self-hostable by anyone with an Apple developer
account — proves infrastructure can be blind.

<details><summary>Original (2026-09-01) for the record</summary>

1. Self-host, free. 2. Self-host + premium iOS app. 3. FSL-hosted
instance with usage limits as a separate premium plan.

</details>
