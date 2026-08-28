#!/usr/bin/env bash
# PoC-5 rebuild script: drop and rebuild poc5_embeddings entirely from the
# corpus in poc/poc5-pgvector/corpus/. This is the "reversibility" story --
# re-running this end to end is how the vault's embeddings get rebuilt
# after e.g. switching embedding models, or from a clean/lost DB.
#
# Usage: ./poc5_rebuild.sh
#   Requires: poc8-pg container running on 127.0.0.1:5433 (not started here --
#   this script reuses existing infrastructure, it does not manage the container).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL="/opt/homebrew/opt/libpq/bin/psql"
export PGPASSWORD=poc
PGARGS=(-h 127.0.0.1 -p 5433 -U postgres -d postgres -v ON_ERROR_STOP=1)

echo "=== PoC-5 rebuild: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo "--- 1. Rebuilding DDL (schema.sql: drop + recreate table + HNSW index) ---"
t0=$(date +%s%N)
"$PSQL" "${PGARGS[@]}" -f "$DIR/schema.sql"
t1=$(date +%s%N)
echo "DDL rebuild took $(( (t1 - t0) / 1000000 ))ms"

echo "--- 2. Rebuilding data (embed pipeline: corpus/*.md -> Ollama -> pgvector) ---"
node "$DIR/poc5_embed.mjs"

echo "--- 3. Post-rebuild verification ---"
ROW_COUNT=$("$PSQL" "${PGARGS[@]}" -t -A -c "SELECT count(*) FROM poc5_embeddings;")
NOTE_COUNT=$("$PSQL" "${PGARGS[@]}" -t -A -c "SELECT count(DISTINCT path) FROM poc5_embeddings;")
HASH_DIGEST=$("$PSQL" "${PGARGS[@]}" -t -A -c "SELECT md5(string_agg(content_hash, ',' ORDER BY content_hash)) FROM poc5_embeddings;")

echo "row_count=$ROW_COUNT note_count=$NOTE_COUNT sorted_hash_digest=$HASH_DIGEST"

# Emit a small machine-readable summary for the verification-run comparison.
cat > "$DIR/.last_rebuild.json" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "row_count": $ROW_COUNT,
  "note_count": $NOTE_COUNT,
  "sorted_hash_digest": "$HASH_DIGEST"
}
EOF

echo "=== Rebuild complete. Summary written to .last_rebuild.json ==="
cat "$DIR/.last_rebuild.json"
