---
"@foldedspacelabs/metistry-cli": patch
---

Fix a `migrate-shape` defect that took production down on 2026-09-10: the
rollback (`metistry migrate-shape compose`) did not wait for the `launchctl
bootout` of `db`/`console`/`assistant` to actually finish, nor for the
bundled Postgres to let go of its port, before calling `docker compose up` —
which lost that race with `ports are not available … address already in
use` and exited 1 with the install completely down (no launchd jobs, no
compose containers).

- Both directions now wait properly: the rollback reuses `up`'s
  wait-for-label-gone helper after each `bootout`, then polls `pg_isready`
  until the bundled Postgres stops answering, before touching compose.
- Both directions now compensate a failed `up`: the rollback restores the
  launchd jobs it just booted out (bootstrap + kickstart the plists still on
  disk) and flips `deployment.yaml` back to `launchd`; the forward migration
  brings the compose stack back up and flips `deployment.yaml` back to
  `compose`. Either failing now leaves the install exactly as it was, never
  with nothing running.
- A second forward run after a rollback now works: a leftover
  `<instance>/state/pg` (from the earlier restore) is moved aside to
  `state/pg.<ts>.stale` — never deleted — before `up`, so `initdb` runs fresh
  and `pg_restore --exit-on-error` lands in an empty schema.
- `docs/ops/migrate-compose-to-launchd.md` documents the `.stale` directory
  and adds a "what a failed rollback looks like and how to recover" section
  with the exact by-hand recovery command.
