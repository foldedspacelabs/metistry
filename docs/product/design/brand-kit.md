# Brand kit — Metistry (round A, 2026-09-18)

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
| ≥ 128 px | 52% | 8 |
| 64 px | 58% | 9 |
| 32 px | 64% | 10 |
| 16 px | 68% | 11 |

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
| PWA **maskable** | full bleed | mark at **40%**, not 52% — everything outside the 80% safe circle can be cropped |

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
| `app-icon-1024.svg` | the macOS master, art inset on the grid, 52% / stroke 8 |
| `app-icon-ramp-64.svg` | the 64 px slice: 58% / stroke 9 |
| `app-icon-ramp-32.svg` | the 32 px slice: 64% / stroke 10 |
| `app-icon-ramp-16.svg` | the 16 px slice: 68% / stroke 11 |
| `pwa-icon.svg` | the PWA icon, full bleed |

The four ramp files are the reference a generator is checked against: render
each at its own size and the output should match pixel for pixel. The maskable
variant is the master geometry at 40% rather than 52% and needs no file of its
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

## Outstanding

**The wordmark letterforms are not delivered.** Every lockup so far sets
"Metistry" in the system stack, which is right for a mockup and wrong for a
wordmark: Apple's SF licence does not cover use in a logo or trademark, and
P7's "no third-party font, ever" rules out buying one. So the wordmark has to
be **drawn as outlines** — informed by the system font's proportions so it sits
naturally beside UI text, but its own artwork. That is the next piece of round
A, and it is the one that needs a decision from the owner about how much
character the letterforms should carry.
