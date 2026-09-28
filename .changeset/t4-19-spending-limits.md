---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Spending limits, side by side — and a subscription has no dollar limit (T4-19, C130, C133).** `GET /api/compute` gains `limits`: this instance's limit, each provider's, and each project's daily budget, each beside what has been spent against it — what Settings › Compute › Spending limits and the Usage popover read. Core's new `spendingLimits` is the fold, over rows read through the `spend` and `projects_rollup` named queries (the same read `GET /api/projects` makes); a query that is not loaded is `null`, never a guessed zero. A provider billed by subscription is its plan's window — `kind: "window"`, the calls made in each window, no amount and no action — and `compute.yaml`'s schema now refuses `budgets.providers.<name>` on one, naming the field and the two ways out, so `metistry compute budget`, `POST /api/compute/budget` and `providers set --billing subscription` all refuse it identically. A file that already carries a dollar limit on a subscription provider no longer loads until that limit is removed (the hot reload keeps the last good configuration and records why).
