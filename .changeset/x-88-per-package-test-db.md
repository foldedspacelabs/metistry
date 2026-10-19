---
"@foldedspacelabs/metistry-core": patch
---

`recreateScratchDb` in `@foldedspacelabs/metistry-core/test-env` takes a `template` option: the new `<METISTRY_TEST_DB_NAME><suffix>` database is a `TEMPLATE` copy of that scratch database instead of empty. The template is held to the same rules as the name being created — a scratch name, within Postgres's limit, never an install's. The root `pnpm test` uses it to give every workspace package a migrated copy of the shared scratch database (`ops/scripts/test-workspace.mjs`), so no two packages' DB-backed suites share rows. Every database it creates is set to answer in UTC (`ALTER DATABASE … SET timezone`), as `ops/scripts/test-db.sh` now sets the shared one, so time-dependent suites behave as in CI on any server.
