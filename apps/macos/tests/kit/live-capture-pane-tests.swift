// Settings ▸ Live Capture (T6-15; screen-11 §8, plan §2.15).
//
// The bar's switch and placement are the one thing this Mac stores, and the
// only defaults key they touch is their own; whether there is a recorder and
// what it grants are read through the bar's own client, never granted here;
// the recordings are read through the API (the transcripts name them, T8-4's
// route says what each still keeps); and Purge Now — the bridge's door,
// through `LiveCaptureClient.purge` — confirms first, naming each recording,
// sends nothing until then, and is off with the client's reason while the
// recorder cannot be asked. Absent, not off, without the bridge.

#if os(macOS)
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The bar: device-local, one key

@MainActor
@Test func theBarsSwitchAndPlacementLiveUnderOneKeyAndNothingElse() {
    let id = "com.foldedspacelabs.metistry.tests.capture-bar.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    defer { UserDefaults.standard.removePersistentDomain(forName: id) }

    let bar = CaptureBarPreferences(defaults: defaults)
    // the defaults: on, the right edge, the main display — and nothing written yet
    #expect(bar.placement == CaptureBarPlacement(enabled: true, edge: .right, displayID: nil))
    #expect((UserDefaults.standard.persistentDomain(forName: id) ?? [:]).isEmpty)

    bar.setEdge(.left)
    bar.setDisplay(7)
    bar.setEnabled(false)
    let domain = UserDefaults.standard.persistentDomain(forName: id) ?? [:]
    #expect(Set(domain.keys) == [AppPreference.captureBar.rawValue], "\(domain.keys)")
    #expect(domain[AppPreference.captureBar.rawValue] as? [String: AnyHashable] == ["enabled": false, "edge": "left", "display_id": 7])

    // a second launch reads it back
    let again = CaptureBarPreferences(defaults: defaults)
    #expect(again.placement == CaptureBarPlacement(enabled: false, edge: .left, displayID: 7))
    again.setDisplay(nil)
    #expect(CaptureBarPreferences(defaults: defaults).placement.displayID == nil)

    // top and bottom are not offered: the type has two cases
    #expect(CaptureBarEdge.allCases.map(\.rawValue) == ["left", "right"])
    // an unreadable value is the default placement, never a crash
    defaults.set("nonsense", forKey: AppPreference.captureBar.rawValue)
    #expect(CaptureBarPreferences(defaults: defaults).placement == CaptureBarPlacement())
}

@MainActor
@Test func theBarModelTakesTheEdgeAndDrawsTheRailOnIt() async throws {
    // the view mirrors by the model's edge: the rail is spoken either way, on either side
    let model = CaptureBarModel(client: AbsentLiveCaptureClient(), composer: nil, chat: nil)
    #expect(model.edge == .right, "the right edge until Settings says otherwise")
    model.edge = .left
    let tree = try await AccessibilityProbe.snapshot(CaptureBarView(model: model).frame(width: 400))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "\(tree.unlabeledControls)")
    #expect(tree.controlNames.contains("Note") && tree.controlNames.contains("To-do"), "\(tree.controlNames)")
}

// MARK: - Permissions: the recorder's words, read through

@Test func theGrantsAreTheRecordersWordsAndSayWhetherNotWhen() {
    let grants = CaptureGrant.rows(["microphone": "granted", "audio_capture": "unverified", "screen_recording": "not_granted"])
    #expect(grants.map(\.kind.title) == ["Microphone", "Audio Capture", "Screen Recording"])
    #expect(grants.map(\.state) == ["Approved", "Not yet verified", "Not approved"])
    #expect(grants.map(\.isApproved) == [true, false, false])
    #expect(CaptureGrant(kind: .microphone, wire: "not_asked").state == "Not yet asked")
    #expect(CaptureGrant(kind: .audioCapture, wire: "observed").state == "Approved")
    #expect(CaptureGrant(kind: .microphone, wire: "denied").state == "Denied")
    // a word this build does not know is shown as the recorder said it, never guessed at
    #expect(CaptureGrant(kind: .microphone, wire: "pending_review").state == "pending_review")
    // a grant the recorder did not name is unknown, said as such
    #expect(CaptureGrant.rows([:]).map(\.wire) == ["unknown", "unknown", "unknown"])
}

@MainActor
@Test func withoutTheBridgeThePaneIsAbsentNotOff() async throws {
    // not asked yet: unknown
    let model = LiveCaptureModel(session: nil)
    #expect(model.presence == .unknown)
    // the client says absent — nothing listens: the pane is absent, and asks the API nothing
    let (absent, console) = try liveCaptureReading(client: FakeRecorder(status: .absent), transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await absent.refresh()
    #expect(absent.presence == .absent)
    #expect(absent.grants == nil && absent.recorderProblem == nil)
    #expect(absent.recordings.isEmpty)
    #expect(console.calls.isEmpty, "no bridge: nothing to count — \(console.calls)")
    // a bridge that refuses this Mac's key is PRESENT, and the pane says so in the client's words
    let (noKey, _) = try liveCaptureReading(client: FakeRecorder(status: .noKey), transcripts: [])
    await noKey.refresh()
    #expect(noKey.presence == .present)
    #expect(noKey.grants == nil)
    #expect(noKey.recorderProblem == LiveCaptureWords.noKey)
    #expect(noKey.purgeUnavailableReason == LiveCaptureWords.noKey, "Purge Now is off with the key's own words")
    // a healthy bridge: present, with its grants
    let (ok, _) = try liveCaptureReading(client: FakeRecorder(), transcripts: [])
    await ok.refresh()
    #expect(ok.presence == .present)
    #expect(ok.grants?.map(\.state) == ["Approved", "Not yet verified", "Not approved"])
}

// MARK: - The recordings, and the count beside Purge Now

@Test func aTranscriptsPathNamesItsRecording() {
    #expect(RecordingRetention.recordingID(fromPath: "Journal/Transcripts/2026-09-28-20260928-133000-00ab.md") == "20260928-133000-00ab")
    #expect(RecordingRetention.recordingID(fromPath: "Journal/Transcripts/2026-09-28-notes.md") == "notes")
    #expect(RecordingRetention.recordingID(fromPath: "Journal/2026-09-28.md") == nil, "not a transcript")
    #expect(RecordingRetention.recordingID(fromPath: "Journal/Transcripts/README.md") == nil, "no day prefix")
    #expect(RecordingRetention.recordingID(fromPath: "Journal/Transcripts/2026-09-28-Has Spaces.md") == nil, "not a recorder id")
    #expect(RecordingRetention.recordingID(fromPath: "Projects/Metistry/Design.md") == nil)
}

@MainActor
@Test func theRecordingsAreReadThroughTheAPIAndCountedBesidePurgeNow() async throws {
    let (model, console) = try liveCaptureReading(client: FakeRecorder(), transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    #expect(model.phase == .read)
    let paths = console.calls.map { "\($0.method) \($0.path)" }
    #expect(paths.count == 2, "\(paths)")
    #expect(paths.first?.hasPrefix("GET /api/knowledge/pages?") == true && paths.first?.contains("prefix=Journal") == true, "\(paths)")
    #expect(paths.last == "GET /api/recordings/20260928-133000-00ab", "\(paths)")
    let recording = try #require(model.recordings.first)
    #expect(recording.id == "20260928-133000-00ab")
    #expect(recording.audioKept && recording.audioBytes == 26_214_400)
    #expect(recording.transcriptPath == "Journal/Transcripts/2026-09-28-20260928-133000-00ab.md")
    #expect(model.countLine == "26 MB in 1 recording")
    let clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    #expect(recording.line(clock: clock, now: model.now()) == "28 Sep, 1:30 PM · 15m · 26 MB")
    #expect(recording.retentionLine(clock: clock, now: model.now()) == "Audio kept until 5 Oct, 1:47 PM")
    // no transcripts: nothing kept, and the button says so
    let (empty, _) = try liveCaptureReading(client: FakeRecorder(), transcripts: [])
    await empty.refresh()
    #expect(empty.countLine == "No audio kept")
    #expect(empty.recordings.isEmpty)
    #expect(empty.purgeUnavailableReason == "Nothing to purge — no audio is kept.")
}

@Test func retentionLinesSayWhyTheAudioWent() {
    let clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    let now = WireTime.date("2026-10-10T12:00:00.000Z")!
    let purged = RecordingRetention(
        id: "a", startedAt: WireTime.date("2026-09-28T13:30:00.000Z"), endedAt: WireTime.date("2026-09-28T13:45:00.000Z"),
        audioKept: false, audioBytes: 0, audioDeleteAfter: nil, audioDeletedAt: WireTime.date("2026-09-30T09:00:00.000Z"),
        audioDeletedReason: "owner", transcriptPath: nil, transcriptDeleteAfter: WireTime.date("2026-10-28T13:45:00.000Z")
    )
    #expect(purged.line(clock: clock, now: now) == "28 Sep, 1:30 PM · 15m · audio deleted")
    #expect(purged.retentionLine(clock: clock, now: now) == "Audio deleted 30 Sep, 9:00 AM by Purge Now; the transcript remains until 28 Oct, 1:45 PM")
    #expect(RecordingRetention.size(26_214_400) == "26 MB")
    #expect(RecordingRetention.size(1_500_000_000) == "1.5 GB")
    #expect(RecordingRetention.size(512) == "512 B")
}

// MARK: - Purge Now: confirmed first, one door

@MainActor
@Test func purgeNowNamesEachRecordingAndReachesTheRecorderOnlyOnConfirm() async throws {
    let recorder = FakeRecorder()
    let (model, console) = try liveCaptureReading(client: recorder, transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    #expect(model.purgeUnavailableReason == nil)
    console.reset()

    // pressing it: the confirm, and nothing sent anywhere
    model.purgeNow()
    let confirm = try #require(model.confirmation)
    #expect(confirm.title == "Purge 1 Recording Now?")
    #expect(confirm.confirm == LiveCapturePaneWords.purgeNow)
    #expect(confirm.alternative == nil, "there is no fold to run first for audio — the transcript is already in the vault")
    #expect(confirm.destructive)
    #expect(confirm.costHeading.contains("26 MB"))
    #expect(confirm.costs == ["28 Sep, 1:30 PM · 15m · 26 MB"])
    #expect(recorder.purged.isEmpty)
    #expect(console.calls.isEmpty)

    // Cancel: nothing
    await model.choose(.cancel)
    #expect(model.confirmation == nil)
    #expect(recorder.purged.isEmpty)

    // Purge Now: one purge per kept recording, by id, then the count is re-read
    model.purgeNow()
    await model.choose(.confirm)
    #expect(recorder.purged == ["20260928-133000-00ab"])
    #expect(model.note?.kind == .done)
    #expect(model.note?.text.hasPrefix("Purged 1 recording") == true, "\(String(describing: model.note))")
    #expect(console.calls.contains { $0.path == "/api/recordings/20260928-133000-00ab" }, "re-read after the purge")
}

@MainActor
@Test func aRefusedPurgeIsSaidInTheRecordersWords() async throws {
    let recorder = FakeRecorder(refusingPurge: "session 20260928-133000-00ab is still recording")
    let (model, _) = try liveCaptureReading(client: recorder, transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    model.purgeNow()
    await model.choose(.confirm)
    #expect(recorder.purged == ["20260928-133000-00ab"])
    #expect(model.note?.kind == .failed)
    #expect(model.note?.text.contains("still recording") == true, "\(String(describing: model.note))")
}

@MainActor
@Test func theBridgeClientSendsPurgeAsTheControlRouteWithTheIdAlone() async throws {
    // the real client over a scripted transport: POST /recording/purge, body {session_id}, the control key as bearer
    let wire = ScriptedTransport()
    let client = BridgeLiveCaptureClient(transport: wire, keys: ScriptedKeys(), instanceID: { "inst-1" })
    let answer = await client.purge("20260928-133000-00ab")
    let purged = try #require(try? answer.get())
    #expect(purged.sessionID == "20260928-133000-00ab" && purged.mediaBytes == 0 && purged.audioDeletedReason == "owner")
    let sent = try #require(wire.sent.last)
    #expect(sent.route == .purge && sent.route.isControl)
    #expect(sent.key == "control-key")
    let body = try JSONSerialization.jsonObject(with: try #require(sent.body)) as? [String: String]
    #expect(body == ["session_id": "20260928-133000-00ab"], "the body is the id and nothing else")
    // a read-only key is refused before anything is asked of the recorder: the client says so
    wire.forbid = true
    let refused = await client.purge("20260928-133000-00ab")
    #expect(refused == .failure(.notControlKey))
}

// MARK: - The view

@MainActor
@Test func theLiveCapturePaneSpeaksEveryControlInBothStates() async throws {
    let (model, _) = try liveCaptureReading(client: FakeRecorder(), transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    let id = "com.foldedspacelabs.metistry.tests.capture-bar-view.\(UUID().uuidString)"
    defer { UserDefaults.standard.removePersistentDomain(forName: id) }
    let bar = CaptureBarPreferences(defaults: UserDefaults(suiteName: id)!)
    var opened = 0
    let actions = SettingsActions(openSystemSettings: { opened += 1 }, displays: { [CaptureBarDisplay(id: 1, name: "Built-in Retina Display", isMain: true), CaptureBarDisplay(id: 2, name: "Studio Display", isMain: false)] })

    let present = try await AccessibilityProbe.snapshot(
        LiveCapturePaneBody(pane: model, bar: bar, actions: actions, assistantName: "Aide").frame(width: SettingsLayout.pane)
    )
    defer { present.close() }
    #expect(present.unlabeledBesidesFields.isEmpty, "unlabeled: \(present.unlabeledBesidesFields)")
    #expect(present.headings.contains("The Floating Bar") && present.headings.contains("Permissions") && present.headings.contains("What Aide Keeps") && present.headings.contains("Recordings"), "\(present.headings)")
    // the two edges are drawn, and spoken
    #expect(present.controlNames.contains("Left edge") && present.controlNames.contains("Right edge"), "\(present.controlNames)")
    #expect(present.controlNames.contains("Show the floating bar"))
    // whether, not when — per grant
    #expect(present.nodes.contains { $0.name.hasPrefix("Microphone: Approved") }, "\(present.nodes.map(\.name).filter { $0.hasPrefix("Micro") })")
    #expect(present.nodes.contains { $0.name.hasPrefix("Screen Recording: Not approved") })
    // the verb says what it will destroy
    #expect(present.controlNames.contains("\(LiveCapturePaneWords.purgeNow): 26 MB in 1 recording"), "\(present.controlNames)")
    // what is kept: the rulings, no path
    let said = present.nodes.map(\.name).joined(separator: "\n")
    #expect(said.contains(LiveCapturePaneWords.keepsAudio) && said.contains(LiveCapturePaneWords.keepsTranscript) && said.contains(LiveCapturePaneWords.keepsNotes))
    #expect(!said.contains(".metistry"), "no paths in a settings pane (screen-11 §8)")

    // absent: no bridge — the panel, and none of the controls
    let (absentModel, _) = try liveCaptureReading(client: FakeRecorder(status: .absent), transcripts: [])
    await absentModel.refresh()
    #expect(absentModel.presence == .absent)
    let absent = try await AccessibilityProbe.snapshot(
        LiveCapturePaneBody(pane: absentModel, bar: bar, actions: actions, assistantName: "Aide").frame(width: SettingsLayout.pane)
    )
    defer { absent.close() }
    #expect(absent.unlabeledBesidesFields.isEmpty)
    #expect(absent.nodes.contains { $0.name.contains(LiveCapturePaneWords.absentTitle) }, "\(absent.nodes.map(\.name))")
    #expect(!absent.controlNames.contains("Show the floating bar"), "no bridge, no bar switch: \(absent.controlNames)")
    #expect(!absent.controlNames.contains { $0.hasPrefix(LiveCapturePaneWords.purgeNow) })
}

// MARK: - Fixtures

/// A recorder as the pane sees it through the bar's client: there or not, its
/// grants, and what it was asked to purge.
private final class FakeRecorder: LiveCaptureClient, @unchecked Sendable {
    enum Status { case ok, absent, noKey }

    private let lock = NSLock()
    private var _purged: [String] = []
    let status: Status
    let purgeRefusal: String?

    init(status: Status = .ok, refusingPurge: String? = nil) {
        self.status = status
        purgeRefusal = refusingPurge
    }

    var purged: [String] { lock.withLock { _purged } }

    private var refusal: LiveCaptureError? {
        switch status {
        case .ok: return nil
        case .absent: return .absent
        case .noKey: return .noKey(LiveCaptureWords.noKey)
        }
    }

    func state() async -> Result<LiveCaptureState, LiveCaptureError> {
        refusal.map { .failure($0) } ?? .success(LiveCaptureState(phase: .idle))
    }

    func start(_ request: LiveCaptureStart) async -> Result<LiveCaptureSession, LiveCaptureError> { .failure(refusal ?? .absent) }
    func stop() async -> Result<LiveCaptureSession?, LiveCaptureError> { .failure(refusal ?? .absent) }
    func keepGoing() async -> Result<Bool, LiveCaptureError> { .failure(refusal ?? .absent) }

    func grants() async -> Result<[String: String], LiveCaptureError> {
        refusal.map { .failure($0) } ?? .success(["microphone": "granted", "audio_capture": "unverified", "screen_recording": "not_granted"])
    }

    func purge(_ sessionID: String) async -> Result<LiveCapturePurged, LiveCaptureError> {
        lock.withLock { _purged.append(sessionID) }
        if let refusal { return .failure(refusal) }
        if let purgeRefusal { return .failure(.refused(code: "recording", message: purgeRefusal)) }
        return .success(LiveCapturePurged(sessionID: sessionID, mediaBytes: 0, audioDeletedAt: "2026-09-30T12:30:00Z", audioDeletedReason: "owner"))
    }
}

/// The wire under the real client, scripted: records what was sent and
/// answers a purge as the bridge would.
private final class ScriptedTransport: LiveCaptureTransport, @unchecked Sendable {
    struct Sent { let route: LiveCaptureRoute; let body: Data?; let key: String? }
    private let lock = NSLock()
    private var _sent: [Sent] = []
    var forbid = false
    var sent: [Sent] { lock.withLock { _sent } }

    func send(_ route: LiveCaptureRoute, body: Data?, key: LiveCaptureControlKey?) async -> LiveCaptureWireResult {
        lock.withLock { _sent.append(Sent(route: route, body: body, key: key?.value)) }
        if forbid && route.isControl {
            return .answered(status: 403, body: Data(#"{"error":{"code":"forbidden","message":"not granted"}}"#.utf8))
        }
        let id = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["session_id"] as? String ?? "?"
        return .answered(status: 200, body: Data(#"{"session_id":"\#(id)","media_bytes":0,"audio_deleted_at":"2026-09-30T12:30:00Z","audio_deleted_reason":"owner","as_of":"2026-09-30T12:30:00Z"}"#.utf8))
    }
}

private struct ScriptedKeys: LiveCaptureKeySource {
    func controlKey(instanceID: String) async -> LiveCaptureKeyLookup { .found(LiveCaptureControlKey("control-key")) }
}

/// A `LiveCaptureModel` over the recorded console with the transcripts list
/// replaced — the recorder never records a `Journal/Transcripts` window — and
/// the recorder as given.
@MainActor
private func liveCaptureReading(client: any LiveCaptureClient, transcripts: [String]) throws -> (LiveCaptureModel, FixtureConsole) {
    let fixtures = try ConsoleFixture.loadAll().map { f -> ConsoleFixture in
        guard f.stem == "get-api-knowledge-pages" else { return f }
        let pages: [[String: Any]] = transcripts.map { path in
            ["path": path, "area": "Journal", "title": String(path.split(separator: "/").last ?? ""), "description": NSNull(), "status": "clean", "modified": "2026-09-28T13:47:00.000Z", "indexed_at": "2026-09-28T13:47:00.000Z"]
        }
        return try f.replacingReply(["pages": pages, "area": NSNull(), "prefix": "Journal/Transcripts", "limit": 100, "offset": 0, "as_of": "2026-09-30T05:00:00.000Z"])
    }
    let console = FixtureConsole(fixtures)
    let session = ConsoleSession(transport: console, management: nil)
    let model = LiveCaptureModel(session: session)
    model.client = client
    model.clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    model.now = { ConsoleFixture.asOf("get-api-recordings-id") }
    return (model, console)
}
#endif
