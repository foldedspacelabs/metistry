#!/bin/sh
# Compile + sign the EventKit helper. The embedded __info_plist carries the
# TCC usage descriptions (PoC-9: without it tccd silently refuses to prompt).
# Signing: Developer ID when present (stable Team-ID identity — grants survive
# rebuilds); otherwise ad-hoc with a fixed identifier — NOTE the ad-hoc cdhash
# changes on every rebuild, which drops the TCC grant (Phase 0 grant-rot
# finding). Don't rebuild a granted ad-hoc binary casually.
set -eu
cd "$(dirname -- "$0")/.."
swiftc -O -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist \
  helper/ek-helper.swift -o helper/ek-helper
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"') || true
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --identifier com.foldedspacelabs.metistry.eventkit --sign "$IDENTITY" helper/ek-helper
  echo "signed: $IDENTITY"
else
  codesign --force --identifier com.foldedspacelabs.metistry.eventkit --sign - helper/ek-helper
  echo "signed: ad-hoc (grant rots on rebuild — install the Developer ID cert)"
fi
echo "built: helper/ek-helper"
