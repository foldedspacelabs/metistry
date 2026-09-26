---
"@foldedspacelabs/metistry-core": patch
---

**`@foldedspacelabs/metistry-core/test-env` gains `testDb()` — the one guarded way a test opens Postgres.** `await testDb(pg.Pool)` refuses, before a socket opens, unless `METISTRY_TEST_DB_NAME` is set, names a `metistry_test_*` database, and is not a `METISTRY_DB_NAME` any install's `.env` on the machine is configured with; it connects with host/port/user/password from `METISTRY_DB_*` only, then checks `SELECT current_database()` and ends the pool rather than hand over the wrong one. Companions: `testDbConfig`, `testDbEnv` + `assertScratchDb` (for code under test that reads `METISTRY_DB_*`), `recreateScratchDb` / `dropScratchDb` (a suffixed database of a suite's own), `installDbNames`. Core still does not depend on `pg` — the caller passes the constructor. Every product test now goes through it; previously a shell with only `METISTRY_DB_PASSWORD` set could send a suite at the live install's Postgres on 5432.
