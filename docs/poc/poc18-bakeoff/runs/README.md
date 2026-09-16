# Raw runs

One file per (candidate, run): `<candidate>-<ISO timestamp>.jsonl`, one JSON
object per case, with a `<candidate>-<ISO timestamp>.meta.json` beside it
carrying `server`, `quant`, `server_build`, `host` and the reasoning style
actually set for that run.

**These are committed.** They are the PoC's evidence, the way
`poc15-complexity/` and `poc16-local-scorer/` committed theirs, and the report
is arithmetic over them — anyone who pulls the repo can regenerate the result
without a model.

`.transcripts/` is **not** committed (`.gitignore`): full message histories are
large and can carry vault content. A row's `transcript_ref` points into it, so
a rubric revision re-scores on the machine that produced the run.

Nothing has been run yet — the fixtures are the owner's to write (§3.8).
