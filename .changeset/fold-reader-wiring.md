---
"@metistry-apps/console": patch
---

**The fold gets the vault reader, so `Templates/Fold.md` renders.** A wiring
gap between #246 and #247: the runner's `ComponentCtx` grew `queries` and
`vault` for `plan-tomorrow`, but `knowledge-fold`'s `FoldCtx` reads the
template through `reader`, a field `ComponentCtx` never carried — so every
fold on every instance took the pre-template fallback note regardless of
whether `Templates/Fold.md` was stamped.

`apps/console/src/runner.ts` gains `routineCapabilities`, the one place
`ComponentCtx`'s `queries`, `vault` and `reader` are built from what
`main.ts` already has, and `ComponentCtx` itself now carries `reader`.
`vaultReader` — the `VaultReadable` → `TemplateReader` adapter — moves from
`plan-tomorrow/run.ts` to a shared `routines/vault-reader.ts` so the runner
builds the exact adapter `plan-tomorrow` already trusted, rather than a
second implementation of "a refusal reads as absent" (§6.4). No behaviour
changes for an instance without the reconciler bridge configured, or without
`Templates/Fold.md` in its vault — both still take the documented fallback.
