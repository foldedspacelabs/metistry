// Settings ▸ Live Capture (T6-15; screen-11 §8, plan §2.15).
//
// The bar's switch and placement are the one thing this Mac stores, and the
// only defaults key they touch is their own; the permissions are the
// recorder's words read off doctor's bridge row, never granted here; the
// recordings are read through the API (the transcripts name them, T8-4's
// route says what each still keeps); and Purge Now — the bridge's door,
// through `LiveCaptureClient.purge` — confirms first, naming each recording,
// sends nothing until then, and is off with its reason when the app holds no
// client. Absent, not off, without the bridge.

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

// MARK: - Permissions: the recorder's words, read through

@Test func theGrantsAreReadOffDoctorsBridgeRowAndSayWhetherNotWhen() throws {
    let row = try bridgeRow(status: "ok", grants: ["microphone": "granted", "audio_capture": "unverified", "screen_recording": "not_granted"])
    let grants = try #require(CaptureGrant.read(row))
    #expect(grants.map(\.kind.title) == ["Microphone", "Audio Capture", "Screen Recording"])
    #expect(grants.map(\.state) == ["Approved", "Not yet verified", "Not approved"])
    #expect(grants.map(\.isApproved) == [true, false, false])
    #expect(CaptureGrant(kind: .microphone, wire: "not_asked").state == "Not yet asked")
    #expect(CaptureGrant(kind: .audioCapture, wire: "observed").state == "Approved")
    #expect(CaptureGrant(kind: .microphone, wire: "denied").state == "Denied")
    // a word this build does not know is shown as the recorder said it, never guessed at
    #expect(CaptureGrant(kind: .microphone, wire: "pending_review").state == "pending_review")
    // no grants on the row: nil, and the pane says the recorder did not report them
    #expect(CaptureGrant.read(try bridgeRow(status: "failed", grants: nil)) == nil)
    #expect(CaptureGrant.read(nil) == nil)
}

@MainActor
@Test func withoutTheBridgeThePaneIsAbsentNotOff() async throws {
    // doctor has not answered: unknown
    let none = StatusModel(cli: nil)
    let model = LiveCaptureModel(session: nil, status: none)
    #expect(model.presence == .unknown)
    // doctor answered with no live-capture row, or one that is absent: absent
    #expect(try await presence(rows: []) == .absent)
    #expect(try await presence(rows: [bridgeRowJSON(status: "absent", grants: nil)]) == .absent)
    // a bridge in any other state is present, whatever doctor thinks of it
    #expect(try await presence(rows: [bridgeRowJSON(status: "degraded", grants: ["microphone": "not_asked"])]) == .present(.degraded))
    #expect(try await presence(rows: [bridgeRowJSON(status: "ok", grants: ["microphone": "granted"])]) == .present(.ok))
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
    let (model, console, _) = try await liveCaptureReading(transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
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
    let (empty, _, _) = try await liveCaptureReading(transcripts: [])
    await empty.refresh()
    #expect(empty.countLine == "No audio kept")
    #expect(empty.recordings.isEmpty)
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

// MARK: - Purge Now: confirmed first, one door, off without the recorder

@MainActor
@Test func purgeNowNamesEachRecordingAndReachesTheRecorderOnlyOnConfirm() async throws {
    let (model, console, _) = try await liveCaptureReading(transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    let recorder = RecordingPurger()
    model.client = recorder
    await model.refresh()
    #expect(model.purgeUnavailableReason == nil)
    console.reset()

    // pressing it: the confirm, and nothing sent anywhere
    model.purgeNow()
    let confirm = try #require(model.confirmation)
    #expect(confirm.title == "Purge 1 Recording Now?")
    #expect(confirm.confirm == LiveCaptureWords.purgeNow)
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
@Test func withoutARecorderClientPurgeNowIsOffWithItsReasonAndSendsNothing() async throws {
    let (model, console, _) = try await liveCaptureReading(transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    #expect(model.client == nil)
    #expect(model.countLine == "26 MB in 1 recording", "the count is still read — the rule still applies")
    #expect(model.purgeUnavailableReason == LiveCaptureWords.purgeNeedsTheRecorder)
    console.reset()
    model.purgeNow()
    #expect(model.confirmation == nil)
    await model.choose(.confirm)
    #expect(console.calls.isEmpty)
}

@MainActor
@Test func aRefusedPurgeIsSaidInTheRecordersWords() async throws {
    let (model, _, _) = try await liveCaptureReading(transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    let recorder = RecordingPurger(refusing: "session 20260928-133000-00ab is still recording")
    model.client = recorder
    await model.refresh()
    model.purgeNow()
    await model.choose(.confirm)
    #expect(recorder.purged == ["20260928-133000-00ab"])
    #expect(model.note?.kind == .failed)
    #expect(model.note?.text.contains("still recording") == true, "\(String(describing: model.note))")
}

// MARK: - The view

@MainActor
@Test func theLiveCapturePaneSpeaksEveryControlInBothStates() async throws {
    let (model, _, status) = try await liveCaptureReading(transcripts: ["Journal/Transcripts/2026-09-28-20260928-133000-00ab.md"])
    await model.refresh()
    let id = "com.foldedspacelabs.metistry.tests.capture-bar-view.\(UUID().uuidString)"
    defer { UserDefaults.standard.removePersistentDomain(forName: id) }
    let bar = CaptureBarPreferences(defaults: UserDefaults(suiteName: id)!)
    var opened = 0
    let actions = SettingsActions(openSystemSettings: { opened += 1 }, displays: { [CaptureBarDisplay(id: 1, name: "Built-in Retina Display", isMain: true), CaptureBarDisplay(id: 2, name: "Studio Display", isMain: false)] })

    let present = try await AccessibilityProbe.snapshot(
        LiveCapturePaneBody(pane: model, bar: bar, status: status, actions: actions, assistantName: "Aide").frame(width: SettingsLayout.pane)
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
    #expect(present.controlNames.contains("\(LiveCaptureWords.purgeNow): 26 MB in 1 recording"), "\(present.controlNames)")
    // what is kept: the rulings, no path
    let said = present.nodes.map(\.name).joined(separator: "\n")
    #expect(said.contains(LiveCaptureWords.keepsAudio) && said.contains(LiveCaptureWords.keepsTranscript) && said.contains(LiveCaptureWords.keepsNotes))
    #expect(!said.contains(".metistry"), "no paths in a settings pane (screen-11 §8)")

    // absent: no bridge — the panel, and none of the controls
    let absentStatus = try statusReporting(rows: [])
    await absentStatus.refresh()
    let absentModel = LiveCaptureModel(session: nil, status: absentStatus)
    #expect(absentModel.presence == .absent)
    let absent = try await AccessibilityProbe.snapshot(
        LiveCapturePaneBody(pane: absentModel, bar: bar, status: absentStatus, actions: actions, assistantName: "Aide").frame(width: SettingsLayout.pane)
    )
    defer { absent.close() }
    #expect(absent.unlabeledBesidesFields.isEmpty)
    #expect(absent.nodes.contains { $0.name.contains(LiveCaptureWords.absentTitle) }, "\(absent.nodes.map(\.name))")
    #expect(!absent.controlNames.contains("Show the floating bar"), "no bridge, no bar switch: \(absent.controlNames)")
    #expect(!absent.controlNames.contains { $0.hasPrefix(LiveCaptureWords.purgeNow) })
}

// MARK: - Fixtures

/// A recorder that records what it was asked to purge and answers as told.
private final class RecordingPurger: LiveCaptureClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _purged: [String] = []
    let refusal: String?

    init(refusing: String? = nil) { refusal = refusing }

    var purged: [String] { lock.withLock { _purged } }

    func state() async -> Result<LiveCaptureState, LiveCaptureError> { .failure(.absent) }
    func start(_ scope: LiveCaptureScope) async -> Result<LiveCaptureState, LiveCaptureError> { .failure(.absent) }
    func stop() async -> Result<LiveCaptureStopped, LiveCaptureError> { .failure(.absent) }

    func purge(_ sessionID: String) async -> Result<LiveCaptureRetention, LiveCaptureError> {
        lock.withLock { _purged.append(sessionID) }
        if let refusal { return .failure(.refused(refusal)) }
        return .success(LiveCaptureRetention(json: .object(["session_id": .string(sessionID), "media_bytes": .number(0), "audio_deleted_reason": .string("owner")])))
    }
}

/// Answers `metistry doctor --json` with one canned report.
private struct DoctorRunner: CommandRunner {
    let report: String

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: arguments.first == "doctor" ? report : "", stderr: "")
    }
}

private func doctorJSON(rows: [String]) -> String {
    #"{"as_of":"2026-09-30T05:00:00.000Z","product_dir":"/tmp/product","shape":"launchd","ok":true,"rows":[\#(rows.joined(separator: ","))]}"#
}

/// A `live-capture` bridge row as doctor reports it: the recorder's `check()` meta under `bridge_meta`.
private func bridgeRowJSON(status: String, grants: [String: String]?) -> String {
    var meta = "{\"probe\":\"asked the helper for its grant states\""
    if let grants {
        let pairs = grants.sorted { $0.key < $1.key }.map { "\"\($0.key)\":\"\($0.value)\"" }.joined(separator: ",")
        meta += ",\"bridge_meta\":{\"grants\":{\(pairs)},\"recording\":false,\"os\":\"26.4\"}"
    }
    meta += "}"
    return "{\"name\":\"live-capture\",\"kind\":\"bridge\",\"status\":\"\(status)\",\"latency_ms\":3,\"probe\":\"GET /check\",\"remediation\":\"the bridge said so\",\"meta\":\(meta)}"
}

private func bridgeRow(status: String, grants: [String: String]?) throws -> DoctorRow {
    try JSONDecoder().decode(DoctorRow.self, from: Data(bridgeRowJSON(status: status, grants: grants).utf8))
}

@MainActor
private func statusReporting(rows: [String]) throws -> StatusModel {
    let runtime = MetistryRuntime(source: .path, executable: URL(fileURLWithPath: "/usr/local/bin/metistry"))
    let cli = MetistryCLI(runtime: runtime, runner: DoctorRunner(report: doctorJSON(rows: rows)), instanceDir: URL(fileURLWithPath: "/tmp/instance"))
    return StatusModel(cli: cli)
}

@MainActor
private func presence(rows: [String]) async throws -> LiveCaptureModel.Presence {
    let status = try statusReporting(rows: rows)
    await status.refresh()
    return LiveCaptureModel(session: nil, status: status).presence
}

/// A `LiveCaptureModel` over the recorded console with the transcripts list
/// replaced — the recorder never records a `Journal/Transcripts` window — and
/// doctor reporting a healthy bridge whose grants are one of each.
@MainActor
private func liveCaptureReading(transcripts: [String]) async throws -> (LiveCaptureModel, FixtureConsole, StatusModel) {
    let fixtures = try ConsoleFixture.loadAll().map { f -> ConsoleFixture in
        guard f.stem == "get-api-knowledge-pages" else { return f }
        let pages: [[String: Any]] = transcripts.map { path in
            ["path": path, "area": "Journal", "title": String(path.split(separator: "/").last ?? ""), "description": NSNull(), "status": "clean", "modified": "2026-09-28T13:47:00.000Z", "indexed_at": "2026-09-28T13:47:00.000Z"]
        }
        return try f.replacingReply(["pages": pages, "area": NSNull(), "prefix": "Journal/Transcripts", "limit": 100, "offset": 0, "as_of": "2026-09-30T05:00:00.000Z"])
    }
    let console = FixtureConsole(fixtures)
    let session = ConsoleSession(transport: console, management: nil)
    let status = try statusReporting(rows: [bridgeRowJSON(status: "ok", grants: ["microphone": "granted", "audio_capture": "unverified", "screen_recording": "not_granted"])])
    await status.refresh()
    let model = LiveCaptureModel(session: session, status: status)
    model.clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    model.now = { ConsoleFixture.asOf("get-api-recordings-id") }
    return (model, console, status)
}
#endif
