# Pre-implementation reviews (2026-08-29)

Four independent reviews of the build plan, run before Phase 1 `packages/core`,
to stress-test the design. Raw reports are in `raw/`; the aggregation prompt
for Opus 4.8 is `AGGREGATION-PROMPT.md`; the synthesized output will be
`SYNTHESIS.md`.

| File | Review | Lens |
|---|---|---|
| `raw/01-security-boundary.md` | Security boundaries | 7 trust boundaries; token lifecycle, XSS, bridge auth, shell/git reach |
| `raw/02-architecture-simplification.md` | Staff-level architecture | consistency, simplification, interfaces, stack, deployment, phasing |
| `raw/03-coherence-consistency.md` | Coherence | casing, numbering, stale refs, internal contradictions |
| `raw/04-user-voice.md` | User voice | busy-technical-user persona; install, daily flow, decision load, abandonment |

Each raw file is the reviewer's final report, extracted verbatim from its agent
transcript. Nothing has been summarized or interpreted.
