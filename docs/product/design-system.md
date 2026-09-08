# Metistry design system (2026-09-08)

> One design language across **PWA (every platform)** and the **SwiftUI
> multiplatform app (macOS + iOS)**. It exists so the native app copies a
> settled interaction instead of inventing one (`desktop-app-plan.md`
> sequencing step 2), and so the PWA stops being a wireframe.
>
> **Scope.** Tokens and components are normative — a screen that needs a
> value not in `design/tokens.json` needs a token added, not a literal.
> Screens are illustrative: the information architecture is normative, the
> pixel arrangement is not.
>
> Companions: `ux-direction.md` (what the interaction must feel like),
> `desktop-app-plan.md` (the panel table), `ios-app-plan.md`,
> `docs/research/2026-09-codegraff-review.md` (presentation lessons).

| Artifact | Path |
| --- | --- |
| Token source of truth | `docs/product/design/tokens.json` |
| Generated custom properties | `docs/product/design/tokens.css` |
| Generator + contrast checker | `ops/scripts/build-design-tokens.mjs` |
| Live component sheet (light + dark) | `docs/product/design/preview.html` |
| Annotated wireframes | `docs/product/design/*.svg` |

---

## 1. Principles

Ten, each one a rule this system already has. A design decision that
cannot be traced to one of these is a preference, and preferences lose.

### P1 — Agent text is data, never chrome

Every string an agent or the assistant wrote renders inside a container
that is visibly *quoted*: the `agent` tint on the attribution, an
`agent-quiet` wash behind the body, and never the typography of a
control. A tool result never looks like a button; an artifact comment
never looks like a system notice; an error message from a bridge never
borrows the failure styling that the console's own checks use.

*Why:* CRIT-7 and invariant 8. `esc()` stops agent text from *becoming*
markup; this principle stops it from *looking like* the interface. Both
are needed — an unescaped string is an injection, a well-escaped string
styled as a confirm button is a confidence trick.

### P2 — Silence is the default, so the surface is calm

The system is quiet unless something needs a person. That means: no
badge that counts things nobody has to act on, no colour on a row that is
merely *recent*, no animation on arrival. Colour is spent on exactly
three things — the accent (one interactive hue), state (ok / degraded /
failed / absent), and presence. Everything else is neutral.

*Why:* the product's promise is an assistant that does not demand
attention. An interface that decorates every event teaches the owner to
ignore it, and then the one row that mattered is ignored too.

### P3 — Destructive actions confirm, and the confirmation states the reason

Revoke, rotate, delete, flip a project to autonomous, force a dispatch: a
confirmation that names the consequence in the same words the tool would
use, with the destructive verb as the affirmative button and Cancel as
the default. Never a bare "Are you sure?".

*Why:* **enforce at the tool, never by prompting.** The UI confirmation
is not the control — the server-side authz is — but the UI must never
imply an action is cheaper than it is. The copy comes from the same
reason string the API returns when it refuses, so the two can't drift.

### P4 — Refusals are explained where they happen

When a drop is refused, a bundle queues instead of dispatching, or a
grant tier hides a note, the boundary that caused it is shown *inline, at
the point of the gesture* — "queued: `mode: review` on `metistry`", not a
toast that says "failed". A refusal is a fact about the system's shape.

*Why:* invariant 2 and §4.21. The autonomy boundaries only build trust if
they are legible; an unexplained refusal reads as a bug.

### P5 — State is reported, never inferred

Presence chips come from lease liveness and delivery evidence, not from
"we saw a request recently". `absent` is a first-class state distinct
from `failed`: a collector that was never configured is not broken. If a
panel cannot answer, it says *unavailable* and the rest of the page still
renders.

*Why:* invariant 1 (Postgres is derived — a missing row is normal) and
the codegraff lesson "never dress a mailbox agent as working".

### P6 — One information architecture, three renderings

Feed, Chat, Agents, Projects, Artifacts, Capture, Triage, Dashboard,
Status, Devices — the same ten destinations, the same order, the same
names on macOS, iOS and the web. Only the navigation *chrome* changes:
sidebar, tab bar, or responsive both. Nothing exists on one platform
that has no home on the others.

*Why:* the native app is a second client of the **same open management
API — no private endpoints** (`ios-app-plan.md`). If the API is shared,
the map should be too, or the owner learns the product twice.

### P7 — Native where the platform has an opinion

Use the platform's own control for the platform's own idea: SF Symbols
and Dynamic Type on Apple, `NavigationSplitView` on macOS, `TabView` on
iOS, `.confirmationDialog` for P3, `UNNotificationAction` for actionable
push. On the web, the system font stack, `prefers-color-scheme`,
`prefers-reduced-motion`, and real `<button>`/`<dialog>` elements. No
webfont is ever loaded; no framework is added to draw a chip.

*Why:* HIG conformance is free accessibility (Dynamic Type, VoiceOver,
Increase Contrast, Reduce Motion all arrive with the standard control),
and invariant 7's "no dependency without a reason" applies to the front
end as much as the back.

### P8 — The chat is modelled on iMessage, deliberately

The conversation with the assistant borrows the interaction people
already know from Messages, and the borrowing is written down so later
decisions have somewhere to appeal: **bubbles**, each aligned to its
sender (yours trailing on `accent-quiet`, the assistant's leading on
`surface`); **timestamps on demand** — a day separator and a tap, not a
stamp on every line; **a single-line composer that grows** with the
text; **one `+` button** that opens the actions menu (§3.6); and
**tapbacks** as the lightweight feedback affordance on a turn, rather
than a row of buttons under every reply.

What is *not* borrowed: read receipts, typing indicators (P2 — the
working state is a word, §3.4), and anything that animates on arrival.

*Why:* the fastest interface to learn is one already learned. Chat is
the surface the owner touches most; novelty spent there buys nothing.
Described, never copied — no Apple asset, string or name is taken.

### P9 — The transcript never moves under you

The message list scrolls **only when the reader is already at the
bottom**. If they have scrolled up — normally to re-read what the agent
said while composing the reply — an arriving message must not move the
viewport, must not re-render the rows already on screen, and must not
take focus from the composer. A **"↓ New Reply" pill** appears at the
bottom edge instead; tapping it scrolls, and nothing else does. Focusing
or typing in the composer never scrolls the list.

The rule holds for every polled list — feed, artifact threads, triage:
**a poll is a repaint, not a navigation.**

*Why:* a client that scrolls on every poll destroys the thing the reader
was reading. This is the one case where being helpful by default is
hostile, and it is a rule rather than a preference because otherwise
every new polled list rediscovers it.

### P10 — Title Case names things; sentence case says things

A copy rule, about rendered strings only — the repo's path- and
identifier-casing rules (`CLAUDE.md`) are untouched by it.

| Case | Applies to |
| --- | --- |
| **Title Case** | screen titles, section headers, navigation and tab-bar labels, table column headers, card titles, menu-group headings, the names of the ten destinations |
| **sentence case** | body copy, helper text, placeholders, empty-state prose, receipts, error messages, and buttons — verb-first per the HIG ("Send", "Allow", "Request Changes" are control labels and take Title Case; "queued — will send when the instance is reachable" is prose and does not) |
| **as-is, always** | identifiers — agent ids, slugs, tool names, file paths, query names, `mode:` values, tier names. Rendered in `mono`, never case-corrected, because `drey-dev` is a key, not a word |

**Where it is applied matters as much as the rule.** Title Case is a
*rendering*, applied in the view layer and never written to the
database, and it is applied only to strings the system itself composed.
An agent-authored subject or body is data (P1) and is never
case-corrected — the two principles meet at §3.2's allow-list of feed
kinds, which is the only place in the system where a stored subject is
re-cased.

*Why:* this console sets machine identifiers beside human labels on
every row. When both are lowercase the reader cannot tell which strings
they could have typed differently and which ones they could not — and
P1's "agent text is data" is easier to see when the chrome around it is
visibly *not* data.

---

## 2. Tokens

`docs/product/design/tokens.json` is the single source. `tokens.css` is
generated and committed so the PWA and the preview page load it with no
build step:

```
node ops/scripts/build-design-tokens.mjs           # regenerate + print the contrast table
node ops/scripts/build-design-tokens.mjs --check   # CI: fail if stale or below AA
```

Custom properties are namespaced `--mt-*`. Nothing in the system uses a
literal colour, a literal radius, or an odd-numbered pixel gap.

### 2.1 Colour roles

Roles, not hues. A role may be re-pointed without renaming a call site.

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `bg` | window canvas | `#f6f7f9` | `#0e1216` |
| `surface` | rows, cards, composer | `#ffffff` | `#171c22` |
| `elevated` | menus, popovers, sheets, palette | `#ffffff` | `#212831` |
| `sunken` | code blocks, wells | `#eef0f3` | `#0b0e12` |
| `border` | row separators, input outline | `#d9dee4` | `#2b333d` |
| `border-strong` | focused input, selected row, table rules | `#b6bec8` | `#3d4854` |
| `text-primary` | body, titles, values | `#12171c` | `#e9edf1` |
| `text-secondary` | metadata that must be read | `#4d565f` | `#a7b1bc` |
| `text-tertiary` | placeholders, de-emphasised hints | `#646d77` | `#8b96a1` |
| `accent` | the one interactive colour | `#2b5fd0` | `#7ea9ff` |
| `accent-hover` | hover/pressed accent surface | `#234ea9` | `#9dbeff` |
| `accent-quiet` | selected row, chip fill, focus halo | `#e6edfc` | `#1b2739` |
| `on-accent` | text on an accent fill | `#ffffff` | `#0b1220` |
| **`agent`** | **agent-sourced tint (P1)** | `#6a4bbd` | `#b9a2f5` |
| `agent-quiet` | agent-sourced background wash | `#f1ecfc` | `#1e1a2c` |
| `ok` | check passed, run succeeded | `#1c7a45` | `#68d391` |
| `degraded` | answering, not healthy | `#8a5a00` | `#e8b84b` |
| `failed` | check failed, run errored | `#b3261e` | `#f4837c` |
| `absent` | not configured — a fact, not a fault | `#646d77` | `#8b96a1` |
| `presence-working` | live lease with recent evidence | `#1c7a45` | `#68d391` |
| `presence-queued` | claimed or waiting behind a cap | `#8a5a00` | `#e8b84b` |
| `presence-idle` | registered, nothing claimed | `#646d77` | `#8b96a1` |
| `presence-interrupted` | lease expired mid-claim | `#b3261e` | `#f4837c` |
| `presence-over-cap` | at max bundles / over budget | `#a24a00` | `#f0a35e` |
| `presence-blocked` | waiting on you or another agent | `#6a4bbd` | `#b9a2f5` |
| `focus-ring` | keyboard focus, 2px, never suppressed | `#2b5fd0` | `#7ea9ff` |
| `scrim` | behind a sheet | `rgba(18,23,28,.32)` | `rgba(0,0,0,.55)` |

**Apple mapping.** Each role names its system-colour analogue in
`tokens.json` (`labelColor`, `secondaryLabelColor`, `separatorColor`,
`controlAccentColor`, `systemGreen/Orange/Red/Gray/Purple`, …). SwiftUI
should prefer the system colour where the mapping is exact and an asset
catalog colour set with the hex pair where it is not — presence and the
agent tint are ours, the rest are Apple's. Semantic colours adapt between
appearances automatically, which is exactly why the roles are named for
purpose rather than value.

**Colour is never the only signal (P2, and the HIG's "don't rely on
colour alone").** Every state and presence value ships a text label and
an SF Symbol / glyph alongside the tint; `failed` also carries a heavier
weight. The preview page is the proof — read it in greyscale and nothing
becomes ambiguous.

### 2.2 Contrast — WCAG AA, computed

Every foreground/background pair declared in `tokens.json` is checked by
the generator using the WCAG 2.1 relative-luminance formula. Text roles
are held to **4.5:1**; chips render at 13px/500 and so are *not* large
text and get no exemption. Non-text roles (the focus ring) are held to
**3:1**. Apple's accessibility guidance sets the same bars: 4.5:1 for
text, 3:1 for non-text.

All 74 declared pairs pass:

| foreground | on | mode | ratio | minimum | AA |
| --- | --- | --- | ---: | ---: | --- |
| `text-primary` | `bg` | light | 16.82:1 | 4.5:1 | pass |
| `text-primary` | `bg` | dark | 15.98:1 | 4.5:1 | pass |
| `text-primary` | `surface` | light | 18.03:1 | 4.5:1 | pass |
| `text-primary` | `surface` | dark | 14.56:1 | 4.5:1 | pass |
| `text-primary` | `elevated` | light | 18.03:1 | 4.5:1 | pass |
| `text-primary` | `elevated` | dark | 12.64:1 | 4.5:1 | pass |
| `text-primary` | `sunken` | light | 15.79:1 | 4.5:1 | pass |
| `text-primary` | `sunken` | dark | 16.44:1 | 4.5:1 | pass |
| `text-primary` | `agent-quiet` | light | 15.57:1 | 4.5:1 | pass |
| `text-primary` | `agent-quiet` | dark | 14.40:1 | 4.5:1 | pass |
| `text-primary` | `accent-quiet` | light | 15.35:1 | 4.5:1 | pass |
| `text-primary` | `accent-quiet` | dark | 12.79:1 | 4.5:1 | pass |
| `text-secondary` | `bg` | light | 6.97:1 | 4.5:1 | pass |
| `text-secondary` | `bg` | dark | 8.65:1 | 4.5:1 | pass |
| `text-secondary` | `surface` | light | 7.47:1 | 4.5:1 | pass |
| `text-secondary` | `surface` | dark | 7.88:1 | 4.5:1 | pass |
| `text-secondary` | `elevated` | light | 7.47:1 | 4.5:1 | pass |
| `text-secondary` | `elevated` | dark | 6.84:1 | 4.5:1 | pass |
| `text-secondary` | `sunken` | light | 6.54:1 | 4.5:1 | pass |
| `text-secondary` | `sunken` | dark | 8.90:1 | 4.5:1 | pass |
| `text-secondary` | `agent-quiet` | light | 6.45:1 | 4.5:1 | pass |
| `text-secondary` | `agent-quiet` | dark | 7.79:1 | 4.5:1 | pass |
| `text-secondary` | `accent-quiet` | light | 6.36:1 | 4.5:1 | pass |
| `text-secondary` | `accent-quiet` | dark | 6.92:1 | 4.5:1 | pass |
| `text-tertiary` | `bg` | light | 4.90:1 | 4.5:1 | pass |
| `text-tertiary` | `bg` | dark | 6.25:1 | 4.5:1 | pass |
| `text-tertiary` | `surface` | light | 5.26:1 | 4.5:1 | pass |
| `text-tertiary` | `surface` | dark | 5.69:1 | 4.5:1 | pass |
| `accent` | `bg` | light | 5.37:1 | 4.5:1 | pass |
| `accent` | `bg` | dark | 8.06:1 | 4.5:1 | pass |
| `accent` | `surface` | light | 5.75:1 | 4.5:1 | pass |
| `accent` | `surface` | dark | 7.35:1 | 4.5:1 | pass |
| `accent` | `accent-quiet` | light | 4.90:1 | 4.5:1 | pass |
| `accent` | `accent-quiet` | dark | 6.45:1 | 4.5:1 | pass |
| `on-accent` | `accent` | light | 5.75:1 | 4.5:1 | pass |
| `on-accent` | `accent` | dark | 8.03:1 | 4.5:1 | pass |
| `agent` | `bg` | light | 5.84:1 | 4.5:1 | pass |
| `agent` | `bg` | dark | 8.55:1 | 4.5:1 | pass |
| `agent` | `surface` | light | 6.26:1 | 4.5:1 | pass |
| `agent` | `surface` | dark | 7.79:1 | 4.5:1 | pass |
| `agent` | `agent-quiet` | light | 5.41:1 | 4.5:1 | pass |
| `agent` | `agent-quiet` | dark | 7.71:1 | 4.5:1 | pass |
| `ok` | `bg` | light | 5.00:1 | 4.5:1 | pass |
| `ok` | `bg` | dark | 10.13:1 | 4.5:1 | pass |
| `ok` | `surface` | light | 5.36:1 | 4.5:1 | pass |
| `ok` | `surface` | dark | 9.23:1 | 4.5:1 | pass |
| `degraded` | `bg` | light | 5.53:1 | 4.5:1 | pass |
| `degraded` | `bg` | dark | 10.20:1 | 4.5:1 | pass |
| `degraded` | `surface` | light | 5.93:1 | 4.5:1 | pass |
| `degraded` | `surface` | dark | 9.29:1 | 4.5:1 | pass |
| `failed` | `bg` | light | 6.10:1 | 4.5:1 | pass |
| `failed` | `bg` | dark | 7.51:1 | 4.5:1 | pass |
| `failed` | `surface` | light | 6.54:1 | 4.5:1 | pass |
| `failed` | `surface` | dark | 6.84:1 | 4.5:1 | pass |
| `absent` | `bg` | light | 4.90:1 | 4.5:1 | pass |
| `absent` | `bg` | dark | 6.25:1 | 4.5:1 | pass |
| `absent` | `surface` | light | 5.26:1 | 4.5:1 | pass |
| `absent` | `surface` | dark | 5.69:1 | 4.5:1 | pass |
| `presence-working` | `surface` | light | 5.36:1 | 4.5:1 | pass |
| `presence-working` | `surface` | dark | 9.23:1 | 4.5:1 | pass |
| `presence-queued` | `surface` | light | 5.93:1 | 4.5:1 | pass |
| `presence-queued` | `surface` | dark | 9.29:1 | 4.5:1 | pass |
| `presence-idle` | `surface` | light | 5.26:1 | 4.5:1 | pass |
| `presence-idle` | `surface` | dark | 5.69:1 | 4.5:1 | pass |
| `presence-interrupted` | `surface` | light | 6.54:1 | 4.5:1 | pass |
| `presence-interrupted` | `surface` | dark | 6.84:1 | 4.5:1 | pass |
| `presence-over-cap` | `surface` | light | 5.97:1 | 4.5:1 | pass |
| `presence-over-cap` | `surface` | dark | 8.25:1 | 4.5:1 | pass |
| `presence-blocked` | `surface` | light | 6.26:1 | 4.5:1 | pass |
| `presence-blocked` | `surface` | dark | 7.79:1 | 4.5:1 | pass |
| `focus-ring` | `bg` | light | 5.37:1 | 3:1 | pass |
| `focus-ring` | `bg` | dark | 8.06:1 | 3:1 | pass |
| `focus-ring` | `surface` | light | 5.75:1 | 3:1 | pass |
| `focus-ring` | `surface` | dark | 7.35:1 | 3:1 | pass |

The three quiet fills — `sunken`, `agent-quiet`, `accent-quiet` — are
declared grounds now rather than assumed ones (added with §4). They are
exactly the backgrounds a long reply sits on: your own turn on
`accent-quiet`, quoted tool output on `agent-quiet`, a code block on
`sunken`. Reply prose is set at 15pt, below the large-text exemption, so
"it's close enough to `surface`" was not an argument worth keeping —
each pair is computed. `agent on agent-quiet` (5.41:1 light, 7.71:1
dark) matters most: it is the tool-disclosure summary, agent ink on the
agent wash, and it was previously unchecked.

`border` is decorative, not a control boundary; `border-strong` is what
a focusable input uses; `scrim` is an alpha layer, not a text pair.

### 2.3 Type scale

Mapped to Apple's Dynamic Type text styles so the SwiftUI app uses
`.font(.body)` and the web uses the same rhythm at the same nominal size.
Apple's default (Large) sizes are the anchor; the `clamp()` gives the web
a fluid range that lands on the Apple size at desktop width and one step
down on a narrow phone.

| Token | Apple style | pt @ Large | Weight | Line | CSS `clamp()` |
| --- | --- | ---: | ---: | ---: | --- |
| `large-title` | `largeTitle` | 34 | 700 | 1.15 | `clamp(1.625rem, 1.35rem + 1.4vw, 2.125rem)` |
| `title-1` | `title` | 28 | 700 | 1.2 | `clamp(1.5rem, 1.32rem + 0.9vw, 1.75rem)` |
| `title-2` | `title2` | 22 | 600 | 1.25 | `clamp(1.25rem, 1.16rem + 0.45vw, 1.375rem)` |
| `title-3` | `title3` | 20 | 600 | 1.3 | `clamp(1.125rem, 1.08rem + 0.22vw, 1.25rem)` |
| `headline` | `headline` | 17 | 600 | 1.35 | `clamp(1rem, 0.98rem + 0.1vw, 1.0625rem)` |
| `body` | `body` | 17 | 400 | 1.5 | `clamp(1rem, 0.98rem + 0.1vw, 1.0625rem)` |
| `callout` | `callout` | 16 | 400 | 1.45 | `clamp(0.9375rem, 0.92rem + 0.1vw, 1rem)` |
| `subhead` | `subheadline` | 15 | 400 | 1.4 | `clamp(0.875rem, 0.86rem + 0.1vw, 0.9375rem)` |
| `footnote` | `footnote` | 13 | 400 | 1.4 | `0.8125rem` |
| `caption-1` | `caption` | 12 | 400 | 1.35 | `0.75rem` |
| `caption-2` | `caption2` | 11 | 500 | 1.3 | `0.6875rem` |
| `mono` | `body` monospaced | 13 | 400 | 1.5 | `0.8125rem` |

**Families.** SF on Apple (`.font(.body)` picks it). On the web,
`-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI Variable Text',
'Segoe UI', Roboto, Cantarell, 'Helvetica Neue', sans-serif`, and
`ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace` for
ids, tokens, diffs and code. **No third-party font is ever loaded** — it
would be a network dependency on a system whose whole claim is that it
works offline and on your own machine.

**Usage.** `headline` for a row's subject; `subhead` for its detail;
`footnote` for metadata (timestamps, ids, "seen 2h ago"); `caption-2`
for chip text. Nothing below `caption-2`, and `caption-2` never carries
information that is not repeated elsewhere. **Assistant and agent reply
prose does not use this scale at all** — it has its own group, tuned for
density rather than scanning (§4).

### 2.4 Spacing, size, radius

**4pt grid.** `space-1` = 4px through `space-16` = 64px. Every gap, pad
and inset is a token; there is no `7px` anywhere in the system.

Common compositions: row padding `space-3 space-4`; card padding
`space-4`; section gap `space-6`; gap between a glyph and its label
`space-2`; gap between chips `space-2`.

**Targets.** `touch-target` 44px (the HIG's stated minimum: controls
should measure at least 44×44pt so they can be tapped accurately),
`pointer-target` 28px on macOS and on a PWA with a fine pointer. A chip
that is *only* a label has no minimum; a chip that is a button does.

**Radius.** `xs` 6 (chips, inline code) · `sm` 8 (small buttons) · `md`
10 (inputs, buttons, rows) · `lg` 14 (cards, message bubbles) · `xl` 20
(sheets, the palette) · `pill` 999 (presence chips, filters).

**Widths.** `sidebar` 248px · `content-max` 760px · `reading-measure`
68ch for prose (artifact markdown, brief text) · `wide-breakpoint` 900px
is where the PWA swaps bottom tabs for a sidebar.

### 2.5 Elevation

Four levels. In dark mode a raised surface is **lighter**, not more
shadowed — that is how the HIG's dark appearance conveys elevation, and a
big black shadow on a near-black canvas conveys nothing.

| Level | Use | Light | Dark |
| --- | --- | --- | --- |
| `0` | flat rows on the canvas | none | none |
| `1` | cards, feed groups, composer | 1px shadow + hairline | hairline only, on `surface` |
| `2` | menus, popovers, palette, model picker | 4/14px shadow + hairline | shadow + hairline, on `elevated` |
| `3` | sheets and modals over a `scrim` | 18/48px shadow | shadow + hairline, on `elevated` |

### 2.6 Motion

Motion explains a change of state and nothing else. No entrance
animation on data that merely arrived (P2).

| Token | Value | Use |
| --- | --- | --- |
| `duration-fast` | 120ms | hover, press, chip state change |
| `duration-base` | 180ms | disclosure open/close, tab change, menu |
| `duration-slow` | 280ms | panel swap, sidebar reveal |
| `duration-sheet` | 320ms | sheet present/dismiss |
| `ease-standard` | `cubic-bezier(.2,0,0,1)` | most transitions |
| `ease-out` | `cubic-bezier(.16,1,.3,1)` | things entering |
| `ease-in` | `cubic-bezier(.4,0,1,1)` | things leaving |

**Reduced motion.** Under `prefers-reduced-motion: reduce` (and
`accessibilityReduceMotion` on Apple) every duration collapses to 1ms and
any transform-based transition becomes an opacity cross-fade. The
generated `tokens.css` does the first half globally; components must not
re-introduce a hard-coded duration. Nothing in Metistry auto-scrolls,
parallaxes, spins or pulses — the only recurring motion is the chat
poll's content update, which is a repaint, not an animation.

---

## 3. Components

Each entry: **anatomy** (what it is made of), **states**, **platform
notes** (SwiftUI / HIG pattern vs PWA element). All of them are rendered
with realistic content in `design/preview.html`.

### 3.1 Navigation

**Anatomy.** Ten destinations in one fixed order: Feed · Chat · Agents ·
Projects · Artifacts · Capture · Triage · Dashboard · Status · Devices.
Each has a glyph, a label, and an optional count badge — shown only when
the count is *actionable* (Triage: proposals awaiting you; Status:
failing checks). Never a badge for "new activity".

**States.** selected · hover · pressed · disabled (a destination whose
data is absent stays enabled and shows its empty state — P5) · focused
(2px `focus-ring`, offset 2px).

**Platform notes.**

- **macOS** — `NavigationSplitView` with a source-list sidebar on the
  leading side (the HIG's sidebar is exactly this: navigate between areas
  of the app or top-level collections). Width `sidebar` 248px, resizable,
  collapsible; selected row is `accent-quiet` with `text-primary` and an
  `accent` glyph. Toolbar carries the view's own controls (filters, the
  model picker in Chat) and never navigation.
- **iOS** — `TabView` with a bottom tab bar for the top five (Feed, Chat,
  Capture, Triage, Status) and a **More** tab holding the rest, because a
  tab bar is a global control that stays anchored to the bottom through
  push transitions and does not survive being crowded. On iPad the same
  `TabView` adopts the sidebar.
- **PWA** — one `<nav id="nav">` element, two presentations. Below
  `wide-breakpoint` (900px) it is a bottom tab bar: `position: fixed`,
  `padding-bottom: env(safe-area-inset-bottom)`, five primary
  destinations plus a "more" disclosure. At or above it, the same `<nav>`
  becomes a left sidebar in a CSS grid — *no markup change, no JS*, so
  the existing ids and test hooks survive. Buttons keep
  `aria-current="page"` on the active view.

### 3.2 Activity feed row

The home surface, and the panel the desktop plan calls the centrepiece.

**Anatomy.** `[kind glyph] [actor chip] [subject] … [relative time]` with
an optional second line of detail. The actor chip carries the `agent`
tint when the actor is an agent and neutral when it is the system or the
owner (P1). Kinds come from the `activity_feed` query: `tool`, `turn`,
`crew_run`, `dispatch`, `task_op`, `agent_admin`, `project_mode`,
`collector_run`, `proposal_created`, `proposal_decided`, `work_history`,
`brief`, `review`, `alert`.

**States.** default · hover (surface lifts to `elevated`, no colour) ·
pressed · focused · failure (the glyph, not the row, takes `failed`) ·
filtered-empty (the empty state, §3.15).

**Titles are Title Cased at render, and only for known kinds (P10 + P1).**
A feed subject is a *card title*, so P10 says Title Case: "Collector Run
Failed", not "collector run failed". But a subject is sometimes a string
an agent wrote, and P1 says agent text is data — data is not
case-corrected. The two are reconciled by *where* the rule is applied:

- **Title-case at render time only**, in the view layer, from a
  **closed allow-list of `activity_feed` kinds** whose subject the
  console itself composes — `collector_run`, `proposal_created`,
  `proposal_decided`, `project_mode`, `agent_admin`, `brief`, `review`,
  `alert`, `task_op`, `crew_run`, `work_history`. Their subjects are
  system phrasings, so casing them is formatting our own copy.
- **Never** for a kind whose subject can carry agent- or user-authored
  text — `turn`, `tool`, `dispatch` — and never for a detail line, which
  is prose (sentence case) or a quotation. Those render exactly as
  stored.
- **Never in the database.** The stored row is untouched; two clients
  reading the same row must be able to disagree about presentation and
  agree about content.
- **Identifiers inside a subject stay as-is** — `github-state`,
  `knowledge_search`, `mode: hybrid`, a path. The transform lowercases
  nothing, skips any token containing `/`, `_`, `-`, `.`, `:` or a
  digit, skips tokens that are already mixed-case, and leaves the short
  joining words (`a`, `an`, `and`, `at`, `by`, `for`, `in`, `of`, `on`,
  `or`, `the`, `to`, `via`) lowercase unless they lead.

*Why a list and not a heuristic:* "is this string ours?" cannot be
answered by looking at the string. It can be answered by looking at its
kind, and the kind is a closed set the query already returns. A new kind
is not title-cased until someone adds it deliberately — the safe default
is to leave text alone.

**Platform notes.** SwiftUI: a `List` row with `.listRowSeparator`, SF
Symbols per kind (`wrench.and.screwdriver`, `bubble.left.and.bubble.right`,
`person.2`, `tray.and.arrow.down`, `checklist`, `shield.lefthalf.filled`,
`slider.horizontal.3`, `exclamationmark.triangle`, `doc.badge.plus`,
`checkmark.seal`, `list.bullet.rectangle`, `newspaper`, `magnifyingglass`,
`bell.badge`), and a `.contextMenu` with the quick actions from
ux-direction ("summarize this", "what's the latest"). PWA: `<li
class="feed-row">` — the markup that ships today, restyled; emoji stand
in for SF Symbols on the web because no icon font may be loaded.

**Never.** No row is coloured for being recent. Time is `footnote` and
relative, with the absolute time in `title=`/`.help()`.

### 3.3 Agent presence chip

**Anatomy.** A pill: `[dot] [label]`, `caption-2`, `radius-pill`, tinted
fill at ~12% of the presence colour with the presence colour as text.
Optionally followed by `footnote` metadata — last seen, spend today.

**States** (the six, and they are exhaustive):

| State | Meaning | Token | Glyph |
| --- | --- | --- | --- |
| working | live lease, evidence this interval | `presence-working` | `circle.fill` |
| queued | claimed, or waiting behind the cap | `presence-queued` | `clock.fill` |
| idle | registered, nothing claimed | `presence-idle` | `circle` |
| interrupted | lease expired mid-claim | `presence-interrupted` | `exclamationmark.circle.fill` |
| over-cap | at max bundles / over budget | `presence-over-cap` | `gauge.high` |
| blocked | waiting on a decision | `presence-blocked` | `hand.raised.fill` |

**Platform notes.** SwiftUI: a `Label` in a `Capsule` with
`.accessibilityLabel("<agent> is <state>, <reason>")`. PWA: `<span
class="chip state-…">` — today's class names are kept.

**Never.** Never inferred from a recent request (P5). An agent with no
liveness signal is `idle`, and `idle` is not a warning.

### 3.4 Chat message + collapsed tool activity

**Anatomy.** A turn is: attribution line (`footnote` — who, when, and for
inbound the delivery status) · body (`body`, markdown-rendered through
`md.js`'s whitelist) · a **tool-activity disclosure** · optional prompt
card (§3.5) · optional links/actions row.

The disclosure is collapsed by default and reads `▸ 4 tools · 6.2s ·
$0.031`. Expanded it lists one line per `runs kind=tool` row —
`[glyph] tool_name · duration · ok|failed` — each itself expandable to
the call and result. Tool arguments and results are agent-sourced: they
render in `mono` on `agent-quiet` inside a scroll region, with secrets
already redacted server-side.

**States.** collapsed (default) · expanded · streaming (the summary line
reads "working…" with the count rising; no spinner animation under
reduced motion) · interrupted · failed (the summary line takes `failed`
and auto-expands to the failing call — the one case where the system
opens something for you, because a failure needs a person).

**Platform notes.** SwiftUI: `DisclosureGroup` inside the message cell,
`.animation(nil)` when `accessibilityReduceMotion`. PWA:
`<details><summary>` — native disclosure, keyboard-operable, no JS.

**Turn state.** Explicit, next to the attribution: `working` · `finished`
· `interrupted`. Never inferred from whether text has arrived.

**Arrival without motion (P9).** A reply that lands while the reader is
scrolled up is appended silently; the only signal is a **"↓ New Reply"**
pill at the bottom edge of the list — `caption-2` on `accent`,
`radius-pill`, 44pt tall, tappable to scroll, and gone the moment the
list reaches the bottom on its own. It is the one element in the system
that exists because something arrived, and it exists *precisely so that
nothing else has to move*.

**Tapbacks (P8).** Feedback on a turn is a long-press (touch) or
right-click (pointer) menu of reactions attached to the bubble, not a
control row rendered under every reply. Nothing about a tapback changes
what the turn said.

### 3.5 Question–answer prompt card

The structured dialogue from ux-direction, rendered from the outbound
`prompt` payload (question, options, default, deadline). One contract,
three surfaces.

**Anatomy.** Card at elevation 1 with a left `accent` rule · question
(`headline`) · optional context (`subhead`, agent-sourced ⇒ `agent`
attribution) · options as buttons in a row (wrapping to a column below
`wide-breakpoint`) with the default option marked · a free-text escape
("Something else…") that focuses a single-line field · deadline as
`footnote` when present.

**States.** open · answered (collapses to one line: "You chose *Allow* ·
2h ago", options gone) · expired (deadline passed; options disabled, the
line says what happened by default) · sending · failed-to-send (retry
inline, answer preserved).

**Platform notes.** SwiftUI: a `GroupBox` with a `ControlGroup` of
buttons; the same payload feeds `UNNotificationCategory` actions so the
push and the card offer the identical choices. PWA: a `<form>` of
`<button type="submit" value=…>` so it works before JS and keyboard
navigation is free.

**Authority.** A tapped option carries no more authority than a typed
reply — the same server-side authz runs either way. The card never
implies otherwise, and a grant option is styled as destructive-adjacent
(§3.17), not as a primary button.

### 3.6 Composer actions menu (and the ⌘K palette)

Two renderings of one generated list. On touch it is a `+` button inside
the composer; with a fine pointer the same list is also a ⌘K palette.
Neither is hand-maintained: the contents come from live `rules.yaml`,
the agent registry, and the ten destinations.

**Why it is not a pinned toolbar.** Nothing but the composer may occupy
the space above the keyboard. A strip of commands pinned there costs two
or three lines of transcript exactly when the reader needs them most —
while typing a reply about what the agent just said (P8, P9). So the
actions collapse into one control, and the collapsed state is the
default the composer returns to after every send.

**Anatomy — the composer.** One row: `[+] [text field] [↑]`. The field
is a single line that grows with the text to a maximum of five, then
scrolls. `+` is a 44×44pt toggle; nothing else is pinned above the
keyboard, and the tab bar hides while editing.

**Anatomy — the actions menu.** `+` opens a list *above* the field,
grouped, in this order:

| Group | Contents | Source |
| --- | --- | --- |
| Quick Actions | Summarize This · What's the Latest · New Note | ux-direction |
| Commands | `/note`, `/status`, `/deep`, … with one-line descriptions | live `rules.yaml` |
| Agents | `@drey-dev`, `@ops-bot`, … with presence (§3.3) | agent registry |
| Attach | Photo · File · Scan | platform pickers |
| Model & Effort | the §3.7 picker, inline | `rules.yaml` tiers |

**States.** collapsed (default) · expanded · **suggesting** (see below) ·
executing · unavailable-item (a command whose tier the instance has not
configured is listed and disabled *with the reason* — P4, never hidden).

**Composer autocomplete.** Typing `@d` suggests `@drey`; typing `/` lists
commands and narrows them as the token grows. It is the same generated
list as the menu, filtered — a **third rendering, not a third source**.

- **Trigger.** `@` or `/` typed at the start of the field or after
  whitespace, and only there: `foo@bar` and a path like `docs/product`
  never open it. The token ends at the next space, which closes it.
- **Ranking, deterministic** (P5 — no model, and no "smart" reordering
  between keystrokes): **prefix match first, then substring, then
  recency**, each group in a stable order, ties broken by the id.
  Recency is last-used-in-this-instance, so the list is predictable
  before the user has any history and merely convenient after.
- **Anatomy.** An inline list *directly under* the field, at most six
  rows, each `glyph · name · one-line description`, plus a footer count
  when more matched. Presence (§3.3) rides the agent rows, so a
  suggestion says whether the agent can act. It is a listbox, not a
  menu: the field keeps focus and keeps its caret throughout.
- **Keyboard.** `↓`/`↑` move the selection, `Enter` (or `Tab`) inserts
  the selected item, `Esc` closes the list without changing the text —
  and only then does a second `Esc` blur the field. Typing a character
  that matches nothing closes it rather than showing an empty box; the
  user is mid-sentence, not mid-search.
- **Touch.** Every row is a 44pt tap target that inserts on tap.
- **Never.** It does not send, does not scroll the transcript (P9), does
  not steal `Enter` when nothing is selected, and never rewrites text the
  user typed beyond completing the token it is completing.

**Everything in the menu inserts itself (P7's "buttons over memorised
syntax", made literal).** A quick action, a command row, an agent tag —
tapping any of them **writes its text into the reply at the caret** and
returns focus to the field with the caret after the inserted token and a
trailing space. Nothing in the menu sends on tap: the user still reads
what they are about to say and still presses send. The one exception is
Attach, which opens a platform picker because a file is not text.

*Why insert rather than execute:* a command tapped in a menu and a
command typed by hand must produce the identical string, or the two paths
diverge and only one gets tested. Insertion also keeps the composed
message editable — `@drey-dev` plus a brief in the user's own words is
the common case, and an execute-on-tap menu makes that two steps.

**Anatomy — the ⌘K palette (Mac and PWA-wide, the equivalent).** The
same four groups, search-first: field on top, grouped results, each row
glyph · name · one-line description · shortcut on the trailing edge.
Opened by ⌘K, by the `+` button, or by typing `/` in the composer.

**⌘K is the rich reply surface wherever a desktop keyboard is present**,
and it stays. The inline autocomplete above is the *narrow* affordance —
right for a thumb and a small screen, deliberately capped at six rows and
one token. The palette is the wide one, and it can do what an inline list
should not: search **across all four groups at once** with the same
deterministic ranking, show the full description and the keyboard
shortcut for each row, preview an agent's presence and current claim
before you address it, and stay open across several insertions so a turn
can be composed out of a command, an agent and a model pin without
reopening anything. It is present on macOS and on the PWA at or above
`wide-breakpoint` whenever `(pointer: fine)` matches — never on touch,
where it would be a keyboard shortcut with no keyboard. Its results
insert at the caret exactly as the menu's do; the palette closes on
insert, the composer keeps focus, and `Esc` closes it having changed
nothing.

**Platform notes.**

- **iOS** — `+` presents a `.sheet` at a small detent
  (`.presentationDetents([.height(320)])`); the HIG's sheet is exactly
  this, a scoped task related to the current context. Attach items are
  the system pickers.
- **macOS** — `+` opens a `.popover`; the same commands also register as
  real menu-bar items, and ⌘K is a `.keyboardShortcut`.
- **PWA** — a `<details>` wrapping the composer: the `<summary>` *is*
  the `+` button and the content is the actions list. It opens with no
  JavaScript, is keyboard-operable, carries `aria-expanded` for free and
  closes on `Esc`. The wide layout adds `<dialog>.showModal()` for ⌘K,
  which brings focus trapping and an inert background with it. The
  suggestion list is a `<ul role="listbox">` the field owns through
  `aria-controls` / `aria-activedescendant`, so the caret never leaves
  the textarea.

**Sources, and the one that does not exist yet.** Agents come from
`GET /api/agents` — live today. Commands **must** come from a real
endpoint over the instance's own `rules.yaml`; that endpoint is not built
(§4.2 has no route for it), so the PWA ships a short static list with the
gap marked in code at its single definition site. It is a placeholder
with an expiry, not a design: a hand-maintained command list is exactly
what ux-direction ruled out, and the first instance whose `rules.yaml`
differs from the shipped defaults will be lied to. Nothing else in the
menu is allowed a fallback of this kind.

**Never.** The menu never survives a send. It never covers the last
message while collapsed, and it is never rendered as a permanent row of
buttons above the keyboard.

### 3.7 Model & effort picker

**Anatomy.** A toolbar control showing the current tier: `[glyph] deep ·
high`. Opening it gives a menu of the instance's own tiers from
`rules.yaml` — each row is name, one-line "what it's for", and the cost
posture — plus a segmented **effort** control and a *Reset to router's
choice* item.

**States.** router-chosen (default; the label is `text-secondary` and
reads e.g. "auto · fast") · pinned for this turn (label goes `accent`
with a small pin glyph) · pinned for the conversation · unavailable
(a tier the instance has not configured is listed and disabled with the
reason, not hidden — P4).

**The invariant it must respect.** The **router is deterministic**
(invariant 4). This control is a *human override*, and the UI says so:
the menu header reads "the router picked `fast`" and the reset item
returns to it. No model ever appears to be choosing a model.

**Platform notes.** SwiftUI: `Menu` in the `.toolbar` with a
`Picker(.segmented)` for effort. PWA: a `<button aria-haspopup="menu">`
plus a `<ul role="menu">` in a `<dialog>`; scope selection is a
`<fieldset>` of radios.

### 3.8 Capture composer

The fast path — the point is that it never blocks and never drops.

**Anatomy.** A multiline field (`body`, autogrowing, 3 lines minimum), an
attachment row (file chip with name and size, removable), and one primary
**Capture** button. Below: the last capture's receipt — "captured →
inbox #418 · classified `note` on-device" — as `footnote`.

**States.** empty (placeholder "note…") · typing · attaching · sending ·
captured (receipt, field cleared) · queued-offline (a `degraded` chip:
"queued — will send when the instance is reachable") · failed (inline
reason, content preserved, retry button).

**Platform notes.** iOS: a sheet with a medium detent from the tab bar,
plus the share extension and its offline queue. macOS: a global hotkey
panel and a drop target on the window. PWA: today's `<form
id="capture-form">`, restyled; the file input becomes a labelled button
plus a chip so it stops looking like a raw control.

**Never.** Capture never opens a triage decision, never asks a question,
never waits on the model. It writes to the inbox and returns.

### 3.9 Triage card

**Anatomy.** Card at elevation 1: kind glyph · title (`headline`, from
the proposal payload — agent-sourced, so `agent`-attributed) · metadata
line (`footnote`: kind · classification · source agent · date) · a
**preview of exactly what will happen** (the file path a note would be
written to, the diff summary, the grant that would be extended) · action
row.

**Actions.** **Allow** (primary) · **Request changes** (secondary — sends
the proposal back with a comment, using the §3.5 free-text escape) ·
**Deny** (destructive tint, and per P3 it confirms with the reason when
the proposal is not reversible).

**States.** pending · previewing (the diff expanded) · deciding
(buttons disabled, spinner-free) · allowed / denied / changes-requested
(collapses to a one-line receipt with an undo affordance where the
underlying operation is reversible, and none where it is not) · stale
(the proposal was decided elsewhere — the card says so and refreshes).

**Platform notes.** iOS adds swipe actions (leading = Allow, trailing =
Deny) mirroring the notification actions, and the same three actions ship
as a `UNNotificationCategory` so a proposal can be triaged from the push
(ux-direction: answered from the push itself). SwiftUI: `.swipeActions`
+ `.confirmationDialog`. PWA: `<li>` with a `<button>` row; the existing
`data-triage` hooks are kept.

### 3.10 Task card + drag-to-dispatch

**Anatomy.** Task card: id (`mono`) · title · project chip · state chip
(ready / claimed / blocked / done) · assignee (an agent chip, §3.3) ·
lease countdown when claimed.

**Drag-to-dispatch.** Drag a task (or a review bundle) onto an agent row.
The valid drop target gets a 2px `accent` outline and an `accent-quiet`
fill; an invalid one gets `border-strong` and **no** red — it is not an
error yet.

**The refusal is the feature (P4).** On drop, one of three things
happens, and the UI says which, inline on the target row, in the API's
own words:

- **dispatched** — "review task #221 created for `drey-dev`" (`ok`).
- **queued** — "queued for `drey-dev` — 3/3 open bundles" (`degraded`,
  with the cap named).
- **proposal** — "queued as proposal #97 — `metistry` is in `mode:
  review`" (`presence-blocked` tint, with a link to Triage).

**States.** idle · dragging (source at 60% opacity) · valid target ·
invalid target (with a tooltip naming the boundary: "not a member of
`metistry`") · dropped-pending · resolved into one of the three above.

**Platform notes.** SwiftUI: `.draggable` / `.dropDestination` with a
custom `Transferable`; the refusal renders as an inline row, never an
alert. PWA: HTML5 drag-and-drop with `dragover`/`drop`, plus a
**keyboard equivalent** — every task card has a "Dispatch to…" menu item
that opens the same agent list, because a gesture that only works with a
pointer is not a control (§6).

### 3.11 Artifact viewer

**Anatomy.** Header (project/slug, `title-3`) · version + file selectors
· authorship line (`footnote`: who, message, commit, "current") · the
viewer · comment threads · the dispatch-review form.

**Renderers.**

- **markdown** — `md.js`'s whitelist, set at `reading-measure`, `body`
  size, headings from the type scale. Wikilinks are `accent` with a
  dotted underline.
- **html** — an opaque-origin `<iframe sandbox="">` with the CSP meta in
  the `srcdoc`. It is framed by a visible **agent-sourced band**: a
  header strip in `agent-quiet` reading "rendered in a sandbox — this
  page cannot reach your session". The band is chrome; everything inside
  the frame is data (P1). The frame never fills the window edge-to-edge,
  precisely so it can never be mistaken for the app.
- **image** — contained, `radius-md`.
- **text / json / other** — `mono` in a `sunken` block.
- **pdf / binary** — a download link, never an inline embed.

**States.** loading · rendered · superseded (the 503 case — "this
version's content is superseded on the working tree", with a link to the
current version) · unavailable · empty (no files).

**Comment threads.** Author line carries the `agent` tint and a robot
glyph when `author_kind === "agent"`; open threads have an `accent` left
rule, resolved ones drop to 60% and lose the rule.

**Platform notes.** SwiftUI: `WKWebView` with JavaScript disabled and the
same CSP for `html`; `Text(AttributedString(markdown:))` clamped to the
same whitelist for `markdown`.

### 3.12 Project header + mode toggle

**Anatomy.** Title (`title-2`) · mode chip (`review` / `autonomous`) ·
budget and cap as `footnote` · member agent chips · a single **toggle**.
Below: open tasks, bundles in flight, queued, open threads, spend today.

**Mode chip.** `autonomous` uses `ok`; `review` uses `presence-blocked`.
Both carry the label — the colour alone never says which (P2).

**The toggle is destructive in one direction (P3).** Flipping to
`autonomous` re-extends trust to every member and must confirm with the
consequence spelled out: *"Switch `metistry` back to autonomous? Members
will dispatch review bundles to each other without you again."* Flipping
to `review` is the safe direction and still confirms, because it queues
in-flight work — the copy says exactly that. The last change is shown as
`footnote`: "review since 2026-09-03 (owner: budget)".

**Platform notes.** SwiftUI: `.confirmationDialog` with the destructive
role on the affirmative button. PWA: `<dialog>`; the existing
`data-project-mode` hooks are kept.

### 3.13 Status / doctor row

**Anatomy.** `[state glyph] [component name] [probe, footnote] …
[state label] [latency]`. Grouped by `runs_on` (container / host /
external).

**States.** `ok` · `degraded` (answering slowly, or on a fallback) ·
`failed` · `absent` (**not configured — not a fault**, rendered in
`absent` grey with the label "not configured" and a link to the doc that
configures it) · `checking`.

**Platform notes.** This row is the macOS **menu-bar item**: the worst
state across components becomes the menu-bar glyph, and the menu lists
the rows. SwiftUI: `MenuBarExtra`. PWA: today's `<li>` in `#checks`,
restyled, plus a summary line at the top ("9 ok · 1 degraded · 2 not
configured") so the page answers before it is read.

### 3.14 Notifications with actions

**Anatomy.** Title (what happened) · body (one sentence, agent-sourced
text quoted, never phrased as an instruction) · up to three actions from
the same `prompt` payload as §3.5 · a deep link as the default tap
(ux-direction: a door, not a dead end).

**States.** delivered · acted-from-notification · opened-app ·
expired-before-action (the app shows what the default was) ·
undeliverable (the Status page reports the channel as `degraded`, never
silently).

**Platform notes.** iOS/macOS: `UNNotificationCategory` +
`UNNotificationAction`, destructive actions flagged
`.destructive`, and the payload stays **thin** — wake-and-fetch, matching
the relay's privacy bar. Web push: `actions[]` where supported, and where
not, the tap opens the item with the prompt card already on screen — the
same choices, one tap later.

**Never.** A notification never carries a secret, a full artifact body,
or an agent's raw text as its own voice.

### 3.15 Empty states

**Anatomy.** Glyph (`icon-lg`, `text-tertiary`) · one sentence saying
what would put something here · one action when there is a sensible one.
Never an illustration, never an apology.

Real copy, per surface: Feed — "nothing in the last 24h." · Triage —
"queue is clear." · Agents — "no agents registered — register one to give
an outside tool a scoped door." · Artifacts — "no artifacts yet — an
agent publishes one with `artifact_publish`." · Projects — "no projects
yet — one appears the first time an agent, task or artifact uses a
project slug." · Dashboard/AWS — "not configured — set `METISTRY_AWS_*`
to fill this in."

**The distinction that matters.** *Empty* (nothing has happened yet) and
*absent* (this was never configured) get different copy and different
tone. Neither is `failed`.

### 3.16 Error envelopes

The wire contract has one error shape; the UI has one presentation for
it.

**Anatomy.** `[failed glyph] [what could not be done] · [the reason,
verbatim from the envelope] · [what to do]`. The reason is quoted as
`mono` when it is a code (`over_cap`, `not_a_member`), and as plain text
when it is a sentence. A correlation id, when present, is `footnote` and
selectable.

**Placement.** Inline, at the control that failed — a panel that cannot
load stamps *unavailable* on its own header and leaves every other panel
alone (P5). A toast is used only for something that has no place on
screen; there is currently one such case (background capture retry).

**States.** transient (with retry) · permanent (with the doc link) ·
authorization (drops to the sign-in wall, preserving the draft — the
composer already stashes to `localStorage`).

**Never.** Never a raw stack trace, never a bare status code, never an
error styled as agent speech or agent text styled as an error.

### 3.17 Destructive confirmation

The rendering of P3, and the reason it is a component rather than a habit.

**Anatomy.** Title = the question in the tool's words · body = the
consequence, naming what changes and what cannot be undone · affirmative
button carrying the **verb** (`Revoke`, `Rotate`, `Deny`) in the
destructive role · `Cancel` as the default focus.

**Cases in the system today.** revoke an agent · rotate an agent token ·
revoke a device session · flip a project mode · deny a proposal that
cannot be re-raised · dispatch that would widen a grant.

**Platform notes.** SwiftUI `.confirmationDialog` (iOS action-sheet
presentation, macOS alert) with `role: .destructive`. PWA: `<dialog>`
with the affirmative button styled `failed` and `autofocus` on Cancel.

**The rule.** The dialog is *never* the control. The server refuses
regardless. If a confirmation is the only thing standing between a click
and an irreversible act, the tool is wrong, not the copy.

---

## 4. Reply Text

The longest text in the product, read on the smallest screen it has.
Everything else in this system is tuned for *scanning* — a feed row, a
chip, a status line, all of them glanced at. A reply is **read**, at
length, once. It gets its own token group and its own rules, because
inheriting the control scale (`body`, 17pt / 1.5) costs about a third of
the words on a phone.

The bar is the one the Claude app hits: **dense enough that the previous
turn is still on screen while you read the current one, and comfortable
enough to read 300 words without leaning in.** Density that costs
legibility is not density, it is small text.

### 4.1 The decisions, and why

| Decision | Value | Why |
| --- | --- | --- |
| **Family** | the system stack — SF on Apple (`.font(.body)`), `system-ui` on the web | P7. SF switches to SF Text below 20pt on its own: looser spacing, taller x-height, open apertures — optical sizing we get for free and could not buy from a webfont. And no webfont is loaded, ever (§2.3). |
| **Size** | **15pt** phone · **16pt** Mac / wide PWA — one `clamp()`, `--mt-reply-size` | 17pt at a 390pt width runs about six words a line inside a bubble. 15pt is Apple's `.subheadline`, still a Dynamic Type style, and buys roughly two more words per line and 15% more lines per screen. It is the **floor**, not a starting point — nothing in a reply goes below it. |
| **Weight** | **400** | 400 at 15pt is where SF Text is drawn to sit. 300 loses stem contrast on the dark canvas at exactly the size where it matters; a heavier body weight makes a reply look like a heading and defeats P1. |
| **Line height** | **1.45** | Below the `body` scale's 1.5 without going near the 1.4 floor where ascenders and descenders of adjacent lines start meeting at this size. Over a 200-word reply that is one extra line of content per screen. |
| **Paragraph spacing** | **12px**, not a blank line | A blank line at 15/1.45 is ~22px — a third of a paragraph's worth of space, spent on nothing. 12px is 0.55 of the line box: unmistakably a break, half the cost. Set as a margin, so a user who sets 2× spacing (WCAG 1.4.12) gets it without the layout breaking. |
| **Bubble padding** | **12px** vertical, **16px** horizontal | 16px is the minimum that clears `radius-lg`'s 14px corner — below it the first character sits inside the arc. The density win comes from type and spacing; padding is already at its floor, and cutting it further just crowds the text against the bubble edge. |
| **Turn gap / meta gap** | **16px** between turns · **4px** attribution to body | The gap between turns must be visibly larger than the gap between paragraphs *inside* one, or two replies read as one. 16 : 12 is the smallest ratio that reads correctly; the attribution is part of its turn, so it sits tight against it. |
| **Lists** | **4px** between items, **20px** indent | List items are one thought each, so they need less separation than paragraphs — using the paragraph gap makes a five-item list taller than the prose around it. 20px puts the marker in the gutter with the text aligned. |
| **Code** | **13px** mono, line **1.45**, **12px** pad, on `sunken` | The `mono` step. Monospace at the same nominal size as the prose *looks* bigger, so it steps down one; 1.45 matches the prose line box so a code block does not visibly change the page rhythm. **Inline** code takes a background and 2px of horizontal padding and nothing else — no size change, because changing the font size mid-line changes the line box and the paragraph re-flows around it. |
| **Measure** | **38em** (~66 characters), wide layouts only | On a phone the bubble is the measure. On a Mac the window is not: an unbounded reply at 16px in a maximised window runs 130 characters and the eye loses the line return. |

### 4.2 Tokens

All of it is `--mt-reply-*` in `tokens.json` → `tokens.css`, applied in
`preview.html`'s chat section and in the PWA's chat CSS. A reply
stylesheet that reaches for `--mt-text-body-*` is a bug: those are
control tokens.

| Token | Value |
| --- | --- |
| `--mt-reply-size` | `clamp(0.9375rem, 0.9rem + 0.19vw, 1rem)` |
| `--mt-reply-weight` · `--mt-reply-line` · `--mt-reply-tracking` | `400` · `1.45` · `0` |
| `--mt-reply-meta-size` · `--mt-reply-meta-gap` | `0.8125rem` · `4px` |
| `--mt-reply-para-gap` · `--mt-reply-turn-gap` | `12px` · `16px` |
| `--mt-reply-bubble-pad-y` · `--mt-reply-bubble-pad-x` · `--mt-reply-bubble-gap` | `12px` · `16px` · `8px` |
| `--mt-reply-heading-gap` · `--mt-reply-list-gap` · `--mt-reply-list-indent` | `16px` · `4px` · `20px` |
| `--mt-reply-code-size` · `--mt-reply-code-line` · `--mt-reply-code-pad` | `0.8125rem` · `1.45` · `12px` |
| `--mt-reply-measure` | `38em` |

**One fluid set, not three platform forks.** The `clamp()` already lands
on 15pt at phone width and 16pt at desktop width; three hand-maintained
sets would be three things to keep in sync and two of them would rot.

### 4.3 Contrast

Reply body is `text-primary`, reply metadata `text-secondary`, and §2.2
now checks both against **every ground a reply can sit on** rather than
assuming `surface`: `surface` (the assistant's turn), `accent-quiet`
(yours), `agent-quiet` (quoted tool output), `sunken` (code). Worst case
across all of them is **12.79:1** for body and **6.36:1** for metadata,
both modes. Reply prose is set below the 18.66px large-text threshold,
so it takes the full 4.5:1 bar with no exemption — which is the reason
those four pairs are computed now instead of argued about.

### 4.4 Platform notes

- **iPhone / PWA-narrow.** 15pt, the bubble is the measure, 12/16
  padding. Dynamic Type still scales everything: the tokens are `rem`
  and `clamp()`, so a user at `accessibilityExtraExtraExtraLarge` gets a
  legible reply and a bubble that grows to hold it.
- **Mac / PWA-wide.** 16pt, measure capped at `--mt-reply-measure`. The
  extra width goes to the sidebar and the detail pane, not to longer
  lines.
- **SwiftUI.** `Text` with `.font(.subheadline)` on iOS and `.callout` on
  macOS, `.lineSpacing` derived from the same ratio, paragraph gaps as
  `VStack(spacing:)`. The point sizes come from Dynamic Type; the ratios
  come from this table.
- **Reduced transparency / Increase Contrast.** Nothing here depends on
  a translucent ground, so both settings are already satisfied.

---

## 5. Screens

Annotated wireframes, one architecture, three renderings (P6). Numbers
in circles are callouts; the legend is in each file.

| File | Screen |
| --- | --- |
| `design/mac-feed.svg` | macOS — activity feed home, sidebar + toolbar |
| `design/mac-chat.svg` | macOS — chat with collapsed tool activity and the model picker |
| `design/mac-agents.svg` | macOS — agents panel with presence and drag-to-dispatch |
| `design/mac-project.svg` | macOS — project header, mode toggle, rollup |
| `design/iphone-feed.svg` | iPhone — feed with tab bar |
| `design/iphone-chat.svg` | iPhone — chat: iMessage-style bubbles, the collapsed `+` composer, its expanded actions menu, and the new-reply pill |
| `design/iphone-triage.svg` | iPhone — triage cards and the actionable notification |
| `design/iphone-capture.svg` | iPhone — capture sheet at a medium detent |
| `design/pwa-narrow.svg` | PWA — narrow (bottom tabs, installed, safe areas) |
| `design/pwa-wide.svg` | PWA — wide (the same `<nav>` as a sidebar) |

The macOS and PWA-wide layouts are deliberately the same three-column
idea (navigation · list · detail) because they are the same job on the
same screen size; the iPhone and PWA-narrow layouts are the same
single-column stack for the same reason. What must not differ is the
order and naming of destinations, the vocabulary of states, and where a
refusal appears.

---

## 6. Accessibility

Not a section at the end of the work — three of the seven principles are
accessibility rules wearing product clothes. The bars:

**Contrast.** AA everywhere: 4.5:1 for text, 3:1 for non-text, checked by
the generator on every declared pair and enforced by
`build-design-tokens.mjs --check`. Apple's own guidance sets the same
numbers. Colour is never the only signal.

**Dynamic Type.** Every Apple text style comes from
`Font.TextStyle`; nothing uses a fixed point size. Layouts must survive
`accessibilityExtraExtraExtraLarge`: chips wrap to their own line, the
sidebar collapses, action rows stack vertically, and no row is a fixed
height. On the web the equivalent is `rem`-based `clamp()` and honouring
the browser's font-size setting — there is no `px` font size in the
system and no `maximum-scale` in the viewport meta.

**VoiceOver.** Every agent-state chip has a spoken label that is a
sentence, not a token: `"drey-dev, interrupted, lease expired 4 minutes
ago"`, `"github-state, degraded, last successful run 3 hours ago"`,
`"aws-costs, not configured"`. Feed rows read as
`"<actor> <subject>, <relative time>"` with the kind as a trait, and the
tool disclosure announces `"4 tools, collapsed"` / `"expanded"`. Agent
text carries an announced prefix — "from agent `drey-dev`:" — so P1
survives with the screen off. On the web: `aria-live="polite"` on the
feed list and the chat thread (never `assertive`; P2), `aria-current` on
navigation, `aria-expanded` from the native `<details>`, and no
`aria-label` that duplicates visible text. The "↓ New Reply" pill is the
visible half of that polite announcement: a reply that arrives while the
reader is scrolled up is *spoken*, never *scrolled to* (P9).

**Keyboard (macOS and PWA).** Full keyboard reachability with a visible
2px `focus-ring` at 2px offset — `:focus-visible` on the web, never
`outline: none`. `⌘K` palette · `⌘1`–`⌘9` destinations · `/` focuses the
composer · `Esc` closes any disclosure, menu, or dialog · `Tab` order
follows reading order · every drag gesture has a menu equivalent (§3.10).
`<dialog>` gives focus trapping and restoration for free; nothing in the
system implements its own focus manager.

**Reduced motion.** `prefers-reduced-motion` / `accessibilityReduceMotion`
collapses all durations to 1ms and replaces transforms with cross-fades.
No parallax, no auto-play, no pulsing "thinking" indicator — the working
state is a word.

**Touch targets.** 44×44pt minimum on touch, per the HIG. Tab bar items,
triage actions, chip buttons and the capture button all meet it; the
preview page is laid out at 390pt so this can be checked by eye on the
phone it will be read on.

**Contrast table.** §2.2 — 74 pairs, all pass.

---

## 7. The preview page

`docs/product/design/preview.html` renders every component in §3 side by
side in light and dark with realistic Metistry content — feed rows from
the real `activity_feed` kinds (Title Cased at render, §3.2), all six
presence chips, a chat turn with collapsed tool activity, a prompt card,
the composer in its collapsed, expanded and **suggesting** states with
the new-reply pill, a **~180-word reply set in the §4 reply tokens** so
the density can be judged rather than described, a triage card, a doctor
table, the dispatch refusals, the empty states and the error envelopes.

It is self-contained: `tokens.css` is inlined, there are no external
resources and no JavaScript beyond the theme toggle. Open it on a phone —
that is what it is for.

---

## 8. Sources

Apple Human Interface Guidelines, retrieved 2026-09-08:

- [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Navigation and search](https://developer.apple.com/design/human-interface-guidelines/navigation-and-search)
- [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Modality](https://developer.apple.com/design/human-interface-guidelines/patterns/modality/)
- [Menus and actions](https://developer.apple.com/design/human-interface-guidelines/menus-and-actions)
- [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)
- [Sufficient Contrast evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/sufficient-contrast-evaluation-criteria/)
- [Reduced Motion evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria/)

Contrast maths is [WCAG 2.1 SC 1.4.3 / 1.4.11](https://www.w3.org/TR/WCAG21/#contrast-minimum),
computed in `ops/scripts/build-design-tokens.mjs`.

Presentation patterns studied — described, never copied, no asset or name
taken: Claude's desktop and mobile apps (collapsed tool-use blocks under
a reply, a searchable model picker in the composer, structured
question-answer cards) and CodeGraff (`docs/research/2026-09-codegraff-review.md`
— agents panel as home, explicit working/finished/interrupted state,
collapsed tool activity, task handoffs as a drag). Neither is a
dependency and neither is licensed into this repo.
