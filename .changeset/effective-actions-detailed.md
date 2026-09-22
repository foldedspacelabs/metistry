---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": patch
"@foldedspacelabs/metistry-cli": patch
"@metistry-apps/macos": patch
---

**The owner can now see WHY an action's mode is what it is, not just what it is.** `effectiveActions()` resolved the (kind → mode) table but dropped the reason, so `metistry agents autonomy`, the console's registry panel and MetistryKit each had to recompute it to say whether a mode was set, defaulted, or clamped to the level's ceiling — and clamped is the one case where the owner's own setting is being overridden. Core adds `effectiveActionsDetailed()` beside it (`effectiveActions` is now a projection of it, so the two cannot drift), and every surface reads that one function instead: `metistry agents autonomy` marks each row set / dimmed-default / clamped-with-ceiling and says the modes as **Allow · Ask First · Never**; `GET /api/agents`'s `scope.autonomy` carries a `detailed` table beside the plain one, so a console never re-derives it; MetistryKit's `AgentRecord` decodes the same table into `actionsDetailed`.
