---
"@foldedspacelabs/metistry-core": patch
---

`loadTestEnv`'s `hasDb` now requires **both** `METISTRY_DB_PASSWORD` and a
`METISTRY_TEST_DB_NAME` shaped like a scratch name (X-2). Before, a password
alone was enough, so a bare `vitest` on a checkout with an install password
but no scratch name set reached `testDb()`'s refusal in every DB-backed
suite instead of skipping it via `describe.skipIf(!hasDb)`.
