// Controlling a recording (design-build-plan §2.2 "device-local", §2.15,
// §2.16; screen 11 §5). The app talks to the LOCAL live-capture bridge
// directly — the console never starts a recording, and the bridge has no
// `exposes` entry that does (invariant 9): the owner's hand starts one, from
// the bar (capture-bar-model.swift). What a recording produces reaches
// Metistry from the bridge through `POST /capture`, so the app sends nothing
// when a session ends.
//
// THE WIRE (packages/mcp-live-capture/README.md, T8-2a/T8-2b/T8-3/T8-4). Four
// bridge routes the bar drives, one Settings ▸ Live Capture drives, and
// `/check` they read — `LiveCaptureRoute` is the closed set, so no caller of
// this file can name another:
//
//   GET  /status                the session read-back: state, elapsed, the
//                               senses that are open, the reminder, the disk
//   POST /recording/start       {"mode":"window"|"screen", app_audio, microphone}
//                               or {"mode":"audio_only","apps":[bundle ids], …}
//   POST /recording/stop
//   POST /recording/keep-going  answers the two-hour reminder
//   POST /recording/purge       Purge Now (T8-4) — one recording's media, now;
//                               Settings ▸ Live Capture's, never the bar's
//   GET  /check                 read only to say why a picture could not start
//
// *Window* and *Screen* NAME NOTHING: the recorder presents the macOS picker
// and the owner's click there is the only chooser, so `LiveCaptureScope` has
// no case that carries a window or display id — F-7's `.window(id:)` and
// `.screen(displayID:)` were removed here, because the helper refuses a start
// that names content, and a type that can express one is a refusal waiting to
// be sent.
//
// THE KEY. Every call presents the recorder's CONTROL credential
// (`METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` — live-capture-key.swift says where
// it lives and why this app may read it). Never the bridge's tool token: that
// one reaches reads only, and this app never asks for it. A key that is not on
// this Mac, or that the bridge refuses, is a STATE the bar shows with its
// reason — never a retry loop, never a prompt.
//
// AN ABSENT BRIDGE IS A STATE, NOT A FAILURE: nothing listens on its port, so
// the bar is hidden entirely (screen 11 §8, "absent, not off").

import Foundation

public protocol LiveCaptureClient: Sendable {
    /// The session read-back (bridge `GET /status`).
    func state() async -> Result<LiveCaptureState, LiveCaptureError>
    /// Start exactly this request (bridge `POST /recording/start`). *Window*
    /// and *Screen* wait on the macOS picker — up to two minutes.
    func start(_ request: LiveCaptureStart) async -> Result<LiveCaptureSession, LiveCaptureError>
    /// Stop, and say what was kept (bridge `POST /recording/stop`).
    func stop() async -> Result<LiveCaptureSession?, LiveCaptureError>
    /// *Keep Going* on the two-hour reminder (bridge `POST /recording/keep-going`).
    /// False when no reminder was due.
    func keepGoing() async -> Result<Bool, LiveCaptureError>
    /// The grants as the recorder can know them (bridge `GET /check`'s `meta.grants`).
    func grants() async -> Result<[String: String], LiveCaptureError>
    /// Purge Now (T8-4, plan §2.15; Settings ▸ Live Capture): delete one ended
    /// recording's audio and frames at once, whatever the retention rule would
    /// have allowed — bridge `POST /recording/purge {session_id}`, the control
    /// credential. The answer is the recording's retention record, never its words.
    func purge(_ sessionID: String) async -> Result<LiveCapturePurged, LiveCaptureError>
    /// Drop the key read before, so the next call reads it afresh — an
    /// instance switch, or the owner's *Try Again* after minting one.
    func forgetKey() async
}

public extension LiveCaptureClient {
    func forgetKey() async {}
}

// MARK: - What a start may say

/// What a recording may take (C76). There is no case with an id in it: the
/// picker chooses a window or a display, and the start says only which kind.
public enum LiveCaptureScope: Sendable, Equatable {
    /// One window, chosen in the macOS picker.
    case window
    /// One display, chosen in the macOS picker.
    case screen
    /// A process tap over these apps' audio — per-process by construction.
    case audioOnly(bundleIDs: [String])

    public var mode: LiveCaptureMode {
        switch self {
        case .window: return .window
        case .screen: return .screen
        case .audioOnly: return .audioOnly
        }
    }
}

public enum LiveCaptureMode: String, Sendable, Equatable, CaseIterable, Codable {
    case audioOnly = "audio_only"
    case window
    case screen

    /// Whether the picker chooses what this mode sees.
    public var takesPicture: Bool { self != .audioOnly }
}

/// The record sheet's answer, as it goes on the wire.
public struct LiveCaptureStart: Sendable, Equatable {
    public let scope: LiveCaptureScope
    /// *App audio* for a window, *system audio* otherwise (screen 11 §5).
    public let appAudio: Bool
    /// The owner's side only.
    public let microphone: Bool

    /// The bridge's own cap on *Audio only*'s list (`MAX_SCOPE_APPS`).
    public static let maxApps = 16

    public init(scope: LiveCaptureScope, appAudio: Bool = true, microphone: Bool = true) {
        self.scope = scope
        self.appAudio = appAudio
        self.microphone = microphone
    }

    /// The only fields a start body carries. A picture start's body is its
    /// mode and two switches — no `apps`, no window, no display, no filter;
    /// `capture-bar-tests.swift` holds every body this type can build to it.
    public static let pictureFields: Set<String> = ["mode", "app_audio", "microphone"]
    public static let audioOnlyFields: Set<String> = ["mode", "apps", "app_audio", "microphone"]

    /// The JSON body, built from the scope's case and nothing else.
    public var body: JSONValue {
        var fields: [String: JSONValue] = [
            "mode": .string(scope.mode.rawValue),
            "app_audio": .bool(appAudio),
            "microphone": .bool(microphone),
        ]
        if case .audioOnly(let apps) = scope {
            fields["apps"] = .array(apps.map(JSONValue.string))
        }
        return .object(fields)
    }
}

// MARK: - What the bridge says back

/// Which senses are open right now, read from the recorder's streams — never
/// from what was asked for (P5). A paused session has none.
public struct LiveCaptureSenses: Sendable, Equatable, Decodable {
    public let display: Bool
    public let appAudio: Bool
    public let microphone: Bool

    public static let none = LiveCaptureSenses(display: false, appAudio: false, microphone: false)

    public init(display: Bool, appAudio: Bool, microphone: Bool) {
        self.display = display
        self.appAudio = appAudio
        self.microphone = microphone
    }

    enum CodingKeys: String, CodingKey { case display, appAudio = "app_audio", microphone }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        display = (try? c.decode(Bool.self, forKey: .display)) ?? false
        appAudio = (try? c.decode(Bool.self, forKey: .appAudio)) ?? false
        microphone = (try? c.decode(Bool.self, forKey: .microphone)) ?? false
    }
}

/// A session as the recorder keeps it — its id, what it took, how it ended.
/// Never its audio, frames or transcript, and never a window title.
public struct LiveCaptureSession: Sendable, Equatable, Decodable {
    public let sessionID: String
    /// `recording`, `paused` or `ended`.
    public let state: String
    /// `owner`, `max_duration`, `disk_full`, `crashed`, `resume_failed`,
    /// `picture_lost`, `failed_to_start` — nil while it runs.
    public let endedReason: String?
    /// nil in a record written before T8-3, which was *Audio only*.
    public let mode: LiveCaptureMode?
    /// *Window* / *Screen*: the kind the picker chose and its app — never a title.
    public let pictureKind: String?
    public let pictureBundleID: String?
    /// *Audio only*'s apps, as the sheet sent them.
    public let apps: [String]

    public init(sessionID: String, state: String, endedReason: String? = nil, mode: LiveCaptureMode? = nil, pictureKind: String? = nil, pictureBundleID: String? = nil, apps: [String] = []) {
        self.sessionID = sessionID
        self.state = state
        self.endedReason = endedReason
        self.mode = mode
        self.pictureKind = pictureKind
        self.pictureBundleID = pictureBundleID
        self.apps = apps
    }

    enum CodingKeys: String, CodingKey { case sessionID = "session_id", state, endedReason = "ended_reason", mode, picture, apps }
    enum PictureKeys: String, CodingKey { case kind, bundleID = "bundle_id" }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionID = try c.decode(String.self, forKey: .sessionID)
        state = (try? c.decode(String.self, forKey: .state)) ?? "ended"
        endedReason = (try? c.decodeIfPresent(String.self, forKey: .endedReason)) ?? nil
        mode = ((try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil).flatMap(LiveCaptureMode.init(rawValue:))
        let picture = try? c.nestedContainer(keyedBy: PictureKeys.self, forKey: .picture)
        pictureKind = picture.flatMap { (try? $0.decodeIfPresent(String.self, forKey: .kind)) ?? nil }
        pictureBundleID = picture.flatMap { (try? $0.decodeIfPresent(String.self, forKey: .bundleID)) ?? nil }
        apps = ((try? c.decodeIfPresent([String].self, forKey: .apps)) ?? nil) ?? []
    }
}

/// `POST /recording/purge`'s answer, typed: the recording's retention record —
/// what is left of it and why. Never a word of the transcript.
public struct LiveCapturePurged: Sendable, Equatable, Decodable {
    public let sessionID: String
    /// The media still on disk after the purge — 0 when it went.
    public let mediaBytes: Int
    public let audioDeletedAt: String?
    /// `retention` or `owner` (Purge Now).
    public let audioDeletedReason: String?

    public init(sessionID: String, mediaBytes: Int, audioDeletedAt: String?, audioDeletedReason: String?) {
        self.sessionID = sessionID
        self.mediaBytes = mediaBytes
        self.audioDeletedAt = audioDeletedAt
        self.audioDeletedReason = audioDeletedReason
    }

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", mediaBytes = "media_bytes", audioDeletedAt = "audio_deleted_at", audioDeletedReason = "audio_deleted_reason"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionID = try c.decode(String.self, forKey: .sessionID)
        mediaBytes = (try? c.decodeIfPresent(Int.self, forKey: .mediaBytes)) ?? 0
        audioDeletedAt = (try? c.decodeIfPresent(String.self, forKey: .audioDeletedAt)) ?? nil
        audioDeletedReason = (try? c.decodeIfPresent(String.self, forKey: .audioDeletedReason)) ?? nil
    }
}

/// `GET /status`, typed: what is running now, never what it took.
public struct LiveCaptureState: Sendable, Equatable, Decodable {
    public enum Phase: String, Sendable, Equatable {
        case idle
        /// The macOS picker is open for a start.
        case choosing
        case recording
        /// The Mac slept; streams are closed and reopen on wake.
        case paused
    }

    public let phase: Phase
    /// The running session — or, while idle, the last one that ended.
    public let session: LiveCaptureSession?
    /// Seconds since Record, as the recorder counted them when it answered.
    public let elapsed: TimeInterval?
    /// The two-hour reminder, when one is waiting for *Keep Going*.
    public let reminderDueHours: Int?
    /// Set under 10 GB free (C137).
    public let diskLowFreeBytes: Int64?
    public let senses: LiveCaptureSenses

    public init(phase: Phase, session: LiveCaptureSession? = nil, elapsed: TimeInterval? = nil, reminderDueHours: Int? = nil, diskLowFreeBytes: Int64? = nil, senses: LiveCaptureSenses = .none) {
        self.phase = phase
        self.session = session
        self.elapsed = elapsed
        self.reminderDueHours = reminderDueHours
        self.diskLowFreeBytes = diskLowFreeBytes
        self.senses = senses
    }

    /// A session is running — recording, or paused by a sleep.
    public var isRunning: Bool { phase == .recording || phase == .paused }

    enum CodingKeys: String, CodingKey {
        case state, session, elapsed = "elapsed_s", reminder = "reminder_due_hours", disk = "disk_low_free_bytes", senses
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = Phase(rawValue: (try? c.decode(String.self, forKey: .state)) ?? "idle") ?? .idle
        session = (try? c.decodeIfPresent(LiveCaptureSession.self, forKey: .session)) ?? nil
        elapsed = (try? c.decodeIfPresent(Double.self, forKey: .elapsed)) ?? nil
        reminderDueHours = (try? c.decodeIfPresent(Int.self, forKey: .reminder)) ?? nil
        diskLowFreeBytes = (try? c.decodeIfPresent(Int64.self, forKey: .disk)) ?? nil
        senses = ((try? c.decodeIfPresent(LiveCaptureSenses.self, forKey: .senses)) ?? nil) ?? .none
    }
}

// MARK: - Refusals

public enum LiveCaptureError: LocalizedError, Equatable {
    /// No bridge on this Mac: hide the bar, say nothing is wrong.
    case absent
    /// The bridge is here and this Mac holds no control key for it — the
    /// "lost token" state. The words say what is missing and the verbs that fix it.
    case noKey(String)
    /// The bridge refused the key this Mac presented (401): it was started
    /// with a different one.
    case keyRefused
    /// The key this Mac holds reaches the bridge's reads only (403 on a
    /// control route) — it is not the control key.
    case notControlKey
    /// The bridge answered and declined, in its own words (a cancelled
    /// picker, a full disk, a recording already running).
    case refused(code: String, message: String)
    /// The bridge did not answer.
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case .absent: return "live capture is not set up on this Mac"
        case .noKey(let why): return why
        case .keyRefused: return LiveCaptureWords.keyRefused
        case .notControlKey: return LiveCaptureWords.notControlKey
        case .refused(_, let message): return message
        case .unreachable(let why): return "The recorder did not answer: \(why)"
        }
    }

    /// Whether this is about the key rather than the recording — the bar
    /// turns Record off and says why, and asks nothing again until the owner acts.
    public var isAboutTheKey: Bool {
        switch self {
        case .noKey, .keyRefused, .notControlKey: return true
        default: return false
        }
    }
}

/// The owner's words for the key states — each names the verbs that fix it,
/// and none names a value.
public enum LiveCaptureWords {
    public static let mint = "metistry secrets mint METISTRY_LIVE_CAPTURE_CONTROL_TOKEN"
    public static let restart = "metistry restart live-capture"

    public static let noKey = "This Mac has no key for the recorder, so it can't start or stop a recording. Run `\(mint)`, then `\(restart)`."
    public static let noInstanceYet = "The recorder's key is filed under this instance's id, and the instance hasn't said who it is yet."
    public static let keyRefused = "The recorder refused this Mac's key — it was started with a different one. Run `\(restart)`."
    public static let notControlKey = "The key filed for the recorder only reads it; it can't start or stop a recording. Run `\(mint)`, then `\(restart)`."

    public static func unreadable(_ why: String) -> String {
        "The Keychain did not give the recorder's key (\(why)), so this Mac can't start or stop a recording."
    }
}

// MARK: - The client over the bridge

/// The routes the bar may call. The transport maps each to the loopback
/// bridge and nothing else — no caller holds a URL.
public enum LiveCaptureRoute: String, Sendable, CaseIterable {
    case check = "GET /check"
    case status = "GET /status"
    case start = "POST /recording/start"
    case stop = "POST /recording/stop"
    case keepGoing = "POST /recording/keep-going"
    /// Settings ▸ Live Capture's Purge Now (T8-4) — the bar never sends it.
    case purge = "POST /recording/purge"

    public var method: String { String(rawValue.split(separator: " ")[0]) }
    public var path: String { String(rawValue.split(separator: " ")[1]) }
    /// A route only the control credential reaches (the bridge's `reach: "control"`).
    public var isControl: Bool { path.hasPrefix("/recording/") }
}

/// What one request came back as.
public enum LiveCaptureWireResult: Sendable, Equatable {
    case answered(status: Int, body: Data)
    /// Nothing listens on the bridge's port.
    case noListener
    /// Something else went wrong on the way: a timeout, a reset.
    case failed(String)
}

/// One request to the bridge on this Mac. Production is
/// `LoopbackLiveCaptureTransport` (live-capture-transport.swift); tests pass a fake.
public protocol LiveCaptureTransport: Sendable {
    /// `key` is sent as the bearer; nil sends no credential at all — the
    /// presence probe that tells "no bridge" from "no key".
    func send(_ route: LiveCaptureRoute, body: Data?, key: LiveCaptureControlKey?) async -> LiveCaptureWireResult
}

/// The client the bar holds: the transport, the key source, and the instance
/// whose account the key is filed under.
@MainActor
public final class BridgeLiveCaptureClient: LiveCaptureClient {
    private let transport: any LiveCaptureTransport
    private let keys: any LiveCaptureKeySource
    private let instanceID: @MainActor () -> String?
    /// The key read for an instance, held in memory only while it is that
    /// instance's — never written anywhere, never logged.
    private var cached: (instanceID: String, key: LiveCaptureControlKey)?

    public init(transport: any LiveCaptureTransport, keys: any LiveCaptureKeySource, instanceID: @escaping @MainActor () -> String?) {
        self.transport = transport
        self.keys = keys
        self.instanceID = instanceID
    }

    /// An instance switch, or the owner's *Try Again*: the key read before is
    /// dropped and read afresh on the next call.
    public func forgetKey() {
        cached = nil
    }

    public func state() async -> Result<LiveCaptureState, LiveCaptureError> {
        await call(.status, body: nil).flatMap { Self.decode(LiveCaptureState.self, $0) }
    }

    public func start(_ request: LiveCaptureStart) async -> Result<LiveCaptureSession, LiveCaptureError> {
        let body = try? JSONEncoder().encode(request.body)
        return await call(.start, body: body).flatMap { data in
            Self.decode(SessionReply.self, data).flatMap { reply in
                reply.session.map { .success($0) } ?? .failure(.refused(code: "internal", message: "the recorder started but named no session"))
            }
        }
    }

    public func stop() async -> Result<LiveCaptureSession?, LiveCaptureError> {
        await call(.stop, body: nil).flatMap { Self.decode(SessionReply.self, $0).map(\.session) }
    }

    public func keepGoing() async -> Result<Bool, LiveCaptureError> {
        await call(.keepGoing, body: nil).flatMap { Self.decode(KeepGoingReply.self, $0).map(\.answered) }
    }

    public func grants() async -> Result<[String: String], LiveCaptureError> {
        // `/check` answers 503 with the same body when the bridge is degraded:
        // the grants are in it either way.
        await call(.check, body: nil, acceptingDegraded: true).flatMap { Self.decode(CheckReply.self, $0).map { $0.meta?.grants ?? [:] } }
    }

    public func purge(_ sessionID: String) async -> Result<LiveCapturePurged, LiveCaptureError> {
        // The body is `{session_id}` and nothing else — the bridge refuses any other field.
        let body = try? JSONEncoder().encode(["session_id": sessionID])
        return await call(.purge, body: body).flatMap { Self.decode(LiveCapturePurged.self, $0) }
    }

    // MARK: The one path every call takes

    private func call(_ route: LiveCaptureRoute, body: Data?, acceptingDegraded: Bool = false) async -> Result<Data, LiveCaptureError> {
        let key: LiveCaptureControlKey
        switch await currentKey() {
        case .success(let k): key = k
        case .failure(let e): return .failure(e)
        }
        var result = await transport.send(route, body: body, key: key)
        if case .answered(401, _) = result {
            // The owner may have minted a new key since it was read: read it
            // once more, and try once more only if it changed. A 401 means
            // nothing happened, so a second try cannot start a second recording.
            cached = nil
            guard case .success(let fresh) = await currentKey(), fresh != key else { return .failure(.keyRefused) }
            result = await transport.send(route, body: body, key: fresh)
        }
        switch result {
        case .noListener:
            return .failure(.absent)
        case .failed(let why):
            return .failure(.unreachable(why))
        case .answered(let status, let data):
            if (200..<300).contains(status) || (acceptingDegraded && status == 503 && route == .check) { return .success(data) }
            if status == 401 { return .failure(.keyRefused) }
            if status == 403 { return .failure(.notControlKey) }
            let envelope = (try? JSONDecoder().decode(ErrorReply.self, from: data))?.error
            return .failure(.refused(code: envelope?.code ?? "http_\(status)", message: envelope?.message ?? "the recorder answered \(status)"))
        }
    }

    /// The key for the current instance — read once, then held. With none,
    /// the bridge is asked with no credential at all, only to tell "no
    /// bridge" (hide the bar) from "no key" (say so): the answer is a 401
    /// either way, and nothing it could say is trusted beyond that.
    private func currentKey() async -> Result<LiveCaptureControlKey, LiveCaptureError> {
        guard let id = instanceID() else { return await withoutKey(LiveCaptureWords.noInstanceYet) }
        if let cached, cached.instanceID == id { return .success(cached.key) }
        switch await keys.controlKey(instanceID: id) {
        case .found(let key):
            cached = (id, key)
            return .success(key)
        case .missing:
            return await withoutKey(LiveCaptureWords.noKey)
        case .unreadable(let why):
            return await withoutKey(LiveCaptureWords.unreadable(why))
        }
    }

    private func withoutKey(_ reason: String) async -> Result<LiveCaptureControlKey, LiveCaptureError> {
        switch await transport.send(.status, body: nil, key: nil) {
        case .noListener: return .failure(.absent)
        case .failed(let why): return .failure(.unreachable(why))
        case .answered: return .failure(.noKey(reason))
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> Result<T, LiveCaptureError> {
        do { return .success(try JSONDecoder().decode(type, from: data)) } catch {
            return .failure(.refused(code: "undecodable", message: "the recorder's answer could not be read"))
        }
    }

    private struct SessionReply: Decodable { let session: LiveCaptureSession? }
    private struct KeepGoingReply: Decodable { let answered: Bool }
    private struct CheckReply: Decodable {
        struct Meta: Decodable { let grants: [String: String]? }
        let meta: Meta?
    }
    private struct ErrorReply: Decodable {
        struct Envelope: Decodable { let code: String; let message: String }
        let error: Envelope
    }
}

/// The client an `AppModel` gets when nothing better is wired — a test's, or
/// a platform with no bridge: always absent, so the bar never appears and
/// nothing is ever sent.
public struct AbsentLiveCaptureClient: LiveCaptureClient {
    public init() {}
    public func state() async -> Result<LiveCaptureState, LiveCaptureError> { .failure(.absent) }
    public func start(_ request: LiveCaptureStart) async -> Result<LiveCaptureSession, LiveCaptureError> { .failure(.absent) }
    public func stop() async -> Result<LiveCaptureSession?, LiveCaptureError> { .failure(.absent) }
    public func keepGoing() async -> Result<Bool, LiveCaptureError> { .failure(.absent) }
    public func grants() async -> Result<[String: String], LiveCaptureError> { .failure(.absent) }
    public func purge(_ sessionID: String) async -> Result<LiveCapturePurged, LiveCaptureError> { .failure(.absent) }
}
