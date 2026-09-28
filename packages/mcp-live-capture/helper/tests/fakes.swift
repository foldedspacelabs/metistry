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
