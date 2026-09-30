// The floating bar (T8-5, screen 11 §2–§7). The ticket's misuse tests first
// (U2): **the bar never sends a start that names a window, a display or an
// app list for a picture**; **a lost control key turns recording off with
// the reason**; **the tool token never reaches the bar**. Then the jots and
// their session anchor, the menu, the breath under Reduce Motion, the glass
// floors, and §2.18. Every bridge here is a fake: nothing connects to the
// recorder's port, reads the Keychain or starts a recording.

import Foundation
import SwiftUI
import Testing
#if os(macOS)
import AppKit
#endif

@testable import MetistryKit

// MARK: - U2: a picture start names nothing

@MainActor
@Test func aPictureStartNeverNamesAWindowADisplayOrApps() async throws {
    // Every body the sheet can build: picture modes carry exactly the mode and two switches.
    for mode in [LiveCaptureMode.window, .screen] {
        for appAudio in [true, false] {
            for microphone in [true, false] {
                var sheet = CaptureRecordSheet()
                sheet.mode = mode
                sheet.apps = ["us.zoom.xos"]      // left over from Audio only: must not ride along
                sheet.appAudio = appAudio
                sheet.microphone = microphone
                let body = try #require(sheet.start?.body)
                #expect(Set(body.objectKeys) == LiveCaptureStart.pictureFields, "\(mode): \(body.objectKeys)")
                #expect(body["mode"]?.stringValue == mode.rawValue)
                #expect(body["apps"] == nil)
            }
        }
    }
    // Audio only names bundle ids, and nothing else.
    var audio = CaptureRecordSheet()
    audio.mode = .audioOnly
    audio.apps = ["us.zoom.xos"]
    let body = try #require(audio.start?.body)
    #expect(Set(body.objectKeys) == LiveCaptureStart.audioOnlyFields)
    #expect(body["apps"] == .array([.string("us.zoom.xos")]))

    // …and on the wire, through the real client, the bytes are exactly that.
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: "control-key"))
    await bar.refresh()
    bar.open(.record)
    bar.sheet.mode = .window
    bar.sheet.apps = ["com.apple.Safari"]
    await bar.beginRecording()
    let start = try #require(wire.sent.first { $0.route == .start })
    let sent = try JSONDecoder().decode(JSONValue.self, from: try #require(start.body))
    #expect(sent == .object(["mode": .string("window"), "app_audio": .bool(true), "microphone": .bool(true)]), "sent: \(sent)")
    for forbidden in ["window_id", "display_id", "filter", "apps", "pid"] {
        #expect(sent[forbidden] == nil, "\(forbidden) on a picture start")
    }
}

// MARK: - U2: a lost key turns recording off, with the reason

@MainActor
@Test func aLostControlKeyTurnsRecordingOffWithTheReason() async throws {
    // The bridge is here (it answers a request with no credential: 401), and
    // this Mac has no key for it.
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: nil))
    var lit: [ShellCommand] = []
    bar.onActions = { lit = Array($0.keys) }

    await bar.refresh()
    #expect(bar.availability == .recordingOff(LiveCaptureWords.noKey))
    #expect(bar.isShown, "the bar is here — the bridge is")
    #expect(bar.recordingOffBecause?.contains(LiveCaptureWords.mint) == true, "the reason names the verb that fixes it")
    #expect(!lit.contains(.startRecording) && !lit.contains(.stopRecording), "Record is off: \(lit)")
    #expect(Set(lit).isSuperset(of: [.ask, .note, .todo]), "jots and Ask still work — they go through the console")

    // Record, pressed anyway: the sheet says why; nothing is sent.
    bar.open(.record)
    await bar.beginRecording()
    #expect(!wire.sent.contains { $0.route == .start }, "no start without a key")
    #expect(wire.sent.allSatisfy { $0.key == nil }, "the probe carries no credential at all")

    // The owner mints one and presses Try Again.
    wire.keyInKeychain = "control-key"
    await bar.tryAgain()
    #expect(bar.availability == .ready)

    // No bridge at all: no bar, and nothing lit.
    let gone = FakeBridge(status: .idle)
    gone.listening = false
    let (hidden, _) = barModel(client: gone.client(key: nil))
    var hiddenLit: [ShellCommand] = [.ask]
    hidden.onActions = { hiddenLit = Array($0.keys) }
    await hidden.refresh()
    #expect(hidden.availability == .absent && !hidden.isShown)
    #expect(hiddenLit.isEmpty, "absent, not off: no items")
}

@MainActor
@Test func aRefusedKeyIsReadOnceMoreThenShownAndNeverRetriedOnItsOwn() async throws {
    let wire = FakeBridge(status: .idle)
    wire.acceptedKey = "the-one-the-bridge-was-started-with"
    let (bar, _) = barModel(client: wire.client(key: "a-stale-key"))
    var polls: [TimeInterval] = []
    bar.schedule = { delay, _ in polls.append(delay) }
    bar.start()
    try await waitUntil { bar.availability != .unknown }
    #expect(bar.availability == .recordingOff(LiveCaptureWords.keyRefused))
    #expect(wire.sent.filter { $0.route == .status }.count == 1, "the same key is not sent twice")
    #expect(polls.isEmpty, "a key problem waits for the owner, it is not polled")

    // A key minted since is read afresh and tried once.
    wire.keyInKeychain = "the-one-the-bridge-was-started-with"
    wire.sent.removeAll()
    await bar.tryAgain()
    #expect(bar.availability == .ready)
}

// MARK: - U2: the tool token never reaches the bar

@MainActor
@Test func theToolTokenNeverReachesTheBar() async throws {
    // If the item filed as the control key held the bridge's read-only tool
    // token, the bridge answers a control route 403: Record goes off with the
    // reason, and nothing is retried.
    let wire = FakeBridge(status: .idle)
    wire.readOnlyKey = "a-tool-token"
    let (bar, _) = barModel(client: wire.client(key: "a-tool-token"))
    await bar.refresh()
    #expect(bar.availability == .ready, "reads are the tool token's")
    bar.open(.record)
    await bar.beginRecording()
    #expect(bar.availability == .recordingOff(LiveCaptureWords.notControlKey))
    #expect(wire.sent.filter { $0.route == .start }.count == 1, "one refused start, never a second")
    await bar.refresh()
    #expect(bar.availability == .recordingOff(LiveCaptureWords.notControlKey), "a read that still works does not un-say it")
    await bar.beginRecording()
    #expect(wire.sent.filter { $0.route == .start }.count == 1, "and Record stays off")

    // The key source asks the Keychain for the control key's service and no other.
    #expect(KeychainLiveCaptureKeySource.service == "metistry:METISTRY_LIVE_CAPTURE_CONTROL_TOKEN")
    let sources = try appSources()
    let named = sources.filter { $0.body.contains("BRIDGE_TOKEN_LIVE_CAPTURE") }.map(\.name)
    #expect(named.isEmpty, "the tool token is named in \(named)")

    // A key never prints: not in a description, a dump, or a word the bar says.
    let secret = LiveCaptureControlKey("s3cret-value-never-shown")
    #expect(!"\(secret)".contains("s3cret") && !String(reflecting: secret).contains("s3cret"))
    var dumped = ""
    dump(secret, to: &dumped)
    #expect(!dumped.contains("s3cret"), "\(dumped)")
    let refused = FakeBridge(status: .idle)
    refused.acceptedKey = "other"
    let (said, _) = barModel(client: refused.client(key: "s3cret-value-never-shown"))
    await said.refresh()
    let words = [said.recordingOffBecause ?? "", said.startProblem ?? "", LiveCaptureError.keyRefused.errorDescription ?? ""].joined()
    #expect(!words.contains("s3cret"), "\(words)")
}

// MARK: - The wire's shape

@Test func theBridgesStatusReadsAsTheRailDrawsIt() throws {
    // `helper/sources/kit/wire.swift`'s `statusJSON` plus the bridge's own
    // `delivery` and `as_of` (src/index.ts).
    let json = """
    {"state":"recording","elapsed_s":823.4,"stops_at":"2026-09-30T22:00:00Z","reminder_due_hours":null,
     "disk_low_free_bytes":null,"senses":{"display":true,"app_audio":true,"microphone":true},
     "session":{"session_id":"20260930-120000-00ab","started_at":"2026-09-30T12:00:00Z","state":"recording",
                "mode":"window","picture":{"kind":"window","bundle_id":"us.zoom.xos"},"apps":[],"app_audio":true,
                "microphone":true,"gaps":[],"processes":[],"app_audio_observed":false,"reminders_raised":0},
     "delivery":{"owed":0},"as_of":"2026-09-30T12:13:43Z"}
    """
    let state = try JSONDecoder().decode(LiveCaptureState.self, from: Data(json.utf8))
    #expect(state.phase == .recording && state.isRunning)
    #expect(state.senses == LiveCaptureSenses(display: true, appAudio: true, microphone: true))
    #expect(state.session?.mode == .window && state.session?.pictureKind == "window" && state.session?.pictureBundleID == "us.zoom.xos")
    #expect(state.elapsed == 823.4)

    let ended = try JSONDecoder().decode(LiveCaptureState.self, from: Data("""
    {"state":"idle","session":{"session_id":"20260930-120000-00ab","started_at":"x","state":"ended","ended_reason":"picture_lost"},
     "elapsed_s":null,"stops_at":null,"reminder_due_hours":null,"disk_low_free_bytes":null,
     "senses":{"display":false,"app_audio":false,"microphone":false}}
    """.utf8))
    #expect(ended.phase == .idle && ended.session?.endedReason == "picture_lost")
}

@Test func theBridgesPortIsTheManifests() throws {
    let manifest = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/mcp-live-capture/manifest.yaml")
    let text = try String(contentsOf: manifest, encoding: .utf8)
    #expect(text.contains("\nport: \(LiveCaptureBridge.port) "), "the manifest's port is \(LiveCaptureBridge.port)")
    #expect(LiveCaptureRoute.allCases.filter(\.isControl).map(\.path).sorted() == ["/recording/keep-going", "/recording/purge", "/recording/start", "/recording/stop"])
}

// MARK: - Note and To-do

@MainActor
@Test func aJotDuringARecordingCarriesItsSessionAndOffset() async throws {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)
    let wire = FakeBridge(status: .recording(elapsed: 754, senses: LiveCaptureSenses(display: true, appAudio: true, microphone: true)))
    let (bar, console) = barModel(client: wire.client(key: "k"))
    bar.now = { t0 }
    await bar.refresh()

    bar.open(.note)
    bar.jotText = "He is measuring against last year, not the comparables"
    await bar.saveJot()
    let posted = try #require(console.calls.last { $0.path == "/capture" })
    let note = try #require(posted.body?["note"]?.stringValue)
    #expect(note == """
    ---
    kind: "jot"
    jot: "note"
    title: "He is measuring against last year, not the comparables"
    capture_session: "20260930-120000-00ab"
    offset_s: 754
    ---
    He is measuring against last year, not the comparables
    """, "\(note)")
    #expect(posted.idempotencyKey?.isEmpty == false, "one key, minted once, like every capture")
    #expect(bar.panel == nil, "Return saves and closes")
    #expect(bar.jotConfirmation?.text(clock: ClockTime()).hasPrefix("Noted ") == true)
    #expect(bar.sessionJotLine == "This session · 1 note")

    // At rest a To-do is a line the drain already reads as one.
    let (rest, restConsole) = barModel(client: FakeBridge(status: .idle).client(key: "k"))
    await rest.refresh()
    rest.open(.todo)
    rest.jotText = "Send him the comparables before Friday"
    await rest.saveJot()
    #expect(restConsole.calls.last { $0.path == "/capture" }?.body?["note"]?.stringValue == "- [ ] Send him the comparables before Friday")
    #expect(rest.sessionJotLine == nil)
}

@MainActor
@Test func aRefusedJotKeepsItsWordsInTheBarNotTheComposer() async throws {
    let console = RefusingCaptureConsole()
    let session = ConsoleSession(transport: console, management: nil)
    let composer = CaptureComposerModel(session: session)
    composer.announce = { _ in }
    composer.draft = "the owner's other thought"
    let bar = CaptureBarModel(client: FakeBridge(status: .idle).client(key: "k"), composer: composer, chat: nil)
    quiet(bar)
    await bar.refresh()
    bar.open(.note)
    bar.jotText = "Volume tier claim needs checking"
    await bar.saveJot()
    #expect(bar.jotText == "Volume tier claim needs checking")
    #expect(bar.jotProblem == "inbox write failed")
    #expect(bar.panel == .note, "the field stays open with the words")
    #expect(composer.draft == "the owner's other thought", "the composer's field is not the bar's")
    #expect(composer.line == .none, "a refused jot does not take the composer's line")
    withExtendedLifetime(session) {}
}

// MARK: - The menu, Stop and the end of a session

@MainActor
@Test func stopIsLitOnlyWhileRecordingAndAnEndedPictureSaysWhy() async throws {
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: "k"))
    var lit: Set<ShellCommand> = []
    bar.onActions = { lit = Set($0.keys) }
    var announced: [String] = []
    bar.announce = { announced.append($0) }

    await bar.refresh()
    #expect(lit == [.ask, .note, .todo, .startRecording, .hideCaptureBar])

    wire.status = .recording(elapsed: 240, senses: LiveCaptureSenses(display: true, appAudio: true, microphone: true))
    await bar.refresh()
    #expect(lit == [.ask, .note, .todo, .stopRecording, .hideCaptureBar])
    #expect(announced == ["Recording, 4 minutes. Window and microphone"], "the status, once")
    await bar.refresh()
    #expect(announced.count == 1, "…and only once")
    #expect(bar.railControls.map(\.spoken) == ["Ask", "Note", "To-do", "Stop recording"])

    // The window closed: the recorder ended the session as picture_lost.
    wire.status = .ended("picture_lost")
    await bar.refresh()
    #expect(bar.ended?.reason == "picture_lost")
    #expect(bar.ended?.words.contains("window closed") == true)
    #expect(lit.contains(.startRecording) && !lit.contains(.stopRecording))
}

// MARK: - The breath, the glass, the idle fade

@MainActor
@Test func theBreathHoldsStillUnderReduceMotion() {
    let still = CaptureBarBreath(reduceMotion: true)
    #expect(!still.breathes)
    #expect(still.animation == nil, "nothing is animated")
    #expect(still.frame(out: false) == still.frame(out: true), "both ends are one frame")
    #expect(still.frame(out: true) == CaptureBarBreath.Frame(scale: 1.5, opacity: 0.4), "held at its widest, and visible")
    #expect(CaptureBarBreathingMark(reduceMotion: true).breath == still)

    let live = CaptureBarBreath(reduceMotion: false)
    #expect(live.breathes && live.animation != nil)
    #expect(live.frame(out: false) == CaptureBarBreath.Frame(scale: 1, opacity: 0.85))
    #expect(live.frame(out: true) == CaptureBarBreath.Frame(scale: 1.5, opacity: 0.12))
    #expect(CaptureBarBreath.period == 2.6)
}

@Test func theGlassNeverDipsUnderItsFloor() {
    // Screen 11 §7: text needs 0.86 (secondary ink in dark measured 0.83);
    // marks only, 0.75; text-tertiary needs 0.81, above the marks floor —
    // so the rail carries no words at all.
    #expect(CaptureBarGlass.textFloor == 0.86 && CaptureBarGlass.marksFloor == 0.75)
    for floor in [CaptureBarGlass.textFloor, CaptureBarGlass.marksFloor] {
        let stops = CaptureBarGlass.scrimStops(floor: floor)
        #expect(stops.allSatisfy { $0.opacity >= floor }, "\(stops)")
        #expect(stops.first!.opacity > stops.last!.opacity, "thicker at the top")
    }
    #expect(0.81 > CaptureBarGlass.marksFloor)
    #expect(CaptureBarGlass.outerRadius - CaptureBarGlass.innerRadius > 0)
}

@MainActor
@Test func onlyTheDecorationFadesAndNeverWhileRecording() async throws {
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: "k"))
    var pending: [@MainActor () async -> Void] = []
    bar.schedule = { _, work in pending.append(work) }
    await bar.refresh()
    bar.noteActivity()
    for work in pending { await work() }
    #expect(bar.decorationFaded, "ten quiet seconds")
    await bar.refresh()
    #expect(bar.decorationFaded, "an idle read of the recorder is not activity")
    bar.noteActivity()
    #expect(!bar.decorationFaded, "the pointer came back")

    pending.removeAll()
    wire.status = .recording(elapsed: 10, senses: .none)
    await bar.refresh()
    bar.noteActivity()
    for work in pending { await work() }
    #expect(!bar.decorationFaded, "never while recording")
}

@Test func aReplyPastFourLinesOpensInChat() {
    #expect(!CaptureBarModel.exceedsReplyLines("He put it 4% over the comparables you pulled."))
    #expect(!CaptureBarModel.exceedsReplyLines(String(repeating: "a", count: 46 * 4)))
    #expect(CaptureBarModel.exceedsReplyLines(String(repeating: "a", count: 46 * 4 + 1)))
    #expect(CaptureBarModel.exceedsReplyLines("one\ntwo\nthree\nfour\nfive"))
}

@MainActor
@Test func anAppModelWithNoBridgeLightsNothing() async throws {
    let name = "com.foldedspacelabs.metistry.tests.capture-bar.\(UUID().uuidString)"
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
    await model.captureBar.refresh()
    #expect(model.captureBar.availability == .absent && !model.captureBar.isShown)
    for command in CaptureBarModel.menuItems {
        #expect(!model.shell.canPerform(command), "\(command) is dimmed with no bridge")
    }
}

// MARK: - §2.18

#if os(macOS)
@MainActor
@Test func theBarSpeaksEveryControlAtRestAndWhileRecording() async throws {
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: "k"))
    bar.assistantName = { "Aide" }
    await bar.refresh()

    var tree = try await AccessibilityProbe.snapshot(CaptureBarView(model: bar))
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty)
    #expect(tree.controlNames.filter { ["Ask Aide", "Note", "To-do", "Start recording. Window and microphone"].contains($0) }.count == 4, "controls: \(tree.controlNames)")
    #expect(tree.labels.contains(CaptureBarWords.group), "the bar is one named group: \(tree.labels)")
    #expect(tree.texts.isEmpty, "the rail carries no words on thin glass: \(tree.texts)")
    tree.close()

    wire.status = .recording(elapsed: 240, senses: LiveCaptureSenses(display: true, appAudio: false, microphone: true))
    await bar.refresh()
    tree = try await AccessibilityProbe.snapshot(CaptureBarView(model: bar))
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.controlNames.contains("Stop recording"), "controls: \(tree.controlNames)")
    #expect(tree.labels.contains { $0.hasPrefix("Recording, 4 minutes. Window and microphone") }, "labels: \(tree.labels)")
    tree.close()
}

@MainActor
@Test func thePanelsSpeakTheirControlsAndGrowLongerNeverWider() async throws {
    let wire = FakeBridge(status: .idle)
    let (bar, _) = barModel(client: wire.client(key: "k"))
    await bar.refresh()

    bar.open(.record)
    var tree = try await AccessibilityProbe.snapshot(CaptureBarRecordSheet(model: bar))
    #expect(tree.unlabeledControls.filter { !["AXTextField", "AXTextArea"].contains($0.role) }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.controlNames.contains("Record") && tree.controlNames.contains("Cancel"), "controls: \(tree.controlNames)")
    #expect(tree.controlNames.contains("App audio") && tree.controlNames.contains("Your microphone, your side only"), "the switches say what they take: \(tree.controlNames)")
    #expect(tree.texts.contains { $0.hasPrefix("macOS picks the window, not us.") }, "texts: \(tree.texts)")
    tree.close()

    let lost = FakeBridge(status: .idle)
    let (off, _) = barModel(client: lost.client(key: nil))
    await off.refresh()
    off.open(.record)
    tree = try await AccessibilityProbe.snapshot(CaptureBarRecordSheet(model: off))
    #expect(tree.texts.contains(LiveCaptureWords.noKey), "the reason, in place: \(tree.texts)")
    #expect(tree.controlNames.contains(StateWords.tryAgain), "controls: \(tree.controlNames)")
    #expect(!tree.controlNames.contains("Record"))
    tree.close()

    bar.open(.ask)
    tree = try await AccessibilityProbe.snapshot(CaptureBarAskPanel(model: bar))
    #expect(tree.unlabeledControls.filter { !["AXTextField", "AXTextArea"].contains($0.role) }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    tree.close()

    func size<V: View>(_ view: V, _ type: DynamicTypeSize) -> CGSize {
        NSHostingView(rootView: view.environment(\.dynamicTypeSize, type)).fittingSize
    }
    bar.open(.record)
    let sheet = (size(CaptureBarRecordSheet(model: bar), .large), size(CaptureBarRecordSheet(model: bar), .accessibility5))
    #expect(sheet.0.width == CaptureBarRecordSheet.width && sheet.1.width == CaptureBarRecordSheet.width, "\(sheet)")
    #expect(sheet.1.height > sheet.0.height)
    let ask = (size(CaptureBarAskPanel(model: bar), .large), size(CaptureBarAskPanel(model: bar), .accessibility5))
    #expect(ask.0.width == CaptureBarModel.askWidth && ask.1.width == CaptureBarModel.askWidth, "\(ask)")
}
#endif

// MARK: - Helpers

/// A bar over the recorded console fixtures (POST /capture, GET /api/messages)
/// and a fake bridge. Nothing is scheduled unless a test says so.
@MainActor
private func barModel(client: any LiveCaptureClient) -> (CaptureBarModel, FixtureConsole) {
    let console = try! FixtureConsole.recorded()
    let session = ConsoleSession(transport: console, management: nil)
    let composer = CaptureComposerModel(session: session)
    composer.announce = { _ in }
    let chat = ChatModel(session: session)
    chat.announce = { _ in }
    chat.watchesInBackground = false
    let bar = CaptureBarModel(client: client, composer: composer, chat: chat)
    quiet(bar)
    retained.append((session, composer, chat))
    return (bar, console)
}

/// The bar holds its composer and chat weakly, as `AppModel` owns them.
@MainActor private var retained: [(ConsoleSession, CaptureComposerModel, ChatModel)] = []

@MainActor
private func quiet(_ bar: CaptureBarModel) {
    bar.announce = { _ in }
    bar.schedule = { _, _ in }
}

@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
    for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
    #expect(condition(), "timed out")
}

private struct SwiftSource { let name: String; let body: String }

private func appSources() throws -> [SwiftSource] {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources")
    let enumerator = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    var found: [SwiftSource] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
        found.append(SwiftSource(name: url.lastPathComponent, body: try String(contentsOf: url, encoding: .utf8)))
    }
    return found
}

/// The live-capture bridge as src/index.ts behaves, without a socket: the
/// control key reaches everything, a read-only key reaches `/check` and
/// `/status` only (403 elsewhere), anything else — or nothing — is 401.
private final class FakeBridge: @unchecked Sendable {
    enum Status {
        case idle
        case recording(elapsed: Double, senses: LiveCaptureSenses)
        case ended(String)
    }

    struct Sent { let route: LiveCaptureRoute; let body: Data?; let key: String? }

    private let lock = NSLock()
    private var _status: Status
    private var _sent: [Sent] = []
    private var _keyInKeychain: String?
    private var _acceptedKey: String?
    private var _readOnlyKey: String?
    private var _listening = true

    init(status: Status) { _status = status }

    var status: Status { get { lock.withLock { _status } } set { lock.withLock { _status = newValue } } }
    var sent: [Sent] { get { lock.withLock { _sent } } set { lock.withLock { _sent = newValue } } }
    var keyInKeychain: String? { get { lock.withLock { _keyInKeychain } } set { lock.withLock { _keyInKeychain = newValue } } }
    /// The control key the bridge was started with; nil = whatever the Keychain holds.
    var acceptedKey: String? { get { lock.withLock { _acceptedKey } } set { lock.withLock { _acceptedKey = newValue } } }
    var readOnlyKey: String? { get { lock.withLock { _readOnlyKey } } set { lock.withLock { _readOnlyKey = newValue } } }
    var listening: Bool { get { lock.withLock { _listening } } set { lock.withLock { _listening = newValue } } }

    @MainActor
    func client(key: String?) -> BridgeLiveCaptureClient {
        keyInKeychain = key
        return BridgeLiveCaptureClient(transport: Transport(bridge: self), keys: Keys(bridge: self), instanceID: { "inst-1" })
    }

    struct Keys: LiveCaptureKeySource {
        let bridge: FakeBridge
        func controlKey(instanceID: String) async -> LiveCaptureKeyLookup {
            #expect(instanceID == "inst-1", "the key is filed under the instance")
            return bridge.keyInKeychain.map { .found(LiveCaptureControlKey($0)) } ?? .missing
        }
    }

    struct Transport: LiveCaptureTransport {
        let bridge: FakeBridge
        func send(_ route: LiveCaptureRoute, body: Data?, key: LiveCaptureControlKey?) async -> LiveCaptureWireResult {
            bridge.respond(route, body: body, key: key?.value)
        }
    }

    private func respond(_ route: LiveCaptureRoute, body: Data?, key: String?) -> LiveCaptureWireResult {
        lock.withLock {
            _sent.append(Sent(route: route, body: body, key: key))
            guard _listening else { return .noListener }
            let control = key != nil && key == (_acceptedKey ?? _keyInKeychain) && key != _readOnlyKey
            let tool = key != nil && key == _readOnlyKey
            guard control || tool else { return reply(401, ["error": ["code": "unauthenticated", "message": "authentication required"]]) }
            if route.isControl && !control { return reply(403, ["error": ["code": "forbidden", "message": "not granted"]]) }
            switch route {
            case .status: return reply(200, statusJSON())
            case .check: return reply(200, ["meta": ["grants": ["screen_recording": "granted"]]])
            case .start:
                _status = .recording(elapsed: 0, senses: LiveCaptureSenses(display: true, appAudio: true, microphone: true))
                return reply(201, ["session": session("recording", nil)])
            case .stop:
                _status = .ended("owner")
                return reply(200, ["session": session("ended", "owner")])
            case .keepGoing: return reply(200, ["answered": true])
            case .purge:
                // Settings ▸ Live Capture's (T6-15): the recording's retention record, its media gone
                let id = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["session_id"] as? String ?? "?"
                return reply(200, ["session_id": id, "media_bytes": 0, "audio_deleted_at": "2026-09-30T12:30:00Z", "audio_deleted_reason": "owner"])
            }
        }
    }

    private func session(_ state: String, _ reason: String?) -> [String: Any] {
        var s: [String: Any] = ["session_id": "20260930-120000-00ab", "started_at": "2026-09-30T12:00:00Z", "state": state, "mode": "window", "picture": ["kind": "window", "bundle_id": "us.zoom.xos"], "apps": []]
        if let reason { s["ended_reason"] = reason }
        return s
    }

    private func statusJSON() -> [String: Any] {
        switch _status {
        case .idle:
            return ["state": "idle", "session": NSNull(), "senses": ["display": false, "app_audio": false, "microphone": false]]
        case .recording(let elapsed, let senses):
            return ["state": "recording", "elapsed_s": elapsed, "session": session("recording", nil),
                    "senses": ["display": senses.display, "app_audio": senses.appAudio, "microphone": senses.microphone]]
        case .ended(let reason):
            return ["state": "idle", "session": session("ended", reason), "senses": ["display": false, "app_audio": false, "microphone": false]]
        }
    }

    private func reply(_ status: Int, _ body: [String: Any]) -> LiveCaptureWireResult {
        .answered(status: status, body: try! JSONSerialization.data(withJSONObject: body))
    }
}

/// `POST /capture` refused, every time: nothing written.
private final class RefusingCaptureConsole: ConsoleCallTransport, @unchecked Sendable {
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.http(status: 500, envelope: ConsoleErrorEnvelope(code: "internal", message: "inbox write failed")))
    }
}
