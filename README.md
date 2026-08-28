# Metistry

A local-first personal assistant and knowledge graph. State is durable
(markdown in git + Postgres); agents are disposable. Apache-2.0.

**This is the product repo — code only.** Each install lives in its own
private *instance repo* (vault, `identity.yaml`, config, `metistry.lock`
release pin), created by `metistry init` and owned by whoever runs it. Code
flows to instances as versioned releases, never as git merges; instance data
never flows anywhere. See build plan §4.15. The assistant's name exists only
in an instance's `identity.yaml` (seed template in `seed/`).

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
