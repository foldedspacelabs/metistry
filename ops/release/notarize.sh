#!/usr/bin/env bash
# Notarize and staple a signed artifact (normally Metistry-<version>.dmg).
#
#   ops/release/notarize.sh <path to .dmg or .app>
#
# Credentials, in the order this script looks for them (docs/ops/apple-signing.md §4):
#
#   1. CI: APPLE_API_KEY_P8 (base64 of the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER_ID.
#      The key is written to a private temp file, used, and deleted — it never
#      lands in the workspace and never reaches a log.
#   2. Locally: the `metistry-notary` keychain profile stored once with
#      `xcrun notarytool store-credentials` (override with METISTRY_NOTARY_PROFILE).
#
# Never an Apple ID plus an app-specific password: an API key survives a
# password reset, which is what makes it usable as a CI credential.
#
# An unsigned artifact is refused here rather than being submitted and rejected
# by Apple several minutes later.
set -euo pipefail

artifact="${1:?usage: notarize.sh <path to .dmg or .app>}"
profile="${METISTRY_NOTARY_PROFILE:-metistry-notary}"

say() { printf '   %s\n' "$*" >&2; }
die() { printf 'notarize: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only"
[ -e "$artifact" ] || die "$artifact does not exist"
command -v xcrun >/dev/null 2>&1 || die "no xcrun — install the Xcode Command Line Tools"

if ! codesign --verify --strict "$artifact" >/dev/null 2>&1; then
  die "$artifact is not validly signed — notarization would reject it.
  Build it with a Developer ID identity: METISTRY_SIGN_IDENTITY=… ops/release/build-app.sh"
fi

cleanup() { [ -n "${keyfile:-}" ] && rm -f "$keyfile"; }
trap cleanup EXIT
keyfile=""

if [ -n "${APPLE_API_KEY_P8:-}" ]; then
  [ -n "${APPLE_API_KEY_ID:-}" ] || die "APPLE_API_KEY_P8 is set but APPLE_API_KEY_ID is not"
  [ -n "${APPLE_API_ISSUER_ID:-}" ] || die "APPLE_API_KEY_P8 is set but APPLE_API_ISSUER_ID is not"
  keyfile="$(mktemp -t metistry-notary-key)"
  chmod 600 "$keyfile"
  printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$keyfile"
  say "notarytool submit --wait  (App Store Connect API key $APPLE_API_KEY_ID)"
  xcrun notarytool submit "$artifact" \
    --key "$keyfile" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" \
    --wait
else
  say "notarytool submit --wait  (keychain profile \"$profile\")"
  xcrun notarytool submit "$artifact" --keychain-profile "$profile" --wait
fi

# Stapling attaches the ticket to the artifact so Gatekeeper accepts it with no
# network. It works on a .dmg and on a .app; it cannot work on a .zip, which is
# why the DMG is the shipped thing.
say "stapler staple $artifact"
xcrun stapler staple "$artifact"
xcrun stapler validate "$artifact"
spctl --assess --type open --context context:primary-signature -v "$artifact" 2>&1 | sed 's/^/   /' >&2 || true
say "notarized and stapled: $artifact"
