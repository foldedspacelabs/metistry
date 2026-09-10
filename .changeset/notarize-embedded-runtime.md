---
"@foldedspacelabs/metistry-cli": patch
---

The Mac app DMG notarizes: `build-app.sh` re-signs every Mach-O it embeds
from the runtime packs under the Developer ID (hardened runtime, timestamp,
`get-task-allow` stripped from Node's entitlements) and audits the bundle
before packaging; `notarize.sh` reads Apple's status instead of trusting
`notarytool`'s exit code, and prints the submission log when it is not
Accepted. Signing retries through Apple's timestamp-server flakes.
