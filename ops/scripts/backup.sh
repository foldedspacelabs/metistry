#!/bin/sh
# Nightly Postgres dump. Config from environment (invariant 7); .env sourced
# for unset vars. Writes a timestamped custom-format dump and prunes old
# local dumps. Offsite (S3 or similar) is the caller's pipe — this script
# only produces the artifact. Note open decision D6: the durable set is
# not yet formally named; until then the whole DB is dumped.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${METISTRY_DB_HOST:=127.0.0.1}"
: "${METISTRY_DB_PORT:=5432}"
: "${METISTRY_DB_NAME:=metistry}"
: "${METISTRY_DB_USER:=metistry}"
: "${METISTRY_DB_PASSWORD:?METISTRY_DB_PASSWORD must be set (see .env.example)}"
: "${METISTRY_BACKUP_DIR:=./backups}"
: "${METISTRY_BACKUP_KEEP:=14}"

mkdir -p "$METISTRY_BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$METISTRY_BACKUP_DIR/metistry-$stamp.dump"

PGPASSWORD="$METISTRY_DB_PASSWORD" pg_dump \
  -h "$METISTRY_DB_HOST" -p "$METISTRY_DB_PORT" \
  -U "$METISTRY_DB_USER" -d "$METISTRY_DB_NAME" \
  --format=custom --compress=6 --file "$out"

size=$(wc -c < "$out" | tr -d ' ')
[ "$size" -gt 1024 ] || { echo "backup suspiciously small ($size bytes)" >&2; exit 1; }

# prune: keep the newest N dumps
ls -1t "$METISTRY_BACKUP_DIR"/metistry-*.dump 2>/dev/null | tail -n +"$((METISTRY_BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old"
done

echo "backup: $out ($size bytes)"
