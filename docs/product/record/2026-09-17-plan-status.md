- 2026-09-17 — **One engine, configurable compute, and the second-instance-first
  queue: caught up in a single day.** A docs status pass over
  `docs/plan-refresh-2026-09-13.md` and `metistry-build-plan.md`'s Queue
  refresh block, reconciling both against the 2026-09-15/17 merges
  (#141–#171): 49 rows across the decisions log, the small-adopts table, the
  refreshed queue and §4b's W1–W7 move to `done`, and the autonomy-widening
  question (OPEN-2) is resolved — the owner overturned the narrowing-only
  rule the same day #170 shipped it as executable action proposals plus
  autonomy levels. The headline the numbers add up to: the product now
  speaks exactly one engine (`openai-compatible`, no vendor SDK), compute is
  a file the owner edits rather than a rebuild, and every second-instance-
  first item that does not wait on a `v0.8.0` release (W1, W3–W7) is built.
  What remains genuinely open is now a short, named list — OPEN-1 and
  OPEN-3 through OPEN-7, crew descriptions (H8), the grammar/slot adopts
  (T1, T5), and the owner's fixtures that gate the bake-off itself — rather
  than a queue nobody had re-read since 2026-09-13. A companion note
  proposes one addition to `CLAUDE.md`'s invariants, closing the console's
  own mutating surface the same way invariant 9 already closes the
  engine's; that edit is the owner's to make.
