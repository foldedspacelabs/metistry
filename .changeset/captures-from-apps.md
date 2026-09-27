---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
---

**Captures from the apps (T2-1): `POST /capture` records `source: "app"` for
an owner credential.** A passkey session or the local owner token — the Mac
app and the PWA, never a request field — is now distinguished from the
Shortcut's `owner_token` and an agent bearer, both of which keep `"http"` as
before (the bridge's own `capture` tool still records `"mcp"`). Activity can
now tell the owner's own captures apart. F-1's frozen row is served; its
fixture (`apps/macos/tests/kit/fixtures/post-capture.json`) is re-recorded.
