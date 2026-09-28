#!/bin/sh
# Compile the live-capture helper: the kit (helper/sources/kit — every
# decision) and the adapters that move audio (helper/sources/helper — Core
# Audio's process tap, the microphone, SpeechTranscriber, the socket).
#
#   helper/build/lc-helper      (or the path given as $1)
#
# A bare, unsigned executable: it proves the helper builds against the SDK.
# The minimal .app bundle TCC keys a grant on, the usage strings
# (NSAudioCaptureUsageDescription, NSMicrophoneUsageDescription), stable
# Developer ID signing and the launchd job are T8-2b's, copied from
# packages/mcp-eventkit/scripts/build-helper.sh — until then this binary can
# be built and run for `check`, and cannot be granted anything.
set -eu
cd "$(dirname -- "$0")/.."

OUT="${1:-helper/build/lc-helper}"
mkdir -p "$(dirname -- "$OUT")"
# -target pins the floor to the Mac app's own (macOS 14); everything newer is
# behind #available (the process tap 14.2, bundle-ID taps and the
# transcriber 26).
swiftc -O -target "$(uname -m)-apple-macos14.0" \
  -framework Foundation -framework AppKit -framework AVFoundation -framework CoreAudio \
  -framework CoreGraphics -framework CoreMedia -framework Speech \
  helper/sources/kit/*.swift helper/sources/helper/*.swift -o "$OUT"
echo "built: $OUT"
