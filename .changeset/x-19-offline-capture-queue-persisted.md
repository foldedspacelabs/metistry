---
"@metistry-apps/macos": patch
---

Ruling 19 (X-19): the offline capture queue survives a relaunch. A capture
still queued — offline, no answer yet — is written to
`stores/capture-store.swift`'s `JSONCaptureQueueStore`, one JSON file under
this app's own Application Support directory (never the instance's, and
never a `UserDefaults` key), and read back at launch through the same gate
and the same `Idempotency-Key`, so a replay dedupes on the console exactly as
it would have before the relaunch. A sent capture is never left in the file,
and an instance switch clears only the switched-from instance's entries —
every other instance's queued captures are untouched.
