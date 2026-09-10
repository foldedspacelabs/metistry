#!/bin/sh
# Quarterly restore drill (plan §5 maintenance): an untested backup is a
# hypothesis. Restores the newest dump into a scratch database, runs sanity
# queries, reports row counts + oldest timestamp, tears down. Exits nonzero
# on any failure so the watchdog/routine can alert.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

# the instance's own state/.env is the install's environment and wins; the
# checkout's may hold nothing but the METISTRY_INSTANCE_DIR pointer
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/state/.env" ]; then
  set -a; . "$METISTRY_INSTANCE_DIR/state/.env"; set +a
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set (see .env.example)}"
: "${METISTRY_BACKUP_DIR:=./backups}"

dump=$(ls -1t "$METISTRY_BACKUP_DIR"/metistry-*.dump 2>/dev/null | head -1) || true
[ -n "${dump:-}" ] || { echo "no dumps found in $METISTRY_BACKUP_DIR" >&2; exit 1; }

scratch="metistry_restore_test"
export PGPASSWORD="$METISTRY_DB_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $METISTRY_DB_HOST -p $METISTRY_DB_PORT -U $METISTRY_DB_USER --no-psqlrc -q"

cleanup() { $PSQL -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

$PSQL -d postgres -c "DROP DATABASE IF EXISTS $scratch;"
$PSQL -d postgres -c "CREATE DATABASE $scratch;"

pg_restore -h "$METISTRY_DB_HOST" -p "$METISTRY_DB_PORT" -U "$METISTRY_DB_USER" \
  -d "$scratch" --no-owner "$dump"

echo "restored $dump into $scratch; sanity:"
$PSQL -d "$scratch" -tA -c "
  SELECT 'migrations: ' || count(*) FROM schema_migrations
  UNION ALL SELECT 'runs: '      || count(*) FROM runs
  UNION ALL SELECT 'work: '      || count(*) FROM work
  UNION ALL SELECT 'proposals: ' || count(*) FROM proposals
  UNION ALL SELECT 'oldest run: ' || coalesce(min(ts)::text, 'none') FROM runs;
"
echo "restore-test: ok"
