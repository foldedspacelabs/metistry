---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@foldedspacelabs/metistry-cli": patch
---

Three strikes and a Stop limit (T3-12, C135, C133). **A component that fails
three times in a row stops** — `DEFAULT_MAX_STREAK` is now 3
(`METISTRY_RUNNER_MAX_STREAK` still overrides it; `metistry doctor` reads the
same default) — and raises ONE Needs You `report` per (component, error
signature) per streak: a routine's waiting failure report is turned into the
stop (`title` *stopped after 3 failures*, plus `stopped: {failures, limit,
since, at}`) rather than joined by a second row, and a collector raises its
stop as `collector-failed:<name>#<signature>`. Both clear at their source on
the next clean run. **A Stop limit** that pauses routines raises ONE `report`
per budget window (`budget-stop:<scope>:<window>:<stamp>@<limit>`), naming
every routine it paused, with *Raise* — cleared once the budget no longer
stops them. Core's `budgetMiss` now returns the `BudgetMiss` it hit (a
`PreflightMiss` with `hit`); the runner's requests seam gains
`collectorSucceeded`, `componentStopped`, `budgetStopped` and `budgetResumed`.
