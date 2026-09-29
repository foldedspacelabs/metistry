---
"@foldedspacelabs/metistry-artifacts": patch
"@foldedspacelabs/metistry-cli": patch
"@foldedspacelabs/metistry-connections": patch
"@foldedspacelabs/metistry-core": patch
"@foldedspacelabs/metistry-mcp-apple-fm": patch
"@foldedspacelabs/metistry-mcp-brain": patch
"@foldedspacelabs/metistry-mcp-eventkit": patch
"@foldedspacelabs/metistry-mcp-live-capture": patch
"@foldedspacelabs/metistry-queries": patch
"@foldedspacelabs/metistry-tasks": patch
---

**Releases publish from the public repository again.** Every published package's `package.json` names its source (`repository` with `directory`, plus `homepage` and `bugs`), which npm's provenance check requires — v0.15.0 published nothing to npm for want of it. The release workflow now builds each GitHub release as a draft with every asset and publishes it only then, so immutable releases no longer refuse the assets; a failed Mac app holds the release as a draft instead of freezing it without the DMG; an npm provenance rejection fails the run instead of passing as a skip; and a malformed `APPLE_API_KEY_P8` is refused naming the format it must be (the raw `.p8` file, BEGIN/END lines included). Metadata and release tooling only; no runtime behaviour changes.
