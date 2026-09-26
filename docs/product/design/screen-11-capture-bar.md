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

1. **Say something to Metis without losing what you are looking at** — a question,
   a note, or a to-do. Seconds long, from anywhere, no context switch.
2. **Let Metis watch and hear what you are doing** — a meeting, or showing how
   something works — and afterwards propose the notes.

And one thing it must never become: a place where work is read at length. The
window is for that.

## 2. The resting state — a toolbar, one click per act

A 34px glass rail on the edge the owner picked: the mark, then **Ask · Note ·
To-do**, then **Record**. Each is its own button. The first pass hid the acts
behind a hover menu and a mode switch, which made every jot cost two clicks before
a single word — ruled out 2026-09-22 as a recipe for non-use.

- **Glyphs only**, with the native tooltip — and its shortcut only when *Shortcuts in any app* is on (C120: off by default; ⌃⌥⌘A N T R S, Start and Stop Recording separate). The rail is thin glass (0.75), so the glyphs are `text-secondary` and
  there are no labels: a label there would need tertiary ink, which C74 bars.
- **No crossed-out eye, no muted speaker.** Absence is the denial (C58), and
  *cannot see* is a claim the system cannot back (C71).
- **Fades to 55% after ten seconds idle** and returns on approach. **Never while
  recording.**

### 2.1 Note and To-do — click, type, Return

The field opens beside the button that summoned it, already focused. **Return
saves and closes**; Escape closes. A one-second confirmation with the time, then
nothing. The same click works during a recording, where each jot also takes the
session's timestamp (C77).

## 3. The live state — the same toolbar, breathing

The mark breathes and the senses that are open sit beneath it — a **display**
while a picture is being taken, a **microphone** while the owner is heard. **Record
becomes Stop**, in the same place. Note and To-do do not move, so a jot during a
meeting is the same click as at any other time.

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

## 4. Ask — the chat, as it was

Ask opens the tail of the one conversation and a composer. **No mode pills** —
Note and To-do have their own buttons. Same thread as the window, same 2px agent
rule (C69), shorter measure (C72): 328px, the tail rather than the transcript, and
**Open in Chat** on any reply past four lines. While recording, the panel shows
*staying on this Mac* and one line counting what has been jotted this session.

## 5. Record — a target and two toggles

```
Record
[ Screen | Window | Audio only ]
 ▢  Zoom — Vendor review                       ⌄
 ───────────────────────────────────────────
 ♫  App audio                                ( ●)
 🎙  Your microphone   your side only          ( ●)
 [ Record ]  [ Cancel ]
```

- **Audio is a toggle, on by default**, beside the microphone (ruled 2026-09-22).
  The label names what it takes — *app audio* for a window, *system audio* for the
  screen or audio only — and nothing else is said.
- **No explainer text.** No stop time, no promises, no permissions rehearsal, no
  qualifiers on the window row. The window row is the picker's choice with a
  chevron to change it.
- `capturesAudio` scopes the sound exactly as the picture (macOS 13);
  `captureMicrophone` adds the owner's voice to the same stream (macOS 15, a second
  session below that against a 14.0 floor). *Audio only* uses the Core Audio
  process tap — no screen grant, per-process by construction.

### 5.2 The phase order this inverts

PR 253 recommended **audio first** and **screen not at all for now**, because audio
is the part with kernel-enforced scoping and screen was "the part the owner himself
was unsure he wanted". The owner has since said a meeting **is** screen plus audio,
which means **the headline act needs the grant with the weaker scope story**.

What the design can carry: the picker means the window is chosen every session; the
helper has one filter path; the rail shows a display glyph whenever a picture is
being taken; and *screen access is not per-window* is said once, in Settings.

What it cannot carry: the OS will not fence that grant for us. Someone who wants
that guarantee uses **Audio only**, which is genuinely per-process — so the option
earns its place twice.

**The sequencing question is the owner's:** ship *Window + audio + mic* first, which
is what he asked for and what makes meetings work — or ship *Audio only* first,
which needs no screen grant and proves the whole downstream path with less surface.

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
  *transcript — 30 days* (C91; this first said 90 minutes); *notes — only what you approve, in your
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

## Corrected 2026-09-23 (review 01)

- **Idle:** after ten seconds only the decoration fades — shadow and specular
  edge. The scrim holds its floor and the ink its strength; fading the whole bar to
  55% was opacity on the ink (C63) on glass already at its floor (C74).
- **The glass gradient no longer dips below its floor**: the bottom stop is the
  floor itself (it was 0.85 under text against the 0.86 rule).
- **Reduced motion holds the halo at its widest**, as §3.1 said (it held at 1.32).
- **Times:** jots carry the clock with AM/PM (*1:02 PM*); the live counter is a
  duration and says so (*13m 42s*).
- **Transcript retention is 30 days** from the end of the session (C91).


## Recording through a working day (C137)

See `components-03-states-and-flows.md` §4: reminders every two hours up to ten, disk watched (warn 10 GB, stop 5 GB), and each interruption handled.
