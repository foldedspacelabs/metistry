---
"@foldedspacelabs/metistry-cli": patch
---

`metistry update --channel release` downloads release assets (the runtime
pack, the runtime-deps pack, `checksums.txt`) through GitHub's authenticated
asset API when `METISTRY_GITHUB_TOKEN` is set — the one path that reads a
private repo's assets with a token; `browser_download_url` 404s there. The
302 to the signed S3 URL is followed without resending the token. A 404 on
download falls back to `gh release download`, as an unauthorised resolve
already did.
