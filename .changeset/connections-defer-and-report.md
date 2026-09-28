---
"@foldedspacelabs/metistry-mcp-brain": minor
"@metistry-apps/assistant": minor
---

**Defer and report (T4-22, C59).** A `tools/call` may say nobody is there to ask: `_meta` `com.foldedspacelabs.metistry/interactive: false`, beside the turn handle. An Ask First `connections_call` from such a run is deferred rather than paused — it answers `{ skipped: true, reason: "waits_for_you", proposal_id }` at once, dials nothing, raises the same `connection_call` request in Needs You (provenance `deferred: true`), and its `runs` row carries `outcome: "deferred"` and `unattended: true`. Absent or malformed is interactive, T4-9's `pending` unchanged; the bit grants nothing — the call runs only on the owner's Approve. The assistant sends `false` for a routine's turn and a New Routine's crew run, `true` for a chat turn and a delegated crew, and after an unattended run reads its own deferred rows back into the run's row (`meta.skipped`, `meta.skipped_count`) and the foot of its output.
