#!/usr/bin/env bash
# Build the PROVIDER TOOL PACKS — one `remote/<tool>/` tree per tool a
# remote-access provider needs (plan §2.23, X-112; operator notes:
# docs/ops/bundled-runtime.md, "Provider tool packs"):
#
#   remote/tailscale/     bin/tailscaled + bin/tailscale, built from the pinned
#                         upstream tag's source (BSD-3)
#   remote/cloudflared/   bin/cloudflared, the official darwin-arm64 release
#                         binary (Apache-2.0), re-signed
#   remote/zrok/          bin/zrok (or zrok2 — whatever the release ships), the
#                         zrok CLI's darwin_arm64 release (Apache-2.0), re-signed
#
# Each tree carries the tool's LICENSE and a manifest.json (version, source
# digest, a sha256 per Mach-O, whether it was signed). The release workflow
# tars each tree as ITS OWN ASSET — metistry-remote-<tool>-<version>-darwin-
# arm64.tar.gz, a single top-level `remote/<tool>/` — covered by checksums.txt
# like every other asset. `metistry remote set <provider>` fetches the one
# pack its provider needs, verifies it against checksums.txt and unpacks it
# to <product>/runtime/remote/<tool>/ (packages/cli/src/runtime-deps.ts).
# Nothing here goes in the DMG or in the runtime-deps pack: a tool is on a
# Mac only once the owner picked its provider.
#
#   ops/release/build-remote-packs.sh [<outdir>]
#   ops/release/build-remote-packs.sh [<outdir>] --only tailscale|cloudflared|zrok
#
# `--only <tool>` builds and verifies ONE tool and stops: nothing is signed,
# no manifest is written. A release build is the whole run.
#
# macOS arm64 only (the `remote-packs (darwin-arm64)` release job). Every
# version and digest is pinned in ops/release/runtime-versions.env; a
# download that does not match its pin fails the build. The signing rule is
# pack-lib.sh's — the runtime pack's, by construction — and after signing
# EVERY Mach-O is checked for the release identity's team, the hardened
# runtime and a secure timestamp.
#
# Env:
#   METISTRY_RUNTIME_WORK   downloads, build trees, the Go module/toolchain
#                           cache (default <repo>/.runtime-build — the same
#                           tree build-runtime-deps.sh uses; CI caches its
#                           cache/ keyed on runtime-versions.env)
#   METISTRY_SIGN_IDENTITY  a Developer ID Application identity: set → every
#                           Mach-O is signed as com.foldedspacelabs.metistry.
#                           remote.<name> and verified; unset → a notice, never
#                           a failure (docs/ops/apple-signing.md)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=ops/release/runtime-versions.env
. "$root/ops/release/runtime-versions.env"

only=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="${2:-}"; shift 2 || { echo "--only needs a tool name" >&2; exit 1; } ;;
    --only=*) only="${1#--only=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

work="${METISTRY_RUNTIME_WORK:-$root/.runtime-build}"
out="${1:-$work/remote-packs}"
dl="$work/dl"
cache="$work/cache"
build="$work/build"
started="$(date -u +%s)"

log() { printf '\n== %s\n' "$*" >&2; }
say() { printf '   %s\n' "$*" >&2; }
die() { printf 'build-remote-packs: %s\n' "$*" >&2; exit 1; }
secs_since() { echo $(($(date -u +%s) - $1)); }

# shellcheck source=ops/release/pack-lib.sh
. "$root/ops/release/pack-lib.sh"

TOOLS="tailscale cloudflared zrok"
TARGET="darwin-arm64"

[ "$(uname -s)" = "Darwin" ] || die "macOS only (this host is $(uname -s)); the release job is macos-14"
[ "$(uname -m)" = "arm64" ] || die "darwin-arm64 only (this host is $(uname -m))"

mkdir -p "$dl" "$cache" "$build"

# Go's module and toolchain cache under the work dir, so CI's cache of
# .runtime-build/cache carries the tailscale modules AND the toolchain — a
# later run compiles, it does not download. The toolchain is PINNED
# (TAILSCALE_GO_TOOLCHAIN in runtime-versions.env), not whatever `go` the
# runner image ships: the go command fetches exactly that release and
# verifies it against the Go checksum database, so the build is the same on
# any image. Bumping Tailscale means re-reading its go.mod and bumping it.
export GOMODCACHE="$cache/go/mod"
export GOCACHE="$cache/go/build"
export GOTOOLCHAIN="$TAILSCALE_GO_TOOLCHAIN"
export GOFLAGS="-mod=readonly"

# A small text file fetched beside a binary (a LICENSE), pinned like the rest.
fetch_text() { # <url> <file> <sha256>
  fetch "$1" "$2" "$3"
}

# ---- cross-checks against what upstream publishes ---------------------------------
# The pin is the authority (a wrong pin fails `fetch`); these say whether the
# pin itself still matches what the publisher says the asset is — the same
# role nodejs.org's SHASUMS256.txt plays in build-runtime-deps.sh.

github_asset_digest() { # <owner/repo> <tag> <asset> → the sha256 GitHub records for that release asset, or ""
  curl -fsSL --retry 3 -H 'accept: application/vnd.github+json' "https://api.github.com/repos/$1/releases/tags/$2" 2>/dev/null \
    | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const a = (JSON.parse(d).assets || []).find((a) => a.name === process.argv[1] && String(a.digest || "").startsWith("sha256:"));
          if (a) console.log(a.digest.slice(7));
        } catch {}
      });' "$3" 2>/dev/null || true
}

# ---- Tailscale ---------------------------------------------------------------------
# `tailscaled` + `tailscale` from the pinned tag's source archive. build_dist.sh
# upstream burns the version in with -X flags read from git; a tarball has no
# git, so the pinned version is stamped directly (the same two variables).
# `-w -s` is what build_dist.sh --strip does, so strip_tree is not needed.
# The toolchain is the pinned one (GOTOOLCHAIN above), fetched through the
# Go checksum database; the archive's go.mod must not ask for a newer one.

build_tailscale() {
  local prefix="$cache/tailscale-$TAILSCALE_VERSION" src="$build/tailscale" tarball="tailscale-$TAILSCALE_VERSION.tar.gz" t0 ldflags
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "tailscale $TAILSCALE_VERSION: cached"; return 0; fi
  log "tailscale $TAILSCALE_VERSION (tailscaled + tailscale, from source)"
  command -v go >/dev/null || die "no go — tailscaled is built from source and the macos-14 runner image ships none. In CI the remote-packs job in .github/workflows/release.yml must run actions/setup-go (version from TAILSCALE_GO_TOOLCHAIN in runtime-versions.env); locally install Go from go.dev/dl. The build itself then uses GOTOOLCHAIN=$TAILSCALE_GO_TOOLCHAIN, fetched and verified by the go command"
  fetch "https://github.com/tailscale/tailscale/archive/refs/tags/v$TAILSCALE_VERSION.tar.gz" "$tarball" "$TAILSCALE_SHA256"

  rm -rf "$prefix" "$src"
  mkdir -p "$src" "$prefix/bin"
  tar -xzf "$dl/$tarball" -C "$src" --strip-components=1
  [ "$(tr -d '[:space:]' < "$src/VERSION.txt")" = "$TAILSCALE_VERSION" ] || die "the archive's VERSION.txt says $(cat "$src/VERSION.txt"), not $TAILSCALE_VERSION — the pin and the tag disagree"

  ldflags="-X tailscale.com/version.longStamp=$TAILSCALE_VERSION -X tailscale.com/version.shortStamp=$TAILSCALE_VERSION -w -s"
  say "go build ./cmd/tailscaled ./cmd/tailscale (toolchain: $(cd "$src" && go version | awk '{print $3}'))"
  ( cd "$src" && go build -trimpath -ldflags "$ldflags" -o "$prefix/bin/tailscaled" ./cmd/tailscaled >"$build/tailscaled-build.log" 2>&1 ) \
    || { tail -30 "$build/tailscaled-build.log" >&2; die "tailscaled build failed"; }
  ( cd "$src" && go build -trimpath -ldflags "$ldflags" -o "$prefix/bin/tailscale" ./cmd/tailscale >"$build/tailscale-build.log" 2>&1 ) \
    || { tail -30 "$build/tailscale-build.log" >&2; die "tailscale build failed"; }
  cp "$src/LICENSE" "$prefix/LICENSE"
  rm -rf "$src"
  echo "$TAILSCALE_VERSION" > "$prefix/.done"
  say "tailscale built in $(secs_since "$t0")s ($(du -sh "$prefix" | cut -f1))"
}

verify_tailscale() { # <prefix> — from a moved copy
  local out v
  # the whole output, not line 1: a tool may print a banner before the version
  out="$("$1/bin/tailscale" version 2>&1)" || true
  v="$(printf '%s\n' "$out" | grep -xF -m1 -e "$TAILSCALE_VERSION" || true)"
  [ -n "$v" ] || die "tailscale version printed '$(printf '%s' "$out" | head -3 | paste -sd'|' -)' from the moved copy, no line of it being $TAILSCALE_VERSION"
  file "$1/bin/tailscaled" | grep -q 'Mach-O 64-bit executable arm64' || die "bin/tailscaled is not an arm64 Mach-O"
  say "tailscale $v, tailscaled is an arm64 Mach-O"
}

# ---- cloudflared --------------------------------------------------------------------
# The official release binary, not a build: Cloudflare's own darwin-arm64 tgz,
# whose digest GitHub publishes on the release. It is RE-SIGNED here — the
# upstream macOS binary is not reliably notarized — which is the one thing
# that changes it.

build_cloudflared() {
  local prefix="$cache/cloudflared-$CLOUDFLARED_VERSION" src="$build/cloudflared" tgz="cloudflared-$CLOUDFLARED_VERSION-darwin-arm64.tgz" t0 published
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "cloudflared $CLOUDFLARED_VERSION: cached"; return 0; fi
  log "cloudflared $CLOUDFLARED_VERSION (official darwin-arm64 release)"
  published="$(github_asset_digest cloudflare/cloudflared "$CLOUDFLARED_VERSION" cloudflared-darwin-arm64.tgz)"
  if [ -n "$published" ]; then
    [ "$published" = "$CLOUDFLARED_SHA256" ] || die "CLOUDFLARED_SHA256 is not what GitHub publishes for cloudflared-darwin-arm64.tgz of $CLOUDFLARED_VERSION ($published) — refusing to bundle it"
    say "GitHub's published digest agrees with the pin"
  else
    say "GitHub published no digest for this asset (or the API was unreachable) — the pin alone is the check"
  fi
  fetch "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-arm64.tgz" "$tgz" "$CLOUDFLARED_SHA256"
  fetch_text "https://raw.githubusercontent.com/cloudflare/cloudflared/$CLOUDFLARED_VERSION/LICENSE" "cloudflared-$CLOUDFLARED_VERSION-LICENSE" "$CLOUDFLARED_LICENSE_SHA256"

  rm -rf "$prefix" "$src"
  mkdir -p "$src" "$prefix/bin"
  tar -xzf "$dl/$tgz" -C "$src"
  [ -f "$src/cloudflared" ] || die "the tgz holds no cloudflared binary at its root ($(ls "$src" | paste -sd' ' -))"
  cp "$src/cloudflared" "$prefix/bin/cloudflared"
  chmod 755 "$prefix/bin/cloudflared"
  cp "$dl/cloudflared-$CLOUDFLARED_VERSION-LICENSE" "$prefix/LICENSE"
  rm -rf "$src"
  echo "$CLOUDFLARED_VERSION" > "$prefix/.done"
  say "cloudflared staged in $(secs_since "$t0")s ($(du -sh "$prefix" | cut -f1))"
}

verify_cloudflared() { # <prefix>
  local out v
  out="$("$1/bin/cloudflared" --version 2>&1)" || true
  v="$(printf '%s\n' "$out" | grep -F -m1 -e "$CLOUDFLARED_VERSION" || true)"
  [ -n "$v" ] || die "cloudflared --version printed '$(printf '%s' "$out" | head -3 | paste -sd'|' -)' from the moved copy, no line of it naming $CLOUDFLARED_VERSION"
  say "$v"
}

# ---- zrok -----------------------------------------------------------------------------
# The zrok CLI's release tarball, cross-checked against the release's own
# checksums.sha256.txt, re-signed. v2 may ship the binary as `zrok2`; whatever
# name the tarball uses is kept (an adapter reads the manifest's `binaries`),
# never renamed — a Go binary's own name is not ours to change.

build_zrok() {
  local prefix="$cache/zrok-$ZROK_VERSION" src="$build/zrok" tgz="zrok_${ZROK_VERSION}_darwin_arm64.tar.gz" t0 bin
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "zrok $ZROK_VERSION: cached"; return 0; fi
  log "zrok $ZROK_VERSION (darwin_arm64 release)"
  say "cross-checking the release's checksums.sha256.txt"
  curl -fsSL --retry 3 -o "$dl/zrok-$ZROK_VERSION-checksums.txt" "https://github.com/openziti/zrok/releases/download/v$ZROK_VERSION/checksums.sha256.txt" \
    || die "could not fetch checksums.sha256.txt for zrok v$ZROK_VERSION"
  grep -qE "^$ZROK_SHA256  (\./)?$tgz\$" "$dl/zrok-$ZROK_VERSION-checksums.txt" \
    || die "ZROK_SHA256 is not what zrok's release publishes for $tgz — refusing to bundle it"
  say "checksums.sha256.txt agrees with the pin"
  fetch "https://github.com/openziti/zrok/releases/download/v$ZROK_VERSION/$tgz" "$tgz" "$ZROK_SHA256"
  fetch_text "https://raw.githubusercontent.com/openziti/zrok/v$ZROK_VERSION/LICENSE" "zrok-$ZROK_VERSION-LICENSE" "$ZROK_LICENSE_SHA256"

  rm -rf "$prefix" "$src"
  mkdir -p "$src" "$prefix/bin"
  tar -xzf "$dl/$tgz" -C "$src"
  bin="$(find "$src" -maxdepth 1 -type f \( -name zrok -o -name zrok2 \) | head -1)"
  [ -n "$bin" ] || die "the tarball holds no zrok or zrok2 binary at its root ($(ls "$src" | paste -sd' ' -))"
  cp "$bin" "$prefix/bin/$(basename "$bin")"
  chmod 755 "$prefix/bin/$(basename "$bin")"
  cp "$dl/zrok-$ZROK_VERSION-LICENSE" "$prefix/LICENSE"
  rm -rf "$src"
  echo "$ZROK_VERSION" > "$prefix/.done"
  say "zrok staged in $(secs_since "$t0")s ($(du -sh "$prefix" | cut -f1); binary: $(basename "$bin"))"
}

verify_zrok() { # <prefix>
  local bin out v
  bin="$(find "$1/bin" -type f | head -1)"
  # zrok 2.x prints an ASCII-art banner before the version line (v0.17.1 died
  # on its first line), so the whole output is searched for the pinned version
  out="$("$bin" version 2>&1)" || true
  v="$(printf '%s\n' "$out" | grep -F -m1 -e "$ZROK_VERSION" | sed 's/^[[:space:]]*//' || true)"
  [ -n "$v" ] || die "$(basename "$bin") version printed no line naming $ZROK_VERSION from the moved copy (output: $(printf '%s' "$out" | tr -s ' \n' ' ' | cut -c1-200))"
  say "$(basename "$bin") $v"
}

# ---- assemble, sign, verify, manifest ----------------------------------------------------

version_of() { # <tool>
  case "$1" in
    tailscale) echo "$TAILSCALE_VERSION" ;;
    cloudflared) echo "$CLOUDFLARED_VERSION" ;;
    zrok) echo "$ZROK_VERSION" ;;
    *) die "unknown tool $1" ;;
  esac
}
source_sha_of() { # <tool>
  case "$1" in
    tailscale) echo "$TAILSCALE_SHA256" ;;
    cloudflared) echo "$CLOUDFLARED_SHA256" ;;
    zrok) echo "$ZROK_SHA256" ;;
  esac
}
origin_of() { # <tool>
  case "$1" in
    tailscale) echo "built from source (github.com/tailscale/tailscale v$TAILSCALE_VERSION)" ;;
    cloudflared) echo "official darwin-arm64 release binary (github.com/cloudflare/cloudflared $CLOUDFLARED_VERSION), re-signed" ;;
    zrok) echo "darwin_arm64 release tarball (github.com/openziti/zrok v$ZROK_VERSION), re-signed" ;;
  esac
}
license_of() { # <tool>
  case "$1" in
    tailscale) echo "BSD-3-Clause" ;;
    cloudflared|zrok) echo "Apache-2.0" ;;
  esac
}

assemble() {
  local tool
  log "assembling $out"
  rm -rf "$out"
  mkdir -p "$out/remote"
  for tool in $TOOLS; do
    cp -R "$cache/$tool-$(version_of "$tool")" "$out/remote/$tool"
    rm -f "$out/remote/$tool/.done"
    [ -f "$out/remote/$tool/LICENSE" ] || die "remote/$tool/LICENSE is missing — a pack ships its licence beside the binary"
    [ -n "$(machos "$out/remote/$tool/bin")" ] || die "remote/$tool/bin holds no Mach-O"
  done
  [ -x "$out/remote/tailscale/bin/tailscaled" ] || die "remote/tailscale/bin/tailscaled is missing"
  [ -x "$out/remote/tailscale/bin/tailscale" ] || die "remote/tailscale/bin/tailscale is missing"
  [ -x "$out/remote/cloudflared/bin/cloudflared" ] || die "remote/cloudflared/bin/cloudflared is missing"
  say "$(du -sh "$out" | cut -f1) in $out"
}

sign() {
  local id="${METISTRY_SIGN_IDENTITY:-}"
  if [ -z "$id" ]; then
    log "signing: skipped"
    say "METISTRY_SIGN_IDENTITY is unset — every Mach-O keeps the signature it came with (upstream's, or none)"
    return 0
  fi
  log "signing every Mach-O as \"$id\""
  sign_machos "$out" "com.foldedspacelabs.metistry.remote"
  # the test the ticket names: every Mach-O in a pack is signed with the
  # release identity — team, hardened runtime, secure timestamp, each one
  verify_signed "$out"
}

verify() {
  local moved="$work/verify/remote" t0
  t0="$(date -u +%s)"
  log "verifying MOVED copies"
  rm -rf "$work/verify"
  mkdir -p "$work/verify"
  cp -R "$out/remote" "$moved"
  verify_tailscale "$moved/tailscale"
  verify_cloudflared "$moved/cloudflared"
  verify_zrok "$moved/zrok"
  rm -rf "$work/verify"
  say "verified in $(secs_since "$t0")s"
}

manifest() { # one manifest.json per tool — what packages/cli/src/runtime-deps.ts reads and checks after unpacking
  local tool dir f rel first tmp
  log "remote/<tool>/manifest.json"
  for tool in $TOOLS; do
    dir="$out/remote/$tool"
    tmp="$dir/.manifest.tmp"
    first=1
    {
      printf '{\n'
      printf '  "schema": 1,\n'
      printf '  "tool": "%s",\n' "$tool"
      printf '  "version": "%s",\n' "$(version_of "$tool")"
      printf '  "target": "%s",\n' "$TARGET"
      printf '  "built_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '  "signed": %s,\n' "$([ -n "${METISTRY_SIGN_IDENTITY:-}" ] && echo true || echo false)"
      printf '  "origin": "%s",\n' "$(origin_of "$tool")"
      printf '  "source_sha256": "%s",\n' "$(source_sha_of "$tool")"
      printf '  "license": "%s",\n' "$(license_of "$tool")"
      printf '  "binaries": {\n'
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        rel="${f#"$dir"/}"
        [ $first -eq 1 ] || printf ',\n'
        first=0
        printf '    "%s": "%s"' "$rel" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
      done < <(machos "$dir" | sort)
      printf '\n  }\n}\n'
    } > "$tmp"
    mv "$tmp" "$dir/manifest.json"
    say "remote/$tool: $(machos "$dir" | wc -l | tr -d ' ') Mach-O files hashed"
  done
}

# ---- run ----------------------------------------------------------------------------------

if [ -n "$only" ]; then
  case "$only" in
    tailscale|cloudflared|zrok) ;;
    *) die "--only takes tailscale, cloudflared or zrok" ;;
  esac
  "build_$only"
  log "verifying a MOVED copy"
  rm -rf "$work/only"
  mkdir -p "$work/only"
  cp -R "$cache/$only-$(version_of "$only")" "$work/only/$only"
  rm -f "$work/only/$only/.done"
  "verify_$only" "$work/only/$only"
  log "done in $(secs_since "$started")s (--only $only: nothing was assembled, signed or hashed)"
  exit 0
fi

build_tailscale
build_cloudflared
build_zrok
assemble
sign
verify
manifest

log "done in $(secs_since "$started")s"
say "$out ($(du -sh "$out" | cut -f1))"
