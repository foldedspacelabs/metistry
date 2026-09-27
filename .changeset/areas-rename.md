---
"@metistry-apps/console": minor
"@metistry-apps/routines": minor
---

C82's rename: the per-area work rollup (`work` grouped by area — open / in progress / blocked / closed this week) is now **Areas**, not Projects, so it never reads as the same thing as the per-project rollup with modes, budgets and a cap. The seed gains `areas_overview` (identical SQL to `projects_overview`, which stays loaded as an alias for one release); the dashboard's Work ▸ Projects sheet now labels the two panels Projects and Areas, and the morning brief's section is `📂 Areas:`.
