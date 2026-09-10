#!/usr/bin/env bash
# Build Metistry.app (and a DMG) from apps/macos.
#
#   ops/release/build-app.sh [options]
#
#     --version <x.y.z>      default: the root package.json's version
#     --runtime <path>       the runtime pack: metistry-runtime-*.tar.gz, or an
#                            already-unpacked metistry-<version>/ directory
#     --runtime-deps <path>  the bundled runtime: metistry-runtime-deps-*.tar.gz,
#                            or an already-unpacked runtime/ directory
#     --out <dir>            default: <repo>/dist-app
#     --no-dmg               stop after the .app
#     --skip-build           reuse .build/release/Metistry (fast iteration)
#
# There is no Xcode project. This is the same shape as the Swift TCC helpers
# (packages/mcp-*/scripts/build-helper.sh): `swift build`, then assemble
# Apple's mandated bundle layout by hand, then codesign the BUNDLE.
#
# SIGNING. METISTRY_SIGN_IDENTITY pins an identity; unset, the first
# "Developer ID Application" identity is auto-detected; with none installed the
# app is left UNSIGNED (not ad-hoc) and the script says so. An unsigned app runs
# fine on the machine that built it, which is all a local build needs — it is
# notarization that requires a real identity, and notarize.sh refuses without
# one rather than producing something Gatekeeper will reject on someone else's
# Mac. (docs/ops/apple-signing.md)
#
# WHAT ENDS UP INSIDE:
#
#   Metistry.app/Contents/
#     Info.plist                        apps/macos/resources/Info.plist, __VERSION__ substituted
#     MacOS/Metistry                    swift build -c release
#     Frameworks/Sparkle.framework      the SPM binary target, copied + signed inside-out
#     Resources/AppIcon.icns            placeholder (ops/release/make-app-icon.mjs)
#     Resources/metistry/               the product, laid out exactly as `metistry update`
#       releases/<version>/             …lays out a release install (docs/ops/releases.md),
#       current -> releases/<version>   …so the app's locator and the CLI agree,
#       runtime/                        …and Node/Postgres/git sit beside releases/, never inside one.
#
# The runtime arguments are optional: without them you get an app that finds a
# product checkout or a `metistry` on PATH instead (first-run step 1). The
# release workflow passes the artifacts its own jobs already built.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
app_src="$root/apps/macos"

version=""
runtime_src=""
runtime_deps_src=""
outdir="$root/dist-app"
make_dmg=1
skip_build=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --runtime) runtime_src="${2:?--runtime needs a path}"; shift 2 ;;
    --runtime-deps) runtime_deps_src="${2:?--runtime-deps needs a path}"; shift 2 ;;
    --out) outdir="${2:?--out needs a path}"; shift 2 ;;
    --no-dmg) make_dmg=0; shift ;;
    --skip-build) skip_build=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "build-app: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { printf '   %s\n' "$*" >&2; }
die() { printf 'build-app: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only — this builds a .app"
command -v swift >/dev/null 2>&1 || die "no swift on PATH (install Xcode or the Command Line Tools)"

if [ -z "$version" ]; then
  version="$(node -p "require('$root/package.json').version")"
fi
version="${version#v}"
[ -n "$version" ] || die "could not determine a version"

app="$outdir/Metistry.app"
contents="$app/Contents"

# ---------------------------------------------------------------- 1. compile
if [ "$skip_build" = "0" ]; then
  say "swift build -c release  ($app_src)"
  swift build -c release --package-path "$app_src"
fi
bin_dir="$(swift build -c release --package-path "$app_src" --show-bin-path)"
[ -x "$bin_dir/Metistry" ] || die "no executable at $bin_dir/Metistry — run without --skip-build"

# ---------------------------------------------------------------- 2. assemble
say "assembling $app"
rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources" "$contents/Frameworks"

cp "$bin_dir/Metistry" "$contents/MacOS/Metistry"
sed "s/__VERSION__/$version/g" "$app_src/resources/Info.plist" > "$contents/Info.plist"
# Sealed into the signature, so it must be written before codesign runs.
plutil -lint "$contents/Info.plist" >/dev/null || die "Info.plist did not lint after substitution"
printf 'APPL????' > "$contents/PkgInfo"

# Sparkle arrives as an SPM binary target; SPM stages the framework beside the
# executable, and the app's rpath (@executable_path/../Frameworks) is where it
# has to end up. `cp -R` preserves the Versions/ symlink farm a framework is.
[ -d "$bin_dir/Sparkle.framework" ] || die "Sparkle.framework is not in $bin_dir — did `swift build` resolve the package?"
cp -R "$bin_dir/Sparkle.framework" "$contents/Frameworks/Sparkle.framework"

# ---- icon (placeholder) ----
icon_tmp="$(mktemp -d)"
trap 'rm -rf "$icon_tmp"' EXIT
node "$root/ops/release/make-app-icon.mjs" "$icon_tmp/icon.png" 1024
iconset="$icon_tmp/AppIcon.iconset"
mkdir -p "$iconset"
for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
  set -- $spec
  sips -z "$1" "$1" "$icon_tmp/icon.png" --out "$iconset/icon_$2.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"
say "icon: placeholder (ops/release/make-app-icon.mjs — replace before launch)"

# ---- the product runtime, if we were handed one ----
resources_metistry="$contents/Resources/metistry"

# Both packs are tarballs with exactly one top-level directory
# (`metistry-<version>/` and `runtime/`). Given a DIRECTORY instead, the
# directory IS that top level — so `--runtime-deps <product>/runtime` works,
# and neither flag can be pointed at a parent and quietly copy a whole
# checkout. Either way the result lands at <dest>, renamed.
place_pack() { # <tar.gz|dir> <destination path>
  local src="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  if [ -d "$src" ]; then
    cp -R "$src" "$dest"
    return
  fi
  local staging
  staging="$(mktemp -d "$icon_tmp/pack.XXXXXX")"
  tar -xzf "$src" -C "$staging"
  local top
  top="$(find "$staging" -mindepth 1 -maxdepth 1 -type d)"
  [ "$(printf '%s\n' "$top" | wc -l | tr -d ' ')" = "1" ] && [ -n "$top" ] \
    || die "$src does not have exactly one top-level directory — is it a Metistry pack?"
  mv "$top" "$dest"
}

if [ -n "$runtime_src" ]; then
  [ -e "$runtime_src" ] || die "--runtime $runtime_src does not exist"
  say "embedding the runtime pack from $runtime_src"
  # releases/<version> + a RELATIVE `current` symlink: byte-for-byte the layout
  # `metistry update` produces in release mode, so the app's locator and the CLI
  # agree, and the bundle survives being moved to /Applications.
  place_pack "$runtime_src" "$resources_metistry/releases/$version"
  ( cd "$resources_metistry" && ln -sfn "releases/$version" current )
  [ -f "$resources_metistry/current/packages/cli/dist/main.js" ] \
    || die "the runtime pack has no packages/cli/dist/main.js — the app would find no CLI inside itself"
  say "  Contents/Resources/metistry/current -> releases/$version"
fi

if [ -n "$runtime_deps_src" ]; then
  [ -e "$runtime_deps_src" ] || die "--runtime-deps $runtime_deps_src does not exist"
  say "embedding the bundled runtime (Node, Postgres, git) from $runtime_deps_src"
  # Beside releases/, never inside one, so a version flip never orphans the
  # Postgres the plists point at (docs/ops/bundled-runtime.md).
  place_pack "$runtime_deps_src" "$resources_metistry/runtime"
  [ -x "$resources_metistry/runtime/node/bin/node" ] \
    || die "no runtime/node/bin/node in $runtime_deps_src — the app would find no bundled CLI"
fi

# ---------------------------------------------------------------- 3. sign
identity="${METISTRY_SIGN_IDENTITY:-}"
if [ "$identity" = "none" ]; then
  # Explicit escape hatch for local iteration; without it, an installed
  # Developer ID cert is always used, which is what a release build wants.
  identity=""
  say "METISTRY_SIGN_IDENTITY=none — skipping signing on purpose"
elif [ -z "$identity" ]; then
  # Auto-detect the SHA-1 HASH, not the display name. A Mac with two valid
  # Developer ID certs for the same team (a renewal, typically) has two
  # identities with byte-identical names, and `codesign -s "<name>"` fails with
  # "ambiguous (matches …)". The hash is unique by construction.
  identity=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 | awk '{print $2}') || true
  [ -n "$identity" ] && say "auto-detected identity $identity ($(security find-identity -v -p codesigning | grep "$identity" | grep -o '"[^"]*"' | tr -d '"'))"
fi

if [ -n "$identity" ]; then
  say "signing with: $identity"
  # AMFI's XML parser rejects comments, and the entitlements file is mostly
  # comments on purpose (it records WHY the app needs no exception).
  ents="$icon_tmp/metistry.entitlements"
  plutil -convert xml1 -o "$ents" "$app_src/resources/metistry.entitlements"

  sign() { codesign --force --options runtime --timestamp --sign "$identity" "$@"; }

  # Anything Mach-O that came in with the runtime packs and is NOT already
  # signed. build-runtime-deps.sh signs every Mach-O it produces, and the TCC
  # helpers are signed by their own build scripts — those are left exactly as
  # they are, because re-signing a helper without its --identifier would change
  # the bundle ID TCC keys its grant on. This catches the leftovers
  # (a prebuilt .node in node_modules, say) that notarization would reject.
  if [ -d "$resources_metistry" ]; then
    while IFS= read -r f; do
      case "$(file -b "$f")" in
        Mach-O*) ;;
        *) continue ;;
      esac
      if codesign -v --strict "$f" >/dev/null 2>&1; then continue; fi
      say "  signing unsigned nested binary: ${f#"$app/"}"
      sign "$f"
    done < <(find "$resources_metistry" -type f -perm -u+x)
  fi

  # Sparkle, inside out. Its XPC services, updater app and Autoupdate helper are
  # separate code that must each carry a signature before the framework is
  # sealed. (sparkle-project.org/documentation/sandboxing — the same order
  # applies unsandboxed.)
  fw="$contents/Frameworks/Sparkle.framework/Versions/B"
  for nested in "$fw/XPCServices/"*.xpc "$fw/Updater.app" "$fw/Autoupdate"; do
    [ -e "$nested" ] || continue
    sign "$nested"
  done
  sign "$contents/Frameworks/Sparkle.framework"

  # The app last: codesign seals Contents/Info.plist and everything nested.
  sign --entitlements "$ents" --identifier com.foldedspacelabs.metistry "$app"
  codesign --verify --strict --deep "$app"
  say "signed and verified"
else
  say "NO Developer ID identity — leaving the app unsigned."
  say "  Fine locally; notarization and distribution need one (docs/ops/apple-signing.md §2)."
fi

say "built: $app"

# ---------------------------------------------------------------- 4. dmg
if [ "$make_dmg" = "0" ]; then
  echo "$app"
  exit 0
fi

dmg="$outdir/Metistry-$version.dmg"
stage="$icon_tmp/dmg"
mkdir -p "$stage"
cp -R "$app" "$stage/Metistry.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
say "hdiutil create $dmg"
hdiutil create -volname "Metistry $version" -srcfolder "$stage" -ov -format UDZO -quiet "$dmg"

if [ -n "$identity" ]; then
  # No --options runtime here: the hardened runtime is a property of an
  # executable, and a disk image has none. What matters is that the DMG carries
  # a timestamped Developer ID signature so notarization can staple to it.
  codesign --force --timestamp --sign "$identity" "$dmg"
  codesign --verify --strict "$dmg"
fi

say "built: $dmg  ($(du -h "$dmg" | cut -f1))"
echo "$dmg"
