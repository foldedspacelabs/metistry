# Live capture — Glass, and a Metistry capture bar with OS-enforced scope (2026-09-21)

Research answering the owner's 2026-09-21 ask about
[`pickle-com/glass`](https://github.com/pickle-com/glass): *"Glass (by pickle)
runs on the desktop and can see everything… meetings, browsing, etc. The most
useful thing I see here is direct capture from the source (meetings) and direct
review … It can be paired with a local model too, which makes it safer. I'm
also not sure I'd want to use this, but there are likely some ideas for capture
and interaction with the user that are worth taking. A floating metistry bar
that has constant context gathering capabilities could be cool, especially if
we could control what apps it can see into. I'd potentially use something like
this for [the second instance] in a heartbeat… not sure about personal yet."*

Nothing here is built; this PR adds one document and no product code.

Sources are Glass's own repo (fetched 2026-09-21, commit-dated), Apple's
documentation JSON and — where a claim is load-bearing — Apple's **headers and
the system's own TCC strings read locally on this Studio**, with verbatim
output below. Repo claims cite `file:line`. Where a claim could not be settled,
it says so rather than filling the gap; §2.2 contains one such correction to
the framing this research was handed, and it is the most consequential
paragraph in the document.

## The short version

1. **Glass is abandoned.** Last release `v0.2.4` on 2025-07-13; last feature
   commit 2025-07-20; one Firebase housekeeping commit 2025-10-26 and nothing
   since — **fourteen months** as of today, against 7,609 ★ and 113 open
   issues. Its README still says *"Currently, we're working on a full code
   refactor and modularization. Once that's completed, we'll jump into
   addressing the major issues."* It is a source of **ideas**, not of code or
   of a dependency. It is also **GPL-3.0** against this repo's Apache-2.0, so
   copying code was never on the table anyway.
2. **Glass is architecturally the opposite of what the ask wants.** The owner
   asked for *"control what apps it can see into."* Glass captures the
   **whole screen** by shelling out to the system `screencapture -x` binary
   — resolved from `PATH`, not by absolute path
   (`src/features/ask/askService.js:43`) — has no per-app scoping of any kind,
   and sells **invisibility** as a feature — "never shows up in screen
   recordings, screenshots, or your dock" — implemented as
   `setContentProtection` on every window (`src/window/windowManager.js:408`).
   Its shipped entitlements turn off library validation, allow unsigned
   executable memory, take the debugger entitlement and set
   `com.apple.security.app-sandbox` to `false` (`entitlements.plist`). It is a
   process designed not to be noticed. Metistry's whole posture is the reverse.
3. **The per-app scoping the owner wants is real for audio and weaker for
   screen — and this reverses the phase order the ask assumed.** Core Audio
   process taps are genuinely capability-scoped: `CATapDescription.processes`
   and, new in macOS 26, `.bundleIDs` mean the tap **only ever yields the named
   processes' audio** (`CATapDescription.h:129,135-136`, read locally). Screen
   capture has no equivalent. `SCContentSharingPicker` is a *selection* UI, not
   a *capability* fence: Apple's own overview says to use it "as the
   recommended approach for letting people select content sources … rather than
   building your own selection UI" **and**, separately, "Request screen
   recording permission from the person before capturing content." The grant
   stays global. See §2.2 — this contradicts the framing in the ask.
4. **On-device transcription exists, three ways, and the right one costs a
   version floor.** `SpeechAnalyzer` + `SpeechTranscriber` are **macOS 26.0**
   (verified locally: `@available(macOS 26.0, …) final public actor
   SpeechAnalyzer`), and the app's `LSMinimumSystemVersion` is **14.0**
   (`apps/macos/resources/Info.plist:37-38`). The older `SFSpeechRecognizer`
   works back to 10.15 but its **own system prompt tells the user their speech
   goes to Apple** — verbatim from this Mac's TCC strings, §2.5 — which is
   fatal to a second-instance "nothing leaves this machine" claim regardless of
   what `requiresOnDeviceRecognition` is set to. **Whisper is not in this
   repo**: `grep -ri whisper ops/release/ docs/ops/bundled-runtime.md packages/
   apps/` returns nothing.
5. **System audio is a third, separate TCC grant, and the manifest schema
   cannot express any of the three.** This Mac's TCC strings name
   `kTCCServiceAudioCapture` — *"'%@' would like access to record your system
   audio"* — distinct from Microphone and from ScreenCapture. The bridge
   manifest's grant list is a **closed enum of five**
   (`packages/core/src/manifest.ts:30-36`: `full_disk_access`, `automation`,
   `calendars`, `reminders`, `contacts`). Three new members, CI-validated, are
   a prerequisite and a product change — the same obstacle the daily-flow spec
   already hit for `full_disk_access`
   (`docs/research/2026-09-19-daily-flow-and-tasks.md:581`).
6. **Almost everything downstream of a transcript already exists.** A
   transcript is a capture: `POST /capture` takes `content_base64` + `filename`
   with an `Idempotency-Key` scoped to the credential class
   (`apps/console/src/server.ts:550-580`); anything over 5 MiB lands in
   `Inbox/.large/`, which git does not carry
   (`docs/ops/capture-shortcut.md:9-11`); `Journal/Meetings/` is already
   stamped by the seed (`seed/vault/Journal/Meetings`); the daily-flow spec
   already routes `kind: transcript` captures and already extracts action items
   (`docs/product/daily-flow-spec.md:893,1018-1034`). **The new code is the
   microphone-to-text end only.** That is the single biggest fact for sizing.
7. **Recommendation: build phase A, defer B, and do not build C for now.**
   Phase A — audio only, calendar-triggered, on-device transcript, one capture
   at the end — is the whole of the owner's stated value ("direct capture from
   the source … without waiting on the Gemini transcript") and is the part with
   genuine OS-enforced scoping. The floating bar (B) is a real idea worth
   taking but is second, because it is the part that needs the designer and a
   compute-assignment rule. Screen capture (C) is where the scope story is
   weakest and the value is least proven, and it is the part the owner himself
   was unsure he wanted.
8. **The consent obligation is the user's, and this document does not design
   around it.** The owner already ruled that meeting consent is collected in
   the meeting (`docs/product/daily-flow-spec.md:1022-1024`, Q7). Recording law
   varies by jurisdiction and by who is on the call; no product control can
   discharge it. What the product *can* do is make recording impossible to miss
   — a system indicator that is not suppressible, a per-session picker, a hard
   stop — and that is what §4 proposes. Note that Q4 in that spec, on transcript
   reach and retention, is **still open**, not ruled.

---

## 1. What Glass is

**Repo facts** (GitHub API, 2026-09-21): `pickle-com/glass`, "Digital Mind
Extension", **GPL-3.0**, 7,609 ★, 1,113 forks, 113 open issues, JavaScript,
created 2025-07-02, last push 2025-10-26. A fork of
[`sohzm/cheating-daddy`](https://github.com/sohzm/cheating-daddy); the
`package.json` `description` field reads `"Cl*ely for Free"` — it is a clone of
an interview-assistance product, repositioned.

### 1.1 The shape

Electron 30.5.1 (`package.json` `devDependencies`), a `lit`-based renderer, a
local Express server, a Next.js web app (`pickleglass_web/`), SQLite via
`better-sqlite3` **and** Firebase/Firestore, `keytar` for the Keychain, and a
custom URL scheme `pickleglass://` for auth deep links.

| Layer | Mechanism | File |
| --- | --- | --- |
| Screen | `execFile('screencapture', ['-x', '-t', 'jpg', tempPath])` — **the whole display**, then `sharp` resizes to 384px high and base64-encodes it for a vision model. Fallback: `desktopCapturer.getSources({types:['screen']})` | `src/features/ask/askService.js:43,91` |
| System audio | a **prebuilt 179,424-byte binary committed to the repo**, `src/ui/assets/SystemAudioDump`, spawned on macOS | `src/ui/listen/audioCore/listenCapture.js:431-452` |
| Microphone | `navigator.mediaDevices.getUserMedia` at 24 kHz mono | `listenCapture.js:455-466` |
| Echo cancellation | a Rust AEC compiled to WASM, driven frame-by-frame from JS | `listenCapture.js:1-30,150-210` |
| Accessibility tree | **none.** No `AXUIElement`, no Accessibility grant, no Input Monitoring anywhere in the tree | — |
| Permissions asked | **microphone and screen only** (`systemPreferences.getMediaAccessStatus`), plus a Keychain step | `src/features/common/services/permissionService.js:11-30` |

The absence in that table is as informative as the entries. Glass's answer to
"what's on screen" is **a JPEG to a vision model**, not structured text. It
never reads the accessibility tree, so it never asks for the Accessibility
grant — which means its screen understanding is exactly as good as the vision
model it is pointed at, and it costs a full-display screenshot each time.

### 1.2 What it does with them

Two features. **Listen**: continuous STT of mic + system audio into a rolling
conversation history, with a `SummaryService` producing live summaries and
"analysis data" (`src/features/listen/listenService.js:105-146,260-262`).
**Ask**: `Cmd+Enter` takes a fresh full-screen screenshot plus the conversation
history and sends both to a model (`askService.js:252`). The README's pitch for
it is *"get answers based on all your previous screen actions & audio."*

### 1.3 Models, and where data lives

Providers: OpenAI, Gemini, Anthropic, Deepgram, **Ollama** and **whisper.cpp**
(`src/features/common/ai/providers/`). Local is real but bolted on:

- Ollama is used over `http://localhost:11434` (`providers/ollama.js:80,123`).
- whisper.cpp is **found or installed at runtime**, not bundled: it looks for
  `whisper-cli` / `whisper` on `PATH`, else installs via **Homebrew**, else
  downloads a release zip (`services/whisperService.js:366-428,646`).
- Models come from Hugging Face with pinned sha256s — but the *binaries* and
  the Ollama installer are pinned to `sha256: null` with the comment
  *"실제 체크섬 추가 필요 — null일 경우 체크섬 검증 스킵됨"* ("real checksum
  needed — when null, checksum verification is skipped")
  (`src/features/common/config/checksums.js:4-8,40-52`). A downloaded,
  unverified executable is then `chmod +x`'d and spawned.

Data lives in **both** a local SQLite file and **Firestore**, with a parallel
`firebase.repository.js` beside every `sqlite.repository.js`. Payloads are
AES-256-GCM encrypted with a key in the Keychain via `keytar`, falling back to
an **in-memory key** when `keytar` is absent — at which point persistence
silently breaks (`services/encryptionService.js:1-60`). So "local" is a
configuration, not a property.

### 1.4 Privacy controls

There is no per-app allowlist, no per-session scope, and no recording
indicator. There is the opposite: `setContentProtection(true)` on every window
(`windowManager.js:408-423,464,496,529,722`) plus `skipTaskbar` and
`setVisibleOnAllWorkspaces`, so the app is **excluded from screen recordings
and screenshots** and absent from the Dock. The README calls this "Truly
invisible" and, in the same sentence, "no always-on capture or hidden sharing"
— a claim the Listen feature contradicts by design.

The entitlements are the other half of the picture (`entitlements.plist`):

```
com.apple.security.cs.allow-unsigned-executable-memory   true
com.apple.security.cs.disable-library-validation          true
com.apple.security.cs.debugger                            true
com.apple.security.app-sandbox                            false
```

Three hardened-runtime exceptions and the sandbox explicitly off. Compare
`apps/macos/resources/metistry.entitlements`, which is **deliberately empty**
and carries 30 lines of comment explaining why each one is not needed.

Two more distribution notes, offered as observations: the "Instant Launch" DMG
in the README is hosted on **Dropbox**, not on GitHub Releases; and `npm run
setup` requires **Python** as a prerequisite.

### 1.5 Ideas worth taking, and what conflicts

| Glass does | Verdict | Why |
| --- | --- | --- |
| Captures the meeting **at the source**, no bot joins the call | **take.** This is the owner's stated value | Nothing joins the call, nothing is uploaded, nothing waits on a vendor's post-processing |
| Mic and system audio separated, with AEC, so speakers are distinguishable | **take** | The single most useful property of a meeting transcript. macOS gives it for free now (§2.3) |
| A small always-available surface with "ask about what just happened" | **take** | This is the floating-bar idea, and it is good |
| Live summary during the meeting | **defer** | Value unproven, cost continuous. A summary *after* is the same information at a fraction of the compute |
| Local model option | **take, and harden** | Metistry makes it a declaration (`locality: on_machine`), not a preference |
| Whole-screen capture with no scoping | **reject** | Directly against the ask |
| Invisibility as a feature | **reject, firmly** | A capture process that hides itself is the exact inverse of "enforce at the tool". The indicator is the control |
| Cloud sync of transcripts on by default (Firestore) | **reject** | Invariant 1: git is the record. A second durable store is not a cache |
| Runtime-downloaded unverified binaries | **reject** | `sha256: null` in a checked-in file is a supply chain nobody controls |
| Hardened-runtime exceptions | **reject** | This app needs none and has none |

---

## 2. The macOS reality for a self-contained, notarized app

### 2.1 What this machine actually has

Read-only probes, this Studio, 2026-09-21, verbatim:

```
$ sw_vers
ProductName:		macOS
ProductVersion:		26.4
BuildVersion:		25E246

$ swift --version
swift-driver version: 1.148.6 Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)
Target: arm64-apple-macosx26.0

$ xcrun --show-sdk-version
26.5

$ ls <SDK>/System/Library/Frameworks/ScreenCaptureKit.framework/Headers
SCContentSharingPicker.h   SCScreenshotManager.h   ScreenCaptureKit.h
SCError.h                  SCShareableContent.h
SCRecordingOutput.h        SCStream.h
```

`ScreenCaptureKit`, `Speech`, `CoreAudio` and `FoundationModels` frameworks are
all present in the installed SDK. Swift is available without Xcode's UI, which
is already how `packages/mcp-eventkit/scripts/build-helper.sh` works.

### 2.2 Screen capture — and a correction to the framing

`SCContentSharingPicker` is **macOS 14.0+** (`SCContentSharingPicker.h:33,62`;
Apple's platform metadata agrees). Its configuration is expressive:
`allowedPickerModes` (single window / multiple windows / single application /
multiple applications / single display), `excludedWindowIDs`,
`excludedBundleIDs`, `allowsChangingSelectedContent`
(`SCContentSharingPicker.h:19-56`). `SCContentFilter` can be built from a
single window, a display minus windows, or **a named set of running
applications** (`SCStream.h:146-180`). `SCStreamConfiguration` carries
`capturesAudio` (macOS 13), `excludesCurrentProcessAudio` (13),
`captureMicrophone` and `microphoneCaptureDeviceID` (15), and
`SCRecordingOutput` writes straight to a file (15)
(`SCStream.h:295,310,360,365`; `SCRecordingOutput.h:23,59,86`). All verified in
the local headers.

**But the picker is not a capability fence, and the ask assumes it is.** The
brief handed to this research said the user picks apps via the picker "so the
OS enforces the scope, not our prompt." Apple's ScreenCaptureKit overview says
two things, in adjacent paragraphs:

> "Use `SCContentSharingPicker`, the system screen-sharing control, as the
> recommended approach for letting people select content sources and manage
> active streams, rather than building your own selection UI."

> "Request screen recording permission from the person before capturing
> content."

The picker is the **recommended selection UI**. The underlying grant —
`kTCCServiceScreenCapture`, whose system prompt on this Mac reads *"'%@' would
like to capture the contents of the system display."* — is **global to the
binary**. A process holding it can call
`SCShareableContent.getShareableContent` and build any filter it likes; nothing
in the OS ties that process to the picker's answer. The one thing the picker
*does* guarantee is that the filter object the observer receives was
constructed by the system from the user's selection.

So the honest formulation is: **the picker makes the scope visible and
user-chosen; a separate, small, single-purpose signed helper that has no code
path constructing a filter any other way is what makes it enforced.** That is
still "enforce at the tool" — the tool is a binary incapable of widening —
but it is *our* boundary, not the kernel's, and the document should say so
rather than borrow credibility from the OS.

Two further details. `getCurrentProcessShareableContent` (macOS 14.4+) returns
"redacted information about windows, displays and applications that are
available to capture by current process **without user consent via TCC**"
(`SCShareableContent.h:151`) — useful for a "you have nothing selected" state
before any grant exists. And Apple's own docs are inconsistent here: the
overview tells you to add an `NSScreenCaptureUsageDescription` key, but no such
key has a reference page in the Information Property List documentation, and
this Mac's TCC strings supply the prompt text themselves — consistent with the
long-standing behaviour that Screen Recording has no app-supplied usage string.

### 2.3 System audio — the one place the scoping is genuinely enforced

Two routes.

**Core Audio process taps.** `AudioHardwareCreateProcessTap` is
`API_AVAILABLE(macos(14.2))` (`AudioHardwareTapping.h:43-44`, read locally).
`CATapDescription` offers `initMonoMixdownOfProcesses:`,
`initStereoMixdownOfProcesses:` and their `…ButExcludeProcesses:` inverses, a
`processes` array, and — **new in macOS 26** — a `bundleIDs` array
(`CATapDescription.h:56-83,129,135-136`). It also has `privateTap` ("only
visible inside the process that created the tap") and a `muteBehavior`.

This is the real thing. A tap built from `[zoom.us, Google Chrome]` **cannot
produce audio from anything else**; the scoping lives in Core Audio's
implementation of the tap, not in our filtering of its output. It is the exact
capability the owner asked for — "control what apps it can see into" — and it
exists only for audio.

TCC: a separate grant. Apple: *"To capture audio with a tap, you need to
include the `NSAudioCaptureUsageDescription` key in your Info.plist … The first
time you start recording from an aggregate device that contains a tap, the
system prompts you to grant the app system audio recording permission."*
`NSAudioCaptureUsageDescription` is documented as **macOS 14.2+**. This Mac's
own TCC strings confirm the service is distinct — see §2.4.

**ScreenCaptureKit audio.** `capturesAudio` on an `SCStream` gets you the
audio of whatever the content filter covers, which is app-scoped when the
filter is. It is simpler if you want video anyway, and it drags the *screen*
grant along with it. For audio-only work the Core Audio tap is strictly better:
no screen grant, per-process by construction, and no video pipeline to keep
warm.

### 2.4 The three grants, in the system's own words

From `/System/Library/PrivateFrameworks/TCC.framework/Resources/Localizable.loctable`
on this Mac (`plutil -convert json`, key `en`), verbatim:

```
ScreenCapture:        “%@” would like to capture the contents of the system display.
Microphone:           “%@” would like to access the Microphone.
AudioCapture:         “%@” would like access to record your system audio.
SpeechRecognition:    “%@” would like to access Speech Recognition.
INFO_SpeechRecognition:
    Speech data from this app will be sent to Apple to process your requests.
    This will also help Apple improve its speech recognition technology.
```

Four separate services. Microphone additionally wants
`NSMicrophoneUsageDescription` (macOS 10.14+). None of `screen_recording`,
`microphone` or `audio_capture` is expressible in
`packages/core/src/manifest.ts:30-36`.

### 2.5 On-device transcription — three options, one recommendation

| Option | Availability | Genuinely on-device? | Cost |
| --- | --- | --- | --- |
| **`SpeechAnalyzer` + `SpeechTranscriber`** | **macOS 26.0** (verified locally: `@available(macOS 26.0, iOS 26.0, …) final public actor SpeechAnalyzer`, `Speech.swiftmodule/arm64e-apple-macos.swiftinterface:205-207`) | **Yes.** The Swift interface declares **no authorization API at all** — `grep -c authoriz` on it returns 0 — and models are managed as downloadable assets via `AssetInventory` (`:12-36`). Apple: transcription "appropriate for normal conversation and general purposes" | Raises the app's floor from 14.0 to 26.0, or needs an `if #available` split |
| `SFSpeechRecognizer` + `requiresOnDeviceRecognition` | macOS 10.15+ | **Treat as no.** `requiresOnDeviceRecognition` is only honoured when `supportsOnDeviceRecognition` is true (`SFSpeechRecognitionRequest.h:63-65`), and the *system's own consent prompt* tells the user "Speech data from this app will be sent to Apple" (§2.4). Explaining that prompt away is not something to ask of a second-instance user | Nothing technical; everything reputational |
| **whisper.cpp** | any | **Yes, unconditionally** | **Not in this repo at all.** `grep -ri whisper ops/release/ docs/ops/bundled-runtime.md packages/ apps/` → no matches. It would be a new binary in the runtime pack, a new model download, a new signing surface |

`DictationTranscriber` also exists in the macOS 26 Speech module with presets
including `timeIndexedLongDictation` (`:49-58`) — the time-indexing matters,
because it is what makes "jump to this moment in the transcript" possible from
an extracted action item (§4c).

**Recommendation: `SpeechTranscriber`, gated on `#available(macOS 26, *)`, with
the feature simply absent below that floor** — rather than adding whisper.cpp
to the runtime pack. The pack is already per-os-arch and already carries signed
Swift helpers (`ops/release/pack-runtime.sh:11-13`); adding a third-party
inference binary plus multi-hundred-megabyte models to it is a large, permanent
maintenance obligation for a capability the OS now supplies. This is the
judgement most likely to be wrong if the owner's second-instance Mac is not on
macOS 26 — that is open question (b).

### 2.6 Summarisation — already solved

`packages/mcp-apple-fm` is a shipped bridge: `runs_on: host`,
`requires_tcc: []`, an OpenAI-compatible `/v1` surface on port 7810, cost 0,
"the weights are already resident for the OS" (`docs/ops/compute.md:252`). A
meeting summary is exactly the workload it exists for, and it needs no new
grant, no new binary and no new decision.

### 2.7 The Accessibility API for on-screen text

`AXUIElementCopyAttributeValue` and `AXIsProcessTrustedWithOptions` are present
(`HIServices.framework/Headers/AXUIElement.h:64,148`). This is the route to
*structured* on-screen text rather than pixels — the thing Glass conspicuously
does not do.

Its cost is the grant. Accessibility has **no request prompt** in TCC's string
table (the search for one returned nothing); `kAXTrustedCheckOptionPrompt`
raises a dialog that sends the user to System Settings to flip a toggle by
hand. This repo currently has **zero** System Settings hand-toggles in its
first-run flow — a property the virtual-filesystem research recommended
protecting for the same reason
(`docs/research/2026-09-19-agent-virtual-filesystems.md`, open question (c)).
Accessibility is also the most powerful grant of the four: it confers the
ability to read and drive *every* app, with no per-app scoping of any kind.

**Verdict: no, not in any proposed phase.** If structured screen text is ever
wanted, it should be argued for on its own, not carried in on a meeting
feature's back.

### 2.8 Meeting apps, concretely

| App | Audio | What you get without a bot |
| --- | --- | --- |
| Zoom (native) | tap `us.zoom.xos` | Remote participants' audio, clean, with local mic separate |
| Teams (native) | tap the Teams bundle | as above |
| Meet / Teams / Zoom **in a browser** | tap the browser's bundle | as above, **plus every other tab's audio in that browser**. This is the one real gap in per-app audio scoping and it should be stated in the UI, not hidden |
| Any | `captureMicrophone` on SCK, or `getUserMedia` | The user's own voice, separately, which is what makes attribution possible |

Nothing joins the call. Nothing is uploaded. No meeting platform's API, no
vendor account, no bot in the participant list — which also means no
participant sees a "recording bot" and concludes they have been told. That
asymmetry is exactly why §2.9 matters.

### 2.9 Consent

**Recording obligations are the user's, and this product cannot discharge
them.** All-party-consent jurisdictions exist; participants in other countries
change the answer; an organisation's own policy may forbid it outright. The
owner has already ruled that consent is collected in the meeting
(`docs/product/daily-flow-spec.md:1022-1024`, Q7), and the right posture is to
say that plainly in the UI and the docs rather than to design a mechanism that
implies the problem is handled.

What the product *can* owe the user: a recording state that is impossible to
miss, a scope they chose this session, a stop that actually stops, and a
retention window that expires by default.

### 2.10 Summary — what a notarized, self-contained app can use

| Primitive | Usable? | Grant | Scoped per-app? | Fit |
| --- | --- | --- | --- | --- |
| **Core Audio process tap** | **yes, 14.2+** | `kTCCServiceAudioCapture` + `NSAudioCaptureUsageDescription` | **yes, enforced** (`bundleIDs` on 26) | **the core of phase A** |
| Microphone | yes | `kTCCServiceMicrophone` + `NSMicrophoneUsageDescription` | n/a | phase A |
| `SpeechTranscriber` / `SpeechAnalyzer` | yes, **26.0+** | **none** | n/a | phase A, behind `#available` |
| `SFSpeechRecognizer` | yes, 10.15+ | `kTCCServiceSpeechRecognition`, whose prompt names Apple | n/a | **no** (§2.5) |
| whisper.cpp | yes | none | n/a | fallback only; not in the pack |
| Apple Foundation Models | **yes, shipped** | none | n/a | summarisation, day one |
| `SCContentSharingPicker` + `SCStream` | yes, 14.0+ | `kTCCServiceScreenCapture`, **global** | **selection, not capability** (§2.2) | phase C, if ever |
| `SCRecordingOutput` | yes, 15.0+ | as above | as above | not needed |
| Accessibility (`AXUIElement`) | yes | Accessibility — **a System Settings hand-toggle**, no scoping at all | **no** | **no** (§2.7) |
| Input Monitoring | — | — | — | never needed; Glass doesn't use it either |

---

## 3. Fit with Metistry

### 3.1 The downstream half already exists

| Piece | Where | State |
| --- | --- | --- |
| The capture door | `apps/console/src/server.ts:550-580` — `POST /capture`, `content_base64` + `filename`, `Idempotency-Key` "scoped to the credential CLASS the server derived, never to anything in the request", replay returns the original row with `idempotency-replayed: true` | **exists.** A retrying helper is already safe |
| One sink for every door | `apps/console/src/server.ts:353-355` — "ONE capture sink for every door"; `captureToInbox` is the single write path (`docs/ops/inbox.md:28-31`) | **exists** |
| Big files | over `METISTRY_INBOX_MAX_TRACKED_BYTES` (5 MiB) a capture goes to `Inbox/.large/`, gitignored, and the reconciler never archives those rows (`docs/ops/capture-shortcut.md:9-11`; `apps/reconciler/test/inbox-scan.integration.test.ts:141-143`) | **exists.** An audio file or a long `.vtt` has a home that git does not carry |
| Transcripts as a kind | `docs/product/daily-flow-spec.md:1018-1034` — a `.md` or `.vtt` in `Inbox/` with `kind: transcript`, picked up by `apps/reconciler/src/indexer.ts:304-337`; reader/writer separation; `Journal/Transcripts/` outside every default grant | **specified**; Q4 (reach + retention) **open** |
| Meeting notes | `Journal/Meetings/<date>-<topic>.md`, **the user's file**, `source: user` (`docs/product/daily-flow-spec.md:521,45`); `seed/vault/Journal/Meetings` is already stamped | **exists** |
| Action items → tasks | "for each action item stated in a meeting note or transcript, raise **one** request carrying `suggested_work`" (`docs/product/daily-flow-spec.md:871-872`) | **specified** |
| The trigger | `packages/mcp-eventkit`: `GET /events?days=N` returns title, times, location, attendees (`src/index.ts:74-78`); `requires_tcc: [calendars, reminders]`, `runs_on: host` (`manifest.yaml:6-7`) | **exists.** The calendar already knows when a meeting is |
| Review | a proposal in Needs You; `blocked` is "the human-gated state … Only your hand" (`docs/ops/board.md:44`) | **exists** |
| Local-only compute | `locality: on_machine` "means nothing leaves this Mac, there is no `data_policy` to write" (`docs/ops/second-instance.md:104-106`) | **exists** |
| The assistant never sees raw media | the assistant's areas are vault paths (`.env.example:68`); a transcript is a file in the inbox and nothing more. Raw audio never enters the vault at all under §4 | **by construction** |

### 3.2 The TCC-bridge pattern, and what it costs

The pattern is settled and small. `packages/mcp-eventkit` is **554 lines
total** across manifest, Swift helper, build script, TS bridge and tests;
`packages/mcp-apple-fm` is 1,180. Both are `runs_on: host` with their own
launchd job, "its own responsible process (PoC-1)"
(`packages/mcp-eventkit/manifest.yaml:6`), and both build as **minimal `.app`
bundles** signed with a Developer ID identity, because "TCC only keys a grant
on a bundle" and an ad-hoc signature's cdhash changes on every rebuild
(`docs/ops/apple-signing.md:10-22`). `ops/release/pack-runtime.sh:11-13` already
carries "the signed TCC helper binaries" on darwin.

The schema is the blocker, not the pattern:

```
packages/core/src/manifest.ts:30-36
const tccGrant = z.enum([
  "full_disk_access", "automation", "calendars", "reminders", "contacts",
]);
```

`requires_tcc` is validated against that enum and CI runs it. Adding
`screen_recording`, `microphone` and `audio_capture` is three lines plus a
test — trivial as code, but it is a **product change** to the closed set, and
`docs/research/2026-09-19-daily-flow-and-tasks.md:581` already flagged the same
wall for `full_disk_access`. Worth settling once, for both.

### 3.3 The Mac app's shape, and the constraint it puts on the bar

`docs/ops/mac-app.md:8-14` is unambiguous: *"the app is a front end for the
CLI, never a second implementation … It opens no database connection
(invariant 3), runs no git of its own, and has no private endpoints."* Its
entitlements are empty on purpose, with the reasoning kept in the file
(`apps/macos/resources/metistry.entitlements`), and one of the stated reasons
is *"It touches no TCC-protected resource itself"*.

**That rule survives the bar, and it decides the architecture.** The bar is a
view; the capture helper is a separate signed bundle with its own grant, its
own launchd job and its own port, exactly like `ek-helper`. The app keeps its
empty entitlements and its clean TCC story; the bar talks to the console and
the bridge over loopback. Putting capture *in* the app would mean the app
acquiring three grants and the `NS*UsageDescription` keys — and would make
`metistry.entitlements`'s comment false.

The surfaces the bar plugs into already exist: `MenuBarExtra`
(`apps/macos/sources/app/metistry-app.swift:97`), the menu-bar content view
(`apps/macos/sources/kit/menu-bar-view.swift`), the Status panel
(`apps/macos/sources/kit/status-panel.swift`), the console client
(`apps/macos/sources/kit/console-client.swift`), and the design rule that
"Capture is a floating '+'" with "**no Capture tab and no Capture screen
anywhere**" (`docs/product/app-ux-plan.md:177-182,593-597`).

One more constraint: `LSMinimumSystemVersion` is `14.0`
(`apps/macos/resources/Info.plist:37-38`). Every API in §2.10 is above that
floor except the picker itself.

---

## 4. The proposed shape

### (a) `packages/mcp-live-capture` — a Swift TCC bridge

Manifest, in the existing vocabulary:

```yaml
name: live-capture
type: bridge
runs_on: host                 # TCC-bound: its own launchd service, its own responsible process (PoC-1)
requires_tcc: [microphone, audio_capture]      # phase A. screen_recording only if phase C ever ships
transport: http
port: 7813
degrades: absent              # no bridge, no bar, no capability
```

Properties, each of which is a mechanism rather than a promise:

1. **Off by default and absent unless installed.** `degrades: absent` is
   already how the router stops offering a missing bridge
   (`packages/mcp-eventkit/manifest.yaml:9`). A personal instance that never
   installs it has no capture surface and no bar (§5).
2. **Started by a calendar event or by the user's hand.** The trigger is
   `GET /events` on the eventkit bridge — which already returns start, end and
   attendees. Never started by a model: invariant 4's spirit, and the same
   determinism the router has.
3. **The audio scope is a named process list, and the helper has no other code
   path.** `CATapDescription(bundleIDs:)` on macOS 26, `processes:` below it.
   The default set is derived from the calendar event's conferencing URL
   (Zoom → `us.zoom.xos`; a Meet link → the default browser) and shown before
   recording starts. **The browser caveat from §2.8 is displayed, not hidden.**
4. **On-device transcription only.** `SpeechTranscriber` behind
   `#available(macOS 26, *)`; below that the bridge reports `degraded` with a
   remediation string, the way `mcp-eventkit` already reports a missing grant
   (`packages/mcp-eventkit/src/index.ts:63-68`).
5. **A rolling buffer under `.metistry/state/`, never in the vault.** Audio
   frames are transcribed and **dropped**; only text is retained, for N minutes
   (default 90, config). The vault sees nothing until the user says "keep".
   This is what makes invariant 1 hold trivially: there is nothing to back up,
   because nothing durable was created.
6. **A visible indicator, never suppressed.** macOS shows its own orange
   microphone dot and a Control Center entry for an active tap; the bar shows
   its own. `setContentProtection` is **never** called. The explicit
   anti-Glass decision.
7. **A hard stop.** Recording ends at the calendar event's end time + M minutes
   (default 5) whatever else happens, and on sleep, on lock, and on the
   bridge's own watchdog timeout. A missed stop is the failure everyone
   actually has.
8. **`check()`, like every bridge** — grant status, tap liveness, transcriber
   availability — so `metistry doctor` stays generic (CLAUDE.md, Packages).

**What it does not have:** any `exposes:` entry the assistant can call to
*start* recording. The bridge's tools are read-only over already-captured text.
Invariant 9 by absence, the same argument `packages/mcp-apple-fm/manifest.yaml`
makes for keeping `/v1` off its `exposes:` list.

### (b) The floating bar

A SwiftUI non-activating `NSPanel` in `apps/macos`, always-on-top,
`hidesOnDeactivate: false`, ~5 controls. **Hidden entirely when the bridge is
absent** — the one rule that makes §5 work.

| Control | Does what | Through |
| --- | --- | --- |
| State dot + elapsed | "recording · Zoom · 14:02", or "idle" | the bridge's `check()` |
| **Ask about the last 10 minutes** | a question answered from the rolling text buffer | `POST /message` with a tier that resolves to an `on_machine` provider |
| **Capture note** | the existing §3.8 composer, prefilled with a timestamp | `POST /capture` — no new door |
| **Mark action item** | writes a `- [ ] …` line proposal carrying `source: meeting:<path>` and the timestamp | the `source` vocabulary already exists (`docs/product/daily-flow-spec.md:140,247`) |
| **Stop** | stops, and says what it kept | the bridge |

**The compute rule.** While the bridge is live, everything the bar asks must go
to a provider with `locality: on_machine`. `docs/ops/compute.md` already has
the vocabulary — providers carry `locality`, `off_machine` requires a
`data_policy`, assignments are per-tier (`:54-65,89`). The cleanest expression
is a **tier** (say `private`) that an install may only assign to an
`on_machine` provider, refused at `metistry compute assign` — enforced at the
verb, not in a prompt. This is the one genuinely new mechanism the bar needs,
and it is the reason (b) is phase B rather than part of phase A.

**Per-app visibility lives in Settings ▸ Status ▸ Live capture**, showing the
current session's scope read back from the bridge, the grants and their state,
the retention window, and a **purge now** button. It is a read-through and two
verbs, matching the Compute pane's precedent (`docs/ops/mac-app.md`, "The
Compute pane").

### (c) Review, after the meeting

One proposal in Needs You: **"Meeting notes for &lt;event title&gt;"**, carrying

- a **draft** `Journal/Meetings/<date>-<topic>.md` — Approve writes it, and it
  is the user's file thereafter, `source: user`. This is deliberately
  byte-identical in shape to what the Gemini-mail path already produces
  (`docs/product/daily-flow-spec.md:983`), so one reviewing habit covers both.
- the **transcript as an inbox capture**, `kind: transcript`, under
  `Journal/Transcripts/` per §8.4 — subject to Q4, which is open.
- **extracted action items as task-line proposals**, one request each carrying
  `suggested_work` (`:871-872`), each with `source: meeting:<path>` and a
  timestamp that a time-indexed transcript makes clickable.

Nothing is written without the user's hand. Invariant 2 holds without a new
mechanism, because the proposal path is the mechanism.

### Compared with the Gemini-transcript-by-mail path

| | Live capture (this) | Gemini notes by mail (spec phase 3) |
| --- | --- | --- |
| Latency | at the meeting's end | hours; a vendor's batch |
| Where the audio goes | nowhere — never leaves the Mac | a cloud transcription service already |
| Coverage | **only meetings taken on this Mac, awake, with the app running** | every meeting on the account, from any device |
| Fidelity | the owner's own words and the room's; speaker-separated | whatever the vendor produced |
| New grants | three | **none** — Apple Mail on the second instance |
| Failure mode | silent miss (asleep, not installed, wrong app scoped) | a link instead of a body (`:997`) |
| Cost to build | §6 | 6 days, already scoped |
| Verdict | **complementary, not a replacement** | keep; it is the coverage floor |

The comparison's conclusion is that these are not alternatives. The mail path
catches every meeting badly; live capture catches some meetings well. If only
one gets built, the mail path is the safer product and live capture is the
better *experience* — which is consistent with the owner's own framing ("a good
way to get meeting context quickly **without waiting** on the Gemini
transcript").

---

## 5. Personal vs the second instance

The owner would use this on the second instance "in a heartbeat" and is unsure
about personal. **Make that a per-instance capability, not a setting.**

- **Absent unless installed.** No `packages/mcp-live-capture` in the install →
  no bridge → no grants ever requested → `degrades: absent` → **the bar is not
  drawn**. Not greyed out, not "upgrade to enable": absent. An install without
  it is indistinguishable from today's.
- **The second instance already has the policy it needs.** `locality:
  on_machine` "means nothing leaves this Mac"
  (`docs/ops/second-instance.md:104-106`), and that instance is already set up
  to run with zero cloud. Live capture adds no new egress.

**What a personal instance would need before it felt safe** — offered as the
list to build to, not as a claim that the owner should enable it:

1. **An indicator that cannot be turned off**, and no content protection,
   ever. The opposite of Glass's headline feature.
2. **A per-session picker.** The scope is chosen each time and shown; there is
   no remembered "always capture Zoom". Habituation is the enemy.
3. **Local-only, enforced at the verb** — the `private` tier of §4(b), refused
   at assignment time if it points anywhere off-machine.
4. **A retention window that expires by default.** Text buffer N minutes;
   nothing durable without an explicit keep; transcripts under a retention
   rule, which is the other half of open Q4.
5. **One-tap purge**, in the bar and in Settings, that deletes the buffer and
   any un-kept session immediately and says what it deleted.
6. **Never on by default, on any instance.** Including after an update.

---

## 6. Effort and phases

Estimates are **by analogy** to the two existing host bridges (554 and 1,180
lines including tests and build scripts) and to the daily-flow spec's own
phase sizing (Phase 1 = 8 days, Phase 3 = 6 days). They are not measured.

### Phase A — audio only · **7–9 days**

| Piece | Where | Size |
| --- | --- | --- |
| Three enum members + validation test | `packages/core/src/manifest.ts:30-36`, `packages/core/test/manifest.test.ts` | XS |
| Swift helper: tap + aggregate device + mic + `SpeechTranscriber`, ring buffer, hard stop, `check()` | `packages/mcp-live-capture/helper/` | ~600–800 lines, the bulk of the work |
| `.app` bundle + Developer ID signing + `NS*UsageDescription` keys | `scripts/build-helper.sh`, `helper/Info.plist` — copy `mcp-eventkit`'s | S, mechanical |
| TS bridge: manifest, HTTP surface, helper client, `check()` | `src/` | ~250 lines, patterned on `mcp-eventkit/src/` |
| Calendar trigger + hard stop | a routine reading `GET /events` | S |
| End-of-meeting: transcript → `POST /capture` with `Idempotency-Key`; proposal → Needs You | no server change | S |
| launchd job + `pack-runtime.sh` + `doctor` row | existing plumbing | S |
| Tests, including **misuse tests** (invariant 8): a tap scoped to app X yields no audio from app Y; the hard stop fires; nothing reaches the vault without a keep | `test/` | M — and non-negotiable |

### Phase B — the bar · **4–6 days**, needs the designer

The `NSPanel`, the five controls, the Settings ▸ Status pane, and the
`private`-tier compute rule with its refusal at `metistry compute assign`. The
compute rule is the only part with a design decision in it; the rest is
assembly over existing surfaces.

### Phase C — screen · **not recommended now**

§2.2 is why: the scope story is materially weaker than for audio, it needs a
third global grant, and the owner's own words were "there are likely some ideas
… worth taking", not "I want it to see my screen". If it is ever built, it is
`SCContentSharingPicker` + a helper with exactly one filter-construction path,
and **never** the Accessibility API (§2.7).

### Dependencies

**None new.** No npm package, no Swift package, no runtime binary — provided
§2.5's recommendation (`SpeechTranscriber`, not whisper) stands. If the owner's
second-instance Mac is below macOS 26, whisper.cpp in the runtime pack becomes
the fallback and phase A grows by an estimated 3–4 days plus a permanent
maintenance obligation.

### What needs the owner

- **A real meeting on the second instance to test against.** This cannot be
  proven on synthetic audio; speaker separation, the browser-tab caveat and the
  end-of-meeting stop all fail in ways only a live call surfaces.
- **The designer, for the bar** (phase B only). Phase A has no UI beyond a
  doctor row and a proposal card.
- **The macOS version of that Mac** — it decides §2.5.
- **A ruling on the three new TCC grant kinds**, which is also blocking the
  daily-flow spec's `full_disk_access`.

### Risks

| Risk | Assessment |
| --- | --- |
| **Thermal and battery on a laptop** | Real but modest for phase A: a Core Audio tap plus on-device ASR, no video pipeline, no periodic screenshots. Phase C's continuous `SCStream` is the expensive one — another reason it is last. **Unmeasured**; the first thing phase A should instrument |
| **TCC prompts** | Three at first run, each with an owner-visible remediation. `docs/ops/apple-signing.md:10-13` already warns that an ad-hoc rebuild silently drops a grant — the same trap `ek-helper` fell into |
| **Consent** | §2.9. Stated, not engineered around |
| **Silent misses** | The worst failure: the user believes it recorded and it did not. Mitigation is a proposal that appears **even when the transcript is empty**, saying so |
| **Scope creep into "sees everything"** | The bar makes continuous capture cheap to add later. Phase A's manifest deliberately does not request `screen_recording`, so widening is a visible product change |
| **macOS 26 floor** | The app supports 14.0; the feature would not exist below 26. Acceptable for an absent-by-default capability, awkward if the floor is ever presented as a product requirement |

---

## 7. Contradictions, and open questions

**Contradictions** (reported, not edited — no plan file is touched by this PR):

1. **The ask's picker premise is off by one step.** "The user picks apps via
   `SCContentSharingPicker`, so the OS enforces the scope, not our prompt" is
   not what Apple's documentation says (§2.2). The picker mediates *selection*;
   the Screen Recording grant remains global to the binary. Per-app **audio**
   scoping via Core Audio taps *is* OS-enforced, which is why §6 reorders the
   phases relative to the brief.
2. **The brief describes daily-flow Q4 as an owner ruling.** It is not:
   `docs/product/daily-flow-spec.md:1347-1352` lists transcript reach and
   retention as **open**, for the owner. What *was* ruled (Q7) is that meeting
   consent is collected in the meeting. Live capture makes Q4 urgent rather
   than theoretical, because it is the first path that would generate
   transcripts continuously.
3. **`packages/core/src/manifest.ts`'s closed grant enum is now blocking two
   specs.** `full_disk_access` for the mail path
   (`docs/research/2026-09-19-daily-flow-and-tasks.md:581`) and three grants
   here. Not a contradiction between documents — a decision that has become
   due.
4. **Apple's own docs are inconsistent about
   `NSScreenCaptureUsageDescription`.** The ScreenCaptureKit overview says to
   add it; no reference page for the key exists, and this Mac's TCC strings
   supply the prompt text themselves. Noted so that nobody spends an afternoon
   on it.

**Open questions for the owner:**

- **(a) Is phase A wanted at all, given the mail path?** They overlap in
  outcome and not in coverage (§4, the comparison table). Live capture is
  7–9 days for *better* meeting notes on *some* meetings; the mail path is
  6 days for *adequate* notes on *all* of them and needs no grants. If only one
  gets built this cycle, the recommendation is the mail path first — which is a
  recommendation **against** the more interesting of the two, so it deserves an
  explicit answer rather than an assumption.
- **(b) What macOS version is the second-instance Mac on?** It decides §2.5
  outright: 26+ means zero new dependencies; below means whisper.cpp in the
  runtime pack, +3–4 days, and a permanent binary to maintain.
- **(c) The three new TCC grant kinds — approve the enum change?** Three lines
  and a test, but it widens a closed set that CI enforces, and the same
  decision is owed to the mail path's `full_disk_access`. Better answered once.
- **(d) Q4, now: transcript reach and retention.** §8.4 puts transcripts
  outside every default grant; nothing yet says when they expire. A transcript
  committed to git is forever, and live capture would produce one per meeting.
  Recommendation: a retention window on `Journal/Transcripts/` with the raw
  audio never written at all — but the window's length is the owner's.
- **(e) The `private` compute tier.** Is a tier that `metistry compute assign`
  **refuses** to point off-machine the right mechanism, or is this a per-bridge
  flag? The tier is more general and reuses `docs/ops/compute.md` wholesale;
  the flag is smaller and less likely to be misused elsewhere.
- **(f) Personal instance: absent, or present and off?** §5 recommends
  **absent** — not installed, no grants, no bar drawn — because a disabled
  capture feature that is nonetheless present is exactly the thing the owner
  said he was unsure about. Confirm, because it changes how the release is
  packaged.

---

## Sources

**Local, verbatim (this Studio, macOS 26.4 build 25E246, SDK 26.5,
2026-09-21).** Read-only; nothing was executed but `sw_vers`, `swift
--version`, `xcrun`, `ls`, `grep` and `plutil -convert json` on a
world-readable system resource.

- `<SDK>/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/` —
  `SCContentSharingPicker.h` (`macos(14.0)`; `allowedPickerModes`,
  `excludedBundleIDs`, `excludedWindowIDs`, `allowsChangingSelectedContent`);
  `SCStream.h` (`capturesAudio` 13.0, `excludesCurrentProcessAudio` 13.0,
  `captureMicrophone` / `microphoneCaptureDeviceID` 15.0, the `SCContentFilter`
  initialisers); `SCShareableContent.h:151`
  (`getCurrentProcessShareableContent…`, "without user consent via TCC");
  `SCRecordingOutput.h` (15.0).
- `<SDK>/…/CoreAudio.framework/Headers/AudioHardwareTapping.h:43-44`
  (`AudioHardwareCreateProcessTap`, `API_AVAILABLE(macos(14.2))`) and
  `CATapDescription.h:56-83,129,135-136,160,166-167` (the per-process
  initialisers; `processes`; `bundleIDs` **`API_AVAILABLE(macos(26.0))`**;
  `privateTap`; `processRestoreEnabled` 26.0).
- `<SDK>/…/Speech.framework/Versions/A/Modules/Speech.swiftmodule/arm64e-apple-macos.swiftinterface`
  — `:205-207` `@available(macOS 26.0, …) final public actor SpeechAnalyzer`;
  `:12-36` `AssetInventory`; `:49-58` `DictationTranscriber` and its presets.
  Zero matches for `authoriz` in the file. Also
  `Speech.framework/Headers/SFSpeechRecognitionRequest.h:63-65` and
  `SFSpeechRecognizer.h:105-108,162-164`.
- `<SDK>/…/ApplicationServices.framework/Frameworks/HIServices.framework/Headers/AXUIElement.h:64,148`.
- `/System/Library/PrivateFrameworks/TCC.framework/Resources/Localizable.loctable`
  (`en`) — the four consent strings quoted verbatim in §2.4, including
  `REQUEST_ACCESS_INFO_SERVICE_kTCCServiceSpeechRecognition`. A search of the
  same table for an Accessibility request string returned nothing.
- Framework presence probes for `ScreenCaptureKit`, `Speech`, `CoreAudio`,
  `FoundationModels`.

**Apple documentation** (fetched via `developer.apple.com`'s documentation
JSON, 2026-09-21).

- *ScreenCaptureKit* (framework overview) — "Use `SCContentSharingPicker`, the
  system screen-sharing control, as the recommended approach…" and "Request
  screen recording permission from the person before capturing content."
  <https://developer.apple.com/documentation/screencapturekit>
- *SCContentSharingPicker* — macOS 14.0; "Avoid creating your own sharing
  picker."  <https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker>
- *Capturing system audio with Core Audio taps* — "To capture audio with a tap,
  you need to include the `NSAudioCaptureUsageDescription` key in your
  Info.plist…"; "The first time you start recording from an aggregate device
  that contains a tap, the system prompts you to grant the app system audio
  recording permission"; "ensure that you're using macOS 14.2 or later".
  <https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps>
- *NSAudioCaptureUsageDescription* (macOS 14.2+) and
  *NSMicrophoneUsageDescription* (macOS 10.14+). `NSScreenCaptureUsageDescription`
  **has no reference page** (§7.4).
- *Capturing screen content in macOS* (sample, macOS 15) — "The first time you
  run this sample, the system prompts you to grant the app Screen Recording
  permission."
- *SpeechAnalyzer* and *SpeechTranscriber* — both macOS 26.0.
- *Persistent Content Capture* entitlement — macOS 14.4, "VNC apps", and
  requires a request form to Apple. Named only to rule it out.

**`pickle-com/glass`** (fetched 2026-09-21; GPL-3.0; 7,609 ★, 1,113 forks, 113
open issues; created 2025-07-02, last push 2025-10-26; releases stop at
`v0.2.4`, 2025-07-13; last feature commit 2025-07-20).
<https://github.com/pickle-com/glass>

- `README.md` — "sees what you see, listens in real time"; "Truly invisible";
  the Dropbox DMG; the Python + Node prerequisites; the changelog ending
  2025-07-08; "we're working on a full code refactor".
- `package.json` — Electron 30.5.1, `"description": "Cl*ely for Free"`, the
  Firebase and `better-sqlite3` dependency pair.
- `entitlements.plist` — the four lines quoted in §1.4.
- `src/features/ask/askService.js:38-120` — `screencapture -x`, the `sharp`
  resize, the `desktopCapturer` fallback.
- `src/ui/listen/audioCore/listenCapture.js:1-30,285,420-500` — the WASM AEC,
  `SystemAudioDump`, `getUserMedia`.
- `src/ui/assets/SystemAudioDump` — a 179,424-byte binary committed to the
  repo (`git/trees`, sha `7f5e54f…`).
- `src/window/windowManager.js:408-423,445,464-465,659-660,722-723` —
  `setContentProtection`, `skipTaskbar`, `setVisibleOnAllWorkspaces`,
  `setAlwaysOnTop(true, 'screen-saver')`.
- `src/features/common/services/permissionService.js:11-30` — microphone and
  screen only.
- `src/features/common/services/whisperService.js:289-428,632-685,759-766` and
  `src/features/common/config/checksums.js` — the Homebrew/GitHub install path
  and the `sha256: null` entries.
- `src/features/common/services/encryptionService.js:1-60` — `keytar`, and the
  in-memory fallback.
- `src/features/common/ai/providers/ollama.js:80,123`.

**Repo, read at `origin/main` `47c8db6`** — `CLAUDE.md` (invariants 1, 2, 6, 8,
9, and "enforce at the tool"); `packages/core/src/manifest.ts:30-63`;
`packages/mcp-eventkit/{manifest.yaml,src/index.ts,helper/}`;
`packages/mcp-apple-fm/manifest.yaml`; `apps/console/src/server.ts:353,550-580`;
`apps/reconciler/manifest.yaml`;
`apps/reconciler/test/inbox-scan.integration.test.ts:141-143`;
`apps/macos/resources/{Info.plist,metistry.entitlements}`;
`apps/macos/sources/{app/metistry-app.swift,kit/menu-bar-view.swift,kit/status-panel.swift}`;
`docs/ops/{mac-app,inbox,capture-shortcut,compute,second-instance,apple-signing}.md`;
`docs/product/{daily-flow-spec,app-ux-plan}.md`;
`docs/product/design/mac-menubar.svg`;
`docs/research/{2026-09-19-daily-flow-and-tasks,2026-09-19-agent-virtual-filesystems}.md`;
`ops/release/pack-runtime.sh`; `.env.example:68`; `seed/vault/Journal/Meetings`.
