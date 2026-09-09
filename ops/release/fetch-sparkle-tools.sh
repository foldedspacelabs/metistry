#!/usr/bin/env bash
# Fetch Sparkle's CLI tools (generate_keys, sign_update, generate_appcast) —
# needed for docs/ops/apple-signing.md §5 and the future `appcast` job
# (.github/workflows/release.yml). The Homebrew cask `sparkle` is disabled
# (fails Gatekeeper, 2026-09-01), so this downloads the pinned release
# archive directly and verifies its sha256, the same pattern
# ops/release/build-runtime-deps.sh uses for Node/Postgres/git — a mirror
# that serves different bytes fails the fetch rather than handing you a
# tampered signing tool.
#
#   ops/release/fetch-sparkle-tools.sh
#
# Idempotent: re-running with the same pin is a no-op after the first
# download. Prints the three tool paths on success. No Homebrew, no sudo.
#
# Bumping the version: edit SPARKLE_VERSION and SPARKLE_SHA256 in
# ops/release/runtime-versions.env (get the sha256 by downloading the new
# Sparkle-<ver>.tar.xz once and `shasum -a 256`), then re-run this script.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=ops/release/runtime-versions.env
. "$root/ops/release/runtime-versions.env"

dl="$root/ops/release/.tools/dl"
out="$root/ops/release/.tools/sparkle"
tarball="Sparkle-$SPARKLE_VERSION.tar.xz"
url="https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/$tarball"

say() { printf '   %s\n' "$*" >&2; }
die() { printf 'fetch-sparkle-tools: %s\n' "$*" >&2; exit 1; }

[ -n "${SPARKLE_VERSION:-}" ] || die "SPARKLE_VERSION not set — check ops/release/runtime-versions.env"
[ -n "${SPARKLE_SHA256:-}" ] || die "SPARKLE_SHA256 not set — check ops/release/runtime-versions.env"

mkdir -p "$dl"

if [ -x "$out/bin/generate_keys" ] && [ -x "$out/bin/sign_update" ] && [ -x "$out/bin/generate_appcast" ] \
  && [ "$(cat "$out/.version" 2>/dev/null || true)" = "$SPARKLE_VERSION" ]; then
  say "sparkle $SPARKLE_VERSION: already fetched at $out/bin"
else
  file="$dl/$tarball"
  if [ -f "$file" ]; then
    got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    if [ "$got" != "$SPARKLE_SHA256" ]; then
      say "$tarball: cached copy has the wrong digest — re-downloading"
      rm -f "$file"
    fi
  fi
  if [ ! -f "$file" ]; then
    say "downloading $tarball"
    curl -fsSL --retry 3 --retry-delay 2 -o "$file.part" "$url" || die "download failed: $url"
    mv "$file.part" "$file"
  fi
  got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [ "$got" != "$SPARKLE_SHA256" ]; then
    rm -f "$file"
    die "$tarball sha256 mismatch
  expected $SPARKLE_SHA256   (ops/release/runtime-versions.env)
  got      $got   from $url"
  fi
  say "$tarball: sha256 ok"

  rm -rf "$out"
  mkdir -p "$out/bin"
  say "extracting bin/ from $tarball"
  tmp="$(mktemp -d "$dl/extract.XXXXXX")"
  tar -xJf "$file" -C "$tmp" bin/generate_keys bin/sign_update bin/generate_appcast \
    || die "archive did not contain the expected bin/* tools — Sparkle may have changed layout"
  mv "$tmp/bin/generate_keys" "$tmp/bin/sign_update" "$tmp/bin/generate_appcast" "$out/bin/"
  chmod +x "$out/bin/generate_keys" "$out/bin/sign_update" "$out/bin/generate_appcast"
  rm -rf "$tmp"
  echo "$SPARKLE_VERSION" > "$out/.version"
fi

for t in generate_keys sign_update generate_appcast; do
  [ -x "$out/bin/$t" ] || die "$out/bin/$t is missing after extraction"
done

say "sparkle $SPARKLE_VERSION tools ready:"
say "  $out/bin/generate_keys"
say "  $out/bin/sign_update"
say "  $out/bin/generate_appcast"
