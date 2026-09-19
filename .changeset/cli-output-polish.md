---
"@foldedspacelabs/metistry-cli": patch
---

The command line has a presentation layer. `packages/cli/src/ui.ts` —
hand-rolled, no dependency — decides once whether to colour (a TTY,
`NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, `--no-color`, and never under
`--json`), whether the terminal can draw `✓` or wants `[ok]`, and how wide a
paragraph may be; and it holds the pieces every verb was re-inventing: an
aligned key/value block, a table with a header rule, a closed status
vocabulary with one colour each, and a spinner that animates on a terminal
and prints one line everywhere else.

Applied to the verbs an operator sees most. `doctor` groups its rows by kind
and puts the remediation — the reason a red row is read at all — wrapped
underneath that row instead of in a ragged fifth column; `version` and
`deployment` and `connect --list` are aligned tables; `compute providers
test` shows the listing and the completion as sub-rows; `update` narrates its
steps and ends with one line saying whether it landed and what moved;
`migrate-layout` shows each section's moves as a `from → to` table; `--help`
opens with the verbs grouped by what you are in the middle of doing, with the
full reference still underneath. `<checkout>/.env is still being read as a
fallback and is deprecated` was the first thing printed by almost every verb;
it is now one dimmed line at the end.

No `--json` document and no exit code changes: colour is off at the source
whenever a verb is printing for a machine. `--no-color` is new.
