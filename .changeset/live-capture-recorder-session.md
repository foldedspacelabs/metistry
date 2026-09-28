---
"@foldedspacelabs/metistry-mcp-live-capture": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/collectors": minor
"@metistry-apps/assistant": minor
---

**The live-capture recorder: the end of a session (T8-2b).** When a recording ends — Stop, the ten-hour stop, the disk, or a crash the helper finds when it next starts — the bridge sends its transcript to the console's `POST /capture` as one Markdown capture (`kind: transcript`), with `Idempotency-Key: live-capture:<session>`, using a capture owner token of its own (`METISTRY_LIVE_CAPTURE_INBOX_TOKEN`) that it never accepts and that must differ from its other two. A session stays owed on the Mac until the console answers with a row; a refusal or an outage leaves it there, `check` says why, and the next pass retries with the same key. The helper ships as a signed `lc-helper.app` ("Metistry Recorder") with its microphone and app-audio usage strings, built and signed the way the calendar helper is. `metistry up` installs it as its own launchd job, `com.foldedspacelabs.metistry.recorder`, and the bridge beside the other bridges — only once `METISTRY_LIVE_CAPTURE_URL` is set, under every shape — and `metistry doctor` reports both. The inbox drain classifies a transcript without a model, and a crashed recording raises one report in Needs You. The assistant now routes every turn that names a capture session onto the private tier — an on-machine provider — whatever was chosen, and refuses the turn when no private tier is assigned; it never falls back.
