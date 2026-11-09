# shellcheck shell=bash
# What the two pack builds share — `ops/release/build-runtime-deps.sh` (the
# bundled runtime) and `ops/release/build-remote-packs.sh` (the provider tool
# packs, plan §2.23 / X-112): the pinned download, the Mach-O helpers, and
# THE SIGNING RULE. One copy, so a provider pack cannot drift from the rule
# the runtime pack is held to (docs/ops/bundled-runtime.md, "Signing"):
#
#   codesign --force --options runtime --timestamp \
#     --identifier <prefix>.<name> \
#     [--entitlements <what it came with, minus get-task-allow>] \
#     --sign "$METISTRY_SIGN_IDENTITY" <file>
#
# Sourced, never run. The caller defines before sourcing:
#   dl    the download directory `fetch` caches into
#   say   a line of progress (stderr)
#   die   print and exit 1

# ---- fetch --------------------------------------------------------------------
# Download once into $dl, and refuse anything whose sha256 is not the pin
# (ops/release/runtime-versions.env). A mirror that serves different bytes
# fails the build rather than shipping inside Metistry.

fetch() { # <url> <file> <sha256>
  # shellcheck disable=SC2154  # $dl is the caller's (the contract above)
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

# Debug symbols are most of the size and none of the value in a shipped tree.
# Always BEFORE signing: stripping invalidates a signature.
strip_tree() { # <prefix>
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if is_dylib "$f"; then strip -S "$f" 2>/dev/null || true; else strip -S -x "$f" 2>/dev/null || true; fi
  done < <(machos "$1")
}

# ---- signing ---------------------------------------------------------------------
# Entitlements are CARRIED OVER, minus get-task-allow. Node's official binary
# is signed with the hardened runtime plus allow-jit,
# allow-unsigned-executable-memory, disable-library-validation and friends —
# V8 cannot run without the first two — and with get-task-allow, which
# notarization rejects (the v0.4.0 lesson, ops/release/build-app.sh). Signing
# it with `--options runtime` and NO entitlements produces a node that dies
# at startup. Postgres, git and the Go binaries carry none and get none.

codesign_retry() { # Apple's timestamp server flakes now and then; one flake must not cost a build
  local attempt
  for attempt in 1 2 3; do
    codesign "$@" 2>/dev/null && return 0
    say "  codesign failed (attempt $attempt/3) — retrying in 5s"
    sleep 5
  done
  return 1
}

# Sign every Mach-O under <dir> as `<prefix>.<file name>` with
# METISTRY_SIGN_IDENTITY — the caller has already decided the identity is set.
# Prints the count; a codesign that actually fails is a build failure.
sign_machos() { # <dir> <identifier prefix>
  local dir="$1" prefix="$2" id="${METISTRY_SIGN_IDENTITY:?sign_machos needs METISTRY_SIGN_IDENTITY}" f name signed=0 ents ent_args
  ents="$(mktemp -t pack-ents)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    name="$(basename "$f" | tr -c 'A-Za-z0-9.-' '-')"
    ent_args=()
    if codesign -d --entitlements :- "$f" 2>/dev/null > "$ents" && [ -s "$ents" ] && plutil -lint -s "$ents" >/dev/null 2>&1; then
      plutil -remove 'com\.apple\.security\.get-task-allow' "$ents" >/dev/null 2>&1 || true
      if [ "$(plutil -p "$ents" | grep -c '=>')" -gt 0 ]; then ent_args=(--entitlements "$ents"); fi
    fi
    codesign_retry --force --options runtime --timestamp \
      --identifier "$prefix.$name" \
      ${ent_args[@]+"${ent_args[@]}"} \
      --sign "$id" "$f" || die "codesign failed for $f"
    signed=$((signed + 1))
  done < <(machos "$dir")
  rm -f "$ents"
  say "signed $signed Mach-O files as $prefix.<name>"
}

# The team id behind METISTRY_SIGN_IDENTITY (a SHA-1 hash or a name), read
# from the keychain the release job imported it into (METISTRY_KEYCHAIN) —
# the same lookup ops/release/build-app.sh makes before its audit.
signing_team() {
  local id="${METISTRY_SIGN_IDENTITY:?}" team
  team="$(security find-identity -v -p codesigning ${METISTRY_KEYCHAIN:+"$METISTRY_KEYCHAIN"} 2>/dev/null | grep -F "$id" | grep -oE '\([A-Z0-9]{10}\)' | head -1 | tr -d '()')" || true
  [ -n "$team" ] || die "could not read the team id behind identity $id"
  printf '%s' "$team"
}

# The proof that the rule held: EVERY Mach-O under <dir> carries the
# identity's team, the hardened runtime and a secure timestamp — the same
# three facts the DMG audit demands of what it embeds. One miss fails the
# build; a pack with an unsigned binary in it is never an asset.
verify_signed() { # <dir>
  local dir="$1" team f info n=0 bad=0
  team="$(signing_team)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    info="$(codesign -dvv "$f" 2>&1 || true)"
    if ! printf '%s' "$info" | grep -q "^TeamIdentifier=$team\$" \
      || ! printf '%s' "$info" | grep -q 'flags=.*runtime' \
      || ! printf '%s' "$info" | grep -q '^Timestamp='; then
      say "  NOT signed with the release identity: ${f#"$dir"/}"
      bad=$((bad + 1))
    fi
  done < <(machos "$dir")
  [ "$bad" -eq 0 ] || die "$bad of $n Mach-O files under $dir are not signed as team $team with the hardened runtime and a secure timestamp"
  say "verified: all $n Mach-O files are signed as team $team (hardened runtime, secure timestamp)"
}
