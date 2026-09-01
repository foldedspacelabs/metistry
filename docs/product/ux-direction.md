# UX direction — expressive, discoverable interaction (2026-09-01)

> Status: **direction, not design.** Recorded now so the eventual UX
> improvement plan (to be built with a frontend UX dev + designer) starts
> from the owner's intent instead of reconstructing it. Applies as one
> design language across **web and iOS**.

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
provable privacy argument**: payload-free wake-and-fetch only, no user
content or metadata beyond an opaque device token transiting FSL, open
relay source, and a design that makes leakage structurally impossible
rather than policy-forbidden — the same enforce-at-the-tool bar as
everything else. This is a launch-blocking requirement for the relay, not
a nice-to-have.
