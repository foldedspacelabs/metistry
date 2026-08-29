#!/bin/bash
# PoC-8 honest latency measurement: 30 sequential curl requests.
# Reports cold (first), then warm p50/p95 for cache-hit and cache-bypassed paths.
set -euo pipefail

URL_CACHED="http://127.0.0.1:8092/api/q/open_work?limit=5"
URL_NOCACHE="http://127.0.0.1:8092/api/q/open_work?limit=5&nocache=1"

percentile() {
  # $1 = space-separated sorted numbers (ms), $2 = percentile (0-100)
  local -a arr=($1)
  local n=${#arr[@]}
  local idx=$(( (n * $2 + 99) / 100 ))
  if [ "$idx" -lt 1 ]; then idx=1; fi
  if [ "$idx" -gt "$n" ]; then idx=$n; fi
  echo "${arr[$((idx-1))]}"
}

echo "=== CACHE-HIT PATH (same query+params repeated; cache_ttl=60s) ==="
echo "-- request 1 (cold: cache empty, hits psql) --"
COLD=$(curl -s -o /tmp/bench_cold.json -w '%{time_total}' "$URL_CACHED")
COLD_MS=$(echo "$COLD * 1000" | bc)
echo "cold time_total: ${COLD_MS} ms"
cat /tmp/bench_cold.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('server cache field:', d['cache'], 'timing_ms:', d['timing_ms'])"

echo "-- requests 2..30 (warm cache hits) --"
times=()
for i in $(seq 2 30); do
  t=$(curl -s -o /dev/null -w '%{time_total}' "$URL_CACHED")
  times+=("$(echo "$t * 1000" | bc)")
done
sorted=$(printf '%s\n' "${times[@]}" | sort -n | tr '\n' ' ')
echo "warm cache-hit times (ms, sorted): $sorted"
p50=$(percentile "$sorted" 50)
p95=$(percentile "$sorted" 95)
echo "warm cache-hit p50: ${p50} ms   p95: ${p95} ms"

echo
echo "=== CACHE-BYPASSED PATH (nocache=1; psql subprocess every request) ==="
echo "-- request 1 (first bypass call) --"
COLD2=$(curl -s -o /tmp/bench_cold2.json -w '%{time_total}' "$URL_NOCACHE")
COLD2_MS=$(echo "$COLD2 * 1000" | bc)
echo "first bypass time_total: ${COLD2_MS} ms"
cat /tmp/bench_cold2.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('server cache field:', d['cache'], 'timing_ms:', d['timing_ms'])"

echo "-- requests 2..30 (bypass, psql subprocess each time) --"
times2=()
psql_times=()
for i in $(seq 2 30); do
  t=$(curl -s -o /tmp/bench_nc.json -w '%{time_total}' "$URL_NOCACHE")
  times2+=("$(echo "$t * 1000" | bc)")
  psql_ms=$(python3 -c "import json; d=json.load(open('/tmp/bench_nc.json')); print(d['timing_ms']['psql_subprocess'])")
  psql_times+=("$psql_ms")
done
sorted2=$(printf '%s\n' "${times2[@]}" | sort -n | tr '\n' ' ')
echo "bypass times (ms, sorted, total request time): $sorted2"
p50b=$(percentile "$sorted2" 50)
p95b=$(percentile "$sorted2" 95)
echo "bypass p50: ${p50b} ms   p95: ${p95b} ms"

sorted_psql=$(printf '%s\n' "${psql_times[@]}" | sort -n | tr '\n' ' ')
echo "psql-subprocess-only times (ms, sorted, server-reported): $sorted_psql"
p50p=$(percentile "$sorted_psql" 50)
p95p=$(percentile "$sorted_psql" 95)
echo "psql-subprocess-only p50: ${p50p} ms   p95: ${p95p} ms"
