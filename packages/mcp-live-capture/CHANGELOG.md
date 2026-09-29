# @foldedspacelabs/metistry-mcp-live-capture

## 0.15.0

### Minor Changes

- fcd6e4e: **New package: the live-capture recorder, audio (T8-2a).** A Swift helper (`lc-helper`) and a TypeScript bridge. App audio is recorded through a Core Audio process tap built from the apps the owner chose, and nothing else. The tap description is made in one function that cannot express "everything except", and an empty scope is refused. The owner's microphone is a second stream. Both are transcribed on the Mac as they record, by `SpeechTranscriber` on macOS 26. The helper runs C137's lifecycle on its own clock: a reminder every two hours, a stop at ten, a warning under 10 GB free and a stop under 5 GB, a paused and marked gap across sleep, and a crash that keeps everything up to it. The bridge serves `check` and `status` to its bridge token. Start, stop and Keep Going answer only a separate control token, and the bridge token gets 403 there. `check()` reports the three grants and the transcriber. The signed bundle, usage strings, launchd job and doctor row come with T8-2b.
- 5008ef6: **The live-capture recorder: the end of a session (T8-2b).** When a recording ends — Stop, the ten-hour stop, the disk, or a crash the helper finds when it next starts — the bridge sends its transcript to the console's `POST /capture` as one Markdown capture (`kind: transcript`), with `Idempotency-Key: live-capture:<session>`, using a capture owner token of its own (`METISTRY_LIVE_CAPTURE_INBOX_TOKEN`) that it never accepts and that must differ from its other two. A session stays owed on the Mac until the console answers with a row; a refusal or an outage leaves it there, `check` says why, and the next pass retries with the same key. The helper ships as a signed `lc-helper.app` ("Metistry Recorder") with its microphone and app-audio usage strings, built and signed the way the calendar helper is. `metistry up` installs it as its own launchd job, `com.foldedspacelabs.metistry.recorder`, and the bridge beside the other bridges — only once `METISTRY_LIVE_CAPTURE_URL` is set, under every shape — and `metistry doctor` reports both. The inbox drain classifies a transcript without a model, and a crashed recording raises one report in Needs You. The assistant now routes every turn that names a capture session onto the private tier — an on-machine provider — whatever was chosen, and refuses the turn when no private tier is assigned; it never falls back.

### Patch Changes

- Updated dependencies [4099fcb]
- Updated dependencies [aee4e7f]
- Updated dependencies [1985d5e]
- Updated dependencies [e41aa66]
- Updated dependencies [2e53e7f]
- Updated dependencies [e55613d]
- Updated dependencies [86d9b8f]
- Updated dependencies [c552e43]
- Updated dependencies [09962c8]
- Updated dependencies [23e173d]
- Updated dependencies [f4b7c13]
- Updated dependencies [d161c43]
- Updated dependencies [301ce2c]
- Updated dependencies [c40fd66]
- Updated dependencies [e0d2891]
  - @foldedspacelabs/metistry-core@0.15.0
