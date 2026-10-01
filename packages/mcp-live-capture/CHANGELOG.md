# @foldedspacelabs/metistry-mcp-live-capture

## 0.16.1

### Patch Changes

- @foldedspacelabs/metistry-core@0.16.1

## 0.16.0

### Minor Changes

- 89e9af5: *Window* and *Screen* recordings: `POST /recording/start` takes `mode` (`audio_only`, `window`, `screen`). For a picture, the helper presents the macOS picker (`SCContentSharingPicker` — one window or one display, the helper excluded, the choice fixed for the recording) and opens one `SCStream` from the filter the picker handed back, with `capturesAudio` and, on macOS 15, `captureMicrophone` (a second microphone session below that). A picture start names no content — `apps`, a window or display id, or any other field is refused `400` — and a cancelled picker records nothing; the helper has no code that constructs a content filter or lists what is on screen. Frames are kept at one a second as `screen.mp4` in the session directory and never leave the Mac; the transcript is delivered as before. `status` gains `senses` (`display`, `app_audio`, `microphone`), read from the open streams, for the bar's display glyph, and a picture the system stops ends the session as `picture_lost`. Also fixed: a stream reopened after a sleep wrote over the audio recorded before it; each reopen now writes beside the first file (`app-2.m4a`, …).
- eadd0df: **A recording's retention and re-review (T8-4).** The recorder helper keeps a session's audio (and frames) until its transcript is ingested plus 7 days, never more than 30 days after it ended, and deletes this Mac's transcript copy at 30 days once delivered — on its own hourly clock, so the ceiling needs no console. The bridge gains `recording_review` (`GET /recording/review`, its third tool): a span of kept audio re-transcribed at the careful setting, answered as text with timestamps rebuilt field by field, never audio; after deletion it says when and why, and that the transcript remains. It joins core's `CREW_NEVER_TOOLS`. `POST /recording/retention` (bridge token, not a tool) takes the console's ingestion report, clamped to the delivery and to now; `POST /recording/purge` is Purge Now on the control credential. A Window / Screen session's frames (`screen.mp4`) go with its audio, and a span after a sleep is read from the file that holds it (`app-2.m4a`…), placed by when it was created.
  
  **Transcripts are filed at `Journal/Transcripts/<date>-<session>.md`** (Q29, X-73 folded in): an owner credential's transcript capture is placed there, create-only, in the owner's name, and records its `capture_sessions` row (migration 0033). `Journal/Transcripts/` is outside every default read grant — core's `underAreas` and mcp-brain's SQL `areaFilter` say the same thing. A capture can be placed at an exact path (`captureToInbox`'s `place`). The console serves `GET /api/recordings/:id` (owner reach) through the route-only `recording_state` query, and the hourly `recording-retention` routine rebuilds rows from the vault, records ingestion from the transcript's proposals, reports it to the Mac, and deletes a transcript on its 30th day as a commit in the owner's name, clearing its words from the inbox row and proposal. The crashed-recording report says where the transcript is saved.

### Patch Changes

- f58c163: **The floating bar (T8-5).** While the live-capture bridge answers on this Mac, a 34pt glass rail sits on the right edge of the main display — the mark, then Ask · Note · To-do, then Record — and the Capture menu's Ask, Note, To-do, Start Recording, Stop Recording and Hide Capture Bar light up with it (Stop only while recording). Note and To-do save with Return through the composer's own capture (one key minted once, the offline queue); during a recording each jot carries the session and its offset in seconds, the anchor the meeting's Approve promotes. Ask is the tail of the one conversation at 328pt, with Open in Chat past four lines. Record opens a sheet — Screen · Window · Audio only, the audio and microphone switches — and the start it sends names a mode and two switches, never a window or display: the recorder's macOS picker chooses. While a session runs the mark breathes (held still under Reduce Motion), the open senses sit beneath it, Record becomes Stop, and the two-hour reminder, a low disk and a session that ended by itself are said beside the rail. The bar presents the recorder's control key, read from the one login-Keychain item `metistry secrets mint METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` writes, to the loopback bridge only; a missing, refused or read-only key turns Record off with the reason and the verbs that fix it, and is never retried on its own. `LiveCaptureClient` is typed to the shipped wire, and F-7's `.window(id:)` / `.screen(displayID:)` are gone. The live-capture README says where the bar's key comes from.
- Updated dependencies [5a6ad9e]
- Updated dependencies [822a0c7]
- Updated dependencies [eadd0df]
- Updated dependencies [e6f16eb]
- Updated dependencies [0ff5643]
- Updated dependencies [f6a8e5d]
- Updated dependencies [cbfb1a9]
- Updated dependencies [7b979ef]
  - @foldedspacelabs/metistry-core@0.16.0

## 0.15.1

### Patch Changes

- 0025a4a: **Releases publish from the public repository again.** Every published package's `package.json` names its source (`repository` with `directory`, plus `homepage` and `bugs`), which npm's provenance check requires — v0.15.0 published nothing to npm for want of it. The release workflow now builds each GitHub release as a draft with every asset and publishes it only then, so immutable releases no longer refuse the assets; a failed Mac app holds the release as a draft instead of freezing it without the DMG; an npm provenance rejection fails the run instead of passing as a skip; and a malformed `APPLE_API_KEY_P8` is refused naming the format it must be (the raw `.p8` file, BEGIN/END lines included). Metadata and release tooling only; no runtime behaviour changes.
- Updated dependencies [0025a4a]
  - @foldedspacelabs/metistry-core@0.15.1

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
