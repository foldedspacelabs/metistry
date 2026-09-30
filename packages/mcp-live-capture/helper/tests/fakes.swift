// The machine, faked. `FakeAudioWorld` models the one Core Audio rule the
// helper relies on — a process tap mixes exactly the processes its
// description names (by process object below macOS 26, by bundle ID on it) —
// so a test can have app X and app Y both playing and read what reached the
// session's transcript. What is under test is everything on our side of that
// rule: the plan the helper builds, and that nothing else feeds the session.

import Foundation

final class FakeStream: CaptureStream {
    let source: AudioSource
    let plan: TapPlan?
    let onSegment: (Double, Double, String) -> Void
    private(set) var open = true
    private(set) var heard: [String] = []

    init(source: AudioSource, plan: TapPlan?, onSegment: @escaping (Double, Double, String) -> Void) {
        self.source = source
        self.plan = plan
        self.onSegment = onSegment
    }

    var observedAudio: Bool { !heard.isEmpty }

    func stop() { open = false }

    func receive(_ text: String, from: Double, to: Double) {
        guard open else { return }
        heard.append(text)
        onSegment(from, to, text)
    }

    /// Core Audio's rule for a tap description, modelled.
    func hears(_ p: AudioProcess) -> Bool {
        guard let plan else { return false }
        switch plan.mode {
        case .processes: return plan.processObjectIDs.contains(p.objectID)
        case .bundleIDs: return plan.bundleIDs.contains(p.bundleID) || plan.processObjectIDs.contains(p.objectID)
        }
    }
}

final class FakeAudioWorld: CaptureBackend {
    var processes: [AudioProcess]
    var bundleIDTapsAvailable: Bool
    var failMicrophone = false
    private(set) var appStreams: [FakeStream] = []
    private(set) var micStreams: [FakeStream] = []

    init(processes: [AudioProcess], bundleIDTaps: Bool) {
        self.processes = processes
        self.bundleIDTapsAvailable = bundleIDTaps
    }

    func runningProcesses() -> [AudioProcess] { processes }

    func openAppAudio(plan: TapPlan, directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream {
        let s = FakeStream(source: .app, plan: plan, onSegment: onSegment)
        appStreams.append(s)
        return s
    }

    func openMicrophone(directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream {
        if failMicrophone { throw NSError(domain: "fake", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"]) }
        let s = FakeStream(source: .mic, plan: nil, onSegment: onSegment)
        micStreams.append(s)
        return s
    }

    /// `p` plays sound that transcribes as `text`: every open tap whose
    /// description names it hears it; nothing else does.
    func play(_ p: AudioProcess, says text: String, from: Double, to: Double) {
        for tap in appStreams where tap.hears(p) { tap.receive(text, from: from, to: to) }
    }

    func speak(_ text: String, from: Double, to: Double) {
        for mic in micStreams { mic.receive(text, from: from, to: to) }
    }

    var openStreams: Int { (appStreams + micStreams).filter(\.open).count }
}

final class FakeDisk: DiskProbe {
    var free: Int64? = 500 * 1_000_000_000
    func freeBytes(at url: URL) -> Int64? { free }
}

final class FakeClock {
    var now = Date(timeIntervalSince1970: 1_790_000_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    func read() -> Date { now }
}

struct FakeGrants: GrantProbe {
    func grants(lastAppAudioObserved: Bool?) -> [String: String] {
        ["microphone": "granted", "audio_capture": lastAppAudioObserved == true ? "observed" : "unverified", "screen_recording": "not_granted"]
    }
}

struct FakeTranscriber: TranscriberProbe {
    var available = true
    func status() -> TranscriberStatus {
        available
            ? TranscriberStatus(engine: "SpeechTranscriber", available: true, assets: "installed", locale: "en_US", reason: nil)
            : TranscriberStatus(engine: "SpeechTranscriber", available: false, assets: "unsupported", locale: nil, reason: "on-device transcription needs macOS 26")
    }
}

// The cast of processes the tests share.
let zoom = AudioProcess(objectID: 101, pid: 5001, bundleID: "us.zoom.xos")
let zoomHelper = AudioProcess(objectID: 102, pid: 5002, bundleID: "us.zoom.xos.helper")
let spotify = AudioProcess(objectID: 201, pid: 6001, bundleID: "com.spotify.client")
let lookalike = AudioProcess(objectID: 301, pid: 7001, bundleID: "us.zoom.xosfake")
let ownHelper = AudioProcess(objectID: 401, pid: 8001, bundleID: ownBundle)
let ownBundle = "com.foldedspacelabs.metistry.live-capture"

func makeRecorder(_ world: FakeAudioWorld, clock: FakeClock = FakeClock(), disk: FakeDisk = FakeDisk()) -> (Recorder, FileSessionStore) {
    let store = FileSessionStore(root: tempCaptureDir())
    return (Recorder(backend: world, store: store, disk: disk, clock: clock.read, ownBundleID: ownBundle), store)
}

// ScreenCaptureKit, faked. `FakeScreenWorld` models the system's side of the
// picker: the owner's click becomes a filter the SYSTEM holds under a handle,
// and a stream opened from that handle sees exactly the content it was built
// from — one window (and its app's sound), or one display (everything on it).
// What is under test is our side: that the only handle the helper ever opens
// is the one the picker answered with.

enum FakeContent: Equatable {
    case window(windowID: UInt32, bundleID: String)
    case display(displayID: UInt32)
    case application(bundleID: String)

    var kind: PickedContent.Kind {
        switch self {
        case .window: return .window
        case .display: return .display
        case .application: return .application
        }
    }

    var bundleID: String? {
        switch self {
        case .window(_, let b), .application(let b): return b
        case .display: return nil
        }
    }
}

final class FakePictureStream: PictureStream {
    let plan: PicturePlan
    let content: FakeContent
    let onSegment: (AudioSource, Double, Double, String) -> Void
    private(set) var open = true
    var frames: [String] = []
    var heard: [String] = []

    init(plan: PicturePlan, content: FakeContent, onSegment: @escaping (AudioSource, Double, Double, String) -> Void) {
        self.plan = plan
        self.content = content
        self.onSegment = onSegment
    }

    var observedAudio: Bool { !heard.isEmpty }
    var observedFrames: Bool { !frames.isEmpty }
    var isRunning: Bool { open }
    func stop() { open = false }
    /// The system ends the stream (the window closed).
    func systemStops() { open = false }

    /// The system's rule for a filter, modelled: a window filter sees that
    /// window; a display filter sees every window on it (one display here).
    func sees(windowID: UInt32) -> Bool {
        switch content {
        case .window(let id, _): return id == windowID
        case .display: return true
        case .application: return false
        }
    }

    /// `capturesAudio` is scoped as the picture: a window's app, or the display's everything.
    func hears(app bundleID: String) -> Bool {
        guard plan.appAudio else { return false }
        switch content {
        case .window(_, let b): return belongs(bundleID, to: b)
        case .display: return true
        case .application: return false
        }
    }
}

final class FakeScreenWorld: PictureBackend {
    var streamMicrophoneAvailable: Bool
    /// What the owner clicks in the picker: nil is Cancel.
    var ownerChooses: FakeContent?
    /// Something to do while the picker is open (the owner's hand elsewhere).
    var whilePickerOpen: (() -> Void)?
    var failOpen = false
    private(set) var presented: [(mode: CaptureMode, excluding: String)] = []
    private(set) var streams: [FakePictureStream] = []
    private(set) var released: [Int] = []
    /// The system's filters, by handle — only the picker makes one.
    private var filters: [Int: FakeContent] = [:]
    private var nextHandle = 7

    init(streamMicrophone: Bool) { streamMicrophoneAvailable = streamMicrophone }

    func pick(_ mode: CaptureMode, excludingBundleID: String) throws -> PickedContent? {
        presented.append((mode, excludingBundleID))
        whilePickerOpen?()
        guard let chosen = ownerChooses else { return nil }
        let handle = nextHandle
        nextHandle += 1
        filters[handle] = chosen
        return PickedContent(handle: handle, kind: chosen.kind, bundleID: chosen.bundleID)
    }

    func openPicture(plan: PicturePlan, directory: URL, onSegment: @escaping (AudioSource, Double, Double, String) -> Void) throws -> PictureStream {
        if failOpen { throw NSError(domain: "fake", code: 2, userInfo: [NSLocalizedDescriptionKey: "the window is gone"]) }
        // A handle the picker never gave out has no filter behind it.
        guard let content = filters[plan.picked.handle] else { throw NSError(domain: "fake", code: 3, userInfo: [NSLocalizedDescriptionKey: "no such filter"]) }
        let s = FakePictureStream(plan: plan, content: content, onSegment: onSegment)
        streams.append(s)
        return s
    }

    func release(_ handle: Int) {
        released.append(handle)
        filters[handle] = nil
    }

    /// A window draws `frame`: every open stream whose filter sees it gets it.
    func draw(windowID: UInt32, _ frame: String) {
        for s in streams where s.open && s.sees(windowID: windowID) { s.frames.append(frame) }
    }

    /// An app plays sound that transcribes as `text`.
    func play(app bundleID: String, says text: String, from: Double, to: Double) {
        for s in streams where s.open && s.hears(app: bundleID) {
            s.heard.append(text)
            s.onSegment(.app, from, to, text)
        }
    }

    /// The owner speaks: a stream carrying the microphone hears it.
    func speak(_ text: String, from: Double, to: Double) {
        for s in streams where s.open && s.plan.microphoneInStream { s.onSegment(.mic, from, to, text) }
    }

    var openStreams: Int { streams.filter(\.open).count }
}

// The windows the picture tests share.
let meetingWindow = FakeContent.window(windowID: 11, bundleID: "us.zoom.xos")
let chatWindow = FakeContent.window(windowID: 12, bundleID: "com.tinyspeck.slackmacgap")
let mainDisplay = FakeContent.display(displayID: 1)

func makePictureRecorder(_ world: FakeAudioWorld, _ screen: FakeScreenWorld?, clock: FakeClock = FakeClock(), disk: FakeDisk = FakeDisk()) -> (Recorder, FileSessionStore) {
    let store = FileSessionStore(root: tempCaptureDir())
    return (Recorder(backend: world, picture: screen, store: store, disk: disk, clock: clock.read, ownBundleID: ownBundle), store)
}
