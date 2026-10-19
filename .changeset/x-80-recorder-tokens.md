---
"@foldedspacelabs/metistry-cli": minor
"@foldedspacelabs/metistry-mcp-live-capture": patch
---

`metistry up` makes the recorder's three tokens (X-80). With
`METISTRY_LIVE_CAPTURE_URL` set, `up` — and bare `metistry secrets mint` —
make `METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` (the login Keychain item the Mac
app's bar reads, filed under the instance's id), `METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE`
and `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` (a capture owner token labelled
`live-capture`, recorded in the console's `owner_tokens` by hash) wherever none
exists, before the jobs are rendered so the bridge is started with them. A
value any store already holds is kept — a Keychain item stands, an owner-pasted
`.env` value is adopted into the Keychain — and a rerun changes nothing; a
database that is down or not yet migrated leaves the inbox token minted and the
next `up` records it. All three join `GENERATED_SECRETS` (minted by
`secrets sync --to env` too, but only while the recorder is configured). The
bridge's `check()` and delivery messages now point at `metistry up` /
`metistry secrets mint` instead of telling the owner to set the token by hand.
