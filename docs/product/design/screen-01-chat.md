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

## 2. The layout decision: one column, tinted by author

`design-system.md` P8, as amended by **ruling 10**, says bubbles and
sender-distinction but leaves alignment to the layout. On Mac that means **one
left-aligned column**: alternating sides across a 900px pane throws the eye
from edge to edge on every turn, and §4's measure exists precisely because
unbounded width is bad for reading.

So the sender is carried by **ground, not side**:

| Turn | Ground | Attribution |
| --- | --- | --- |
| yours | `accent-quiet` | "You" in `text-secondary` |
| the assistant's | `agent-quiet` | the assistant's name in `agent` |

**This makes P1 structural rather than decorative.** The principle says
agent-authored text renders "inside a container that is visibly quoted: the
`agent` tint on the attribution, an `agent-quiet` wash behind the body". Every
reply already sits in that wash, so agent-authored text is marked as data
before a word of it is read — not by a badge someone can forget to add, but by
the container it arrives in.

**The assistant's name is never drawn.** The attribution templates from the
instance's `identity.yaml`; the artboard shows the literal word "Assistant"
because `CLAUDE.md`'s naming rule forbids a name anywhere in the product's own
files, artboards included.

### 2.1 A nesting problem this turned up

§3.4 says tool arguments and results render "in `mono` on `agent-quiet`". But
the reply body is now *itself* on `agent-quiet`, so a nested block in the same
fill is invisible. **The nested block uses `sunken`**, which §2.1 already
assigns to wells and code. Recorded because it is a real amendment to §3.4, not
a drawing choice: the rule should read "on `agent-quiet`, or `sunken` where the
containing turn is already `agent-quiet`".

## 3. Anatomy, top to bottom

1. **Toolbar** — mark + **Metistry** (never the section name) · spacer · the
   model & effort control · capture "+" · the Needs You bell with its count ·
   the Usage gauge.
2. **Day separator** — a hairline with the day centred. Timestamps are on
   demand (P8), not stamped on every line.
3. **Turns** — attribution, body at the §4 reply tokens, then, on an
   assistant turn, the collapsed tool strip and any prompt card.
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

## 4. The reply typography, finally read

§4's tokens are used as declared — **16px, line 1.45, 12px paragraph gap** at
Mac width — with one open question.

**The measure.** `--mt-reply-measure` is `38em` (~66 characters). Round 00
proposed `34em` (~60). The artboard sets the drawn screen at 34em and puts both
side by side at the bottom so the difference can be read rather than argued:
38em is right for a document, 34em for a *transcript*, where the eye returns on
every line and the previous turn has to stay on screen. **One token, and the
owner's to overrule.** Not changed in `tokens.json` yet.

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

1. **The measure** — 38em or 34em (§4).
2. **`rules.yaml` endpoint** — blocks the tier picker and the command menu (§8).
3. **§3.4's nesting rule** needs the `sunken` amendment (§2.1).
4. **Long transcripts** — nothing here says what happens above 30 messages;
   the load-more affordance has to obey P9 as strictly as an arriving reply does.
