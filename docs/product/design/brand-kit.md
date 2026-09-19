# Brand kit — Metistry (rounds A and B, 2026-09-19)

> The marks, the one colour, the sizes they survive at, and what not to do.
> Chosen from three directions on 2026-09-18 (direction **C**), then refined
> once because the first cut read as a house. Nothing here needs colour to be
> legible.

## The mark

A square with one corner cut deep: **a boundary that only fits one way.** It is
the product's safety story as a shape — every boundary explicit, testable, and
keyed so a thing goes in one way or not at all — and it is the simplest durable
form that is not already a UI icon.

The geometry is fixed. In a 64-unit grid: a square from 12 to 52, the
**bottom-left** corner cut by 26 units, stroked on the centre line.

```
M12 12 H52 V52 H38 L12 26 Z
```

**The counter is the mark.** It is never filled: a solid 16 px slice is a
rounded blob with a nick in it and says nothing. This was tested by rendering,
not assumed — see "The optical ramp".

**Avoided, deliberately:** owls, laurels, columns, helmets, brains, sparkles,
robot faces, glowing orbs, gradient meshes, and the letter M as the whole idea.
The two placeholders it replaces were both an M.

## The one colour

Pinned as the brand colour (ruling 8, 2026-09-18). `controlAccentColor` drives
only the controls Apple draws itself — checkbox fills, text selection, the
system focus ring — so every pair the contrast checker declares describes the
app that actually ships.

| Role | Light | Dark | Was |
| --- | --- | --- | --- |
| `accent` | `#125f6b` | `#6ec9d6` | `#2b5fd0` / `#7ea9ff` |
| `on-accent` | `#f6f7f9` | `#07161a` | `#ffffff` / `#0b1220` |

Measured with `ops/scripts/build-design-tokens.mjs`'s own WCAG 2.1 formula:

| Pair | Ratio | Was |
| --- | ---: | ---: |
| `on-accent` on `accent`, light | **7.30:1** | 5.75:1 |
| `accent` on `bg`, light | **6.81:1** | 5.37:1 |
| `accent` on `surface`, light | **7.30:1** | 5.75:1 |
| `accent` on `bg`, dark | **9.84:1** | 8.06:1 |
| `accent` on `surface`, dark | **8.97:1** | 7.35:1 |
| `on-accent` on `accent`, dark | **9.65:1** | 8.03:1 |

Petrol is **not one of the eight macOS system accents**, so the mark never
collides with the user's own choice — which was the reason for pinning it.
`agent` stays `#6a4bbd` and is now nowhere near the accent in hue, which is
what P1 actually requires of it. The full colour system, including the quiet
fills and the chart ramp, is round B.

## The optical ramp

One silhouette, one weight — but the mark **grows** and its stroke **thickens**
as the slice shrinks, because at 52% / stroke 8 the counter closes up below
32 px.

| Slice | Mark, as a fraction of the tile | Stroke, in the 64-unit grid |
| ---: | ---: | ---: |
| ≥ 128 px | 62% | 8 |
| 64 px | 66% | 9 |
| 32 px | 68% | 10 |
| 16 px | 70% | 11 |

Revised 2026-09-19: the first ramp ran 52% → 68% and left the large slices
looking empty. The gain went almost entirely to the large end — rendering the
two ramps side by side showed 74% at 16 px crowding the tile's corners and
thinning the counter, so the small end barely moved. Clear space still grows
with the icon, which is the right direction; there is just less of it.

**This is why one master downsampled by `sips` is not enough.** The current
build (`ops/release/build-app.sh:130`) generates one 1024 PNG and lets `sips`
produce ten slices, which would give every slice the 52% / stroke-8 art. The
ten `.icns` slices need per-size art. See "What the build needs" below.

## Geometry of the containers

| Target | Canvas | Art |
| --- | --- | --- |
| macOS `.icns` | art **inset 9.8%** of the canvas; tile corner radius **22.4% of the tile** | mark centred, per the ramp |
| iOS 18+ | **full bleed, no drawn radius** — the system applies the squircle | light, dark and tinted; the tinted variant carries only alpha |
| PWA favicon / apple-touch / 512 | full bleed | per the ramp |
| PWA **maskable** | full bleed | mark at **44%**, not 62% — everything outside the 80% safe circle can be cropped. At 44% the mark's diagonal is 0.62 of the canvas, comfortably inside the 0.80 circle |

## Clear space and minimum sizes

- **Clear space:** half the mark's width on every side. Nothing enters it.
- **Mark alone:** 16 px minimum.
- **Horizontal lockup:** 96 px wide minimum.
- **Stacked lockup:** 64 px wide minimum.

## Do not

- Never rotate the mark.
- Never thin the stroke below the ramp.
- Never fill it — the counter is the mark.
- Never use a second colour in it.
- Never put it in the menu bar; that stays four SF Symbols carrying
  `ok / degraded / failed / absent` (ruling 14).
- The wordmark is never set in the accent.

## Files

Vector only, deliberately. `ops/release/make-app-icon.mjs`'s own header gives
the reason the repo does not keep icon binaries — "a binary blob nobody
remembers is the kind of placeholder that ships forever" — and that reasoning
survives the placeholder it was written about. These SVGs are the source; the
`.icns` slices and the PWA PNGs are build output.

| File | What it is |
| --- | --- |
| `mark.svg` | the mark alone, 64 grid, in `accent` |
| `mark-template.svg` | the same in black, for a template or mask context |
| `app-icon-1024.svg` | the macOS master, art inset on the grid, 62% / stroke 8 |
| `app-icon-ramp-64.svg` | the 64 px slice: 66% / stroke 9 |
| `app-icon-ramp-32.svg` | the 32 px slice: 68% / stroke 10 |
| `app-icon-ramp-16.svg` | the 16 px slice: 70% / stroke 11 |
| `pwa-icon.svg` | the PWA icon, full bleed |

The four ramp files are the reference a generator is checked against: render
each at its own size and the output should match pixel for pixel. The maskable
variant is the master geometry at 44% rather than 62% and needs no file of its
own.

## What the build needs — not done here

These are build and app changes, not design ones, and they are listed rather
than made:

1. **`ops/release/build-app.sh`** — ruling 16 allows an `ICON_PNG` variable,
   but one variable is not sufficient given the ramp. The better shape keeps
   the repo's own "generated, not a committed blob" reasoning: rewrite
   `ops/release/make-app-icon.mjs` so it draws **this** mark at each slice with
   the ramp, still reading `color.accent.light` and `color["on-accent"].light`
   from `tokens.json` exactly as it does today, and drop the "placeholder"
   line at `build-app.sh:138`. The four ramp SVGs here are the reference to
   check that generator against.
2. **`ops/release/make-app-icon.mjs`'s header** still tells a replacement to
   point `build-app.sh`'s `ICON_PNG` at a master; no such variable exists
   (logged as C9).
3. **`apps/console/web/icon.svg`** — replace with `pwa-icon.svg`. Today's file
   uses the **dark**-mode accent on the **dark**-mode canvas in both
   appearances, and disagrees with the app icon (C12).
4. **`apps/console/web/index.html:17`** — `apple-touch-icon` points at an SVG,
   which iOS does not honour, so an installed PWA has no home-screen icon
   (C13). It needs a 180 px PNG, rendered from `pwa-icon.svg` by the same
   generator.
5. **`apps/console/web/manifest.webmanifest`** — add the PNG entries and a
   `"purpose": "maskable"` entry, and give `background_color` / `theme_color` a
   dark counterpart; today there is one light value, so an installed dark-mode
   PWA flashes light on launch.

## The wordmark

**IBM Plex Sans SemiBold, converted to outlines.** The first attempt drew the
letterforms from scratch — monolinear strokes on a grid, with a square dot on
the `i`. The owner's read on 2026-09-19 was that it looked childish and
half-baked, and that is the right call: bespoke letterforms need a type
designer, and a stroked approximation of one reads as exactly that.

Plex is the right face for this product rather than a default: it was drawn as
an engineering typeface, it is quietly technical without being trendy, and it
is not on the avoid list (no Inter, Roboto or Arial). Set at SemiBold 600,
tracked **−14 units per 1000 em**.

**The licence, which is why this works and SF did not.** Plex is SIL OFL. The
OFL permits using the font to create artwork, including a logo, and the
reserved-name clause only restricts redistributing a modified *font* under the
name — not outlines in a wordmark. Apple's SF licence explicitly forbids logo
use, which is why the wordmark could never be set in the UI face. And because
the deliverable is **paths, not a font**, P7's "no third-party font is ever
loaded" still holds: nothing is fetched at runtime and no licence rides along
with the app.

`brand/wordmark.svg` is the artwork, in `text-primary`, `viewBox 0 -1025 3716
1300`. For a reversed lockup swap the `fill` for the dark theme's ink; the
geometry does not change.

## Outstanding

~~**The wordmark letterforms are not delivered.**~~ Delivered 2026-09-19. Every lockup so far sets
"Metistry" in the system stack, which is right for a mockup and wrong for a
wordmark: Apple's SF licence does not cover use in a logo or trademark, and
P7's "no third-party font, ever" rules out buying one. So the wordmark has to
be **drawn as outlines** — informed by the system font's proportions so it sits
naturally beside UI text, but its own artwork. That is the next piece of round
A, and it is the one that needs a decision from the owner about how much
character the letterforms should carry.


---

## Round B — the themes (2026-09-19)

Two themes, one system. **Light is warm paper; dark is neutral.** The light
ground moved off `#f6f7f9`, a cool grey, onto `#f7f4ee` — and with it every
neutral, because a cool grey text on a warm ground reads as dirt. Dark is
unchanged apart from the accent, because it was already right.

| | Light | Dark |
| --- | --- | --- |
| `bg` | `#f7f4ee` | `#0e1216` |
| `surface` | `#fffdf8` | `#171c22` |
| `sunken` | `#efeadf` | `#0b0e12` |
| `border` | `#e4ded1` | `#2b333d` |
| `text-primary` | `#1a1815` | `#e9edf1` |
| `accent` | `#125f6b` | `#6ec9d6` |

**Nine roles were added, and they are why the check went from 74 pairs to 122.**

- **Quiet fills** — `ok-quiet`, `degraded-quiet`, `failed-quiet`,
  `absent-quiet`, `stale-quiet` and one per presence state. Each is the fill a
  chip is *actually painted on*, declared so the contrast check sees the ground
  that ships rather than `surface`, which nothing is drawn on. This is the fix
  for the three chips that were failing AA in light mode.
- **`stale`** — `#5a6670` / `#96a4b0`, with its own quiet fill. Deliberately a
  cool grey against the warm neutrals: `absent` is warm and means "never
  configured"; `stale` is cold and means "was answering and has not lately".
  The two are now distinguishable without reading the label.
- **`destructive` / `on-destructive`** — a fill, where `failed` is a
  foreground. This is what the Decline button's inline `#7a3b3b` literal
  becomes.
- **`chart-1..3`** — a three-step sequential ramp in the accent's hue.

**Why three chart steps and not five.** Two reasons, and the second is a
finding. First, a sequential ramp is one hue by definition, and identity is not
what these are for: the compute tiers are *ordered*, so they take the ramp, and
four or more series become small multiples rather than more hues — every other
hue in the product already means something, and the status colours are
reserved. Second, `build-design-tokens.mjs` holds every declared pair to
**4.5:1**, exempting only `focus-ring`. WCAG sets **3:1** for non-text
graphics, which is what a chart mark is. Under the 4.5 bar, five ordered steps
on a near-white ground collapse — steps four and five came out at 4.80:1 and
4.77:1, visually identical. **Recommendation:** add the `chart-*` roles to the
generator's non-text set alongside `focus-ring`, and the ramp can go to five
steps and read more calmly. That is a one-line change to the checker, so it is
logged rather than made.

All **122 declared pairs pass**; `node ops/scripts/build-design-tokens.mjs
--check` is green, and the generator rebuilt `tokens.css`, the PWA's
stylesheet, `design-tokens.swift` and `preview.html` from the JSON with no
hand-editing.


---

## Round B revised — 2026-09-19

Four changes from the owner's review of the first theme pass, and one of them
moves the information architecture.

**Usage left the sidebar.** It is now a **gauge beside the bell**, top-right,
with capture's "+". So the fixed navigation is **five** sections — Chat ·
Activity · Work ▸ · Knowledge ▸ · Agents — plus Pinned, and there are **three**
global controls rather than two. This supersedes the part of ruling 17 that
kept Usage last in the sidebar: it is not in the sidebar at all.

> **Needs amending by whoever owns those documents, not edited here:**
> `design-system.md` P6 and §3.1 (which say six sections and two global
> controls), §3.18's "the product's only badge" paragraph (the gauge carries no
> badge, so the rule survives — but the sentence enumerates the controls), and
> `app-ux-plan.md` §3.1 and §3.3's per-platform table. On iOS the tab bar is
> unaffected: it was already four plus More.

**Every section row has an icon**, so the sidebar is scanned rather than read.
SF Symbols first, per the brief; the drawn icons on the canvas stand in for
these and the build should use the real symbols:

| Row | SF Symbol |
| --- | --- |
| Chat | `bubble.left.and.bubble.right` |
| Activity | `waveform.path.ecg` |
| Work | `checklist` |
| Knowledge | `text.book.closed` |
| Agents | `person.2` |
| Usage (top-right) | `gauge.medium` |
| Needs You (top-right) | `bell` |
| Capture (top-right) | `plus` |

**Feed rows are column-aligned.** Every subject starts at one left edge behind
a fixed 28px kind-glyph column, and the actor moved to a second line with the
detail. Previously a variable-width actor chip pushed each subject to a
different x, which is the thing that makes a list unscannable — the eye has no
column to run down.

**Approve is affirmative, not accent.** Two new roles, `affirmative` /
`on-affirmative` (`#1c6b42` / `#48b87b`), parallel to `destructive` /
`on-destructive`. `ok` stays what it is — the *state* role — because a button
that starts something is not a status report about it.

> **This is a change to P2**, which says colour buys exactly three things: one
> accent, state, and presence. It now buys four: accent, state, presence, and
> **action intent** — the affirming action and the destructive one. `destructive`
> already broke the rule when it was added; this makes the amendment explicit
> rather than leaving two roles outside a principle that does not mention them.

**The chart ramp went back to five steps.** `build-design-tokens.mjs`'s
`NON_TEXT` set now holds the `chart-*` roles beside `focus-ring`, so they are
judged at WCAG 1.4.11's **3:1** for non-text graphics rather than the 4.5:1
text bar. The ramp is spaced evenly *by relative luminance* rather than by eye,
and holds the accent's hue and chroma at every step — an earlier attempt spaced
it evenly and went grey, which is worse than a compressed ramp. **128 pairs
pass.**


### The window title names the product, not the section

Ruled 2026-09-19. The title bar reads **Metistry** on every screen, beside the
mark — it is the window's identity, not a breadcrumb. Which section you are in
is already carried by the highlighted sidebar row, and a title that changes as
you navigate spends the one persistent place the product can say its own name.

A section heading inside the content pane is a separate question and is **not**
drawn here; propose it with the Activity screen if the pane needs the hierarchy.
