#!/bin/sh
# Compile the helper's kit (helper/sources/kit — every decision the helper
# makes) with its tests (helper/tests) into one executable and run it. No
# Package.swift and no XCTest: the kit is plain Foundation, the harness is
# helper/tests/harness.swift, and the fakes stand in for Core Audio, the
# microphone and the transcriber — so this touches no audio device and no
# TCC grant, and runs anywhere swiftc does.
#
# Output goes to a temp dir (or $1), never into the tree.
set -eu
cd "$(dirname -- "$0")/.."

OUT="${1:-$(mktemp -d -t lc-helper-tests)}"
mkdir -p "$OUT"
swiftc -O -target "$(uname -m)-apple-macos14.0" -framework Foundation \
  helper/sources/kit/*.swift helper/tests/*.swift -o "$OUT/lc-helper-tests"
"$OUT/lc-helper-tests"
