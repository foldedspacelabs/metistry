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

# METISTRY_SIGN_IDENTITY pins a specific identity (e.g. multiple Developer ID
# certs installed); unset falls back to auto-detecting the first Developer ID
# Application identity, then to ad-hoc (docs/ops/apple-signing.md §3).
IDENTITY="${METISTRY_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"') || true
fi
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --identifier com.foldedspacelabs.metistry.apple-fm --sign "$IDENTITY" "$APP"
  echo "signed: $IDENTITY"
else
  codesign --force --identifier com.foldedspacelabs.metistry.apple-fm --sign - "$APP"
  echo "signed: ad-hoc (no Developer ID found)"
fi
codesign --verify --strict "$APP"
"$APP/Contents/MacOS/afm-helper" </dev/null >/dev/null 2>&1 || true
echo "built: $APP/Contents/MacOS/afm-helper"
