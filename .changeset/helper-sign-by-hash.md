---
"@foldedspacelabs/metistry-mcp-eventkit": patch
"@foldedspacelabs/metistry-mcp-apple-fm": patch
---

The helper build scripts pick a Developer ID identity by its SHA-1 hash
instead of its display name, so a keychain holding two certs with the same
name (a renewal, a second import) no longer fails `codesign` with
"ambiguous". Duplicates of one team are tolerated; certs for different teams
stop the build and ask for `METISTRY_SIGN_IDENTITY`. The chosen hash and
name are printed.
