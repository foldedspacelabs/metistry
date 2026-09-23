# Screen 11 — The floating bar

New, 2026-09-22. A second interface for Metistry, **additive** to the Chat
destination rather than a replacement for it. Built on PR 253
(`docs/research/2026-09-21-live-capture-bar.md`), which settles most of the hard
parts and corrects one premise this design had to absorb.

**Owner's rulings, 2026-09-22:** present at all times while the bridge is
installed; minimal at rest and louder while a session runs; docked to a screen
edge and display the owner chooses, not the bottom; and **the bar's chat is the
same conversation as the window's**.

## 1. What the bar is for

Two jobs the nav row cannot do, which is what C60 was actually about:

1. **Say something to Metis without losing what you are looking at.** Seconds
   long, from anywhere, no context switch.
2. **Let Metis hear a meeting you are in**, and afterwards propose the notes.

And one thing it must never become: a place where work is read at length. The
window is for that.

## 2. The resting state — 30px, one mark, one word

The bar is **the brand mark and one dot**, 30px wide, on the edge the owner
picked. Hovering widens it to name the state in words — *not listening* — and
offers the four acts: **Ask · Capture a note · Listen to this · Share a window**.

**There is no crossed-out eye, no muted speaker and no muted microphone.**
C58 again: *absence is the denial*. Three negative icons are three claims about
what Metis is not doing — noise, and in the eye's case a claim the system cannot
back (§6). One state, one word, and the grants themselves in Settings.

The rail is drawn on the **marks-only** glass — 0.75 rather than 0.86 — because
nothing on it is text. That is the whole trick to making it feel like the OS:
**transparency is bought by giving up the faintest ink**, not by hoping. It is also
why the rail carries no numerals and no faint label (§7).

**It fades to 55% after ten seconds without the pointer** and returns on
approach. That is the only fade in the product, allowed because at rest the bar
carries nothing. **While a session runs it may never fade, dim or hide** — the
anti-Glass rule: Glass sold invisibility as a feature and called
`setContentProtection` on every window. This is the opposite object.

## 3. The live state — it breathes, and it names the sense

The mark **fills**, the border takes the `agent` hue, a **halo breathes** around it,
and the senses that are open are shown as glyphs beneath.

**The senses are shown, not implied.** A filled **microphone** means it is hearing;
a filled **display** means a window is being shared; both can be lit at once. Each
is the glyph macOS uses for the same idea, so the row reads without a legend. They
are **indicators, not switches** — the act that started each one is what ends it.

### 3.1 The breath, ratified under C16 rather than against it

C16 allows motion only where it carries information the reader cannot otherwise
get. In the **panel**, the elapsed count carries liveness, so nothing moves. On a
**30px rail seen from across the room**, a 14px mark cannot be resolved and a
numeral certainly cannot — **a slow expanding halo is detectable in peripheral
vision when nothing else on the rail is**. That is information unavailable by other
means, at the moment it matters most, so the rule admits it on its own terms.

- **2.6s, ease-in-out, scale 1 → 1.5, opacity 0.85 → 0.12.** Slow enough to read as
  breathing rather than blinking: an alarm pulse would say *something is wrong*,
  which is the tint channel's job and is not true here.
- **One ring, one property pair, no colour change.** The halo is `agent`, 1.5px.
- **The mark stays filled at all times**, so the state never depends on the
  animation. Under `prefers-reduced-motion` the halo holds at its widest, still and
  visible.
- **The halo is decoration and is exempt from 3:1** — it measures 1.68:1 at its
  mid-frame — *because it is not the carrier*. The filled mark behind it clears
  3.36:1. C63's rule is about marks that carry meaning; redundancy may be faint.

**This is now the second and last animation in the product** — the waiting dots in
Chat, and this. Both pass the same test and both stop under reduced motion. The
list is closed: a third candidate should have to displace one of these rather than
join them.

**macOS's own orange indicator is untouched.** We never suppress it and never
imitate it.

## 4. Expanded — one conversation, a shorter measure

**Ruled: one conversation.** What the owner says in the bar lands in the same
thread as Chat, so opening the window later shows the turn where they left it.
Two threads would mean deciding every time which one a question belongs to, and
being wrong about it later.

- **The reply carries the 2px `agent` rule** (C69), so a turn is recognisably
  the same object in both places.
- **The measure is not the same, and that is deliberate.** 620px does not fit
  beside a meeting. The panel runs at **328px** and shows **the tail**, not the
  transcript; **Open in Chat** appears on any reply longer than four lines. The
  window's promise — resizing never rewraps a line — is a promise about the
  window. The bar is where you ask; the window is where you read.
- **While a session runs the panel says *answers are staying on this Mac*,**
  because the research's `private` tier may only be assigned to a provider with
  `locality: on_machine`, refused at `metistry compute assign`. That sentence is
  the reason the feature is acceptable, so it is on the surface.
- **Four acts at rest, three while live.** *Note* is the floating "+" the UX plan
  already ruled ("no Capture tab and no Capture screen anywhere") — this bar is
  its home. *Action item* exists only while there is a transcript to anchor it
  to, carrying `source: meeting:<path>` and a timestamp.

## 5. Starting a session — two lines, then Start

**Cut from eleven lines to four.** macOS explains its own permissions better than
we can, in its own words, at the moment it asks — so the sheet no longer rehearses
them, and the grant table moved to Settings where someone who wants the full answer
goes. What is left is what only we know:

```
Listen to this meeting
 ⚭  Zoom                                    the meeting
 🎙  Your microphone                          your side
 [ Start ]  [ Cancel ]     Stops at 11:30. Nothing is written without you.
```

**Still one act per sense.** Listening takes the meeting's audio and the microphone
together, because a conversation is both halves or it is nothing. Sharing a window
is its own act, its own sheet, its own glyph.

**The screen sheet keeps exactly one honest line** — *screen access is not
per-window* — because C71 means the interface may not let the picker imply a fence
the OS does not provide. Four words and a chip; it does not need a paragraph.

## 6. The premise the brief got wrong

The brief said the user picks apps via the system picker *"so the OS enforces the
scope, not our prompt."* Apple's documentation says two things in adjacent
paragraphs: use `SCContentSharingPicker` as the recommended way to let people
**select** content — and, separately, **request screen recording permission**
before capturing. `kTCCServiceScreenCapture` is held by the binary.

So the picker makes the scope **visible and user-chosen**; what makes it
*enforced* is that the helper is a small signed binary with **exactly one code
path for building a filter**. That is still "enforce at the tool" — invariant 2 —
but it is **our** boundary, and the interface may not borrow the kernel's
credibility for it.

Three consequences, all visible in the drawings:

1. The screen sheet says *macOS picks the window, not us*, and then says the
   grant is not per-window. Once, in place, not as a recurring nag.
2. No crossed-out eye at rest: *cannot see* is unprovable; *not listening* and
   *no stream running* are provable.
3. Seeing is a **separate act** from hearing, never a checkbox beside it, so the
   weaker guarantee is never smuggled in under the stronger one.

P5 is the rule doing the work: **state is reported, never inferred.** A
capability claim is a state claim about the machine, and this is one the machine
cannot make.

## 7. Glass — four layers, and two floors (C70, C73)

The bar is the one place §4.4's "nothing here depends on a translucent ground" is
set aside, so it gets numbers rather than hope.

**The four layers, of which one is not decoration:**

1. **The lensed backdrop** — `blur(28px) saturate(185%) brightness(1.04)`. The
   saturation lift is what reads as glass rather than frosting: colour from behind
   survives the blur.
2. **The scrim** — a vertical gradient, thicker at the top where the specular sits.
   **This is the only layer that keeps the inks legal.**
3. **The specular edge** — a 0.5px border plus an `inset 0 1px 0` highlight, 0.62
   white in light and 0.20 in dark. This single line is most of why Apple's glass
   looks lit rather than painted.
4. **The ground** — a tight 1px contact shadow under a wide soft one, so the panel
   sits on the desktop instead of hovering above it. Radii are concentric: 18
   outside, 11 inside, the difference being the padding.

**Two floors, because the floor follows the ink, not the object.** Measured by
compositing each ink over the scrim at every opacity against six backdrops — white,
black, mid grey, deep blue, bright yellow, saturated red — worst case taken:

| Ink | Needs | Light | Dark |
| --- | --- | --- | --- |
| `text-primary` | 4.5:1 | 0.51 | 0.65 |
| `text-secondary` | 4.5:1 | 0.78 | **0.83** |
| `text-tertiary` | 3:1 | 0.77 | **0.81** |
| `accent` | 3:1 | 0.66 | 0.68 |
| `agent` | 3:1 | 0.71 | 0.72 |

- **Glass carrying text: 0.86.** Secondary ink in dark binds it.
- **Glass carrying only marks in `ts`, `agent` or `accent`: 0.75.**
- **`text-tertiary` is not allowed on thin glass at all** — it needs 0.81, which is
  above the marks floor. So a thin surface may not carry a faint label, which is
  the measurement that decided the rail shows two marks and no words.

**And one fault this caught in the drawing (C73).** The first pass drew each sense
as an `agent` glyph on an `agent` tint plate: **2.69:1 light, 2.60:1 dark** against
its own background. Dropping the plate puts the same glyph at 3.36 / 3.43 on the
rail and 4.46 / 5.07 on a panel. A mark and its ground drawn from one hue is the
C54 fault in a new costume, and a tint plate behind a glyph of the same hue is now
a thing to check for by habit.

## 8. Settings ▸ Live capture

One switch, one place, three permissions, and what it keeps.

- **The floating bar** is a real toggle that turns the whole surface off — distinct
  from the bridge being absent, and the only control here that changes what is on
  screen.
- **Placement:** left or right edge, drawn rather than named; which display; then
  draggable. **Top and bottom are not offered** — the menu bar owns the top, the
  Dock and the system's own recording pill own the bottom.
- **Permissions say whether, not when.** *Approved* or *not yet asked*, per grant.
  The date a grant was given is trivia; what a person wants to know is whether they
  are about to be interrupted. The rows are a read-through, not a control — macOS
  holds these, and a console that pretended to grant one would be lying about who
  decides.
- **What Metis keeps**, in three rows of two words: *audio — never kept*;
  *transcript — 90 minutes, then gone*; *notes — only what you approve, in your
  vault*. **No paths.** Naming `.metistry/state` in a settings pane was
  documentation leaking into the product.
- **Purge now** keeps the amount beside it, because a destructive verb should say
  what it will destroy.
- **Absent, not off, without the bridge.** No bridge, no pane, no bar, no grants
  (`degrades: absent`).

## 9. What this asks of the build

1. **Three TCC grant kinds in the manifest enum** — `microphone`,
   `audio_capture`, and `screen_recording` only if the screen act ships. The enum
   is closed at five (`packages/core/src/manifest.ts:30-36`) and now blocks two
   specs; one decision, owed once.
2. **The `private` compute tier**, refused at `metistry compute assign` when
   pointed off-machine. *Staying on this Mac* is only honest if the verb enforces
   it.
3. **A per-grant read-through** for the Settings pane — state and date, rather
   than one health word.
4. **Retention and a purge verb.** Daily-flow Q4 is open and this is the first
   path that would produce transcripts continuously.
5. **A window-position preference per display.**
6. **Nothing in `exposes:`.** The assistant may not start a session — invariant 9
   by absence, the same argument `mcp-apple-fm` makes for keeping `/v1` off its
   list. The bar is the owner's hand, and only the owner's.

## 10. What is not drawn

The after-meeting review, because it already exists as a shape: one proposal in
Needs You carrying a draft `Journal/Meetings/<date>-<topic>.md`, the transcript as
an inbox capture, and extracted action items as task-line proposals. The research
deliberately makes it byte-identical to what the Gemini-mail path produces, so one
reviewing habit covers both. If it needs its own card kind on Needs You, that is a
back-patch to screen 4 rather than a new screen.
