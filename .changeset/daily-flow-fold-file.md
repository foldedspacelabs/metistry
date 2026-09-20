---
"@metistry-apps/routines": patch
"@foldedspacelabs/metistry-cli": patch
---

**The fold has its own file; your daily note is yours.** Ticket P1-9 of
`docs/product/daily-flow-spec.md` §5.1: the evening fold now writes
`Journal/Fold/<date>.md`, `source: knowledge-fold`, and never
`Journal/<date>.md` — that file has always been the user's own daily note,
and no fold turn touches it again.

When `Templates/Fold.md` reads, the routine renders it itself — every
directive but `{{ prose }}`, the one legal only there (D14) — and hands the
skeleton plus the still-open prose slots to the SAME assistant turn it
already enqueues; the assistant's whole job is filling the numbered slots and
writing the result back verbatim. When there is no template yet (a missing
`Templates/Fold.md`, or no vault reader wired into the routine — §6.4's
`template_missing`), the fold falls back to the pre-template freeform note,
at the SAME new path, with a visible reason on the turn rather than losing
the night's fold or writing nothing at all.

`seed/assistant-prompt.md`'s Fold section (shipped by
`@foldedspacelabs/metistry-cli`, stamped into every instance by `metistry
init`/`update`) is updated to match: it names the new path, states plainly
that `Journal/<date>.md` is never a fold write target, and describes both
shapes the enqueued turn may hand it — a skeleton to fill or a freeform note
to compose.
