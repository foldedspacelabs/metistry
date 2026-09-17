---
"@foldedspacelabs/metistry-cli": patch
---

**The darwin runtime pack builds again.** The release job that builds the signed TCC helpers moves to the `macos-26` image: the Apple FM helper imports FoundationModels and guards on macOS 26.4, so it needs the 26.4 SDK, which no older image carries. Both helpers now pin their own deployment floor (`arm64-apple-macos26.0` for Apple FM, `arm64-apple-macos14.0` for EventKit) so a helper built on a newer runner still launches on the Mac it ships to. 0.8.0's darwin pack never built; this is the fix that lets 0.8.1 ship it.
