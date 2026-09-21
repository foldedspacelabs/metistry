# The design canvas generator

Every artboard on the Metistry design canvas is produced by this. It exists as
files on disk **so that changing a board is a small edit rather than re-sending
a program** — pasting these generators into a conversation is what made the
first design pass expensive.

## Running it

```sh
METISTRY_CANVAS=/path/to/metistry-brand-a python3 build.py          # every board
METISTRY_CANVAS=/path/to/metistry-brand-a python3 build.py board    # just one
```

It writes `<canvas>/project/<Board>.dc.html`. Publishing those to the canvas
artifact is a separate step.

## Layout

| File | What is in it |
| --- | --- |
| `lib.py` | tokens, icons, and every shared component: the facet ladder, the priority badge, entity chips, agent prose, the diff, the day bar, task rows, the toolbar and sidebar, the artifact card |
| `today.py` | the Today board's assembly |
| `board.py` | the Board's components and assembly |
| `build.py` | imports each board module listed in `BOARDS` |

`lib.py` is the stable part. A normal change touches a board module or one
function in `lib.py`; it should almost never mean rewriting either.

## Rules that are enforced by hand, so check them

- **Contrast.** Every colour pair must clear 4.5:1 for text and 3:1 for a
  non-text mark, on *the ground it actually sits on*. Most faults found so far
  were a token used against a ground it was never computed against. Check new
  pairs before publishing; `tokens.json` + `ops/scripts/build-design-tokens.mjs
  --check` covers the declared ones.
- **No quoted family names in a font stack** written into an inline `style`
  attribute — `"SF Mono"` inside a double-quoted attribute terminates it early
  and silently drops everything after it. `MONO` and `SERIF` in `lib.py` are
  already safe; do not hand-write a stack.
- **The facet order** is priority · due · estimate · people · links · state,
  everywhere a task is drawn. `trow3()` enforces it; do not assemble a task row
  by hand.

## Boards not yet ported

`Facets`, `Plugin` and `Voice` were built from earlier snapshots of this
library and are not yet modules here. Port each one the next time it changes —
it will be regenerated anyway at that point.
