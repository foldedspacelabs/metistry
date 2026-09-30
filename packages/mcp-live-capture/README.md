# `@foldedspacelabs/metistry-mcp-live-capture`

Record a meeting on a Mac, scoped to the apps or the window you choose, and
transcribe it on the Mac as it records.

- **App audio through a Core Audio process tap.** A tap mixes exactly the
  processes its description names, so a recording scoped to Zoom cannot
  hear anything else. The helper builds that description in one function,
  from a list of bundle IDs; it cannot express "everything except", and an
  empty list is refused.
- **A window or a screen you pick in the macOS picker** (*Window*, *Screen*).
  The helper presents `SCContentSharingPicker` — one window, or one
  display, the helper itself excluded, the choice fixed for the recording —
  and opens one `SCStream` from the filter the picker handed back, with
  `capturesAudio` (that content's own sound) and, on macOS 15,
  `captureMicrophone`. A start names no content: a window id, display id
  or app list is refused, a cancelled picker records nothing, and the
  helper has no code that builds a filter or lists what is on screen. The
  picture is kept at one frame a second (`screen.mp4`) and never leaves the
  Mac.

  *Be clear about what that enforces.* The picker makes the choice yours
  and visible; the Screen Recording permission itself is not per-window —
  macOS grants it to the whole helper. What keeps a recording to the
  window you picked is that this helper has exactly one way to get a
  filter. If you want the operating system's own guarantee, use *Audio
  only*: a process tap is per-process by construction.
- **Your microphone**, your side only, as a second stream (in the picture
  stream itself on macOS 15).
- **Transcription on the Mac** with `SpeechTranscriber` (macOS 26), as the
  audio arrives. Below macOS 26 the audio is kept without a transcript, and
  `check` says so.
- **A working day's limits**: a reminder every two hours, a hard stop at ten,
  a warning under 10 GB free and a stop under 5 GB. A sleep pauses the
  recording and marks the gap. The transcript is written line by line, so a
  crash keeps everything up to the crash.
- **The transcript goes to Metistry when the session ends** — however it
  ends: Stop, the ten-hour stop, the disk, or a crash found when the helper
  next starts. The bridge posts it to the console's `POST /capture` as one
  Markdown capture (`kind: transcript`), with
  `Idempotency-Key: live-capture:<session>`, so a retry lands once. A
  session stays owed until the console has answered with a row; a console
  that is down or refuses the credential leaves it on this Mac, and the
  next pass (every minute) tries again. A Metistry console files it at
  `Journal/Transcripts/<date>-<session>.md` in the owner's name.
- **Retention you can read.** The audio (and a *Window* / *Screen*
  session's frames) stays under the session's directory until the
  transcript is ingested (the meeting's proposals decided, or the fold has
  read it) plus 7 days, and never more than 30 days after the recording
  ended; this Mac's transcript copy goes at 30 days once it was delivered.
  The helper applies that rule itself, every hour — the 30-day ceiling
  needs no console. The console's `recording-retention` routine reports
  ingestion (`POST /recording/retention`), which can only bring a deletion
  forward. Purge Now (`POST /recording/purge`, the control credential)
  deletes a session's media at once. `session.json` stays, saying when and
  why.
- **Re-review — "check the audio again".** `recording_review` re-transcribes
  a span of the kept audio (at most 15 minutes) with the transcriber's most
  careful setting and answers **text with timestamps, never audio**: the
  answer is rebuilt field by field, so nothing but a source, two times and a
  line of text per line leaves the bridge. After the audio is deleted it
  says when, and that the transcript remains. It is the assistant's alone:
  core's `CREW_NEVER_TOOLS` names it.

Requires macOS 14.2 or later for app audio, macOS 14 for *Window* and
*Screen*, and macOS 26 for transcription. It needs three permissions:
Microphone, Audio Capture (*Audio only*) and Screen Recording (*Window* and
*Screen*).

## Three credentials

| credential | reaches |
| --- | --- |
| `METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE` | `GET /check`, `GET /status` and `GET /recording/review` (`recording_review`), all reads — the manifest's `exposes:`, what a tool caller may invoke — and `POST /recording/retention`, which is not a tool: the console's retention routine reporting ingestion |
| `METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` | all of those, plus `POST /recording/start` (every mode — *Audio only*, *Window*, *Screen*), `/recording/stop`, `/recording/keep-going` and `/recording/purge`. This is the person at the Mac, pressing Record or Purge Now |
| `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` | nothing here — the bridge refuses it like a stranger's. It is the capture owner token the bridge **presents** to the console's `POST /capture` when a session ends (capture and messages only; `docs/ops/capture-shortcut.md` §1 mints one) |

The bridge token is refused `403` on every route that is the owner's hand,
before the helper is asked anything. A model with this bridge's tools can
see whether something is being recorded and re-read what was said, and can
never start a recording, delete audio or cause a delivery. The bridge will not start if any two of the three are the same.

## Standalone

The helper (`lc-helper.app`) holds the permissions, so it runs as its own
process — a signed bundle, because macOS keys each grant on the bundle's
identifier and signature (`scripts/build-helper.sh`; a Developer ID
identity keeps the grants across rebuilds, an ad-hoc one does not). The
bridge connects to it over a Unix socket.

```sh
./scripts/build-helper.sh
METISTRY_CAPTURE_DIR=./capture METISTRY_LC_SOCKET=/tmp/lc.sock ./helper/lc-helper.app/Contents/MacOS/lc-helper &

export METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE=$(openssl rand -base64 32)
export METISTRY_LIVE_CAPTURE_CONTROL_TOKEN=$(openssl rand -base64 32)
METISTRY_LC_SOCKET=/tmp/lc.sock npx @foldedspacelabs/metistry-mcp-live-capture
```

```sh
curl -sS http://127.0.0.1:7815/check -H "authorization: Bearer $METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE"
```

```json
{"name":"live-capture","status":"ok","latency_ms":145,
 "probe":"asked the helper for its grant states and the on-device transcriber's readiness",
 "meta":{"grants":{"audio_capture":"unverified","microphone":"not_asked","screen_recording":"not_granted"},
         "transcriber":{"assets":"supported","available":true,"engine":"SpeechTranscriber","locale":"en_US",
                        "reason":"the language model downloads the first time a recording starts"},
         "recording":false,"os":"26.4"}}
```

```sh
curl -sS -X POST http://127.0.0.1:7815/recording/start \
  -H "authorization: Bearer $METISTRY_LIVE_CAPTURE_CONTROL_TOKEN" \
  -d '{"mode":"audio_only","apps":["us.zoom.xos"],"app_audio":true,"microphone":true}'
```

*Window* and *Screen* name nothing — the helper presents the picker and
waits (up to two minutes) for your choice:

```sh
curl -sS -X POST http://127.0.0.1:7815/recording/start \
  -H "authorization: Bearer $METISTRY_LIVE_CAPTURE_CONTROL_TOKEN" \
  -d '{"mode":"window","app_audio":true,"microphone":true}'
```

Re-review a span of a kept recording (the bridge token — `recording_review`):

```sh
curl -sS "http://127.0.0.1:7815/recording/review?session_id=20260928-133000-00ab&from_s=160&to_s=170" \
  -H "authorization: Bearer $METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE"
```

```json
{"session_id":"20260928-133000-00ab","from_s":160,"to_s":170,"audio":"kept",
 "lines":[{"source":"app","speaker":"apps","from_s":160.5,"to_s":162,"at":"00:02:40","text":"the numbers are in"}],
 "text":"[00:02:40] (apps) the numbers are in","as_of":"…"}
```

Once the media is gone: `"audio":"deleted"`, no lines, and
`"note":"Audio deleted on 2026-10-05 after the fold; the transcript remains."`.

| start body | |
| --- | --- |
| `mode` | `audio_only` (the default), `window` or `screen` |
| `apps` | *Audio only*: the bundle IDs to tap, 1–16. *Window* / *Screen*: must be absent |
| `app_audio`, `microphone` | `true` unless set; *Window* / *Screen* may turn both off and keep the picture |

Anything else in the body is refused `400` before the helper hears it —
`window_id`, `display_id`, `filter` and the like included. A cancelled
picker is `400` (*nothing was chosen*); ScreenCaptureKit missing is `503`.

`GET /status` says what is running, never what it took: the mode, the
apps, what the picker chose (`picture: {kind, bundle_id}` — never a window
title), and `senses` — `display`, `app_audio`, `microphone` — read from the
streams that are open; a paused session has none. A picture the system
stops (the window closed, the permission withdrawn) ends the session as
`picture_lost`.

`audio_capture` stays `unverified` until a tap has delivered sound, then
reads `observed`. macOS has no way for an app to read that permission back,
and a tap without it records silence.

| variable | | |
| --- | --- | --- |
| `METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE` | **required** | the tool caller's bearer |
| `METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` | **required** | the recording controls' bearer; must differ |
| `METISTRY_LC_SOCKET` | `/tmp/metistry-live-capture.sock` | the helper's socket (under 104 bytes) |
| `METISTRY_LC_PORT` | `7815` | |
| `METISTRY_LC_HOST` | `127.0.0.1` | |
| `METISTRY_LC_HELPER_TIMEOUT_MS` | `150000` | a start can wait on the transcriber's first set-up and the microphone prompt |
| `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` | — | the capture owner token transcripts are posted with; unset, they stay on this Mac and `check` is `degraded` |
| `METISTRY_LC_CONSOLE_URL` | `METISTRY_CONSOLE_URL`, else `http://127.0.0.1:$METISTRY_CONSOLE_PORT` (8080) | where `POST /capture` is |
| `METISTRY_CAPTURE_DIR` (helper) | `<METISTRY_INSTANCE_DIR>/.metistry/state/capture` | where sessions are written: `<session>/session.json`, `transcript.jsonl`, `app.m4a`, `mic.m4a`, `screen.mp4` (after a sleep, `app-2.m4a`… beside the first — each file's place in the session is read from when it was created, which `recording_review` uses); the helper refuses to start with neither set |
| `METISTRY_LC_LOCALE` (helper) | the Mac's | the transcriber's language |

## Tests

`pnpm test` runs the bridge's wire, delivery and misuse tests against a
fake helper and a fake console. On a Mac it also runs
`scripts/test-helper.sh`, which compiles the helper's decisions
(`helper/sources/kit`) with fakes for Core Audio, ScreenCaptureKit and its
picker, the microphone and the transcriber — among them, *the picker's
choice is the only filter the helper builds*. It then builds the helper
against the SDK with `build-helper.sh --compile-only` — unsigned, not a
bundle — and reads the sources to hold that no code constructs a content
filter or lists what is on screen. No step touches an audio device, the
screen, a permission or a signing identity.

## On a Metistry install

`metistry up` installs two jobs once `METISTRY_LIVE_CAPTURE_URL` is set:
the helper as its own launchd agent (`com.foldedspacelabs.metistry.recorder`
— its own responsible process, so the grants attach to it) and the bridge
beside the other bridges. `metistry doctor` reports both: the job's state,
and the bridge's `check` — the grants, the transcriber, and whether any
recording is still owed to the inbox.
