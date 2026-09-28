---
"@metistry-apps/assistant": patch
---

**A budget refusal is now a `report`, not a `decision` (ruled at the W2 checkpoint, ruling 12, X-13).** A chat turn stopped by a budget used to raise a `decision` proposal with two options ("allow one more window" / "leave it stopped") — a choice this queue never actually offers, since `compute.yaml` is a protected path and the limit moves only by the owner's own hand (invariant 2). `apps/assistant/src/budgets.ts`'s `offerBudgetWindow` now raises a `report` instead, matching the shape the runner already uses for a routine paused by the same budget (`BUDGET_STOPPED_KIND`, `apps/console/src/runner.ts`): a title and excerpt naming what stopped and why, and one `act` — Raise, straight to Settings › Compute › Spending limits — rather than a false choice.
