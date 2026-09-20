# Facets, colour and the mark

Boards: `Facets, colour and the mark` · `The Obsidian plugin`. Supersedes the
facet ladder in `screen-05-today.md` §13.3; the item contract there stands.

## 1. Three channels, and they never borrow from each other

The first pass was too grey. The fix was not a louder ladder — it was noticing
that one channel was being asked to say three different things.

| Channel | Carries | Vocabulary |
| --- | --- | --- |
| **Hue** | *what kind of thing* a chip points at | `entity-person` · `entity-note` · `entity-project` · `agent` · neutral |
| **Weight and fill** | *how much it matters* | priority, and nothing else |
| **Tint** | *something is wrong* | `degraded` · `failed` · `stale` · `ok` |

Split them and colour becomes cheap. **Hue can be generous, because it is only
ever naming a kind** — a rose chip is a person whether that person is urgent or
not. And the state tints stay rare, which is the only reason they still mean
anything.

**Three new tokens**, each ≥4.5:1 on its own quiet fill, with the quiets tuned
into the existing band (~1.17:1 on `bg` light, ~1.48:1 dark) so an entity chip
never outweighs a state chip:

| Token | Light | Dark | Points at |
| --- | --- | --- | --- |
| `entity-person` | `#bd2c40` on `#ede0e1` | `#e17d8b` on `#3b3031` | an `@mention` resolving to a People/ page |
| `entity-note` | `#1b734a` on `#cfe9dd` | `#29af71` on `#1d382b` | a note, a page, a document link |
| `entity-project` | `#345dcf` on `#dee3f0` | `#7d98e1` on `#27324e` | a project or an area |

**The cap, loosened:** at most **three** chips on one item, of which at most
**one** may be a state tint. Entity chips are no longer rationed — they are how
you read the line.

## 2. Priority is weight, not hue — and louder than it was

`P1` is a **solid badge**: `text-primary` fill, `bg` text. `P2` is outlined.
`P3`/`P4` are plain text, and `P3` is usually omitted because unset sorts
there.

Red for P1 was drawn on the board and argued against. It costs the page twice:
it collides with `failed`, which already means *this broke*, so an overdue P1
beside a failed collector is two reds meaning two different things. And in a
system you run for yourself, everything becomes P1 within a month — a red P1
makes the whole page red and trains you out of seeing red, which is expensive
because red is the last thing that can still interrupt you.

The solid badge is **louder than red in greyscale** and spends no hue. If a
warmer P1 is wanted, the honest move is a `priority` token of its own, never a
borrowed state colour.

## 3. Capitalisation — one rule

> **An attribute name is Title Case. A value is verbatim, always.**

The second half is not style: a value is usually something the owner or an
agent wrote, and P1 says data is not case-corrected.

| Was | Is | Why |
| --- | --- | --- |
| `overdue` | **Overdue** | an attribute name |
| `2 places` | **2 Places** | an attribute name, even starting with a number |
| `jim fallon` | **Jim Fallon** | a *value* — as the vault spells it, never recased by us |
| `LINEAR:ABC-123` | `linear:ABC-123` | an identifier is a value |
| `lease-renewal.md` | **Lease Renewal** | the title is the value; the path belongs in the tooltip |

Section labels keep the small all-caps style — they are furniture, not
attributes.

## 4. The spark — one mark for Metis, two meanings

On a **button** it means *Metis can do this for you*. On **content** it means
*Metis wrote this*. Same promise from two directions, so the same mark and the
same colour.

**Purple stays.** It sits 87° from the person rose, 113° from the note green,
41° from the project blue and 75° from the accent teal — the only hue in the
set with that much room on both sides, which matters because it is the one that
has to be recognisable as a 7px dot.

**A delegate button appears only where delegation is real.** A task needing
your signature or your voice does not get one. A spark on something Metis
cannot actually take is worse than no spark: it is the mark losing its meaning
in exchange for looking helpful.

## 5. Agent prose is set in a serif, and carries a verdict

`ui-serif` — New York on Apple, Georgia elsewhere. **No font is loaded**, so P7
holds.

You can tell it is the assistant **before you have read a word**. You already
know a model can be wrong; the typeface is what lets you hold that thought
without a warning label on every paragraph. It also does what the tint cannot:
**it survives being quoted** — copy a briefing into a note and the purple wash
is gone, but the serif still says where the sentence came from.

**Thumbs on every piece of agent prose**, not only in Chat: same control, same
two verbs, same optional note on a thumbs-down. If the output is worth rating
in one place it is worth rating everywhere, and one feedback signal beats
three. Needs a stable id per piece of prose — request **B7**.

## 6. The Obsidian plugin

### 6.1 The same object in both apps

Same geometry, same radius, same hue, same capitalisation. **Only the ground
changes**, because Obsidian's theme belongs to the user and the plugin has no
business overriding it: it reads its grounds from Obsidian's own CSS variables
and brings the entity hues and the geometry with it.

The raw line stays one keystroke away and is the thing that actually exists.
The chips render a line you could have typed by hand, which is why the plugin
can be uninstalled without losing anything.

### 6.2 Discovery — the menu teaches the shorthand it inserts

The hint appears **only on a line that is already a task**, and fades once the
menu has been used a few times. Nothing appears while writing prose — this is a
note-taking app first.

**Every menu row shows the literal text it will insert.** Pick *Due → Friday*
three times, read `due friday` on the right each time, and by the fourth you
type it. **The menu is the discovery path, typing is the speed path, and the
menu's job is to make itself unnecessary** — a picker that hides its own syntax
keeps you dependent on it forever, which is fatal when the real use is typing
fast in a meeting.

Both paths stay live: `⌘J` opens the menu, `/` opens it inline, and typing
`p1` / `@Jim` / `due fri` skips it. One grammar behind both —
`packages/core/src/task-filter.ts`.

**Autocomplete is scoped to what exists**: `@` from People/ pages, `+` from
projects, `[[` from notes. An assignment can only name a person you have a page
for, so a typo is a miss rather than a new person — the same discipline as the
meeting card refusing to guess an attendee's page.
