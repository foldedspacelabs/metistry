#!/bin/sh
# Compile + sign the Swift helper. Uses the Developer ID identity when
# present (stable TCC-proof identity, §4.16) — though apple-fm needs no
# TCC grant, so an ad-hoc signature is functionally fine on a dev box.
set -eu
cd "$(dirname -- "$0")/.."
swiftc -O -parse-as-library helper/afm-helper.swift -o helper/afm-helper
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"') || true
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --sign "$IDENTITY" helper/afm-helper
  echo "signed: $IDENTITY"
else
  codesign --force --sign - helper/afm-helper
  echo "signed: ad-hoc (no Developer ID found)"
fi
./helper/afm-helper </dev/null >/dev/null 2>&1 || true
echo "built: helper/afm-helper"
