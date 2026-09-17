#!/bin/sh
# Fresh scratch database for integration tests: tests must NEVER touch the
# live instance db (they polluted the deployed triage queue and caused a
# push-retry storm before this existed). Drops + recreates
# ${METISTRY_TEST_DB_NAME:-metistry_test} and applies all migrations to it.
# The root `pnpm test` derives a per-checkout default from the directory
# name, so parallel worktrees (subagents) never drop each other's db.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
# the instance's own .metistry/state/.env is the install's environment and wins; the
# checkout's may hold nothing but the METISTRY_INSTANCE_DIR pointer
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
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set}"
: "${METISTRY_TEST_DB_NAME:=metistry_test}"

export PGPASSWORD="$METISTRY_DB_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $METISTRY_DB_HOST -p $METISTRY_DB_PORT -U $METISTRY_DB_USER --no-psqlrc -q -d postgres"
$PSQL -c "DROP DATABASE IF EXISTS $METISTRY_TEST_DB_NAME;"
$PSQL -c "CREATE DATABASE $METISTRY_TEST_DB_NAME;"
METISTRY_DB_NAME="$METISTRY_TEST_DB_NAME" ops/scripts/migrate.sh
echo "test-db: $METISTRY_TEST_DB_NAME ready"
