// The recorder: one session at a time, from Record to its end, whatever ends
// it. Everything with a decision in it is here and runs against fakes in the
// tests; the Core Audio, AVAudioEngine and SpeechAnalyzer adapters
// (sources/helper/) only move audio.
//
// It is driven, never self-starting: `start` is reached from exactly one
// place — the helper's `start` op, which the bridge admits only on the
// control credential the owner's bar holds (src/index.ts). Nothing the
// assistant can call reaches it (plan §2.15: no `exposes` entry starts a
// recording; invariant 9).

import Foundation

/// A running capture stream for one source: the adapter writes its audio to
/// the session directory and transcribes it as it arrives, handing each
/// finished segment to `onSegment` with times relative to the stream's own
/// start. `stop` flushes both and returns once they are on disk.
public protocol CaptureStream: AnyObject {
    /// True once any non-silent audio has arrived.
    var observedAudio: Bool { get }
    func stop()
}

/// What the recorder needs from the machine.
public protocol CaptureBackend: AnyObject {
    /// macOS 26's `CATapDescription.bundleIDs`.
    var bundleIDTapsAvailable: Bool { get }
    func runningProcesses() -> [AudioProcess]
    /// Open the app-audio tap from `plan` (and only from it).
    func openAppAudio(plan: TapPlan, directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream
    /// Open the default input device — the owner's side only.
    func openMicrophone(directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream
}

public protocol DiskProbe {
    /// Free bytes on the volume holding `url`, or nil when it cannot be read.
    func freeBytes(at url: URL) -> Int64?
}

/// What the record sheet sends.
public struct StartRequest: Equatable {
    public let apps: [String]
    public let appAudio: Bool
    public let microphone: Bool

    public init(apps: [String], appAudio: Bool = true, microphone: Bool = true) {
        self.apps = apps
        self.appAudio = appAudio
        self.microphone = microphone
    }
}

public enum RecorderError: Error, Equatable {
    case alreadyRecording(String)
    case scope(ScopeError)
    case nothingToRecord
    case diskFull(Int64)
    case streamFailed(String)

    public var code: String {
        switch self {
        case .alreadyRecording: return "already_recording"
        case .scope: return "invalid_scope"
        case .nothingToRecord: return "nothing_to_record"
        case .diskFull: return "disk_full"
        case .streamFailed: return "stream_failed"
        }
    }

    public var message: String {
        switch self {
        case .alreadyRecording(let id): return "already recording (session \(id)) — stop it first"
        case .scope(let e): return e.message
        case .nothingToRecord: return "turn on app audio, the microphone, or both"
        case .diskFull(let free): return "only \(free / 1_000_000_000) GB free — a recording needs more than 5 GB"
        case .streamFailed(let why): return "could not start recording: \(why)"
        }
    }
}

/// The read-back the bar and `status` show.
public struct RecorderStatus: Equatable {
    public let state: String
    public let session: SessionRecord?
    public let elapsedS: Double?
    public let stopsAt: Date?
    public let reminderDueHours: Int?
    public let diskLowFreeBytes: Int64?
}

public final class Recorder {
    public let ownBundleID: String
    public let policy: LifecyclePolicy
    private let backend: CaptureBackend
    private let store: SessionStore
    private let disk: DiskProbe
    private let clock: () -> Date
    private let lock = NSRecursiveLock()

    private struct Active {
        var record: SessionRecord
        var lifecycle: LifecycleState
        var plan: TapPlan?
        var streams: [AudioSource: CaptureStream] = [:]
        var pausedAt: Date?
        var reminderDue: Int?
        var diskLow: Int64?
    }

    private var active: Active?
    /// The last session that ended, so `status` can say how (e.g. the 10-hour stop).
    public private(set) var lastEnded: SessionRecord?

    public init(backend: CaptureBackend, store: SessionStore, disk: DiskProbe, clock: @escaping () -> Date = Date.init, policy: LifecyclePolicy = .c137, ownBundleID: String) {
        self.backend = backend
        self.store = store
        self.disk = disk
        self.clock = clock
        self.policy = policy
        self.ownBundleID = ownBundleID
    }

    // MARK: - Start

    public func start(_ req: StartRequest) throws -> SessionRecord {
        lock.lock(); defer { lock.unlock() }
        if let a = active { throw RecorderError.alreadyRecording(a.record.sessionID) }
        guard req.appAudio || req.microphone else { throw RecorderError.nothingToRecord }

        // The scope is checked even when app audio is off: the session names
        // what the owner chose, and a malformed list is refused either way.
        let scope: CaptureScope
        do { scope = try validateScope(req.apps) } catch let e as ScopeError { throw RecorderError.scope(e) }
        var plan: TapPlan?
        if req.appAudio {
            do {
                plan = try planTap(scope: scope, running: backend.runningProcesses(), bundleIDTaps: backend.bundleIDTapsAvailable, ownBundleID: ownBundleID)
            } catch let e as ScopeError { throw RecorderError.scope(e) }
        }

        if let free = disk.freeBytes(at: store.root), free < policy.stopBelowFreeBytes {
            throw RecorderError.diskFull(free)
        }

        let now = clock()
        let record = SessionRecord(
            sessionID: newSessionID(now),
            startedAt: now,
            state: .recording,
            endedAt: nil,
            endedReason: nil,
            apps: scope.apps,
            tapMode: plan?.mode.rawValue,
            processes: (plan?.matched ?? []).map { ScopeProcess(bundleID: $0.bundleID, pid: $0.pid) },
            appAudio: req.appAudio,
            microphone: req.microphone,
            gaps: [],
            appAudioObserved: false,
            remindersRaised: 0
        )
        do { try store.create(record) } catch { throw RecorderError.streamFailed("cannot write the session: \(error.localizedDescription)") }

        var a = Active(record: record, lifecycle: LifecycleState(startedAt: now), plan: plan)
        do {
            a.streams = try openStreams(for: a, offset: 0)
        } catch {
            a.record.state = .ended
            a.record.endedAt = clock()
            a.record.endedReason = "failed_to_start"
            try? store.update(a.record)
            throw RecorderError.streamFailed("\(error)")
        }
        active = a
        return a.record
    }

    private func openStreams(for a: Active, offset: Double) throws -> [AudioSource: CaptureStream] {
        let dir = store.directory(for: a.record.sessionID)
        let id = a.record.sessionID
        var opened: [AudioSource: CaptureStream] = [:]
        do {
            if a.record.appAudio, let plan = a.plan {
                opened[.app] = try backend.openAppAudio(plan: plan, directory: dir) { [store] from, to, text in
                    store.append(TranscriptSegment(source: .app, fromS: offset + from, toS: offset + to, text: text), to: id)
                }
            }
            if a.record.microphone {
                opened[.mic] = try backend.openMicrophone(directory: dir) { [store] from, to, text in
                    store.append(TranscriptSegment(source: .mic, fromS: offset + from, toS: offset + to, text: text), to: id)
                }
            }
        } catch {
            opened.values.forEach { $0.stop() }
            throw error
        }
        return opened
    }

    private func closeStreams(_ a: inout Active) {
        for s in a.streams.values { s.stop() }
        if let app = a.streams[.app], app.observedAudio { a.record.appAudioObserved = true }
        a.streams = [:]
    }

    // MARK: - Stop, and the lifecycle

    @discardableResult
    public func stop(_ reason: StopReason) -> SessionRecord? {
        lock.lock(); defer { lock.unlock() }
        guard var a = active else { return nil }
        closeStreams(&a)
        a.record.state = .ended
        a.record.endedAt = clock()
        a.record.endedReason = reason.rawValue
        a.record.remindersRaised = a.lifecycle.remindersRaised
        try? store.update(a.record)
        active = nil
        lastEnded = a.record
        return a.record
    }

    /// *Keep Going*: the reminder is answered. False when none was due.
    public func keepGoing() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active?.reminderDue != nil else { return false }
        active?.reminderDue = nil
        return true
    }

    /// Run the lifecycle now (the helper's timer calls this every few seconds).
    public func tick() {
        lock.lock(); defer { lock.unlock() }
        guard var a = active else { return }
        let actions = evaluate(&a.lifecycle, now: clock(), freeBytes: disk.freeBytes(at: store.directory(for: a.record.sessionID)), policy: policy)
        for action in actions {
            switch action {
            case .remind(let hours): a.reminderDue = hours
            case .warnDisk(let free): a.diskLow = free
            case .stop(let reason):
                active = a
                stop(reason)
                return
            }
        }
        a.record.remindersRaised = a.lifecycle.remindersRaised
        active = a
    }

    // MARK: - Sleep

    /// The Mac is going to sleep: close the streams (their audio and text are
    /// flushed) and hold the session paused.
    public func willSleep() {
        lock.lock(); defer { lock.unlock() }
        guard var a = active, a.pausedAt == nil else { return }
        closeStreams(&a)
        a.pausedAt = clock()
        a.record.state = .paused
        try? store.update(a.record)
        active = a
    }

    /// Awake: the ten hours may have passed while asleep, so the lifecycle
    /// runs first; otherwise the gap is marked and the streams reopen with
    /// their times continuing from Record.
    public func didWake() {
        lock.lock(); defer { lock.unlock() }
        guard var a = active, let pausedAt = a.pausedAt else { return }
        let now = clock()
        let gap = Gap(fromS: pausedAt.timeIntervalSince(a.record.startedAt), toS: now.timeIntervalSince(a.record.startedAt), reason: "sleep")
        a.record.gaps.append(gap)
        store.appendGap(gap, to: a.record.sessionID)
        a.pausedAt = nil
        a.record.state = .recording
        active = a
        tick()
        guard var resumed = active else { return } // the lifecycle stopped it
        // Below macOS 26 a tap names process objects, which a sleep can
        // retire; the plan is rebuilt from the same scope, never widened.
        if resumed.record.appAudio {
            do {
                let scope = try validateScope(resumed.record.apps)
                resumed.plan = try planTap(scope: scope, running: backend.runningProcesses(), bundleIDTaps: backend.bundleIDTapsAvailable, ownBundleID: ownBundleID)
            } catch {
                active = resumed
                stop(.resumeFailed)
                return
            }
        }
        do {
            resumed.streams = try openStreams(for: resumed, offset: gap.toS)
        } catch {
            active = resumed
            stop(.resumeFailed)
            return
        }
        try? store.update(resumed.record)
        active = resumed
    }

    // MARK: - Crash recovery

    /// At the helper's start, before anything else: a session still marked
    /// recording or paused was cut off. It is ended as `crashed` at its last
    /// write — everything up to then is already on disk.
    public func recoverInterrupted() -> [SessionRecord] {
        lock.lock(); defer { lock.unlock() }
        var out: [SessionRecord] = []
        for var r in store.sessions() where r.state != .ended {
            r.state = .ended
            r.endedAt = store.lastWrite(r.sessionID) ?? r.startedAt
            r.endedReason = StopReason.crashed.rawValue
            try? store.update(r)
            out.append(r)
        }
        return out
    }

    // MARK: - Read-back

    public func status() -> RecorderStatus {
        lock.lock(); defer { lock.unlock() }
        guard let a = active else {
            return RecorderStatus(state: "idle", session: lastEnded, elapsedS: nil, stopsAt: nil, reminderDueHours: nil, diskLowFreeBytes: nil)
        }
        return RecorderStatus(
            state: a.pausedAt == nil ? "recording" : "paused",
            session: a.record,
            elapsedS: round2(clock().timeIntervalSince(a.record.startedAt)),
            stopsAt: a.record.startedAt.addingTimeInterval(policy.maxDuration),
            reminderDueHours: a.reminderDue,
            diskLowFreeBytes: a.diskLow
        )
    }

    /// Whether the tap has ever delivered sound — the running session's
    /// streams first, else the newest ended session that recorded app audio.
    /// nil when no recording has tried.
    public func lastAppAudioObserved() -> Bool? {
        lock.lock(); defer { lock.unlock() }
        if let a = active, a.record.appAudio, let s = a.streams[.app] { return s.observedAudio || a.record.appAudioObserved }
        return store.sessions().last(where: { $0.appAudio && $0.state == .ended })?.appAudioObserved
    }

    public var isRecording: Bool {
        lock.lock(); defer { lock.unlock() }
        return active != nil
    }

    private func newSessionID(_ at: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'-'HHmmss"
        let suffix = String(UInt32.random(in: 0...0xFFFF), radix: 16)
        return "\(f.string(from: at))-\(String(repeating: "0", count: 4 - suffix.count))\(suffix)"
    }
}
