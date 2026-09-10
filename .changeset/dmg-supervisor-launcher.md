---
"@foldedspacelabs/metistry-cli": patch
---

The Mac app DMG builds again: the bundled supervisor launcher lives in
`Contents/Resources/` rather than `Contents/MacOS/`, where codesign demands
a nested signature a shell script cannot carry (v0.7.0's DMG job failed
sealing the app on it).
