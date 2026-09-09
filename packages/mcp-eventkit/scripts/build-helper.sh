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

swiftc -O -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist \
  helper/ek-helper.swift -o "$APP/Contents/MacOS/ek-helper"

# codesign hands the entitlements file to AMFI, whose XML parser rejects
# comments — so strip them through plutil rather than keeping the file bare
# and undocumented. (The comments in ek-helper.entitlements are the record of
# WHY the hardened-runtime calendars entitlement is needed.)
ENTS="$(mktemp -t ek-helper-ents)"
trap 'rm -f "$ENTS"' EXIT
plutil -convert xml1 -o "$ENTS" helper/ek-helper.entitlements

# METISTRY_SIGN_IDENTITY pins a specific identity (e.g. multiple Developer ID
# certs installed); unset falls back to auto-detecting the first Developer ID
# Application identity, then to ad-hoc (docs/ops/apple-signing.md §3).
IDENTITY="${METISTRY_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"') || true
fi
# Sign the BUNDLE, not the inner binary: codesign seals Contents/Info.plist
# into the signature, which is what ties the bundle ID to the identity. No
# --deep needed — there is nothing nested to sign.
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.eventkit --sign "$IDENTITY" "$APP"
  echo "signed: $IDENTITY"
else
  codesign --force --options runtime --entitlements "$ENTS" --identifier com.foldedspacelabs.metistry.eventkit --sign - "$APP"
  echo "signed: ad-hoc (grant rots on rebuild — install the Developer ID cert)"
fi
codesign --verify --strict "$APP"
echo "built: $APP/Contents/MacOS/ek-helper"
