# Screen 01 — Chat (2026-09-19)

> Round D, first screen, Mac. Canvas: the **Chat** artboard.
> Drawn first because P1, P8 and P9 all meet here, and because the §4 reply
> tokens have been declared since they were written and never read at length.

---

## 1. What the user came here to do

**Read the last reply and answer it.** Everything else on the screen — tool
activity, tier, cost, turn state, tapbacks — is chrome around one piece of
prose, and four of those five want to be visible at once. The calm rule is hard
here because the temptation is a status bar per turn.

## 2. The layout decision: one capped column, only yours tinted

Revised 2026-09-19.

Ruling 10 says bubbles and sender-distinction with alignment left to the
layout, so on Mac the turns run in **one left-aligned column**. Two further
rulings from the owner's review:

**Only your turns carry a fill.** Yours sit on `accent-quiet`; the assistant's
have no container at all. A reply is the longest text in the product and the
thing most often read at length — giving it the full column rather than a
tinted box is worth more than the symmetry, and your turns being the marked
ones is enough for the eye to find them when scanning back.

**The column is capped and centred.** `max-width` on the transcript, centred in
whatever width the pane has. Resizing the window then moves the column but
**never rewraps a line**, which is the thing that makes a resizable chat feel
unstable.

That collapses two numbers into one: the container cap *is* the measure, so
`--mt-reply-measure` governs the column rather than the prose inside it, and
tool strips, chips and cards fill the same width as the text.

### 2.1 What this costs P1, and what pays for it

P1 asks for agent text in a container that is *visibly quoted* — "the `agent`
tint on the attribution, an `agent-quiet` wash behind the body". Dropping the
wash keeps the first half and loses the second, so this is a **deviation to
be ruled on, not a drawing choice**. Three options, in the order I would take
them:

1. **The attribution carries it** (drawn). P1's wash is kept for agent data
   that appears **outside** a transcript — a feed row, a card title, tool
   output, an artifact comment — which is where being mistaken for the
   interface actually costs something. Inside a transcript, everything is a
   turn and the attribution is unambiguous.
2. **A 2px `agent` left rule** on the assistant's turn — literally a quote bar.
   Costs 18px of width, keeps the quoting explicit. On the board beside the
   drawn version.
3. Keep the wash. Rejected: it is the option the owner asked to remove.

**This also resolves the nesting problem** the first pass found. With the reply
body unfilled, tool output goes back onto `agent-quiet` exactly as §3.4 says,
and the `sunken` workaround is no longer needed. §3.4 stands unamended.

## 3. Anatomy, top to bottom

1. **Toolbar** — mark + **Metistry** (never the section name) · spacer · the
   model & effort control · capture "+" · the Needs You bell with its count ·
   the Usage gauge.
2. **Day separator** — a hairline with the day centred. Timestamps are on
   demand (P8), not stamped on every line.
3. **Turns** — attribution, body at the §4 reply tokens, then, on an
   assistant turn, any attachment chips, the collapsed tool strip and any
   prompt card.
3a. **Attachment chips** — agent-authored references to a page, an image or an
   artifact: glyph · name · path or version, on `agent-quiet` because the
   reference is agent-sourced (P1). Clicking one opens the preview pane (§3b).
4. **Tool strip** — `▸ 4 tools · 6.2s · $0.031` on `sunken`. Expanded, one
   line per call: glyph · tool name (`mono`) · duration · outcome, then the
   arguments and result in `mono`. Collapsed by default; **auto-expands only on
   failure**, which is the one case the system opens something for you.
5. **Prompt card** (§3.5) — an `accent` left rule, the question, options with
   the default named, and a free-text escape. It sits inside the assistant's
   turn because it *is* part of that turn.
6. **Composer** — `[+] [field] [↑]`, growing to five lines then scrolling,
   with the tier chip and its explanation beneath.
7. **"↓ New Reply" pill** — centred at the bottom edge, `accent` on
   `on-accent`, 44pt tall. The only element in the product that exists because
   something arrived, and it exists so that nothing else moves (P9).

## 3b. The preview pane

New 2026-09-19. A third column inside the window, so a page, an image or an
artifact can be read **without leaving Metistry**.

**Anatomy.** 400px, resizable, `surface`, a `border` on its leading edge.
Header: kind glyph in `agent` · name · path or version in `mono` · open
externally · close. Body: an `agent-quiet` band reading *written by the
assistant* where the content is agent-authored (P1 — the band is chrome,
everything below it is data), then the renderer.

**Renderers** are §3.11's, unchanged — markdown at reading measure, image
contained, text and JSON in `mono` on `sunken`, HTML in an opaque-origin
sandboxed frame with its band, PDF and binary as a download link, never an
inline embed. **The pane and Work ▸ Artifact are the same component**, which is
the point: one viewer, two places it appears.

**How it obeys P9.** Opening the pane must not move the transcript under the
reader. The rule: **the column keeps its width and only translates** — it never
narrows, so no line rewraps and nobody loses their place. If the window is too
narrow to hold both, the pane opens over the transcript as a sheet rather than
squeezing it.

**Data sources.** `GET /api/artifacts/{id}` and `…/versions/{ver}/file` for
artifacts; `GET /api/knowledge/page?path=` for a vault page — **which does not
exist yet**, and is the same phase-E gap round 00 logged. A chip pointing at a
page is drawn and cannot be built until that route lands; a chip pointing at an
artifact can be built today.

## 3c. Model & effort

Rebuilt 2026-09-19 — the owner needs a real control, per conversation or per
turn, and modelled on what a coding assistant's picker does.

**Anatomy.** A chip in the composer reading the current tier — `fast · medium`
— opening a menu of four parts:

| Part | Contents |
| --- | --- |
| header | "The router picked `fast` for this turn" — **the router decides, and the UI says so first** (invariant 4) |
| **Preset** | the instance's tiers from `rules.yaml`: `fast`, `deep`, `research`, `shadow`… each with a one-line "what it's for". A tier the instance has not configured is **listed and disabled with its reason**, never hidden (P4) |
| **Model** | the models `compute.yaml` actually has, each with its provider and whether it is local |
| **Effort** | a segmented low · medium · high |
| **Scope** | this turn, or this conversation — then *Reset to the router's choice* |

**Selection is never carried by fill alone.** The selected row takes an
`accent` check glyph and `accent` text; the tint is reinforcement. See §6.1 for
why that had to change.

**Data sources.** Models and providers come from `compute.yaml` via the
`metistry compute` verbs, which **exist on the Mac today** — so the model and
effort halves are buildable now. The preset list needs a `rules.yaml` endpoint,
which does not exist. **The control is half-sourced**: build model and effort,
leave presets behind the endpoint rather than hard-coding a tier list.

## 4. The reply typography, finally read

§4's tokens are used as declared — **16px, line 1.45, 12px paragraph gap** at
Mac width — with one open question.

**The measure.** Now that the column itself is capped (§2), `--mt-reply-measure`
governs the **column**, not just the prose — one number for both. The drawn
screen uses 38em as declared; round 00's proposal of 34em would make a narrower
column. With the cap doing the work the difference is much less consequential
than it was, and I would now leave the token at **38em** unless reading it at
size says otherwise.

Everything else in §4 survived contact: 12px paragraph spacing reads as a break
without the third-of-a-paragraph cost of a blank line, and inline `mono` at
14px inside 16px prose sits on the line without disturbing the line box.

## 5. States

| State | Rendering |
| --- | --- |
| working | the attribution's second slot reads **`working`** — a word, never a spinner — and the tool strip shows a rising count. Nothing pulses |
| finished | the relative time replaces it |
| interrupted | `interrupted` in `failed`, the partial text left exactly where it stopped, and a `Continue` link. The text is never truncated with an ellipsis or removed |
| new reply while scrolled up | appended silently; the pill appears; the viewport does not move, rows already on screen do not re-render, and the composer keeps focus (P9) |
| tier pinned | the chip goes `accent` with a pin glyph and reads `deep · high`; the line beneath says it is pinned and how to reset. Router-chosen is `text-secondary` and reads `auto · fast` |

**Tapbacks** are a right-click menu on the turn, not a control row under every
reply (P8). Nothing about a tapback changes what the turn said.

## 6.1 Two contrast faults this round found

Both were invisible to CI because the pairs were never declared.

1. **`text-tertiary` on a tinted fill.** The selected menu row put
   `text-tertiary` on `accent-quiet` in dark mode: **4.06:1**, below AA. Rule
   added to the token's own role text: *never on a tinted fill — only on `bg`,
   `surface` or `elevated`*. Its `contrast` list gains `elevated` (4.94:1
   dark), so its real grounds are now all checked. **130 pairs.**
2. **`accent-quiet` is invisible on `elevated`.** It was computed against
   `surface`; on a menu's `elevated` ground it is **1.21:1**, so a selected row
   all but disappears — which is what the owner saw. The fix is not a new
   colour: a selected row is marked by an **accent check glyph and accent
   text**, with the fill as reinforcement. Colour alone was carrying the state,
   which §2.1 forbids.

## 6. Keyboard

`/` focuses the composer · `⌘K` the palette · `↑` in an empty composer edits
your last turn · `⌘↩` sends · `esc` closes the menu, then blurs · `⌘R` resets
the tier to the router's choice · the pill is focusable and `↩` scrolls.

The composer menu **inserts at the caret and never sends** (`ux-direction.md`),
so every row is a string you could have typed.

## 7. VoiceOver

- "from agent, assistant: The compute budget is at 68 percent with eleven days left… 4 tools, collapsed."
- "your turn, 9:14. Where is the compute budget this month…"
- "new reply available, button"

Agent text carries the "from agent" prefix so P1 survives with the screen off.
The transcript is `aria-live="polite"`, never `assertive` (P2).

## 8. Data sources

| Piece | Source |
| --- | --- |
| the transcript | `GET /api/messages?limit=30` |
| sending | `POST /message` |
| tapbacks | `POST` / `DELETE /api/messages/{id}/feedback` |
| tool activity | the `runs` rows for the turn, `kind=tool` |
| the prompt card | the reply's fenced `decision` block, stored as a `proposals` row |

**One component on this screen has no data source: the model & effort picker.**
It needs the instance's own tiers from `rules.yaml`, and **no endpoint serves
them** — `app-ux-plan.md` §1.4 records that the PWA ships a hand-written
`COMMANDS` array marked as a placeholder at its definition site for the same
reason. By the brief's own gate — *a screen whose spec cannot name its data
source does not pass* — **this screen passes with one component held back.**
The picker is drawn, and it should not be built until a `rules.yaml` endpoint
exists; a hard-coded tier list would lie to the first instance whose
`rules.yaml` differs from the defaults.

The composer's command menu has the same dependency and the same answer.

## 9. Open

1. **P1's wash** — does the attribution alone carry it inside a transcript, or
   does the assistant's turn keep a quote rule? (§2.1)
2. **`rules.yaml` endpoint** — blocks the preset list and the command menu
   (§3c, §8).
3. **`GET /api/knowledge/page`** — blocks a chip that points at a vault page
   (§3b).
4. **Long transcripts** — nothing here says what happens above 30 messages;
   the load-more affordance has to obey P9 as strictly as an arriving reply does.
