#!/bin/sh
# Build the PoC-19 server. Deliberately simpler than
# packages/mcp-apple-fm/scripts/build-helper.sh: a bare executable, ad-hoc
# signed. apple-fm needs no TCC grant (manifest.yaml: requires_tcc: []), and
# the app-bundle shape in the real script exists for signing/notarization
# continuity, which a scratch binary does not need.
set -eu
cd "$(dirname -- "$0")"
swiftc -O -parse-as-library afm-v1.swift -o afm-v1
codesign --force --sign - afm-v1
echo "built: $(pwd)/afm-v1"
