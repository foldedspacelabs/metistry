---
"@metistry-apps/macos": patch
---

The Mac app's test suite no longer fails on CI's time limits in a healthy run.
The drive-table test that speaks every store method over the session child
drives the routes concurrently instead of one after another (a sequential walk
was ~300 waits on the main actor's queue, 45–55 s on CI's three-core runner for
a test that takes 0.1 s alone), and the live-events, store-session and chat
model tests carry a two-minute limit with the reason written down: they wait on
the main actor behind the ~480 other main-actor tests `swift test` dispatches at
once, not on wall time. No change to the app.
