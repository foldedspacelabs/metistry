---
"@foldedspacelabs/metistry-core": minor
---

**The TCC enum gains three grants for live capture.** `screen_recording`,
`microphone`, `audio_capture` join `tccGrant` (§2.15, Q6) alongside the
existing five; the enum stays closed, and a bridge declaring any of the new
grants is held to the same PoC-1 rule as every other TCC bridge — `transport:
http`, `runs_on: host` only.
