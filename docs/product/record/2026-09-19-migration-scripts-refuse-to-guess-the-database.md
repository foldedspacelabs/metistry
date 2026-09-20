- 2026-09-19 — **The migration scripts refuse to guess which database
  they're about to touch.** `ops/scripts/migrate.sh` and
  `ops/scripts/test-db.sh` now track where their target database's name
  actually came from — a caller's explicit override, a checkout `.env`, or
  the install's own `.metistry/state/.env` — and refuse rather than proceed
  whenever that provenance says something a person almost certainly did not
  mean: a shell that already has a scratch database name set (a test shell,
  by definition) touching a different database by omission, or a target that
  traces back to a live install's own configuration with nobody confirming
  that is really the machine. Both scripts take `--print-target`, which
  resolves and reports the same decision without ever opening a connection —
  which database a command is about to touch is now something you read
  before running it, not something you infer from an incident afterward. It
  follows a real one: a shell carrying a leftover test-database name ran
  `migrate.sh` with no explicit target, fell through to the built-in
  default, and applied a migration to the live install (reverted by hand).
  The same shell today gets refused, in words, before it touches anything.
