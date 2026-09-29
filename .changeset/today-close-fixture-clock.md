---
"@metistry-apps/console": patch
---

**The console's audit rows follow an injected clock.** With `cfg.now` set (the fixture recorder, tests), `audit()` stamps the row's `ts`, `started_at` and `finished_at` with that instant instead of Postgres's `now()`. `day_close` counts the Defer door's rows by the day of `runs.ts`, so the recorder's pinned 2026-09-28 lost its deferral at real UTC midnight and `post-api-today-close` drifted (`moved` came back `{}`) on every PR. No change for an install: without `cfg.now` the wall clock is still the clock.
