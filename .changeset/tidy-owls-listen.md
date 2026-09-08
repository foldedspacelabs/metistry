---
"@foldedspacelabs/metistry-core": minor
---

`parseDecisionBlock` — the question-answer convention (§4.21). A reply whose
last block is a fenced ```decision block (a `title:` line plus two to eight
`options:`) is a blocking question; the emitter parses it where the reply is
stored and turns it into one queue item. Strict by design — a malformed block
parses to null and is ignored, so the shape is all a model can put in front of
the user.
