- 2026-09-19 — **The command line reads like something that was designed.**
  The verbs an operator actually lives in — is my install healthy, what
  version am I on, what is this update about to do — now answer in a shape
  the eye can skim: rows grouped by what they are, one icon and one colour
  per status, the fix for a broken check wrapped directly under the check
  rather than pushed into a column that runs off the screen, and the long
  steps showing a spinner instead of a silent terminal. Colour is decoration
  and never information: every line says its status in words too, so the
  output is identical to anyone who turns colour off, pipes it into a file,
  or cannot separate red from green. It is a closed vocabulary — five status
  words, seven icons, no emoji — held to by its own tests, and a terminal
  that cannot draw `✓` is given `[ok]` rather than a box. The machine-readable
  half is untouched by all of it: `--json` turns colour off at the source, so
  what the Mac app parses is the same byte for byte, which is what makes this
  a presentation change rather than a wire change. The one notice that used
  to shout — a deprecated `.env` still being read, printed before the answer
  you asked for — is now a dimmed line after it.
