#!/bin/sh
# Compile + sign the live-capture helper AS A MINIMAL APP BUNDLE — copied from
# packages/mcp-eventkit/scripts/build-helper.sh, whose comments carry the
# history (docs/ops/apple-signing.md §3):
#
#   helper/lc-helper.app/Contents/Info.plist
#   helper/lc-helper.app/Contents/MacOS/lc-helper
#
# TCC records a BUNDLED client by its CFBundleIdentifier and checks it against
# the signature's designated requirement — under a Developer ID identity that
# is identifier + certificate chain, no cdhash — so a rebuild keeps the three
# grants (Microphone, Audio Capture, Screen Recording). A bare Mach-O is
# recorded by absolute path and loses them whenever the checkout moves.
#
# The usage strings live in helper/Info.plist and are ALSO linked into the
# executable as __TEXT,__info_plist (PoC-9: without them tccd silently refuses
# to prompt). The launchd job that runs the bundle is
# ops/launchd/com.foldedspacelabs.metistry.recorder.plist.
#
#   scripts/build-helper.sh                     the signed bundle
#   scripts/build-helper.sh --compile-only OUT  a bare, UNSIGNED executable at
#                                               OUT — proves the helper builds
#                                               against the SDK; the test suite
#                                               uses this, and it can never be
#                                               granted anything
set -eu
cd "$(dirname -- "$0")/.."

# -target pins the floor to the Mac app's own (macOS 14); everything newer is
# behind #available (the process tap 14.2, bundle-ID taps and the
# transcriber 26).
compile() {
  swiftc -O -target "$(uname -m)-apple-macos14.0" \
    -framework Foundation -framework AppKit -framework AVFoundation -framework CoreAudio \
    -framework CoreGraphics -framework CoreMedia -framework Speech \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist \
    helper/sources/kit/*.swift helper/sources/helper/*.swift -o "$1"
}

if [ "${1:-}" = "--compile-only" ]; then
  OUT="${2:?--compile-only needs an output path}"
  mkdir -p "$(dirname -- "$OUT")"
  compile "$OUT"
  echo "built (unsigned, not a bundle — cannot be granted anything): $OUT"
  exit 0
fi

APP="helper/lc-helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"          # Contents/MacOS is Apple's mandated
cp helper/Info.plist "$APP/Contents/Info.plist"   # bundle layout, not ours.
compile "$APP/Contents/MacOS/lc-helper"

# AMFI's XML parser rejects comments: strip them through plutil (the comments
# in lc-helper.entitlements are the record of WHY the entitlement is there).
ENTS="$(mktemp -t lc-helper-ents)"
trap 'rm -f "$ENTS"' EXIT
plutil -convert xml1 -o "$ENTS" helper/lc-helper.entitlements

# The identity rules are ek-helper's, verbatim: METISTRY_SIGN_IDENTITY pins one
# (a name or a SHA-1 hash); unset auto-detects the first Developer ID
# Application identity BY HASH (two certs with one display name make
# `codesign -s "<name>"` ambiguous), refuses to guess between two teams, and
# falls back to ad-hoc — whose designated requirement IS cdhash-based, so the
# grants rot on every rebuild. Install the Developer ID cert
# (docs/ops/apple-signing.md §2).
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
# Sign the BUNDLE, not the inner binary: codesign seals Contents/Info.plist
# into the signature, which is what ties the bundle ID to the identity.
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.live-capture --sign "$IDENTITY" "$APP"
  echo "signed: $IDENTITY ($(security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | grep -o '"[^"]*"' | head -1 | tr -d '"'))"
else
  codesign --force --options runtime --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.live-capture --sign - "$APP"
  echo "signed: ad-hoc (the grants rot on rebuild — install the Developer ID cert)"
fi
codesign --verify --strict "$APP"
echo "built: $APP/Contents/MacOS/lc-helper"
