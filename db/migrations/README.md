# db/migrations

Plain SQL, applied in filename order, once each, one transaction per file,
under a Postgres advisory lock — by `ops/scripts/migrate.sh` (psql, no build)
or by `metistry update` (`packages/cli/src/migrate.ts`, the pg driver). Both
take the same lock key, so they never interleave. Only `*.sql` is read; this
file is not a migration.

**The filename is the identity.** `schema_migrations` records it, so a renamed
file is a new migration and runs again, and a deleted one leaves a row no file
answers on every install that applied it. A shipped file is never renamed,
renumbered or deleted.

## Writing one

- **Additive-first** (CLAUDE.md): new tables and columns, not rewrites. A
  destructive migration needs an explicit decision and a rollback note in the
  PR.
- **A header comment** that says what the migration answers, its
  **durability** — durable, derived (rebuilt after `down -v` by a walk or a
  collector), ephemeral, or no data (invariant 1) — and a **ROLLBACK** note
  with the statements that undo it.
- **Named `NNNN_snake_case.sql`**, lowercase, on a number reserved below.

## Numbers are reserved

Parallel tickets used to take "the next free number" and collide: the spec for
`0024_vault_tasks.sql` named it 0023, and 0023 was taken by
`0023_agent_grant_overrides.sql` while it was being written. So a number is
reserved here, to one file, before anyone writes it, and
`ops/scripts/check-migration-numbers.mjs` holds every PR to this table in CI:

- **Below the table's first row is history.** `0001`–`0025` were written
  before numbers were reserved. Each has exactly one file and there are no
  gaps, so there is no free number to take there.
- **A row with a file reserves its number for exactly that file** —
  `0026_work_description.sql` and nothing else. Any other file on that number
  fails the check.
- **A spare row (`—`) is not yet anyone's.** A file on a spare number fails the
  check. To claim one, write the file name and your ticket into the row in the
  same PR as the migration. Two PRs that claim the same spare edit the same
  line, so whichever merges second has a conflict and cannot merge until it
  takes another number — that conflict is the lock.
- **Need more numbers:** append a row after the last one, the same way. A
  number with no row fails the check.
- **Rows are never deleted or renumbered.** Once its file ships, a row stays as
  the record of which ticket took the number.

## Reserved numbers

Recorded from the approved spec, `docs/product/design-build-plan.md` §2.9. The
check reads the `#`, `File` and `Ticket` columns; `File` is the name after the
number.

| # | File | What | Durability | Ticket |
| --- | --- | --- | --- | --- |
| 0026 | `work_description.sql` | `work.description text` | durable where the owner wrote it | T1-1 |
| 0027 | `proposal_group_and_source.sql` | `proposals.group_id text`, `proposals.source jsonb {kind, external_ref, person}`, unique index on `(source->>'kind', source->>'external_ref') WHERE decision = 'pending'`; `resolved_at_source` needs no DDL | durable | T1-8 |
| 0028 | `today_order.sql` | `today_order (day, task_key, position)` | durable | T1-9 |
| 0029 | `meeting_refs.sql` | `vault_meeting_refs (event_id, path)`, `people_emails (email, path)` — derived by the reconciler | derived | T1-10 |
| 0030 | `session_archive.sql` | `session_archive (id, session_id, thread, turn_id, ts, system_prompt, messages jsonb, tool_calls jsonb, folded_at, expires_at)` | **ephemeral** — a 30-day cache in Postgres, lost on `down -v` (§4 Q16) | T1-11 |
| 0031 | `prose_feedback.sql` | `prose_feedback (prose_id UNIQUE, rating, note, ts)` | durable | T1-12 |
| 0032 | `project_grants.sql` | `projects.grants jsonb` | durable | T1-13 |
| 0033 | `capture_sessions.sql` | `capture_sessions (id, event_id, started_at, ended_at, media_bytes, transcript_capture_id, folded_at, audio_deleted_at)` — retention state; media stays on the Mac under `.metistry/state/capture/` | derived | T8-4 |
| 0034 | `calendar_events.sql` | `calendar_events (connection, event_id, ical_uid, series_id, starts_at, ends_at, all_day, title, location, organizer, attendees jsonb, self_status, updated_at)` + `sync_state (connection, key, value, updated_at)` — **every** calendar source syncs here, so Today has one read path; `all_day` is the F-7 Today fixture's field; no invite body, ever | derived | T2-11 |
| 0035 | `event_notify.sql` | `metistry_notify()` and `AFTER INSERT OR UPDATE` triggers on `runs`, `proposals`, `work`, `inbox`, `artifact_comments`, `outbound_messages`, `agents` — `pg_notify` with `{table, op, id}` only (§2.20) | no data | T2-18 |
| 0036 | `vault_tasks_someday.sql` | `vault_tasks.someday boolean NOT NULL DEFAULT false` — the `someday` token (K6) | derived | T2-5 |
| 0037 | — | spare | | |
