#!/bin/zsh
# PoC-11 scratch — watchdog independence.
# Runs three liveness probes with ZERO model / ZERO Anthropic dependency, then
# sends the result to yourself over iMessage via osascript (also no model).
# The point: prove you can be told Metis is broken by something that isn't Metis.
#
# Run interactively (Terminal will prompt to control Messages -> Allow), or via
# the one-shot launchd plist alongside this file (headless watchdog case).

# your own iMessage handle. Set METISTRY_WATCHDOG_SELF; placeholder default
# keeps a real number out of git (this repo is meant to be forkable).
SELF="${METISTRY_WATCHDOG_SELF:-+15555550100}"

wd=""

# probe 1: Claude Code credential present in the login Keychain (existence only)
if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  wd="cred:ok"
else
  wd="cred:MISSING"
fi

# probe 2: docker daemon liveness
if docker info >/dev/null 2>&1; then
  wd="$wd docker:ok"
else
  wd="$wd docker:DOWN"
fi

# probe 3: collector staleness, simulated via a backdated marker file
marker="$HOME/.metistry-poc11-marker"
touch -t 202608260100 "$marker" 2>/dev/null || touch "$marker"
age_min=$(( ($(date +%s) - $(stat -f %m "$marker")) / 60 ))
if [ "$age_min" -gt 60 ]; then
  wd="$wd collector:STALE(${age_min}m)"
else
  wd="$wd collector:fresh"
fi
rm -f "$marker"

echo "probes: $wd"

# out-of-band alert — no model anywhere in this path.
# Canonical Messages form: `buddy "<handle>" of <iMessage service>`.
# (Variable names avoid the reserved `buddy`/`service` class keywords.)
/usr/bin/osascript -e "
tell application \"Messages\"
  set theService to 1st service whose service type = iMessage
  set theRecipient to buddy \"$SELF\" of theService
  send \"Metistry watchdog PoC-11 — $wd\" to theRecipient
end tell" && echo "SEND: ok" || echo "SEND: FAILED exit=$?"
