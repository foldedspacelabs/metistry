#!/bin/zsh
# One-shot launchd run of ekpoc <subcommand>, in the gui/501 domain.
# NEVER use `launchctl submit` — it respawns quick-exit jobs in a loop.
set -e
D=${0:a:h}
SUB=$1
POLL=${2:-60}
LABEL=metistry.poc9
PLIST=$D/$LABEL.plist
OUT=$D/launchd-$SUB.out
ERR=$D/launchd-$SUB.err

rm -f "$OUT" "$ERR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$D/ekpoc</string>
    <string>$SUB</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$OUT</string>
  <key>StandardErrorPath</key><string>$ERR</string>
</dict></plist>
EOF

launchctl bootout gui/501/$LABEL 2>/dev/null || true
launchctl bootstrap gui/501 "$PLIST"

# poll for the job to finish (RESULT line written, or timeout)
for i in $(seq 1 $POLL); do
  if grep -q '^RESULT ' "$OUT" 2>/dev/null; then break; fi
  sleep 1
done

echo "=== launchctl print (post-run) ==="
launchctl print gui/501/$LABEL 2>&1 | grep -E 'state|last exit|program|pid' | head -8 || true
echo "=== stdout ($OUT) ==="
cat "$OUT" 2>/dev/null || echo "(no stdout)"
echo "=== stderr ($ERR) ==="
cat "$ERR" 2>/dev/null || echo "(no stderr)"
launchctl bootout gui/501/$LABEL 2>/dev/null || true
echo "=== booted out ==="
