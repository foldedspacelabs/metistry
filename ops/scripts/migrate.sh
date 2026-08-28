#!/bin/sh
# Apply db/migrations/*.sql in filename order, once each, transactionally.
# Zero dependencies beyond psql. Config from environment (.env is sourced if
# present and vars aren't already set) — no hardcoded paths or hosts.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

# Load .env for any unset vars (export everything it defines).
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_NAME:=metistry}"
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set (see .env.example)}"

export PGPASSWORD="$METISTRY_DB_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $METISTRY_DB_HOST -p $METISTRY_DB_PORT -U $METISTRY_DB_USER -d $METISTRY_DB_NAME --no-psqlrc -q"

$PSQL -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);"

applied=0
for f in db/migrations/*.sql; do
  name=$(basename "$f")
  done_already=$($PSQL -tA -c "SELECT 1 FROM schema_migrations WHERE filename = '$name';")
  if [ "$done_already" = "1" ]; then
    continue
  fi
  echo "applying $name"
  # single transaction: the migration plus its record
  { printf 'BEGIN;\n'; cat "$f"; printf "\nINSERT INTO schema_migrations (filename) VALUES ('%s');\nCOMMIT;\n" "$name"; } | $PSQL
  applied=$((applied + 1))
done

echo "migrations: $applied applied, $(ls db/migrations/*.sql | wc -l | tr -d ' ') total"
