#!/bin/zsh
# PoC-9 one-shot: get consent, then run the whole battery.
#
# WHY THIS SCRIPT EXISTS: the EventKit consent prompt is only offered when the
# requesting binary is its OWN responsible process. Run from the Claude Code
# shell, the responsible process is Claude.app, whose Info.plist has no
# NSCalendarsFullAccessUsageDescription / NSRemindersFullAccessUsageDescription,
# so tccd refuses to prompt and returns denied in 0.0s. Run as its own launchd
# job, ekpoc IS the responsible process and its embedded Info.plist applies, so
# the prompt appears. Hence: consent must be requested from the launchd job.
#
# PREREQUISITE: the Mac must be UNLOCKED. The prompt is drawn by
# UserNotificationCenter and sits behind the lock screen otherwise.
#
# Usage:  ./grant.sh
# Then click Allow on BOTH prompts (Calendars, then Reminders).

set -e
D=${0:a:h}

echo "### screen lock state (must be 0) ###"
"$D/lockstate" 2>/dev/null || echo "(lockstate helper missing)"

echo
echo "### requesting consent via launchd job (click Allow twice) ###"
"$D/run-launchd.sh" request 900

echo
echo "### resulting authorization status ###"
"$D/ekpoc" status 2>&1 | grep -E "^INFO auth"

if "$D/ekpoc" status 2>&1 | grep -q "auth.event fullAccess"; then
  echo
  echo "### consent granted - running full battery ###"
  "$D/battery.sh"
else
  echo
  echo "!!! still not granted. Check System Settings > Privacy & Security >"
  echo "!!! Calendars / Reminders for an entry named 'ekpoc' or"
  echo "!!! 'Metistry PoC-9 EventKit' and enable it, then run ./battery.sh"
fi
