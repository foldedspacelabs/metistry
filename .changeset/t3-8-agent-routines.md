---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/assistant": minor
---

**New Routines run, and their per-run grants are read-only** (T3-8). `routineAssignmentSchema`'s `grants` loses `write:` — a `write:` key is refused by name with the owner's ruling, since a routine's reserved subfolder is an ownership fact, never a grant. New exports carry the contract the console's runner, the crew drain and the console's door share for a New Routine's run: `ROUTINE_RUN_META_KEY`, `RUN_BEARER_META_KEY`, `routineRunMeta`, `routineRunReads` (only agent-grantable prefixes survive a read-back), `grantArea`, `newRoutines`, `routineGrantsFor`, `GRANTS_READ_ONLY_REFUSAL`. `POST /api/scheduled/routines` is served in the client API table (reach `local`).
