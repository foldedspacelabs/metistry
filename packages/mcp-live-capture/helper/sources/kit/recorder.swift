// The recorder: one session at a time, from Record to its end, whatever ends
// it. Everything with a decision in it is here and runs against fakes in the
// tests; the Core Audio, AVAudioEngine, ScreenCaptureKit and SpeechAnalyzer
// adapters (sources/helper/) only move audio and frames.
//
// Two acts (C76): *Audio only* — a process tap over named apps (scope.swift);
// *Window* or *Screen* — one `SCStream` from the system picker's filter, with
// `capturesAudio` and (macOS 15) `captureMicrophone`, or the microphone as a
// second session below that (picture.swift).
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

/// What the record sheet sends. `apps` is *Audio only*'s scope; *Window* and
/// *Screen* name nothing — the picker chooses — so `apps` must be empty there.
public struct StartRequest: Equatable {
    public let mode: CaptureMode
    public let apps: [String]
    public let appAudio: Bool
    public let microphone: Bool

    public init(mode: CaptureMode = .audioOnly, apps: [String], appAudio: Bool = true, microphone: Bool = true) {
        self.mode = mode
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
    /// The picker's answer was refused (picture.swift).
    case picture(PictureError)
    /// A *Window* or *Screen* start that names content — only the picker chooses.
    case contentNamed
    /// The picker is open for another start.
    case choosing
    /// No picture backend on this Mac.
    case pictureUnavailable

    public var code: String {
        switch self {
        case .alreadyRecording, .choosing: return "already_recording"
        case .scope, .picture, .contentNamed: return "invalid_scope"
        case .nothingToRecord: return "nothing_to_record"
        case .diskFull: return "disk_full"
        case .streamFailed: return "stream_failed"
        case .pictureUnavailable: return "not_available"
        }
    }

    public var message: String {
        switch self {
        case .alreadyRecording(let id): return "already recording (session \(id)) — stop it first"
        case .scope(let e): return e.message
        case .nothingToRecord: return "turn on app audio, the microphone, or both"
        case .diskFull(let free): return "only \(free / 1_000_000_000) GB free — a recording needs more than 5 GB"
        case .streamFailed(let why): return "could not start recording: \(why)"
        case .picture(let e): return e.message
        case .contentNamed: return "Window and Screen are chosen in the picker — a request cannot name what to record"
        case .choosing: return "the picker is already open — choose there, or cancel it"
        case .pictureUnavailable: return "recording a window or the screen is not available on this Mac — use Audio only"
        }
    }
}

public enum DeliveryError: Error, Equatable {
    case invalid(String)
    case unknown(String)
    case stillRecording(String)

    public var code: String {
        switch self {
        case .invalid: return "invalid_request"
        case .unknown: return "unknown_session"
        case .stillRecording: return "still_recording"
        }
    }

    public var message: String {
        switch self {
        case .invalid(let why): return why
        case .unknown(let id): return "no session \(id)"
        case .stillRecording(let id): return "session \(id) is still recording — its transcript is not finished"
        }
    }
}

/// Which senses are open right now — what the rail draws beneath the mark
/// (screen 11 §3): the **display** glyph whenever a picture is being taken,
/// the microphone while the owner is heard. Read from the streams that are
/// open, never from what was asked for (P5): a paused session has none.
public struct Senses: Equatable {
    public let display: Bool
    public let appAudio: Bool
    public let microphone: Bool

    public static let none = Senses(display: false, appAudio: false, microphone: false)
}

/// The read-back the bar and `status` show.
public struct RecorderStatus: Equatable {
    public let state: String
    public let session: SessionRecord?
    public let elapsedS: Double?
    public let stopsAt: Date?
    public let reminderDueHours: Int?
    public let diskLowFreeBytes: Int64?
    public var senses: Senses = .none
}

public final class Recorder {
    public let ownBundleID: String
    public let policy: LifecyclePolicy
    /// T8-4's rule (retention.swift) — the owner's rulings unless a test says otherwise.
    public let retention: RetentionPolicy
    private let backend: CaptureBackend
    /// ScreenCaptureKit; nil where there is none — *Window* and *Screen* are refused.
    private let picture: PictureBackend?
    private let store: SessionStore
    private let disk: DiskProbe
    private let clock: () -> Date
    private let lock = NSRecursiveLock()

    private struct Active {
        var record: SessionRecord
        var lifecycle: LifecycleState
        var plan: TapPlan?
        /// *Window* / *Screen*: the picker's handle, reopened as is after a wake.
        var picturePlan: PicturePlan?
        var streams: [AudioSource: CaptureStream] = [:]
        var pictureStream: PictureStream?
        var pausedAt: Date?
        var reminderDue: Int?
        var diskLow: Int64?
    }

    private var active: Active?
    /// The picker is open for a start: nothing else may start meanwhile.
    private var choosing = false
    /// The last session that ended, so `status` can say how (e.g. the 10-hour stop).
    public private(set) var lastEnded: SessionRecord?

    public init(backend: CaptureBackend, picture: PictureBackend? = nil, store: SessionStore, disk: DiskProbe, clock: @escaping () -> Date = Date.init, policy: LifecyclePolicy = .c137, retention: RetentionPolicy = .q7, ownBundleID: String) {
        self.retention = retention
        self.backend = backend
        self.picture = picture
        self.store = store
        self.disk = disk
        self.clock = clock
        self.policy = policy
        self.ownBundleID = ownBundleID
    }

    // MARK: - Start

    public func start(_ req: StartRequest) throws -> SessionRecord {
        if req.mode.takesPicture { return try startPicture(req) }
        lock.lock(); defer { lock.unlock() }
        if let a = active { throw RecorderError.alreadyRecording(a.record.sessionID) }
        if choosing { throw RecorderError.choosing }
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
            remindersRaised: 0,
            mode: .audioOnly
        )
        return try begin(Active(record: record, lifecycle: LifecycleState(startedAt: now), plan: plan))
    }

    /// *Window* or *Screen*: the request names nothing; the owner chooses in
    /// the system picker, and its answer is the only thing the stream is
    /// opened from (picture.swift). The lock is not held while the picker is
    /// open — the owner may take a while — but `choosing` refuses any other
    /// start meanwhile.
    private func startPicture(_ req: StartRequest) throws -> SessionRecord {
        lock.lock()
        do {
            if let a = active { throw RecorderError.alreadyRecording(a.record.sessionID) }
            if choosing { throw RecorderError.choosing }
            // Only the picker chooses: a start that names apps is refused
            // before anything is presented.
            guard req.apps.isEmpty else { throw RecorderError.contentNamed }
            guard picture != nil else { throw RecorderError.pictureUnavailable }
            if let free = disk.freeBytes(at: store.root), free < policy.stopBelowFreeBytes { throw RecorderError.diskFull(free) }
        } catch {
            lock.unlock()
            throw error
        }
        choosing = true
        lock.unlock()
        defer {
            lock.lock()
            choosing = false
            lock.unlock()
        }
        guard let picture else { throw RecorderError.pictureUnavailable }

        let picked: PickedContent?
        do { picked = try picture.pick(req.mode, excludingBundleID: ownBundleID) } catch { throw RecorderError.streamFailed("the picker: \(error)") }

        lock.lock(); defer { lock.unlock() }
        let plan: PicturePlan
        do {
            plan = try planPicture(mode: req.mode, picked: picked, appAudio: req.appAudio, microphone: req.microphone, streamMicrophone: picture.streamMicrophoneAvailable, ownBundleID: ownBundleID)
        } catch let e as PictureError {
            if let picked { picture.release(picked.handle) }
            throw RecorderError.picture(e)
        }

        let now = clock()
        let record = SessionRecord(
            sessionID: newSessionID(now),
            startedAt: now,
            state: .recording,
            endedAt: nil,
            endedReason: nil,
            apps: plan.picked.bundleID.map { [$0] } ?? [],
            tapMode: nil,
            processes: [],
            appAudio: req.appAudio,
            microphone: req.microphone,
            gaps: [],
            appAudioObserved: false,
            remindersRaised: 0,
            mode: req.mode,
            picture: PictureRecord(kind: plan.picked.kind, bundleID: plan.picked.bundleID)
        )
        do {
            return try begin(Active(record: record, lifecycle: LifecycleState(startedAt: now), picturePlan: plan))
        } catch {
            picture.release(plan.picked.handle)
            throw error
        }
    }

    /// Write the session and open its streams; a stream that will not open
    /// ends the session as `failed_to_start`. Called with the lock held.
    private func begin(_ fresh: Active) throws -> SessionRecord {
        var a = fresh
        do { try store.create(a.record) } catch { throw RecorderError.streamFailed("cannot write the session: \(error.localizedDescription)") }
        do {
            try openStreams(&a, offset: 0)
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

    private func openStreams(_ a: inout Active, offset: Double) throws {
        let dir = store.directory(for: a.record.sessionID)
        let id = a.record.sessionID
        var opened: [AudioSource: CaptureStream] = [:]
        var pictureStream: PictureStream?
        do {
            if let plan = a.picturePlan {
                guard let picture else { throw RecorderError.pictureUnavailable }
                // The picker's handle, as the plan carries it: the only filter there is.
                pictureStream = try picture.openPicture(plan: plan, directory: dir) { [store] source, from, to, text in
                    store.append(TranscriptSegment(source: source, fromS: offset + from, toS: offset + to, text: text), to: id)
                }
            }
            if a.record.appAudio, a.picturePlan == nil, let plan = a.plan {
                opened[.app] = try backend.openAppAudio(plan: plan, directory: dir) { [store] from, to, text in
                    store.append(TranscriptSegment(source: .app, fromS: offset + from, toS: offset + to, text: text), to: id)
                }
            }
            // The microphone rides the picture stream on macOS 15; otherwise
            // (and for Audio only) it is its own session.
            if a.record.microphone, !(a.picturePlan?.microphoneInStream ?? false) {
                opened[.mic] = try backend.openMicrophone(directory: dir) { [store] from, to, text in
                    store.append(TranscriptSegment(source: .mic, fromS: offset + from, toS: offset + to, text: text), to: id)
                }
            }
        } catch {
            pictureStream?.stop()
            opened.values.forEach { $0.stop() }
            throw error
        }
        a.streams = opened
        a.pictureStream = pictureStream
    }

    private func closeStreams(_ a: inout Active) {
        a.pictureStream?.stop()
        a.pictureStream = nil
        for s in a.streams.values { s.stop() }
        // The process tap's sound only: it is the audio-capture grant's one
        // observable fact. A picture stream's sound is the screen grant's.
        if let app = a.streams[.app], app.observedAudio { a.record.appAudioObserved = true }
        a.streams = [:]
    }

    // MARK: - Stop, and the lifecycle

    @discardableResult
    public func stop(_ reason: StopReason) -> SessionRecord? {
        lock.lock(); defer { lock.unlock() }
        guard var a = active else { return nil }
        closeStreams(&a)
        if let plan = a.picturePlan { picture?.release(plan.picked.handle) }
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
        if let p = a.pictureStream, !p.isRunning {
            stop(.pictureLost)
            return
        }
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
        // A picture reopens from the SAME picker handle — the picker is never
        // presented again behind the owner's back; if that filter no longer
        // opens (the window closed), the session ends.
        if resumed.record.appAudio, resumed.picturePlan == nil {
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
            try openStreams(&resumed, offset: gap.toS)
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

    // MARK: - Delivery (T8-2b): the transcript owed to POST /capture

    /// Every session whose transcript has not reached the console yet: ended
    /// — by the owner, the ten-hour stop, the disk, a failed wake or a crash —
    /// and not delivered. A session that never started recording has nothing
    /// to deliver. Oldest first.
    public func owed() -> [SessionRecord] {
        lock.lock(); defer { lock.unlock() }
        return store.sessions().filter { $0.state == .ended && $0.delivery == nil && $0.endedReason != "failed_to_start" }
    }

    /// One ended session's record and its transcript, for delivery. Refused
    /// for a malformed id (no path is built from it), an unknown one, and the
    /// session still recording — its transcript is not finished.
    public func transcript(of sessionID: String) throws -> (SessionRecord, [[String: Any]]) {
        lock.lock(); defer { lock.unlock() }
        let record = try endedRecord(sessionID)
        return (record, store.transcript(sessionID))
    }

    /// The console has the transcript: record where it went. Written once —
    /// a second report for the same session keeps the first (a retried
    /// delivery answers with the same inbox row anyway, by its key).
    @discardableResult
    public func markDelivered(_ sessionID: String, inboxID: Int) throws -> SessionRecord {
        lock.lock(); defer { lock.unlock() }
        var record = try endedRecord(sessionID)
        guard inboxID > 0 else { throw DeliveryError.invalid("inbox_id is the console's positive row id") }
        if record.delivery != nil { return record }
        record.delivery = Delivery(inboxID: inboxID, at: clock())
        do { try store.update(record) } catch { throw DeliveryError.invalid("cannot write the session: \(error.localizedDescription)") }
        return record
    }

    // MARK: - Retention and re-review (T8-4): see retention.swift for the rule

    /// Apply the rule to every ended session — the bridge's timer calls this
    /// each sweep, so the 30-day ceiling holds with no console at all. The
    /// records it changed.
    @discardableResult
    public func applyRetention() -> [SessionRecord] {
        lock.lock(); defer { lock.unlock() }
        return store.sessions().filter { $0.state == .ended }.compactMap { r in
            guard let after = try? enforce(r), after != r else { return nil }
            return after
        }
    }

    /// The console's report that a session's transcript was ingested, at
    /// `at` (nil: no report, just the rule). Recorded once, clamped to the
    /// delivery and to now — so it can bring the deletion forward to no
    /// earlier than 7 days after the console took the transcript — and then
    /// the rule is applied to the session. Refused for a session never
    /// delivered: nothing can have ingested a transcript it never received.
    public func reportIngestion(_ sessionID: String, at: Date?) throws -> SessionRecord {
        lock.lock(); defer { lock.unlock() }
        var r = try endedRecord(sessionID)
        if let at, r.ingestedAt == nil {
            guard let kept = clampIngestion(at, record: r, now: clock()) else {
                throw DeliveryError.invalid("session \(sessionID) has not reached Metistry yet — nothing can have ingested its transcript")
            }
            r.ingestedAt = kept
            do { try store.update(r) } catch { throw DeliveryError.invalid("cannot write the session: \(error.localizedDescription)") }
        }
        do { return try enforce(r) } catch { throw DeliveryError.invalid("cannot apply retention: \(error.localizedDescription)") }
    }

    /// Purge Now — the owner's hand, from Settings ▸ Live Capture: the
    /// session's audio goes at once, whatever the rule says. Ended sessions
    /// only; a second purge is a no-op that answers the first one's record.
    public func purgeNow(_ sessionID: String) throws -> SessionRecord {
        lock.lock(); defer { lock.unlock() }
        var r = try endedRecord(sessionID)
        if r.audioDeletedAt != nil { return r }
        do {
            _ = try store.deleteMedia(sessionID)
            r.audioDeletedAt = clock()
            r.audioDeletedReason = "owner"
            try store.update(r)
        } catch { throw DeliveryError.invalid("cannot delete the audio: \(error.localizedDescription)") }
        return r
    }

    /// Delete whatever of `record` is due now; the record as it stands after.
    private func enforce(_ record: SessionRecord) throws -> SessionRecord {
        var r = record
        let now = clock()
        var changed = false
        if r.audioDeletedAt == nil, let due = audioDeleteAfter(r, policy: retention), now >= due {
            _ = try store.deleteMedia(r.sessionID)
            r.audioDeletedAt = now
            r.audioDeletedReason = "retention"
            changed = true
        }
        // Only a DELIVERED transcript is deleted here: an undelivered one is
        // the only copy, and `check` already says it is owed.
        if r.transcriptDeletedAt == nil, r.delivery != nil, let due = transcriptDeleteAfter(r, policy: retention), now >= due {
            try store.deleteTranscript(r.sessionID)
            r.transcriptDeletedAt = now
            changed = true
        }
        if changed { try store.update(r) }
        return r
    }

    /// The audio bytes a session still keeps on this Mac.
    public func mediaBytes(_ sessionID: String) -> Int64 {
        guard isSessionID(sessionID) else { return 0 }
        guard let started = store.sessions().first(where: { $0.sessionID == sessionID })?.startedAt else { return 0 }
        return store.media(sessionID, startedAt: started).reduce(0) { $0 + $1.bytes }
    }

    /// `recording_review`: re-transcribe `[fromS, toS)` (seconds from Record)
    /// of an ended session's kept audio. Text only: the lines the
    /// transcriber wrote, with their source and times — or, once the audio
    /// is gone, when and why it went. The span's files are read outside the
    /// recorder's lock, so a re-review never holds the bar's Stop.
    public func review(_ sessionID: String, fromS: Double, toS: Double, with transcriber: SpanTranscribing) throws -> ReviewResult {
        guard fromS.isFinite, toS.isFinite, fromS >= 0, toS > fromS else {
            throw ReviewError.invalid("from_s and to_s are seconds from Record, with from_s before to_s")
        }
        guard toS - fromS <= maxReviewSpanS else {
            throw ReviewError.invalid("a review re-reads at most \(Int(maxReviewSpanS / 60)) minutes at a time")
        }
        let (record, media): (SessionRecord, [MediaFile])
        do {
            lock.lock(); defer { lock.unlock() }
            record = try endedRecord(sessionID)
            media = store.media(sessionID, startedAt: record.startedAt)
        }
        if record.audioDeletedAt != nil { return .audioDeleted(record) }
        var lines: [ReviewLine] = []
        for (file, lo, hi) in reviewPlan(media, fromS: fromS, toS: toS) {
            guard let source = file.source else { continue }
            let heard: [TimedText]
            do { heard = try transcriber.transcribe(file: file.url, fromS: lo, toS: hi) } catch let e as ReviewError { throw e } catch { throw ReviewError.failed("\(error)") }
            for t in heard where !t.text.isEmpty {
                lines.append(ReviewLine(source: source, fromS: round2(file.offsetS + t.fromS), toS: round2(file.offsetS + t.toS), text: t.text))
            }
        }
        return .text(lines.sorted { ($0.fromS, $0.source.rawValue) < ($1.fromS, $1.source.rawValue) })
    }

    private func endedRecord(_ sessionID: String) throws -> SessionRecord {
        guard isSessionID(sessionID) else { throw DeliveryError.invalid("session_id is not a session id") }
        if active?.record.sessionID == sessionID { throw DeliveryError.stillRecording(sessionID) }
        guard let record = store.sessions().first(where: { $0.sessionID == sessionID }) else { throw DeliveryError.unknown(sessionID) }
        guard record.state == .ended else { throw DeliveryError.stillRecording(sessionID) }
        return record
    }

    // MARK: - Read-back

    public func status() -> RecorderStatus {
        lock.lock(); defer { lock.unlock() }
        guard let a = active else {
            return RecorderStatus(state: choosing ? "choosing" : "idle", session: lastEnded, elapsedS: nil, stopsAt: nil, reminderDueHours: nil, diskLowFreeBytes: nil)
        }
        let inStream = a.pictureStream?.isRunning ?? false
        return RecorderStatus(
            state: a.pausedAt == nil ? "recording" : "paused",
            session: a.record,
            elapsedS: round2(clock().timeIntervalSince(a.record.startedAt)),
            stopsAt: a.record.startedAt.addingTimeInterval(policy.maxDuration),
            reminderDueHours: a.reminderDue,
            diskLowFreeBytes: a.diskLow,
            senses: Senses(
                display: inStream,
                appAudio: a.streams[.app] != nil || (inStream && a.record.appAudio),
                microphone: a.streams[.mic] != nil || (inStream && (a.picturePlan?.microphoneInStream ?? false))
            )
        )
    }

    /// Whether the tap has ever delivered sound — the running session's
    /// streams first, else the newest ended session that recorded app audio.
    /// nil when no recording has tried.
    public func lastAppAudioObserved() -> Bool? {
        lock.lock(); defer { lock.unlock() }
        if let a = active, a.record.appAudio, let s = a.streams[.app] { return s.observedAudio || a.record.appAudioObserved }
        // A Window or Screen session's sound came through ScreenCaptureKit,
        // not a tap: it says nothing about the audio-capture grant.
        return store.sessions().last(where: { $0.appAudio && $0.state == .ended && ($0.mode ?? .audioOnly) == .audioOnly })?.appAudioObserved
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
