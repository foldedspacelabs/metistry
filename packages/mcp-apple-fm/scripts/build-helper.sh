#!/bin/sh
# Compile + sign the Swift helper. Uses the Developer ID identity when
# present (stable TCC-proof identity, §4.16) — though apple-fm needs no
# TCC grant, so an ad-hoc signature is functionally fine on a dev box.
set -eu
cd "$(dirname -- "$0")/.."
swiftc -O -parse-as-library helper/afm-helper.swift -o helper/afm-helper
# METISTRY_SIGN_IDENTITY pins a specific identity (e.g. multiple Developer ID
# certs installed); unset falls back to auto-detecting the first Developer ID
# Application identity, then to ad-hoc (docs/ops/apple-signing.md §3).
IDENTITY="${METISTRY_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"') || true
fi
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --identifier com.foldedspacelabs.metistry.apple-fm --sign "$IDENTITY" helper/afm-helper
  echo "signed: $IDENTITY"
else
  codesign --force --sign - helper/afm-helper
  echo "signed: ad-hoc (no Developer ID found)"
fi
./helper/afm-helper </dev/null >/dev/null 2>&1 || true
echo "built: helper/afm-helper"
