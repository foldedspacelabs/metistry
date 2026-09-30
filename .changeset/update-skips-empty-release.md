---
"@foldedspacelabs/metistry-cli": patch
---

**`metistry update` installs the newest release that has a runtime pack.** An unpinned update no longer takes GitHub's Latest blindly: when Latest carries no runtime pack for this platform (or no `checksums.txt`) — as v0.15.0 does, published immutable with no assets after its workflow failed — it walks the last 10 releases, drafts and prereleases skipped, newest version first, installs the newest that has both, and prints one line per release it passed over (`v0.15.0 has no pack for darwin-arm64 — installing v0.14.4`). It never downgrades (`already on the newest release with a pack`), fails only when none of the 10 has a pack, and `--version X` still means exactly X.
