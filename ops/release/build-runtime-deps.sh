#!/usr/bin/env bash
# Build the BUNDLED RUNTIME — `runtime/` — everything a Mac needs to run
# Metistry that is not the product itself: Node, Postgres 17 + pgvector, git,
# and llama.cpp's `llama-server` (the no-install local model provider). The
# Mac app ships this inside
# `Metistry.app/Contents/Resources/metistry/runtime/`, and `metistry up`
# already resolves `<product>/runtime/postgres/bin` ahead of Homebrew
# (packages/cli/src/postgres.ts). Design: docs/product/desktop-app-plan.md
# "Bundled runtime" (ratified 2026-09-09); operator notes:
# docs/ops/bundled-runtime.md.
#
#   ops/release/build-runtime-deps.sh [<outdir>]
#   ops/release/build-runtime-deps.sh [<outdir>] --only llamacpp
#
# `--only <component>` is a development aid: build and verify ONE component
# and stop, so a change to (say) the llama.cpp flags is provable in minutes
# instead of behind a Postgres-from-source compile. It assembles nothing,
# signs nothing and writes no manifest — a release build is the whole run.
#
# macOS arm64 only (the `runtime-deps (darwin-arm64)` release job). Every
# version and every source digest is pinned in ops/release/runtime-versions.env
# — one place, and a tarball that does not match its pin fails the build.
#
# The result is RELOCATABLE: Postgres is configured --disable-rpath and then
# has its install names rewritten to `@rpath` with an `@executable_path/../lib`
# rpath added, git is built RUNTIME_PREFIX=1, and both are verified from a
# MOVED copy of the tree before this script exits. Nothing is installed into
# the system, into Homebrew, or anywhere outside <outdir> and the work dir.
#
# Env:
#   METISTRY_RUNTIME_WORK   downloads + build trees + the per-version cache
#                           (default <repo>/.runtime-build). CI caches
#                           $METISTRY_RUNTIME_WORK/cache, keyed on
#                           runtime-versions.env, so a later run only
#                           re-assembles, signs and verifies.
#   METISTRY_SIGN_IDENTITY  a Developer ID Application identity. Set → every
#                           Mach-O is `codesign --force --options runtime
#                           --timestamp`ed as
#                           com.foldedspacelabs.metistry.runtime.<name>, with
#                           the entitlements it came with carried over minus
#                           get-task-allow (Node needs its JIT exceptions;
#                           notarization refuses get-task-allow).
#                           Unset → skipped with a notice. A missing identity
#                           is NEVER a build failure (docs/ops/apple-signing.md).
#   METISTRY_RUNTIME_JOBS   make -j (default: hw.ncpu)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=ops/release/runtime-versions.env
. "$root/ops/release/runtime-versions.env"

only=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="${2:-}"; shift 2 || die "--only needs a component name" ;;
    --only=*) only="${1#--only=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

out="${1:-$root/runtime}"
work="${METISTRY_RUNTIME_WORK:-$root/.runtime-build}"
dl="$work/dl"
cache="$work/cache"
build="$work/build"
jobs="${METISTRY_RUNTIME_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
started="$(date -u +%s)"

log() { printf '\n== %s\n' "$*" >&2; }
say() { printf '   %s\n' "$*" >&2; }
die() { printf 'build-runtime-deps: %s\n' "$*" >&2; exit 1; }
secs_since() { echo $(($(date -u +%s) - $1)); }

[ "$(uname -s)" = "Darwin" ] || die "macOS only (this host is $(uname -s)); the release job is macos-14"
[ "$(uname -m)" = "arm64" ] || die "darwin-arm64 only (this host is $(uname -m))"
command -v clang >/dev/null || die "no clang — install the Xcode Command Line Tools (xcode-select --install)"
command -v cmake >/dev/null || die "no cmake — llama.cpp is a CMake project (the macos-14 runner ships one; locally: brew install cmake, or unpack cmake.org's macos-universal tarball and put its CMake.app/Contents/bin on PATH)"

mkdir -p "$dl" "$cache" "$build"

# What the source builds give up, recorded here so the manifest and the docs
# cannot drift from the flags below. macOS ships no ICU headers, readline or
# gettext outside Homebrew and this script installs nothing, so each of these
# is a deliberate omission rather than an accident.
PG_DISABLED="icu (--without-icu: no ICU collations; initdb runs --locale=C), readline (--without-readline: psql has no line editing or history), rpath (--disable-rpath: install names are rewritten to @rpath instead), openssl (not linked: the launchd shape listens on loopback and a unix socket only)"
GIT_DISABLED="gettext (NO_GETTEXT=1: English messages only), tcl/tk (NO_TCLTK=1: no gitk or git gui), perl (NO_PERL=1: no git add -p, git svn, git send-email), python (NO_PYTHON=1)"
# Three of these four are RELOCATABILITY requirements, not preferences: each
# names a find_package() that would happily link a Homebrew dylib on a runner
# that happens to have one, and a runtime/ that needs /opt/homebrew is not a
# bundled runtime. The fourth keeps the build hermetic.
LLAMACPP_DISABLED="openssl (-DLLAMA_OPENSSL=OFF: no HTTPS in the server, so no Homebrew libssl gets linked in; the CLI downloads GGUFs itself), openmp (-DGGML_OPENMP=OFF: same reason, Homebrew libomp), the web UI (-DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF: the prebuilt UI is an UNPINNED Hugging Face download at build time, and the app owns this UX), tools and examples other than the server (-DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_APP=OFF)"

PG_BASE_URL="https://ftp.postgresql.org/pub/source"
GIT_BASE_URL="https://mirrors.edge.kernel.org/pub/software/scm/git"

# ---- fetch --------------------------------------------------------------------
# Download once into $dl, and refuse anything whose sha256 is not the pin.

fetch() { # <url> <file> <sha256>
  local url="$1" file="$dl/$2" want="$3" got
  if [ -f "$file" ]; then
    got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    if [ "$got" = "$want" ]; then say "$2: cached, sha256 ok"; return 0; fi
    say "$2: the cached copy has the wrong digest — re-downloading"
    rm -f "$file"
  fi
  say "downloading $2"
  curl -fsSL --retry 3 --retry-delay 2 -o "$file.part" "$url" || die "download failed: $url"
  got="$(shasum -a 256 "$file.part" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    rm -f "$file.part"
    die "$2 sha256 mismatch
  expected $want   (ops/release/runtime-versions.env)
  got      $got   from $url"
  fi
  mv "$file.part" "$file"
  say "$2: sha256 ok"
}

# ---- Mach-O helpers -----------------------------------------------------------
# `file` is the arbiter, per the signing contract: a shell script in bin/ is
# not a Mach-O and must be neither stripped nor signed.

machos() { # <dir> — one path per line
  find "$1" -type f -print0 2>/dev/null | xargs -0 file 2>/dev/null | awk -F': ' '/Mach-O/ {print $1}'
}

is_dylib() { file "$1" | grep -q 'dynamically linked shared library'; }

# Rewrite one prefix's Mach-Os so the tree resolves its own libraries wherever
# it is unpacked: absolute $prefix/lib/... dependencies become @rpath/..., each
# dylib announces itself as @rpath/<name>, and every binary carries the rpath
# that finds them relative to itself.
relocate() { # <prefix>
  local prefix="$1" f dep base rel dir depth up
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base="$(basename "$f")"
    if is_dylib "$f"; then install_name_tool -id "@rpath/$base" "$f" 2>/dev/null || true; fi
    while IFS= read -r dep; do
      case "$dep" in "$prefix"/*) install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f" 2>/dev/null || true ;; esac
    done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
    # how far below $prefix this file sits, so bin/ and libexec/git-core/ both
    # get an rpath that lands on $prefix/lib
    rel="${f#"$prefix"/}"
    dir="${rel%/*}"
    depth="$(printf '%s' "$dir" | awk -F/ '{print NF}')"
    up=""
    for _ in $(seq 1 "$depth"); do up="../$up"; done
    if is_dylib "$f"; then
      install_name_tool -add_rpath "@loader_path" "$f" 2>/dev/null || true
      install_name_tool -add_rpath "@loader_path/${up}lib" "$f" 2>/dev/null || true
    else
      install_name_tool -add_rpath "@executable_path/${up}lib" "$f" 2>/dev/null || true
      install_name_tool -add_rpath "@loader_path/${up}lib" "$f" 2>/dev/null || true
    fi
  done < <(machos "$prefix")
}

# Debug symbols are most of the size and none of the value in a shipped tree.
# Always BEFORE signing: stripping invalidates a signature.
strip_tree() { # <prefix>
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if is_dylib "$f"; then strip -S "$f" 2>/dev/null || true; else strip -S -x "$f" 2>/dev/null || true; fi
  done < <(machos "$1")
}

# ---- Node ---------------------------------------------------------------------
# The official darwin-arm64 build, verified against BOTH the pin and that
# release's own SHASUMS256.txt. Nothing is compiled, and the binary keeps the
# Node Foundation's own Developer ID signature unless we re-sign it — so it is
# never stripped.

build_node() {
  local prefix="$cache/node-$NODE_VERSION" tarball="node-v$NODE_VERSION-darwin-arm64.tar.gz" t0
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "node $NODE_VERSION: cached"; return 0; fi
  log "node $NODE_VERSION"
  say "cross-checking nodejs.org's SHASUMS256.txt for this release"
  curl -fsSL --retry 3 -o "$dl/node-SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
    || die "could not fetch SHASUMS256.txt for node v$NODE_VERSION"
  grep -q "^$NODE_SHA256  $tarball\$" "$dl/node-SHASUMS256.txt" \
    || die "NODE_SHA256 is not what nodejs.org publishes for $tarball — refusing to bundle it"
  say "SHASUMS256.txt agrees with the pin"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/$tarball" "$tarball" "$NODE_SHA256"

  rm -rf "$prefix" "$build/node"
  mkdir -p "$build/node" "$prefix/bin" "$prefix/lib"
  tar -xzf "$dl/$tarball" -C "$build/node" --strip-components=1
  # node, npm and npx (bridges run as `npx @foldedspacelabs/metistry-mcp-*`),
  # and the licence. Headers, man pages and the changelog are not runtime.
  cp "$build/node/bin/node" "$prefix/bin/node"
  cp -R "$build/node/lib/node_modules" "$prefix/lib/node_modules"
  ( cd "$prefix/bin" && ln -sf ../lib/node_modules/npm/bin/npm-cli.js npm && ln -sf ../lib/node_modules/npm/bin/npx-cli.js npx )
  cp "$build/node/LICENSE" "$prefix/LICENSE"
  rm -rf "$build/node"
  echo "$NODE_VERSION" > "$prefix/.done"
  say "node staged in $(secs_since "$t0")s"
}

# ---- Postgres 17 + pgvector ----------------------------------------------------

build_postgres() {
  local prefix="$cache/postgres-$PG_VERSION-pgvector-$PGVECTOR_VERSION" t0
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "postgres $PG_VERSION + pgvector $PGVECTOR_VERSION: cached"; return 0; fi
  log "postgres $PG_VERSION + pgvector $PGVECTOR_VERSION"
  fetch "$PG_BASE_URL/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" "postgresql-$PG_VERSION.tar.bz2" "$PG_SHA256"
  fetch "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" "pgvector-$PGVECTOR_VERSION.tar.gz" "$PGVECTOR_SHA256"

  rm -rf "$prefix" "$build/postgres" "$build/pgvector"
  mkdir -p "$build/postgres" "$build/pgvector"
  tar -xjf "$dl/postgresql-$PG_VERSION.tar.bz2" -C "$build/postgres" --strip-components=1
  tar -xzf "$dl/pgvector-$PGVECTOR_VERSION.tar.gz" -C "$build/pgvector" --strip-components=1

  say "configure (--disable-rpath --without-icu --without-readline)"
  ( cd "$build/postgres" && ./configure \
      --prefix="$prefix" \
      --disable-rpath \
      --without-icu \
      --without-readline \
      --with-zlib \
      >"$build/postgres-configure.log" 2>&1 ) || { tail -30 "$build/postgres-configure.log" >&2; die "postgres configure failed"; }
  say "make -j$jobs"
  ( cd "$build/postgres" && make -j"$jobs" >"$build/postgres-make.log" 2>&1 ) || { tail -30 "$build/postgres-make.log" >&2; die "postgres build failed"; }
  ( cd "$build/postgres" && make install >>"$build/postgres-make.log" 2>&1 ) || { tail -30 "$build/postgres-make.log" >&2; die "postgres install failed"; }

  say "pgvector against $prefix/bin/pg_config"
  ( cd "$build/pgvector" && make -j"$jobs" PG_CONFIG="$prefix/bin/pg_config" >"$build/pgvector-make.log" 2>&1 \
      && make install PG_CONFIG="$prefix/bin/pg_config" >>"$build/pgvector-make.log" 2>&1 ) \
    || { tail -30 "$build/pgvector-make.log" >&2; die "pgvector build failed"; }
  [ -f "$prefix/share/extension/vector.control" ] || die "pgvector installed no share/extension/vector.control"

  # doc/ and include/ are not runtime. share/ and lib/ stay: the server finds
  # them relative to its own executable, which is what makes the tree movable.
  rm -rf "$prefix/doc" "$prefix/include" "$prefix/share/doc" "$prefix/share/man"
  say "strip + rewrite install names"
  strip_tree "$prefix"
  relocate "$prefix"
  echo "$PG_VERSION+$PGVECTOR_VERSION" > "$prefix/.done"
  say "postgres built in $(secs_since "$t0")s"
}

# ---- git ------------------------------------------------------------------------

build_git() {
  local prefix="$cache/git-$GIT_VERSION" t0
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "git $GIT_VERSION: cached"; return 0; fi
  log "git $GIT_VERSION"
  fetch "$GIT_BASE_URL/git-$GIT_VERSION.tar.gz" "git-$GIT_VERSION.tar.gz" "$GIT_SHA256"

  rm -rf "$prefix" "$build/git"
  mkdir -p "$build/git"
  tar -xzf "$dl/git-$GIT_VERSION.tar.gz" -C "$build/git" --strip-components=1

  # RUNTIME_PREFIX makes git find its own exec path, templates and system
  # config relative to argv[0] (Darwin: _NSGetExecutablePath) — a prefix baked
  # in at build time would be the CI runner's. NO_INSTALL_HARDLINKS installs
  # the builtins as SYMLINKS: a hardlinked builtin becomes a second full copy
  # the moment codesign rewrites the file.
  say "make -j$jobs (RUNTIME_PREFIX=1; no gettext/tcltk/perl/python)"
  ( cd "$build/git" && make -j"$jobs" \
      prefix="$prefix" \
      RUNTIME_PREFIX=1 \
      NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 \
      NO_INSTALL_HARDLINKS=1 \
      install >"$build/git-make.log" 2>&1 ) || { tail -30 "$build/git-make.log" >&2; die "git build failed"; }

  rm -rf "$prefix/share/man" "$prefix/share/doc"
  say "strip + rewrite install names"
  strip_tree "$prefix"
  relocate "$prefix"
  echo "$GIT_VERSION" > "$prefix/.done"
  say "git built in $(secs_since "$t0")s"
}

# ---- llama.cpp (llama-server) ----------------------------------------------------
# The no-install local model provider: ONE Metal-enabled binary, so a fresh
# Mac can run a local model without being sent to install a second app. LM
# Studio and Ollama stay peers — `metistry compute models list` discovers all
# three over /v1/models — this is only what is there when none of them is.
#
# BUILD_SHARED_LIBS=OFF on purpose: a static llama-server has no dylibs to
# relocate, no @rpath to get wrong, and is one file to sign. (relocate() and
# strip_tree() still run over the prefix, so flipping this back would be a
# flag change rather than a rewrite.) GGML_METAL_EMBED_LIBRARY=ON is the
# other half of that: without it the binary looks for a default.metallib
# beside itself and a moved copy has no GPU.

build_llamacpp() {
  local prefix="$cache/llamacpp-$LLAMACPP_VERSION" src="$build/llamacpp" b="$build/llamacpp-build" t0
  t0="$(date -u +%s)"
  if [ -f "$prefix/.done" ]; then say "llama.cpp $LLAMACPP_VERSION: cached"; return 0; fi
  log "llama.cpp $LLAMACPP_VERSION (llama-server, Metal)"
  fetch "https://github.com/ggml-org/llama.cpp/archive/refs/tags/v$LLAMACPP_VERSION.tar.gz" "llama.cpp-$LLAMACPP_VERSION.tar.gz" "$LLAMACPP_SHA256"

  rm -rf "$prefix" "$src" "$b"
  mkdir -p "$src" "$prefix/bin"
  tar -xzf "$dl/llama.cpp-$LLAMACPP_VERSION.tar.gz" -C "$src" --strip-components=1

  # BUILD_IS_DEV=OFF is what upstream says to set when building from a
  # release tag, and the COMMIT is stated rather than discovered: llama.cpp
  # asks `git rev-parse HEAD` in its source dir, and with the default work dir
  # inside this repo that is METISTRY's commit stamped into llama-server.
  say "cmake configure (Metal on, static, no openssl/openmp/web UI)"
  cmake -S "$src" -B "$b" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 \
    -DLLAMA_BUILD_IS_DEV=OFF \
    -DLLAMA_BUILD_NUMBER=0 \
    -DLLAMA_BUILD_COMMIT="v$LLAMACPP_VERSION" \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_OPENMP=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TOOLS=ON \
    -DLLAMA_BUILD_APP=OFF \
    -DLLAMA_BUILD_UI=OFF \
    -DLLAMA_USE_PREBUILT_UI=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    >"$build/llamacpp-configure.log" 2>&1 || { tail -30 "$build/llamacpp-configure.log" >&2; die "llama.cpp configure failed"; }
  # the SERVER TARGET only: llama-cli, quantize and the rest are another ten
  # minutes of compile for binaries nothing in this product spawns
  say "cmake --build --target llama-server -j$jobs"
  cmake --build "$b" --target llama-server --config Release -j"$jobs" \
    >"$build/llamacpp-make.log" 2>&1 || { tail -30 "$build/llamacpp-make.log" >&2; die "llama.cpp build failed"; }

  [ -x "$b/bin/llama-server" ] || die "llama.cpp built no bin/llama-server"
  cp "$b/bin/llama-server" "$prefix/bin/llama-server"
  # a static build leaves nothing here, but the layout is the promise
  for f in "$b"/bin/*.dylib; do [ -e "$f" ] || continue; mkdir -p "$prefix/lib"; cp "$f" "$prefix/lib/"; done
  cp "$src/LICENSE" "$prefix/LICENSE"
  rm -rf "$src" "$b"

  say "strip + rewrite install names"
  strip_tree "$prefix"
  relocate "$prefix"
  echo "$LLAMACPP_VERSION" > "$prefix/.done"
  say "llama.cpp built in $(secs_since "$t0")s ($(du -sh "$prefix" | cut -f1))"
}

# The moved-copy check for llama-server, factored out so `--only llamacpp`
# runs exactly what the full `verify` runs. `--list-devices` enumerates the
# ggml backends: it is the cheapest thing that proves BOTH that the binary
# runs from somewhere it was not built AND that the Metal backend registered
# — a binary whose embedded metallib was lost lists CPU alone.
verify_llamacpp() { # <prefix>
  local prefix="$1" devices
  say "llama-server $("$prefix/bin/llama-server" --version 2>&1 | head -1)"
  devices="$("$prefix/bin/llama-server" --list-devices 2>&1 || true)"
  printf '%s\n' "$devices" | sed 's/^/      /' >&2
  # the Metal backend registers its device as MTL<n> ("MTL0: Apple M4 Max"),
  # not as the word "metal" — a CPU/BLAS-only list is the failure this catches
  printf '%s' "$devices" | grep -q 'MTL[0-9]' || die "llama-server --list-devices lists no MTL<n> device from the moved copy — the Metal backend did not register (GGML_METAL_EMBED_LIBRARY?):
$devices"
}

# ---- assemble -------------------------------------------------------------------

assemble() {
  log "assembling $out"
  rm -rf "$out"
  mkdir -p "$out"
  cp -R "$cache/node-$NODE_VERSION" "$out/node"
  cp -R "$cache/postgres-$PG_VERSION-pgvector-$PGVECTOR_VERSION" "$out/postgres"
  cp -R "$cache/git-$GIT_VERSION" "$out/git"
  cp -R "$cache/llamacpp-$LLAMACPP_VERSION" "$out/llamacpp"
  rm -f "$out"/*/.done
  # the layout packages/cli/src/postgres.ts and docs/ops/deployment-shapes.md
  # both promise; a missing one is a broken bundle, not a warning
  for b in postgres initdb psql createdb pg_isready pg_ctl pg_dump pg_restore; do
    [ -x "$out/postgres/bin/$b" ] || die "runtime/postgres/bin/$b is missing"
  done
  [ -f "$out/postgres/share/extension/vector.control" ] || die "runtime/postgres/share/extension/vector.control is missing"
  [ -x "$out/node/bin/node" ] || die "runtime/node/bin/node is missing"
  [ -x "$out/git/bin/git" ] || die "runtime/git/bin/git is missing"
  [ -x "$out/llamacpp/bin/llama-server" ] || die "runtime/llamacpp/bin/llama-server is missing"
  say "$(du -sh "$out" | cut -f1) in $out"
}

# ---- signing ---------------------------------------------------------------------
# Unset is a notice, never a failure; a codesign that actually fails is.
#
# Entitlements are CARRIED OVER, minus get-task-allow. Node's official binary
# is signed with the hardened runtime plus allow-jit,
# allow-unsigned-executable-memory, disable-library-validation and friends —
# V8 cannot run without the first two — and with get-task-allow, which
# notarization rejects (the v0.4.0 lesson, ops/release/build-app.sh). Signing
# it with `--options runtime` and NO entitlements produces a node that dies
# at startup. Postgres and git carry none and get none.

codesign_retry() { # Apple's timestamp server flakes now and then; one flake must not cost a build
  local attempt
  for attempt in 1 2 3; do
    codesign "$@" 2>/dev/null && return 0
    say "  codesign failed (attempt $attempt/3) — retrying in 5s"
    sleep 5
  done
  return 1
}

sign() {
  local id="${METISTRY_SIGN_IDENTITY:-}" f name signed=0 ents ent_args
  if [ -z "$id" ]; then
    log "signing: skipped"
    say "METISTRY_SIGN_IDENTITY is unset — every Mach-O keeps the signature it came with"
    say "(Node's own Developer ID for node; ad-hoc for what was compiled here). The DMG job re-signs what it embeds."
    return 0
  fi
  log "signing every Mach-O as \"$id\""
  ents="$(mktemp -t runtime-ents)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    name="$(basename "$f" | tr -c 'A-Za-z0-9.-' '-')"
    ent_args=()
    if codesign -d --entitlements :- "$f" 2>/dev/null > "$ents" && [ -s "$ents" ] && plutil -lint -s "$ents" >/dev/null 2>&1; then
      plutil -remove 'com\.apple\.security\.get-task-allow' "$ents" >/dev/null 2>&1 || true
      if [ "$(plutil -p "$ents" | grep -c '=>')" -gt 0 ]; then ent_args=(--entitlements "$ents"); fi
    fi
    codesign_retry --force --options runtime --timestamp \
      --identifier "com.foldedspacelabs.metistry.runtime.$name" \
      ${ent_args[@]+"${ent_args[@]}"} \
      --sign "$id" "$f" || die "codesign failed for $f"
    signed=$((signed + 1))
  done < <(machos "$out")
  rm -f "$ents"
  say "signed $signed Mach-O files"
  # the proof that matters: the signed node still runs (a JIT-less hardened node does not)
  "$out/node/bin/node" -e 'process.exit(0)' || die "signed node does not start — entitlements were lost"
  codesign -d --entitlements :- "$out/node/bin/node" 2>/dev/null | grep -q 'get-task-allow' && die "signed node still carries get-task-allow"
  say "signed node starts, without get-task-allow"
}

# ---- verification: from a MOVED copy ----------------------------------------------
# The test that matters. A tree that only works where it was built is not a
# bundled runtime — it is a Homebrew install with extra steps.

verify() {
  log "verifying a MOVED copy (relocatability)"
  local moved="$work/verify/runtime" data sock repo t0
  t0="$(date -u +%s)"
  rm -rf "$work/verify"
  mkdir -p "$work/verify"
  cp -R "$out" "$moved"
  data="$work/verify/pgdata"
  # a unix socket path over ~103 bytes is silently unusable and $work can be
  # deep, so the socket goes somewhere short (the same trap `metistry up` checks)
  sock="$(mktemp -d "${TMPDIR:-/tmp}/mrt.XXXXXX")"

  say "node $("$moved/node/bin/node" --version)"

  say "initdb"
  "$moved/postgres/bin/initdb" -D "$data" -U metistry --auth-local=trust --auth-host=trust \
    --encoding=UTF8 --locale=C -N >"$work/verify/initdb.log" 2>&1 \
    || { tail -20 "$work/verify/initdb.log" >&2; die "initdb failed from the moved copy"; }

  say "pg_ctl start (unix socket only)"
  "$moved/postgres/bin/pg_ctl" -D "$data" -l "$work/verify/pg.log" -w -t 60 \
    -o "-c listen_addresses='' -c unix_socket_directories=$sock" start >/dev/null 2>&1 \
    || { tail -20 "$work/verify/pg.log" >&2; die "pg_ctl start failed from the moved copy"; }
  # shellcheck disable=SC2064
  trap "'$moved/postgres/bin/pg_ctl' -D '$data' -m immediate stop >/dev/null 2>&1 || true" EXIT

  say "CREATE EXTENSION vector"
  "$moved/postgres/bin/psql" -h "$sock" -U metistry -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE EXTENSION vector' >"$work/verify/psql.log" 2>&1 \
    || { cat "$work/verify/psql.log" >&2; die "CREATE EXTENSION vector failed from the moved copy"; }
  say "vector $("$moved/postgres/bin/psql" -h "$sock" -U metistry -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector'")"

  say "pg_dump"
  "$moved/postgres/bin/pg_dump" -h "$sock" -U metistry -d postgres -s >/dev/null \
    || die "pg_dump failed from the moved copy"

  "$moved/postgres/bin/pg_ctl" -D "$data" -m fast stop >/dev/null 2>&1 || true
  trap - EXIT
  rm -rf "$sock"

  say "git init / add / commit"
  repo="$work/verify/repo"
  mkdir -p "$repo"
  ( cd "$repo" \
    && "$moved/git/bin/git" init -q . \
    && echo hi > a.txt \
    && "$moved/git/bin/git" add a.txt \
    && "$moved/git/bin/git" -c user.name=t -c user.email=t@example.invalid commit -q -m first \
    && [ "$("$moved/git/bin/git" rev-list --count HEAD)" = "1" ] ) \
    || die "git init/commit failed from the moved copy"
  say "git $("$moved/git/bin/git" --version | awk '{print $3}') committed from a moved tree"

  verify_llamacpp "$moved/llamacpp"

  rm -rf "$work/verify"
  say "verified in $(secs_since "$t0")s"
}

# ---- manifest ---------------------------------------------------------------------

manifest() {
  log "runtime/manifest.json"
  local f rel first=1 tmp="$out/.manifest.tmp"
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "target": "darwin-arm64",\n'
    printf '  "built_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "build_seconds": %s,\n' "$(secs_since "$started")"
    printf '  "signed": %s,\n' "$([ -n "${METISTRY_SIGN_IDENTITY:-}" ] && echo true || echo false)"
    printf '  "components": {\n'
    printf '    "node": { "version": "%s", "origin": "nodejs.org official darwin-arm64 build", "source_sha256": "%s" },\n' "$NODE_VERSION" "$NODE_SHA256"
    printf '    "postgres": { "version": "%s", "origin": "built from source", "source_sha256": "%s", "disabled": "%s" },\n' "$PG_VERSION" "$PG_SHA256" "$PG_DISABLED"
    printf '    "pgvector": { "version": "%s", "origin": "built from source against runtime/postgres", "source_sha256": "%s" },\n' "$PGVECTOR_VERSION" "$PGVECTOR_SHA256"
    printf '    "git": { "version": "%s", "origin": "built from source", "source_sha256": "%s", "disabled": "%s" },\n' "$GIT_VERSION" "$GIT_SHA256" "$GIT_DISABLED"
    printf '    "llamacpp": { "version": "%s", "origin": "built from source (CMake, Metal on, static)", "source_sha256": "%s", "disabled": "%s" }\n' "$LLAMACPP_VERSION" "$LLAMACPP_SHA256" "$LLAMACPP_DISABLED"
    printf '  },\n'
    printf '  "binaries": {\n'
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rel="${f#"$out"/}"
      [ $first -eq 1 ] || printf ',\n'
      first=0
      printf '    "%s": "%s"' "$rel" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
    done < <(machos "$out" | sort)
    printf '\n  }\n}\n'
  } > "$tmp"
  mv "$tmp" "$out/manifest.json"
  say "$(machos "$out" | wc -l | tr -d ' ') Mach-O files hashed"
}

# ---- run ----------------------------------------------------------------------------

# `--only <component>`: build one thing and prove it from a MOVED copy, then
# stop. Nothing is assembled, signed or hashed — that is a release build's
# job, and a half-filled runtime/ would be worse than none.
if [ -n "$only" ]; then
  case "$only" in
    llamacpp)
      build_llamacpp
      log "verifying a MOVED copy (relocatability)"
      rm -rf "$work/only"
      mkdir -p "$work/only"
      cp -R "$cache/llamacpp-$LLAMACPP_VERSION" "$work/only/llamacpp"
      rm -f "$work/only/llamacpp/.done"
      verify_llamacpp "$work/only/llamacpp"
      say "$(du -sh "$work/only/llamacpp/bin/llama-server" | cut -f1) llama-server, verified from $work/only/llamacpp"
      ;;
    *) die "--only takes llamacpp (node, postgres and git are proved by a full run)" ;;
  esac
  log "done in $(secs_since "$started")s (--only $only: nothing was assembled, signed or hashed)"
  exit 0
fi

build_node
build_postgres
build_git
build_llamacpp
assemble
sign
verify
manifest

log "done in $(secs_since "$started")s"
say "$out ($(du -sh "$out" | cut -f1))"
