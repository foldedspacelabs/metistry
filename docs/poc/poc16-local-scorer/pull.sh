#!/bin/zsh
for m in granite4.2:8b gemma4:e4b-it-qat gemma4:12b-it-q4_K_M qwen3.6:27b-q4_K_M qwen3.6:35b-a3b-q4_K_M; do
  echo "=== PULL $m  $(date +%T)"
  t0=$(python3 -c 'import time;print(time.time())')
  ollama pull "$m" 2>&1 | tail -2
  t1=$(python3 -c 'import time;print(time.time())')
  echo "=== DONE $m in $(python3 -c "print(f'{$t1-$t0:.1f}s')")"
  ollama list
  df -h / | tail -1
done
echo "=== ALL PULLS COMPLETE"
