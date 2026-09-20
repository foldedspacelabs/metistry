#!/bin/sh
# Fresh scratch database for integration tests: tests must NEVER touch the
# live instance db (they polluted the deployed triage queue and caused a
# push-retry storm before this existed). Drops + recreates
# ${METISTRY_TEST_DB_NAME:-metistry_test} and applies all migrations to it.
# The root `pnpm test` derives a per-checkout default from the directory
# name, so parallel worktrees (subagents) never drop each other's db.
#
# THE GUARD (see migrate.sh for the incident this answers): this script's
# whole reason to exist is dropping a database, so if METISTRY_TEST_DB_NAME
# ever resolves to the same name as the install's own configured
# METISTRY_DB_NAME (its `.metistry/state/.env`), that is never a coincidence
# worth trusting — refuse rather than drop it. There is no override flag for
# this one; unlike migrate.sh there is no legitimate reason to point
# test-db.sh at an install. `--print-target` reports the resolution without
# dropping or creating anything.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

PRINT_TARGET=0
for arg in "$@"; do
  case "$arg" in
    --print-target) PRINT_TARGET=1 ;;
    *)
      echo "usage: $0 [--print-target]" >&2
      exit 2
      ;;
  esac
done

# the instance's own .metistry/state/.env is the install's environment and wins; the
# checkout's may hold nothing but the METISTRY_INSTANCE_DIR pointer
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
INSTANCE_ENV=
if [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/.metistry/state/.env" ]; then
  INSTANCE_ENV="$METISTRY_INSTANCE_DIR/.metistry/state/.env"
elif [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/state/.env" ]; then
  INSTANCE_ENV="$METISTRY_INSTANCE_DIR/state/.env"   # pre-2026-09-17 layout
fi
INSTALL_DB_NAME=
if [ -n "$INSTANCE_ENV" ]; then
  set -a; . "$INSTANCE_ENV"; set +a
  # only a real answer if the install's own file actually names one — an
  # unset METISTRY_DB_NAME here says nothing about what the install runs as
  grep -Eq '^[[:space:]]*METISTRY_DB_NAME=' "$INSTANCE_ENV" && INSTALL_DB_NAME="${METISTRY_DB_NAME:-}"
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set}"
: "${METISTRY_TEST_DB_NAME:=metistry_test}"

# ---- the guard ------------------------------------------------------------

REFUSAL=
if [ -n "$INSTALL_DB_NAME" ] && [ "$METISTRY_TEST_DB_NAME" = "$INSTALL_DB_NAME" ]; then
  REFUSAL="METISTRY_TEST_DB_NAME=$METISTRY_TEST_DB_NAME is the same database $INSTANCE_ENV configures for this install — refusing to drop and recreate it. Point METISTRY_TEST_DB_NAME at a scratch name instead."
fi

if [ "$PRINT_TARGET" -eq 1 ]; then
  echo "target database: $METISTRY_TEST_DB_NAME (drop + recreate)"
  if [ -n "$INSTALL_DB_NAME" ]; then
    echo "install's configured database: $INSTALL_DB_NAME ($INSTANCE_ENV)"
  else
    echo "install's configured database: none found (no instance .env names one)"
  fi
  if [ -n "$REFUSAL" ]; then
    echo "would run: no -- $REFUSAL"
  else
    echo "would run: yes"
  fi
  exit 0
fi

if [ -n "$REFUSAL" ]; then
  echo "refusing: $REFUSAL" >&2
  exit 2
fi

export PGPASSWORD="$METISTRY_DB_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $METISTRY_DB_HOST -p $METISTRY_DB_PORT -U $METISTRY_DB_USER --no-psqlrc -q -d postgres"
$PSQL -c "DROP DATABASE IF EXISTS $METISTRY_TEST_DB_NAME;"
$PSQL -c "CREATE DATABASE $METISTRY_TEST_DB_NAME;"
METISTRY_DB_NAME="$METISTRY_TEST_DB_NAME" METISTRY_TEST_DB_NAME="$METISTRY_TEST_DB_NAME" ops/scripts/migrate.sh
echo "test-db: $METISTRY_TEST_DB_NAME ready"
