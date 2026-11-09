// A session on disk: `<capture dir>/<session id>/` under the instance's
// `.metistry/state/capture/` (plan §2.15) — never in the vault. The helper is
// told the directory (`METISTRY_CAPTURE_DIR`, invariant 7: no absolute path is
// assumed) and writes three kinds of file there:
//
//   session.json      the record below, rewritten whole (atomically) on every
//                     change of state
//   transcript.jsonl  one line per finished segment or gap, appended and
//                     synchronised as it arrives — so a crash keeps
//                     everything up to the crash (C137)
//   <source>.m4a      the audio (the adapters write it; `-2`, `-3`… after a wake)
//   screen.mp4        Window / Screen: the frames (`-2`… after a wake)
//
// When a session has ended, the bridge hands its transcript to the console's
// `POST /capture` and tells the helper so (`delivery`, below): the record is
// the one place that says a transcript reached Metistry, so a crash, a
// console that was down or a refused credential leaves it owed, never lost.
//
// Retention (T8-4, plan §2.15) deletes two things here and nothing else: the
// media files (`deleteMedia` — the audio, and a Window / Screen session's
// frames) once the session is due, and `transcript.jsonl`
// (`deleteTranscript`) once the transcript's 30 days are up. `session.json`
// stays — it is the record that says when, and why, the audio went, which is
// what `recording_review` answers after it has.

import Foundation

public enum AudioSource: String, Codable, Equatable, CaseIterable {
    /// The chosen apps, through the process tap.
    case app
    /// The owner's microphone — their side only.
    case mic
}

public enum SessionState: String, Codable, Equatable {
    case recording
    /// The Mac slept; streams are closed and reopen on wake.
    case paused
    case ended
}

/// A span the recording did not hear, in seconds from Record.
public struct Gap: Codable, Equatable {
    public let fromS: Double
    public let toS: Double
    public let reason: String

    enum CodingKeys: String, CodingKey { case fromS = "from_s", toS = "to_s", reason }
}

public struct ScopeProcess: Codable, Equatable {
    public let bundleID: String
    public let pid: Int32

    enum CodingKeys: String, CodingKey { case bundleID = "bundle_id", pid }
}

/// Where a session's transcript went: the inbox row `POST /capture` answered
/// with. Written once; a session with one is never delivered again.
public struct Delivery: Codable, Equatable {
    public let inboxID: Int
    public let at: Date

    public init(inboxID: Int, at: Date) {
        self.inboxID = inboxID
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case inboxID = "inbox_id", at }
}

public struct SessionRecord: Codable, Equatable {
    public let sessionID: String
    public let startedAt: Date
    public var state: SessionState
    public var endedAt: Date?
    public var endedReason: String?
    /// The owner's chosen apps, as the record sheet sent them.
    public let apps: [String]
    /// What the tap was built from (the plan's mode and what it matched).
    public let tapMode: String?
    public let processes: [ScopeProcess]
    public let appAudio: Bool
    public let microphone: Bool
    public var gaps: [Gap]
    /// Whether the tap delivered any sound at all — the one behavioural fact
    /// about the audio-capture grant that macOS lets a helper observe.
    public var appAudioObserved: Bool
    public var remindersRaised: Int
    /// nil until the transcript has reached the console (T8-2b). A
    /// session.json written before this field existed reads as owed.
    public var delivery: Delivery? = nil
    /// What the session took (T8-3). nil in a session.json written before
    /// this field existed, which was Audio only.
    public var mode: CaptureMode? = nil
    /// *Window* / *Screen*: what the picker chose — its kind and app, never a
    /// title or a frame. nil for Audio only.
    public var picture: PictureRecord? = nil
    /// When the transcript was ingested — the meeting's proposals decided, or
    /// the fold has read it — as the console reported it (T8-4). The audio
    /// goes 7 days after this, never later than 30 days after the end.
    /// Written once; never before the delivery.
    public var ingestedAt: Date? = nil
    /// When the media was deleted, and why: `retention` (the rule) or
    /// `owner` (Purge Now). nil while it is kept.
    public var audioDeletedAt: Date? = nil
    public var audioDeletedReason: String? = nil
    /// When this Mac's copy of the transcript (`transcript.jsonl`) was
    /// deleted — 30 days after the end, and only once it was delivered.
    public var transcriptDeletedAt: Date? = nil

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", startedAt = "started_at", state, endedAt = "ended_at", endedReason = "ended_reason"
        case apps, tapMode = "tap_mode", processes, appAudio = "app_audio", microphone, gaps
        case appAudioObserved = "app_audio_observed", remindersRaised = "reminders_raised", delivery, mode, picture
        case ingestedAt = "ingested_at", audioDeletedAt = "audio_deleted_at", audioDeletedReason = "audio_deleted_reason"
        case transcriptDeletedAt = "transcript_deleted_at"
    }
}

/// One finished stretch of speech, in seconds from Record.
public struct TranscriptSegment: Equatable {
    public let source: AudioSource
    public let fromS: Double
    public let toS: Double
    public let text: String

    public init(source: AudioSource, fromS: Double, toS: Double, text: String) {
        self.source = source
        self.fromS = fromS
        self.toS = toS
        self.text = text
    }
}

/// One media file of a session: its source (`app`, `mic` or `screen`), and
/// where in the session it starts, in seconds from Record — read from when
/// the file was created, which is when its stream wrote its first sample (0
/// for the first, the end of the sleep it followed for a `-2`, `-3`…).
public struct MediaFile: Equatable {
    public let base: String
    public let offsetS: Double
    public let url: URL
    public let bytes: Int64

    public init(base: String, offsetS: Double, url: URL, bytes: Int64) {
        self.base = base
        self.offsetS = offsetS
        self.url = url
        self.bytes = bytes
    }

    /// The audio source, for an audio file; nil for the frames.
    public var source: AudioSource? { AudioSource(rawValue: base) }
}

/// The media file names a session holds (`nextMediaURL`'s): `app.m4a`,
/// `app-2.m4a`…, the same for `mic`, and `screen.mp4`, `screen-2.mp4`…. nil
/// for anything else — `session.json` and `transcript.jsonl` are never media.
public func parseMediaFileName(_ name: String) -> (base: String, n: Int)? {
    for (base, ext) in [("app", "m4a"), ("mic", "m4a"), ("screen", "mp4")] {
        if name == "\(base).\(ext)" { return (base, 1) }
        let prefix = "\(base)-", suffix = ".\(ext)"
        guard name.hasPrefix(prefix), name.hasSuffix(suffix), name.count > prefix.count + suffix.count else { continue }
        let digits = String(name.dropFirst(prefix.count).dropLast(suffix.count))
        if let n = Int(digits), n >= 2, String(n) == digits { return (base, n) }
    }
    return nil
}

public protocol SessionStore: AnyObject {
    /// The capture directory every session lives under.
    var root: URL { get }
    func directory(for sessionID: String) -> URL
    func create(_ record: SessionRecord) throws
    func update(_ record: SessionRecord) throws
    func append(_ segment: TranscriptSegment, to sessionID: String)
    func appendGap(_ gap: Gap, to sessionID: String)
    func sessions() -> [SessionRecord]
    /// When the session's files were last written — how far a crash saved.
    func lastWrite(_ sessionID: String) -> Date?
    /// The transcript as written, one object per line (segments and gaps),
    /// in the order they were appended. A torn last line — the crash landed
    /// mid-write — is skipped, never guessed at.
    func transcript(_ sessionID: String) -> [[String: Any]]
    /// The session's media files, by source and then by where they start.
    /// `startedAt` is the session's start, which each file's offset is from.
    func media(_ sessionID: String, startedAt: Date) -> [MediaFile]
    /// Delete every media file of the session; the bytes it freed. Nothing
    /// else in the directory is touched.
    func deleteMedia(_ sessionID: String) throws -> Int64
    /// Delete this Mac's copy of the transcript (`transcript.jsonl`).
    func deleteTranscript(_ sessionID: String) throws
}

public let sessionFile = "session.json"
public let transcriptFile = "transcript.jsonl"

public func sessionEncoder() -> JSONEncoder {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    e.outputFormatting = [.sortedKeys]
    return e
}

public func sessionDecoder() -> JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return d
}

/// Session ids are the directory names, so they are checked before any path
/// is built from one: lowercase, digits and hyphens only.
public func isSessionID(_ s: String) -> Bool {
    !s.isEmpty && s.count <= 64 && s.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
}

public final class FileSessionStore: SessionStore {
    public let root: URL
    private let lock = NSLock()
    private let fm = FileManager.default

    public init(root: URL) { self.root = root }

    public func directory(for sessionID: String) -> URL {
        precondition(isSessionID(sessionID), "session id \(sessionID) is not a directory name")
        return root.appendingPathComponent(sessionID, isDirectory: true)
    }

    public func create(_ record: SessionRecord) throws {
        // Owner-only: what the Mac heard is nobody else's to read.
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(at: directory(for: record.sessionID), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try update(record)
    }

    public func update(_ record: SessionRecord) throws {
        lock.lock(); defer { lock.unlock() }
        let data = try sessionEncoder().encode(record)
        try data.write(to: directory(for: record.sessionID).appendingPathComponent(sessionFile), options: [.atomic])
    }

    public func append(_ segment: TranscriptSegment, to sessionID: String) {
        appendLine(["kind": "segment", "source": segment.source.rawValue, "from_s": round2(segment.fromS), "to_s": round2(segment.toS), "text": segment.text], to: sessionID)
    }

    public func appendGap(_ gap: Gap, to sessionID: String) {
        appendLine(["kind": "gap", "from_s": round2(gap.fromS), "to_s": round2(gap.toS), "reason": gap.reason], to: sessionID)
    }

    private func appendLine(_ object: [String: Any], to sessionID: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        lock.lock(); defer { lock.unlock() }
        let url = directory(for: sessionID).appendingPathComponent(transcriptFile)
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let h = try? FileHandle(forWritingTo: url) else { return }
        defer { try? h.close() }
        _ = try? h.seekToEnd()
        try? h.write(contentsOf: data + Data([0x0A]))
        // Synchronised line by line: a crash keeps every finished segment.
        try? h.synchronize()
    }

    public func sessions() -> [SessionRecord] {
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        return names.filter(isSessionID).sorted().compactMap { name in
            let url = root.appendingPathComponent(name).appendingPathComponent(sessionFile)
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? sessionDecoder().decode(SessionRecord.self, from: data)
        }
    }

    public func lastWrite(_ sessionID: String) -> Date? {
        let dir = directory(for: sessionID)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return nil }
        return names.compactMap { n in
            (try? fm.attributesOfItem(atPath: dir.appendingPathComponent(n).path))?[.modificationDate] as? Date
        }.max()
    }

    public func transcript(_ sessionID: String) -> [[String: Any]] {
        let url = directory(for: sessionID).appendingPathComponent(transcriptFile)
        guard let data = try? Data(contentsOf: url) else { return [] }
        return data.split(separator: 0x0A).compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any]
        }
    }

    public func media(_ sessionID: String, startedAt: Date) -> [MediaFile] {
        let dir = directory(for: sessionID)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.compactMap { name -> MediaFile? in
            guard let (base, _) = parseMediaFileName(name) else { return nil }
            let url = dir.appendingPathComponent(name)
            let attrs = (try? fm.attributesOfItem(atPath: url.path)) ?? [:]
            let bytes = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            let created = (attrs[.creationDate] as? Date) ?? startedAt
            return MediaFile(base: base, offsetS: round2(max(0, created.timeIntervalSince(startedAt))), url: url, bytes: bytes)
        }.sorted { ($0.base, $0.offsetS) < ($1.base, $1.offsetS) }
    }

    public func deleteMedia(_ sessionID: String) throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        let dir = directory(for: sessionID)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return 0 }
        var freed: Int64 = 0
        for name in names where parseMediaFileName(name) != nil {
            let url = dir.appendingPathComponent(name)
            freed += ((try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
            try fm.removeItem(at: url)
        }
        return freed
    }

    public func deleteTranscript(_ sessionID: String) throws {
        lock.lock(); defer { lock.unlock() }
        let url = directory(for: sessionID).appendingPathComponent(transcriptFile)
        if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
    }
}

/// `METISTRY_CAPTURE_DIR`, else `<METISTRY_INSTANCE_DIR>/.metistry/state/capture`
/// (plan §2.15) — the launchd job `metistry up` renders carries the instance
/// directory, so the helper needs no path of its own (invariant 7). nil when
/// neither is set: the helper refuses to start rather than pick a directory.
public func captureDirectory(_ env: [String: String]) -> String? {
    if let dir = env["METISTRY_CAPTURE_DIR"]?.trimmingCharacters(in: .whitespaces), !dir.isEmpty { return dir }
    guard var instance = env["METISTRY_INSTANCE_DIR"]?.trimmingCharacters(in: .whitespaces), !instance.isEmpty else { return nil }
    while instance.count > 1 && instance.hasSuffix("/") { instance.removeLast() }
    return instance + "/.metistry/state/capture"
}

func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
