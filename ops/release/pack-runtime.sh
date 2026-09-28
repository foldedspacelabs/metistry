#!/usr/bin/env bash
# Build the runtime pack: `metistry-runtime-<version>-<os>-<arch>.tar.gz`,
# the built product an install runs WITHOUT a git checkout. `metistry
# update` in release mode downloads exactly this, verifies its sha256,
# unpacks it to <product-dir>/releases/<version>/ and points `current` at
# it (docs/ops/releases.md documents the contents; a test asserts this
# script and the workflow agree on the name).
#
#   ops/release/pack-runtime.sh <version> [<os>-<arch>] [<outdir>]
#
# The pack is per os-arch because it carries production node_modules (and,
# on darwin, the signed TCC helper binaries). Set METISTRY_PACK_DEPS=0 to
# omit node_modules — a smaller pack that needs `pnpm install --prod`
# on the target before it can run.
set -euo pipefail

version="${1:?usage: pack-runtime.sh <version> [<os>-<arch>] [<outdir>]}"
version="${version#v}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

case "$(uname -s)" in
  Darwin) default_os=darwin ;;
  Linux)  default_os=linux ;;
  *)      default_os="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) default_arch=arm64 ;;
  x86_64|amd64)  default_arch=x64 ;;
  *)             default_arch="$(uname -m)" ;;
esac
target="${2:-$default_os-$default_arch}"
outdir="${3:-$root/dist-release}"
mkdir -p "$outdir"

stage_root="$(mktemp -d)"
stage="$stage_root/metistry-$version"
mkdir -p "$stage"
trap 'rm -rf "$stage_root"' EXIT

cd "$root"

# Copy a path into the stage, keeping its position in the tree. Missing
# paths are skipped: an optional artifact (a Swift helper binary that was
# not built on this runner) must not fail the pack.
copy() {
  for p in "$@"; do
    [ -e "$p" ] || continue
    mkdir -p "$stage/$(dirname "$p")"
    cp -R "$p" "$stage/$p"
  done
}

# --- what a release install actually needs -----------------------------------
# 1. the workspace's own shape: metistry init/doctor/up identify a product
#    directory by seed/identity.yaml + a package.json named "metistry"
copy package.json pnpm-workspace.yaml pnpm-lock.yaml docker-compose.yml README.md LICENSE

# 2. config-shaped defaults, the schema, the ops surface.
#    ops/sandbox is NOT optional on darwin: under the launchd shape BOTH the
#    assistant's and the reconciler's jobs exec /usr/bin/sandbox-exec -f
#    __REPO__/ops/sandbox/<profile>.sb, so a pack without one produces a job
#    that cannot start — the only host confinement either has, missing exactly
#    where the container boundary was given up (open decision 15). Found by
#    the 2026-09-10 launchd trial; v0.4.0 and earlier packs lack it.
#    unconfined.sb ships too: it is the reconciler's documented off switch
#    (METISTRY_RECONCILER_SANDBOX=0), and a release that omitted it would turn
#    that switch into a job that cannot start.
copy seed db/migrations ops/launchd ops/sandbox ops/scripts ops/release targets
for profile in assistant reconciler unconfined; do
  [ -f "$stage/ops/sandbox/$profile.sb" ] || { echo "pack-runtime: ops/sandbox/$profile.sb did not make it into the pack — the launchd shape's confined children could not start" >&2; exit 1; }
done

# 3. every workspace package: its manifest, its package.json, its build output.
#    src/, tests and tsconfigs are deliberately left out — a release is
#    compiled output, not a checkout.
for d in apps/* packages/* plugins/*; do
  [ -f "$d/package.json" ] || continue
  copy "$d/package.json" "$d/manifest.yaml" "$d/dist" "$d/README.md"
done
copy apps/console/web packages/cli/seed
copy packages/mcp-apple-fm/helper packages/mcp-eventkit/helper packages/mcp-live-capture/helper

# 4. collectors/ and routines/ are one workspace package each whose
#    SUBDIRECTORIES are the manifests doctor walks and the runner reads
copy collectors routines

# node_modules/, tests and build metadata never ship inside the pack
find "$stage" \( -name node_modules -o -name test -o -name '*.tsbuildinfo' \) -prune -exec rm -rf {} + 2>/dev/null || true

built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
commit="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
cat > "$stage/metistry-runtime.json" <<JSON
{
  "version": "$version",
  "target": "$target",
  "built_at": "$built_at",
  "commit": "$commit",
  "contents": "built product: apps/*/dist, packages/*/dist, seed/, collectors/, routines/, targets/, db/migrations, ops/, docker-compose.yml, package manifests, pnpm-lock.yaml",
  "docs": "docs/ops/releases.md"
}
JSON

# 5. production dependencies, so the pack runs as unpacked (the desktop app
#    bundles it as a resource: no Homebrew, no pnpm install on first run)
if [ "${METISTRY_PACK_DEPS:-1}" = "1" ]; then
  ( cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-scripts --reporter=silent )
  # 6. the pack's own doctor validates the pack's own manifests — the packed
  #    core's schema against the packed collectors/, routines/ and targets/ —
  #    before it can become a release asset (check-pack-manifests.mjs)
  node "$root/ops/release/check-pack-manifests.mjs" "$stage"
else
  echo "pack-runtime: METISTRY_PACK_DEPS=0 — no node_modules in the pack, so its manifests are not validated here" >&2
fi

tarball="$outdir/metistry-runtime-$version-$target.tar.gz"
rm -f "$tarball"
tar -czf "$tarball" -C "$stage_root" "metistry-$version"
echo "$tarball"
