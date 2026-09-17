#!/bin/sh
# Apply db/migrations/*.sql in filename order, once each, transactionally,
# under a Postgres advisory lock. Zero dependencies beyond psql — the path
# for a machine with no built CLI. `metistry update` runs the same logic in
# packages/cli/src/migrate.ts and takes the SAME lock key, so the two can
# never interleave: whoever holds the lock applies what is pending, the
# other waits and then finds nothing to do.
#
# Everything runs in ONE psql session (advisory locks are session-scoped),
# driven by psql's \gset / \if: the lock, the table, then per file "skip if
# recorded, else BEGIN; \i file; INSERT record; COMMIT". ON_ERROR_STOP makes
# a failing file end the session, which rolls its transaction back and
# releases the lock — nothing from it is kept, and no row is recorded.
#
# Config from environment (.env is sourced if present and vars aren't
# already set) — no hardcoded paths or hosts.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

# Load .env for any unset vars (export everything it defines). An instance
# directory is self-contained, so its own `.metistry/state/.env` is the install's
# environment and is sourced LAST (it wins); the checkout's may hold nothing
# but the METISTRY_INSTANCE_DIR pointer.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/.metistry/state/.env" ]; then
  set -a; . "$METISTRY_INSTANCE_DIR/.metistry/state/.env"; set +a
elif [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/state/.env" ]; then
  set -a; . "$METISTRY_INSTANCE_DIR/state/.env"; set +a   # pre-2026-09-17 layout
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_NAME:=metistry}"
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set (see .env.example)}"

# pg_advisory_lock key — MUST equal MIGRATION_LOCK_KEY in packages/cli/src/migrate.ts
# (0x4d455453, "METS"); packages/cli/test/lock-key.test.ts holds the two together.
LOCK_KEY=1296389203

export PGPASSWORD="$METISTRY_DB_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $METISTRY_DB_HOST -p $METISTRY_DB_PORT -U $METISTRY_DB_USER -d $METISTRY_DB_NAME --no-psqlrc -q"

script() {
  # query results go nowhere (\o); \echo still reaches stdout, so the
  # transcript is exactly the list of files this run applied
  printf '\\o /dev/null\n'
  printf 'SET client_min_messages = warning;\n'
  printf 'SELECT pg_advisory_lock(%s);\n' "$LOCK_KEY"
  printf 'CREATE TABLE IF NOT EXISTS schema_migrations (\n  filename   text PRIMARY KEY,\n  applied_at timestamptz NOT NULL DEFAULT now()\n);\n'
  for f in db/migrations/*.sql; do
    name=$(basename "$f")
    printf "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '%s') AS done \\\\gset\n" "$name"
    printf '\\if :done\n\\else\n'
    printf '\\echo applying %s\n' "$name"
    # single transaction: the migration plus its record
    printf 'BEGIN;\n\\i %s\n' "$f"
    printf "INSERT INTO schema_migrations (filename) VALUES ('%s');\nCOMMIT;\n" "$name"
    printf '\\endif\n'
  done
  printf 'SELECT pg_advisory_unlock(%s);\n' "$LOCK_KEY"
}

transcript=$(mktemp "${TMPDIR:-/tmp}/metistry-migrate.XXXXXX")
trap 'rm -f "$transcript"' EXIT

# psql is the last command of the pipeline, so set -e sees ITS exit status
script | $PSQL > "$transcript"

cat "$transcript"
applied=$(grep -c '^applying ' "$transcript" || true)
echo "migrations: $applied applied, $(ls db/migrations/*.sql | wc -l | tr -d ' ') total"
