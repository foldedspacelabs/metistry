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

**It fades to 55% after ten seconds without the pointer** and returns on
approach. That is the only fade in the product, allowed because at rest the bar
carries nothing. **While a session runs it may never fade, dim or hide** — the
anti-Glass rule: Glass sold invisibility as a feature and called
`setContentProtection` on every window. This is the opposite object.

## 3. The live state — the same object, louder

The mark **fills**, the border takes the `agent` hue, the elapsed time runs
vertically beside it, and **Stop** is one click from anywhere on screen.

- **Hue and weight, never tint.** Recording is not a fault, and tint means
  *something is wrong*. Metis hearing you is Metis doing something: `agent` hue
  at full weight.
- **It does not pulse.** C16, ratified the same day: motion only where it carries
  information the reader cannot otherwise get. `13:42` advancing *is* the
  liveness, and a number is content rather than decoration — a breathing dot
  would be a second loop in a product that has ruled itself one.
- **macOS's own orange indicator is untouched.** We never suppress it and never
  imitate it. The system's indicator is the one a sceptical person trusts; ours
  is the one that says what it is doing.

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

## 5. Starting a session — one act per sense

**One session, not three toggles.** The owner's worry — *enabling visual, audio
and microphone for a meeting seems like a lot of work* — is right, and the fix is
to stop modelling senses as switches. **Listen to this meeting** is one act that
takes the meeting's audio and the microphone together, because a conversation is
both halves or it is nothing. The grants are asked for once, by macOS, in its own
words.

The sheet shows, before anything starts: **what it will hear** (named processes,
by bundle id), **which permissions macOS holds** and which it will ask for,
**when it stops on its own**, and **what is kept** — text for 90 minutes in
`.metistry/state`, the audio transcribed and dropped, and one proposal in Needs
You afterwards with nothing written until it is approved.

**Hearing and seeing are not siblings, and the two sheets differ on purpose.**
A Core Audio process tap only ever yields the named processes' audio
(`CATapDescription.processes`, `.bundleIDs` on macOS 26), so *the system enforces
this list* is a fact. Screen capture has no equivalent (§6). Drawing them as two
identical switches would make the second one a lie.

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

## 7. Glass, and the opacity floor it needs (C70)

§4.4 says "nothing here depends on a translucent ground", and C4 logged that no
declared contrast pair holds on a vibrant material. The owner wants the bar to
look like the OS, so this is a **deliberate exception that needs a number**.

Each ink composited over the scrim at every opacity from 1.00 down, against five
backdrops — white, black, mid grey, deep blue, bright yellow — worst case taken:

| Ink | Needs | Min opacity, light | Min opacity, dark |
| --- | --- | --- | --- |
| `text-primary` | 4.5:1 | 0.51 | 0.65 |
| `text-secondary` | 4.5:1 | 0.78 | **0.83** |
| `text-tertiary` | 3:1 | 0.77 | 0.81 |
| `accent` | 3:1 | 0.66 | 0.68 |
| `agent` | 3:1 | 0.71 | 0.72 |

**The rule: the bar's scrim is never below 0.85, and the blur is decoration on
top of it.** At 0.85 every ink clears with margin (secondary 4.95:1 dark,
tertiary 3.58:1) and the wallpaper still reads through as glass.

This is the **fourth mechanism** by which contrast has failed in this engagement
— wrong token (C49), two inks too close (C54), opacity on the ink (C63),
translucency under it (C70). All four are one lesson: **check the composite,
never the token.**

## 8. Settings ▸ Live capture

- **Placement:** left or right edge, drawn rather than named; which display; and
  roughly how far down, draggable after. **Top and bottom are not offered** — the
  menu bar owns the top, the Dock and the system's own recording pill own the
  bottom.
- **The grant table is a read-through, not a control.** macOS holds these; the
  pane reports them and links to System Settings. Same shape and same reason as
  the Compute pane: a console that pretended to grant a TCC permission would be
  lying about who decides.
- **Purge now** is the one destructive verb, here rather than on the bar, with
  the line above it saying what is held — *14 minutes of text from one session*.
- **Absent, not off, without the bridge.** No bridge, no pane, no bar, no grants
  (`degrades: absent`). A personal instance that never installs it has no
  capture surface at all.

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
