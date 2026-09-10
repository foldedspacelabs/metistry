---
"@foldedspacelabs/metistry-cli": minor
---

Move a LIVE install between the two deployment shapes, with its data, in one
reversible verb — `docs/ops/migrate-compose-to-launchd.md` is the runbook.

- **`metistry migrate-shape launchd`** quiesces the console and the assistant,
  `pg_dump`s the live database through the running `db` container to
  `<instance>/state/migrate/<ts>.dump` and **verifies it with `pg_restore
  --list` before stopping anything**, `docker compose stop`s (never `down -v`
  — the containers and the volume are the rollback), writes `deployment.yaml`
  through the reconciler as the `user` principal, runs `up`, `pg_restore`s
  **before any migration runs** (the dump carries `schema_migrations`, so the
  next `metistry update` applies none), compares every table's exact row count
  and fails by name if one lost rows, and ends with `doctor` — after waiting
  for the console and the reconciler to answer, so the verdict is not a race.
  `--dry-run` prints the whole plan and runs nothing.
- **`metistry migrate-shape compose`** is the documented rollback. The compose
  volume still holds the database as it was at the cutover; anything written
  under `launchd` since is not copied back, and the verb prints the `pg_dump`
  command for it.
- **Four refusals, all while the old shape is still running and nothing has
  changed**: no bundled `runtime/`; no `ops/sandbox/assistant.sb` in the
  product tree (any pack before v0.6.0 — the assistant's launchd job could not
  start at all); no `pg_dump`/`pg_restore`/pgvector; and a namespaced instance
  whose docker compose project is not namespaced, which would have stopped
  ANOTHER install's containers.
- **The TCC bridges keep their grant.** A runtime pack ships no built
  `ek-helper.app`/`afm-helper.app`, so the migration pins those two jobs at the
  Developer-ID-signed bundles that already hold the Calendars/Reminders grant —
  same bundle id and certificate chain, so the same TCC designated requirement
  and no re-grant. Shipping prebuilt signed helpers in the pack is the recorded
  follow-up.
- **Five defects the rehearsal found**, each of which passed a green test suite
  first: a row-count query using `query_to_xml`, which the bundled Postgres
  (built without libxml) cannot execute; rows written into the gap between the
  dump and the stop; a bridge plist re-render that dropped a namespaced
  instance's ports and sent it looking for the default install's; a hand-rolled
  `bootout`/`bootstrap` that hit the same asynchronous-teardown race PR #117
  fixed for `up`; and a closing `doctor` that raced the jobs it had just
  kickstarted.
