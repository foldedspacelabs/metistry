#!/bin/zsh
# PoC-9 build. The embedded __TEXT,__info_plist section is what lets a bare CLI
# binary present a TCC consent prompt (usage-description strings must be there).
set -e
D=${0:a:h}
swiftc -O \
  -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$D/res/Info.plist" \
  -o "$D/ekpoc" "$D/ekpoc.swift"
codesign --force --sign - --identifier com.metistry.poc9.ekpoc "$D/ekpoc"
echo "built $D/ekpoc"
codesign -dvv "$D/ekpoc" 2>&1 | sed 's/^/  /'
