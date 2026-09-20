#!/bin/sh
# Apply db/migrations/*.sql in filename order, once each, transactionally,
# under a Postgres advisory lock. Zero dependencies beyond psql — the path
# for a machine with no built CLI. `metistry update` runs a SEPARATE
# implementation of the same logic in packages/cli/src/migrate.ts, straight
# against the pg driver — it never shells out to this script — but takes
# the SAME lock key, so the two can never interleave: whoever holds the
# lock applies what is pending, the other waits and then finds nothing to
# do.
#
# Everything runs in ONE psql session (advisory locks are session-scoped),
# driven by psql's \gset / \if: the lock, the table, then per file "skip if
# recorded, else BEGIN; \i file; INSERT record; COMMIT". ON_ERROR_STOP makes
# a failing file end the session, which rolls its transaction back and
# releases the lock — nothing from it is kept, and no row is recorded.
#
# Config from environment (.env is sourced if present and vars aren't
# already set) — no hardcoded paths or hosts.
#
# THE GUARD (2026-09-19 incident: this script ran with METISTRY_TEST_DB_NAME
# set but METISTRY_DB_NAME unset, defaulted to the live `metistry` database,
# and applied a migration there). A shell with METISTRY_TEST_DB_NAME set is a
# test shell by definition (docs/ops/testing.md) and must never touch a
# different database by omission. And a target whose value came from the
# INSTALL's own `.metistry/state/.env` is refused unless the run is
# explicitly `--install` — that file is a running install's environment, so
# without this, one missing override is all it takes to mutate it. Both
# refusals print what they saw and exit 2. `--print-target` resolves and
# reports without running anything, so a person can check first.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

INSTALL=0
PRINT_TARGET=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --print-target) PRINT_TARGET=1 ;;
    *)
      echo "usage: $0 [--install] [--print-target]" >&2
      exit 2
      ;;
  esac
done

# Captured before any sourcing: a test shell says so itself, by having this
# set at all — no .env file ever defines it (docs/ops/testing.md).
TEST_DB_NAME_SET=${METISTRY_TEST_DB_NAME:+set}

# Provenance of METISTRY_DB_NAME's eventual value, watched as each layer
# below is applied. Each layer that defines the var still wins over the ones
# before it, same as always — this only records which one last touched it,
# so the guard below can tell "an explicit override" from "the install's own
# config file" from "nobody set it, this is the built-in default". An
# override a CALLER passed in (test-db.sh's `METISTRY_DB_NAME=<test db>
# ops/scripts/migrate.sh`, or a person's own export) is exempt from being
# quietly overwritten by a sourced .env below it — a caller who named the
# database is never wrong by omission the way a sourced file can leave you.
PRESET_DB_NAME_SET=${METISTRY_DB_NAME+set}
PRESET_DB_NAME=${METISTRY_DB_NAME:-}
DB_NAME_SOURCE=default
[ -n "$PRESET_DB_NAME_SET" ] && DB_NAME_SOURCE=environment

# Load .env for any unset vars (export everything it defines). An instance
# directory is self-contained, so its own `.metistry/state/.env` is the install's
# environment and is sourced LAST (it wins); the checkout's may hold nothing
# but the METISTRY_INSTANCE_DIR pointer.
if [ -f .env ]; then
  set -a; . ./.env; set +a
  if [ -n "$PRESET_DB_NAME_SET" ]; then
    METISTRY_DB_NAME="$PRESET_DB_NAME"
  else
    grep -Eq '^[[:space:]]*METISTRY_DB_NAME=' .env && DB_NAME_SOURCE="checkout .env"
  fi
fi
INSTANCE_ENV=
if [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/.metistry/state/.env" ]; then
  INSTANCE_ENV="$METISTRY_INSTANCE_DIR/.metistry/state/.env"
elif [ -n "${METISTRY_INSTANCE_DIR:-}" ] && [ -f "$METISTRY_INSTANCE_DIR/state/.env" ]; then
  INSTANCE_ENV="$METISTRY_INSTANCE_DIR/state/.env"   # pre-2026-09-17 layout
fi
if [ -n "$INSTANCE_ENV" ]; then
  set -a; . "$INSTANCE_ENV"; set +a
  if [ -n "$PRESET_DB_NAME_SET" ]; then
    METISTRY_DB_NAME="$PRESET_DB_NAME"
  else
    grep -Eq '^[[:space:]]*METISTRY_DB_NAME=' "$INSTANCE_ENV" && DB_NAME_SOURCE="instance .env ($INSTANCE_ENV)"
  fi
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_NAME:=metistry}"
: "${METISTRY_DB_USER:=metistry}"

# ---- the guard ------------------------------------------------------------

REFUSAL=
if [ -n "$TEST_DB_NAME_SET" ] && [ "$METISTRY_DB_NAME" != "$METISTRY_TEST_DB_NAME" ]; then
  REFUSAL="METISTRY_TEST_DB_NAME=$METISTRY_TEST_DB_NAME is set (this is a test shell) but the target resolved to METISTRY_DB_NAME=$METISTRY_DB_NAME — a test shell must never touch a different database by omission. Pass a matching METISTRY_DB_NAME, or unset METISTRY_TEST_DB_NAME if this genuinely is not a test shell."
fi
if [ -z "$REFUSAL" ]; then
  case "$DB_NAME_SOURCE" in
    "instance .env"*)
      if [ "$INSTALL" -ne 1 ]; then
        REFUSAL="METISTRY_DB_NAME=$METISTRY_DB_NAME comes from the install's own environment ($DB_NAME_SOURCE) — this looks like the install's configured database. Rerun with --install to confirm that is what you mean, or point METISTRY_DB_NAME/METISTRY_INSTANCE_DIR at a scratch setup instead."
      fi
      ;;
  esac
fi

if [ "$PRINT_TARGET" -eq 1 ]; then
  echo "target database: $METISTRY_DB_NAME"
  echo "source: $DB_NAME_SOURCE"
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
