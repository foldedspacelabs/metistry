#!/bin/sh
# Compile + sign the Apple FM helper AS A MINIMAL APP BUNDLE.
#
#   helper/afm-helper.app/Contents/Info.plist
#   helper/afm-helper.app/Contents/MacOS/afm-helper
#
# apple-fm needs no TCC grant (manifest.yaml: requires_tcc: []), so the bundle
# buys it nothing directly — it is here so both Swift helpers have ONE build
# shape to sign, notarize and reason about. The eventkit helper needs it:
# TCC keys a bundled client on CFBundleIdentifier + the stored csreq (the
# designated requirement), so its grant survives a rebuild; a bare executable
# is keyed by absolute path and is invisible to the Privacy pane and to
# `tccutil reset` (docs/ops/apple-signing.md §3).
set -eu
cd "$(dirname -- "$0")/.."

APP="helper/afm-helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"          # Contents/MacOS is Apple's mandated
cp helper/Info.plist "$APP/Contents/Info.plist"   # bundle layout, not ours.

swiftc -O -parse-as-library helper/afm-helper.swift -o "$APP/Contents/MacOS/afm-helper"

# METISTRY_SIGN_IDENTITY pins an identity verbatim (a name or a SHA-1 hash —
# codesign -s takes either); unset falls back to auto-detecting the first
# Developer ID Application identity, then to ad-hoc (docs/ops/apple-signing.md
# §3). Auto-detection takes the HASH, not the display name: after a renewal
# or a second import the keychain holds two valid certs with byte-identical
# names and `codesign -s "<name>"` fails with "ambiguous (matches … and …)".
# The hash is unique by construction. Duplicates of ONE name are fine (first
# hash wins — same team, same chain, same TCC designated requirement); certs
# for DIFFERENT teams are not guessed at: pin one, or the helper gets signed
# under whichever team happened to sort first.
IDENTITY="${METISTRY_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  FOUND=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application') || true
  NAMES=$(printf '%s\n' "$FOUND" | grep -o '"[^"]*"' | sort -u)
  if [ "$(printf '%s\n' "$NAMES" | grep -c .)" -gt 1 ]; then
    echo "more than one Developer ID team is installed — set METISTRY_SIGN_IDENTITY to the hash of the one to use:" >&2
    printf '%s\n' "$FOUND" >&2
    exit 1
  fi
  IDENTITY=$(printf '%s\n' "$FOUND" | head -1 | awk '{print $2}')
  [ -n "$IDENTITY" ] && echo "auto-detected identity: $IDENTITY ($(printf '%s\n' "$NAMES" | tr -d '"'))"
fi
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --identifier com.foldedspacelabs.metistry.apple-fm --sign "$IDENTITY" "$APP"
  echo "signed: $IDENTITY ($(security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | grep -o '"[^"]*"' | head -1 | tr -d '"'))"
else
  codesign --force --identifier com.foldedspacelabs.metistry.apple-fm --sign - "$APP"
  echo "signed: ad-hoc (no Developer ID found)"
fi
codesign --verify --strict "$APP"
"$APP/Contents/MacOS/afm-helper" </dev/null >/dev/null 2>&1 || true
echo "built: $APP/Contents/MacOS/afm-helper"
