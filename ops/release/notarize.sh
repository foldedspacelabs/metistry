#!/usr/bin/env bash
# Notarize and staple a signed artifact (normally Metistry-<version>.dmg).
#
#   ops/release/notarize.sh <path to .dmg or .app>
#
# Credentials, in the order this script looks for them (docs/ops/apple-signing.md §4):
#
#   1. CI: APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID.
#      APPLE_API_KEY_P8 is the AuthKey_<KEY_ID>.p8 file's contents exactly as
#      Apple issued them, `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE
#      KEY-----` lines included; base64 of that file is accepted too (the
#      format these docs used to ask for). Anything that does not come out as
#      a PEM private key is refused here, naming the format, rather than
#      reaching notarytool as `invalidPrivateKeyContents` (v0.15.0).
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

# `notarytool submit --wait` exits 0 whether Apple said Accepted or Invalid
# (learned from v0.4.0: the job went on to staple and died with "Error 65").
# So the status is read from the output, and on anything but Accepted the
# submission's log — the list of files Apple objected to and why — is fetched
# and printed before failing. That log is the only useful error there is.
creds=()
if [ -n "${APPLE_API_KEY_P8:-}" ]; then
  [ -n "${APPLE_API_KEY_ID:-}" ] || die "APPLE_API_KEY_P8 is set but APPLE_API_KEY_ID is not"
  [ -n "${APPLE_API_ISSUER_ID:-}" ] || die "APPLE_API_KEY_P8 is set but APPLE_API_ISSUER_ID is not"
  keyfile="$(mktemp -t metistry-notary-key)"
  chmod 600 "$keyfile"
  case "$APPLE_API_KEY_P8" in
    *"-----BEGIN PRIVATE KEY-----"*) printf '%s\n' "$APPLE_API_KEY_P8" > "$keyfile" ;;
    *) printf '%s' "$APPLE_API_KEY_P8" | tr -d ' \r\n' | base64 --decode > "$keyfile" 2>/dev/null || : ;;
  esac
  if ! grep -q -- "-----BEGIN PRIVATE KEY-----" "$keyfile" || ! grep -q -- "-----END PRIVATE KEY-----" "$keyfile"; then
    die "APPLE_API_KEY_P8 is not an App Store Connect API key. It must be the AuthKey_${APPLE_API_KEY_ID}.p8 file's
  contents, BEGIN/END PRIVATE KEY lines included (or base64 of that file). Re-set it with:
    gh secret set APPLE_API_KEY_P8 --env release --repo <owner>/<repo> < AuthKey_${APPLE_API_KEY_ID}.p8
  (docs/ops/apple-signing.md §4)"
  fi
  creds=(--key "$keyfile" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")
  say "notarytool submit --wait  (App Store Connect API key $APPLE_API_KEY_ID)"
else
  creds=(--keychain-profile "$profile")
  say "notarytool submit --wait  (keychain profile \"$profile\")"
fi

submit_out="$(xcrun notarytool submit "$artifact" "${creds[@]}" --wait 2>&1 | tee /dev/stderr)" || true
submission_id="$(printf '%s\n' "$submit_out" | grep -oE '^\s*id: [0-9a-f-]{36}' | head -1 | awk '{print $2}')"
status="$(printf '%s\n' "$submit_out" | grep -oE '^\s*status: .*' | tail -1 | awk '{print $2}')"
if [ "$status" != "Accepted" ]; then
  say "notarization status: ${status:-unknown} (submission ${submission_id:-unknown})"
  if [ -n "$submission_id" ]; then
    say "notarytool log $submission_id"
    xcrun notarytool log "$submission_id" "${creds[@]}" 2>&1 | sed 's/^/   /' >&2 || true
  fi
  die "Apple did not accept $artifact — see the issues above"
fi

# Stapling attaches the ticket to the artifact so Gatekeeper accepts it with no
# network. It works on a .dmg and on a .app; it cannot work on a .zip, which is
# why the DMG is the shipped thing.
say "stapler staple $artifact"
xcrun stapler staple "$artifact"
xcrun stapler validate "$artifact"
spctl --assess --type open --context context:primary-signature -v "$artifact" 2>&1 | sed 's/^/   /' >&2 || true
say "notarized and stapled: $artifact"
