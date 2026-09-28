# `@foldedspacelabs/metistry-mcp-live-capture`

Record a meeting on a Mac, scoped to the apps you choose, and transcribe it
on the Mac as it records.

- **App audio through a Core Audio process tap.** A tap mixes exactly the
  processes its description names, so a recording scoped to Zoom cannot
  hear anything else. The helper builds that description in one function,
  from a list of bundle IDs; it cannot express "everything except", and an
  empty list is refused.
- **Your microphone**, your side only, as a second stream.
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
  next pass (every minute) tries again.

Requires macOS 14.2 or later for app audio, and macOS 26 for transcription.
It needs three permissions: Microphone, Audio Capture and (for screen
capture, not built yet) Screen Recording.

## Three credentials

| credential | reaches |
| --- | --- |
| `METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE` | `GET /check` and `GET /status`, both reads. These are the manifest's `exposes:` — what a tool caller may invoke |
| `METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` | those two, plus `POST /recording/start`, `/recording/stop` and `/recording/keep-going`. This is the person at the Mac, pressing Record |
| `METISTRY_LIVE_CAPTURE_INBOX_TOKEN` | nothing here — the bridge refuses it like a stranger's. It is the capture owner token the bridge **presents** to the console's `POST /capture` when a session ends (capture and messages only; `docs/ops/capture-shortcut.md` §1 mints one) |

The bridge token is refused `403` on every recording route, before the
helper is asked anything. A model with this bridge's tools can see whether
something is being recorded, and can never start a recording or cause a
delivery. The bridge will not start if any two of the three are the same.

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
  -d '{"apps":["us.zoom.xos"],"app_audio":true,"microphone":true}'
```

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
| `METISTRY_CAPTURE_DIR` (helper) | `<METISTRY_INSTANCE_DIR>/.metistry/state/capture` | where sessions are written: `<session>/session.json`, `transcript.jsonl`, `app.m4a`, `mic.m4a`; the helper refuses to start with neither set |
| `METISTRY_LC_LOCALE` (helper) | the Mac's | the transcriber's language |

## Tests

`pnpm test` runs the bridge's wire, delivery and misuse tests against a
fake helper and a fake console. On a Mac it also runs
`scripts/test-helper.sh`, which compiles the helper's decisions
(`helper/sources/kit`) with fakes for Core Audio, the microphone and the
transcriber. It then builds the helper against the SDK with
`build-helper.sh --compile-only` — unsigned, not a bundle. No step touches
an audio device, a permission or a signing identity.

## On a Metistry install

`metistry up` installs two jobs once `METISTRY_LIVE_CAPTURE_URL` is set:
the helper as its own launchd agent (`com.foldedspacelabs.metistry.recorder`
— its own responsible process, so the grants attach to it) and the bridge
beside the other bridges. `metistry doctor` reports both: the job's state,
and the bridge's `check` — the grants, the transcriber, and whether any
recording is still owed to the inbox.
