#!/bin/sh
# Compile + sign the EventKit helper AS A MINIMAL APP BUNDLE.
#
#   helper/ek-helper.app/Contents/Info.plist
#   helper/ek-helper.app/Contents/MacOS/ek-helper
#
# Why a bundle and not a bare executable (learned 2026-09-08): TCC records a
# BUNDLED client by its CFBundleIdentifier and validates the caller against the
# stored csreq — the designated requirement, which under a Developer ID
# identity is identifier + certificate chain with NO cdhash in it. So a rebuild
# keeps the grant. A bare Mach-O has no bundle for TCC to key on and is
# recorded by absolute path instead (client_type 1): invisible to the Privacy
# pane and to `tccutil reset`, and lost whenever the checkout moves. That is
# the grant-rot we kept hitting even after moving off ad-hoc signing
# (citations: docs/ops/apple-signing.md §3).
#
# The usage descriptions live in helper/Info.plist and are ALSO linked into
# the executable as __TEXT,__info_plist, so the strings are present whether
# the binary is launched through the bundle or directly (PoC-9: without them
# tccd silently refuses to prompt).
#
# Signing: Developer ID when present (stable identity); otherwise ad-hoc with
# a fixed identifier — but an ad-hoc signature's designated requirement IS
# cdhash-based, so it changes every rebuild and the grant rots even in a
# bundle. Install the Developer ID cert (docs/ops/apple-signing.md §2).
set -eu
cd "$(dirname -- "$0")/.."

APP="helper/ek-helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"          # Contents/MacOS is Apple's mandated
cp helper/Info.plist "$APP/Contents/Info.plist"   # bundle layout, not ours.

# -target pins the floor to the app's own minimum (apps/macos Package.swift,
# .macOS(.v14)); without it swiftc targets the build host.
swiftc -O -target arm64-apple-macos14.0 -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist \
  helper/ek-helper.swift -o "$APP/Contents/MacOS/ek-helper"

# codesign hands the entitlements file to AMFI, whose XML parser rejects
# comments — so strip them through plutil rather than keeping the file bare
# and undocumented. (The comments in ek-helper.entitlements are the record of
# WHY the hardened-runtime calendars entitlement is needed.)
ENTS="$(mktemp -t ek-helper-ents)"
trap 'rm -f "$ENTS"' EXIT
plutil -convert xml1 -o "$ENTS" helper/ek-helper.entitlements

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
# Sign the BUNDLE, not the inner binary: codesign seals Contents/Info.plist
# into the signature, which is what ties the bundle ID to the identity. No
# --deep needed — there is nothing nested to sign.
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.eventkit --sign "$IDENTITY" "$APP"
  echo "signed: $IDENTITY ($(security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | grep -o '"[^"]*"' | head -1 | tr -d '"'))"
else
  codesign --force --options runtime --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.eventkit --sign - "$APP"
  echo "signed: ad-hoc (grant rots on rebuild — install the Developer ID cert)"
fi
codesign --verify --strict "$APP"
echo "built: $APP/Contents/MacOS/ek-helper"
