# Metistry

A local-first personal assistant and knowledge graph running on a Mac Studio.
The assistant is **Metis** (named only in `identity.yaml`). State is durable
(markdown in git + Postgres); agents are disposable.

## Where things are

- **`metistry-build-plan.md`** — the full design. Decisions already made, not
  suggestions. Start here.
- **`CLAUDE.md`** — conventions for building Metistry (not Metis's own operating
  instructions, which live at `Knowledge/CLAUDE.md` later).
- **`START-HERE.md`** — original Phase 0 kickoff notes.
- **`poc/RESULTS.md`** — Phase 0 proof-of-concept findings (the real results).
- **`poc/`** — throwaway PoC scratch code, one dir per PoC. Not product; will be
  reorganized.

## Status

**Phase 0 (proof of concepts) complete — 2026-08-28.** 10 PASS, 2 deferred
(RTSP camera, Obsidian Sync), 2 informative fails (comms-reduction precision,
a rejected local input-classifier idea). See `poc/RESULTS.md` and the
"Outcomes" table in §2 of the build plan.

**Next: Phase 1 — Substrate** (monorepo skeleton, `packages/core`, Postgres +
pgvector compose, first migrations, Linux CI). Not started.
