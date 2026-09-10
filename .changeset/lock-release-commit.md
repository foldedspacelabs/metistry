---
"@foldedspacelabs/metistry-cli": patch
---

`metistry update --channel release` now pins `metistry.lock`'s
`product.commit` to the commit the installed runtime pack was actually
built from, read from that pack's own `metistry-runtime.json` — release
mode never does a git pull, so there was no HEAD to read, and the lock
previously kept whatever commit the prior release had pinned even after a
version bump. A pack built before this field shipped (0.3.0, 0.3.1) falls
back to the prior lock's commit rather than fabricating one.
