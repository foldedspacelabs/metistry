// Settings ▸ Live Capture (T6-15; screen-11 §8, plan §2.15): one switch, one
// place, three permissions, what is kept, and Purge Now with its count.
//
// EVERY ROW IS A READ-THROUGH OR THE ONE THING THIS MAC OWNS.
//
//   the bar, its edge, its display   `CaptureBarPreferences` — device-local by
//                                    contract ("no CLI and no API",
//                                    docs/ops/client-api.md); the bar (T8-5)
//                                    reads it, this pane writes it
//   permissions                      doctor's `live-capture` bridge row: the
//                                    recorder's own `check()` reports each
//                                    grant's state (`bridge_meta.grants`). The
//                                    rows are a read-through — macOS holds the
//                                    grants, and a pane that pretended to grant
//                                    one would be lying about who decides
//   what is kept                     the rulings (§2.15, Q7, C91), templated
//                                    with the assistant's name; no path
//   the recordings                   the transcripts under Journal/Transcripts/
//                                    (`GET /api/knowledge/pages`) name the
//                                    recordings; `GET /api/recordings/:id`
//                                    (T8-4) says of each whether its audio is
//                                    still kept, how much, and until when
//   Purge Now                        the bridge's `POST /recording/purge`, one
//                                    recording at a time, through
//                                    `LiveCaptureClient.purge` — the control
//                                    credential, this Mac's alone. Confirmed
//                                    first, naming each recording (C136)
//
// ABSENT, NOT OFF, WITHOUT THE BRIDGE (screen-11 §8). No `live-capture` row,
// or one doctor reports `absent`: the pane is the absent state — no switch,
// no grants, no count — because there is no bar to switch and nobody holding
// a grant. That is a fact about this Mac, not a fault (design-system §3.13).
//
// The app does not hold the recorder's control credential yet — the bar is
// T8-5's, and the credential arrives with it. Until a `LiveCaptureClient` is
// wired in, Purge Now is off and says so, and the recorder's own hourly rule
// keeps deleting on time regardless (packages/mcp-live-capture/README.md).

import Foundation
import Observation

// MARK: - Permissions, as the recorder reports them

/// One TCC grant the recorder needs, and the state its `check()` reported.
public struct CaptureGrant: Sendable, Equatable, Identifiable {
    public enum Kind: String, CaseIterable, Sendable {
        case microphone
        case audioCapture = "audio_capture"
        case screenRecording = "screen_recording"

        /// Title Case — the row's name, as System Settings spells it.
        public var title: String {
            switch self {
            case .microphone: return "Microphone"
            case .audioCapture: return "Audio Capture"
            case .screenRecording: return "Screen Recording"
            }
        }

        /// What each one is for, in a line.
        public var purpose: String {
            switch self {
            case .microphone: return "Your side of a call."
            case .audioCapture: return "The other side — app audio, for Audio Only."
            case .screenRecording: return "Window and Screen recordings."
            }
        }
    }

    public let kind: Kind
    /// The recorder's own word: `granted`, `observed`, `not_asked`, `not_granted`, `unverified`, `denied`, `restricted`.
    public let wire: String

    public var id: String { kind.rawValue }

    public init(kind: Kind, wire: String) {
        self.kind = kind
        self.wire = wire
    }

    /// Whether, not when (screen-11 §8): *Approved* or *Not yet asked*, per
    /// grant. `observed` is Audio Capture heard working — macOS has no
    /// permission API for it, so the recorder can only say whether sound
    /// arrived; `unverified` is that it has not tried yet.
    public var state: String {
        switch wire {
        case "granted", "observed", "authorized": return "Approved"
        case "not_asked", "not_determined": return "Not yet asked"
        case "not_granted": return "Not approved"
        case "unverified": return "Not yet verified"
        case "denied": return "Denied"
        case "restricted": return "Restricted"
        default: return wire
        }
    }

    public var isApproved: Bool { state == "Approved" }

    /// A line the recorder's word needs, under the state; nil for the plain cases.
    public var detail: String? {
        switch wire {
        case "unverified": return "macOS has no switch for this one — it is verified the first time a recording hears app audio."
        case "not_granted": return "Screen Recording is approved in System Settings ▸ Privacy & Security, for Metistry Recorder."
        case "denied", "restricted": return "Turned off in System Settings ▸ Privacy & Security; the recorder cannot ask again."
        default: return nil
        }
    }

    /// The three rows, from the bridge row's `bridge_meta.grants`. Nil when the
    /// row carries none — a bridge that did not answer.
    public static func read(_ bridgeRow: DoctorRow?) -> [CaptureGrant]? {
        guard let grants = bridgeRow?.meta?["bridge_meta"]?["grants"], case .object(let fields) = grants else { return nil }
        return Kind.allCases.map { kind in
            CaptureGrant(kind: kind, wire: fields[kind.rawValue]?.stringValue ?? "unknown")
        }
    }
}

// MARK: - A recording's retention, as `GET /api/recordings/:id` reports it

public struct RecordingRetention: Sendable, Equatable, Identifiable {
    public let id: String
    public let startedAt: Date?
    public let endedAt: Date?
    public let audioKept: Bool
    public let audioBytes: Int
    public let audioDeleteAfter: Date?
    public let audioDeletedAt: Date?
    /// `retention` or `owner` (Purge Now).
    public let audioDeletedReason: String?
    public let transcriptPath: String?
    public let transcriptDeleteAfter: Date?

    public init(
        id: String, startedAt: Date?, endedAt: Date?, audioKept: Bool, audioBytes: Int,
        audioDeleteAfter: Date?, audioDeletedAt: Date?, audioDeletedReason: String?,
        transcriptPath: String?, transcriptDeleteAfter: Date?
    ) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.audioKept = audioKept
        self.audioBytes = audioBytes
        self.audioDeleteAfter = audioDeleteAfter
        self.audioDeletedAt = audioDeletedAt
        self.audioDeletedReason = audioDeletedReason
        self.transcriptPath = transcriptPath
        self.transcriptDeleteAfter = transcriptDeleteAfter
    }

    public init?(json: JSONValue) {
        guard let id = json.string("id") else { return nil }
        let audio = json["audio"]
        let transcript = json["transcript"]
        self.init(
            id: id,
            startedAt: WireTime.date(json.string("started_at")),
            endedAt: WireTime.date(json.string("ended_at")),
            audioKept: audio?.bool("kept") ?? false,
            audioBytes: audio?.int("bytes") ?? 0,
            audioDeleteAfter: WireTime.date(audio?.string("delete_after")),
            audioDeletedAt: WireTime.date(audio?.string("deleted_at")),
            audioDeletedReason: audio?.string("deleted_reason"),
            transcriptPath: transcript?.string("path"),
            transcriptDeleteAfter: WireTime.date(transcript?.string("delete_after"))
        )
    }

    /// *28 Sep, 1:30 PM · 15m · 25 MB* — the cost line the confirm names, and
    /// the row in the list. Twelve-hour times.
    public func line(clock: ClockTime, now: Date) -> String {
        var parts: [String] = []
        if let startedAt { parts.append(clock.moment(startedAt, now: now)) }
        if let startedAt, let endedAt { parts.append(ClockTime.duration(endedAt.timeIntervalSince(startedAt))) }
        parts.append(audioKept ? RecordingRetention.size(audioBytes) : "audio deleted")
        return parts.joined(separator: " · ")
    }

    /// Under the row: when the audio goes, or why it went.
    public func retentionLine(clock: ClockTime, now: Date) -> String {
        if audioKept {
            guard let audioDeleteAfter else { return "Audio kept" }
            return "Audio kept until \(clock.moment(audioDeleteAfter, now: now))"
        }
        var line = "Audio deleted"
        if let audioDeletedAt { line += " \(clock.moment(audioDeletedAt, now: now))" }
        switch audioDeletedReason {
        case "owner": line += " by Purge Now"
        case "retention": line += " by the retention rule"
        default: break
        }
        if let transcriptDeleteAfter { line += "; the transcript remains until \(clock.moment(transcriptDeleteAfter, now: now))" }
        return line
    }

    /// *25 MB*, *1.2 GB* — decimal units, one decimal above a gigabyte.
    public static func size(_ bytes: Int) -> String {
        let b = Double(max(bytes, 0))
        if b >= 1_000_000_000 { return String(format: "%.1f GB", b / 1_000_000_000) }
        if b >= 1_000_000 { return "\(Int((b / 1_000_000).rounded())) MB" }
        if b >= 1_000 { return "\(Int((b / 1_000).rounded())) KB" }
        return "\(Int(b)) B"
    }

    /// Where the bridge's transcripts are filed (docs/ops/client-api.md; Q29).
    public static let transcriptsPrefix = "Journal/Transcripts"

    /// `Journal/Transcripts/2026-09-28-20260928-133000-00ab.md` → the recorder's
    /// session id after the day prefix. Nil for a file that is not a transcript
    /// the bridge delivered (`docs/ops/client-api.md`: `<date>-<session>.md`).
    public static func recordingID(fromPath path: String) -> String? {
        guard path.hasPrefix(transcriptsPrefix + "/") else { return nil }
        let name = String(path.split(separator: "/").last ?? "")
        guard name.hasSuffix(".md") else { return nil }
        let stem = String(name.dropLast(3))
        // YYYY-MM-DD- is eleven characters
        guard stem.count > 11, stem.range(of: #"^\d{4}-\d{2}-\d{2}-"#, options: .regularExpression) != nil else { return nil }
        let id = String(stem.dropFirst(11))
        guard id.range(of: #"^[a-z0-9-]{1,64}$"#, options: .regularExpression) != nil else { return nil }
        return id
    }
}

// MARK: - The displays the platform offers

/// One display, as the app target reads it off `NSScreen` (the kit has no
/// AppKit). An empty list is drawn as the main display alone.
public struct CaptureBarDisplay: Sendable, Equatable, Identifiable {
    public let id: Int
    public let name: String
    public let isMain: Bool

    public init(id: Int, name: String, isMain: Bool) {
        self.id = id
        self.name = name
        self.isMain = isMain
    }
}

// MARK: - The words

public enum LiveCaptureWords {
    public static let purgeNow = "Purge Now"
    /// The three *What <name> keeps* rows (§2.15; screen-11 §8, corrected by Q7 and C91).
    public static let keepsAudio = "Until the transcript is folded, plus 7 days — never more than 30"
    public static let keepsTranscript = "30 days"
    public static let keepsNotes = "Only what you approve, in your vault"
    /// Under the permissions: who holds them.
    public static let permissionsNote = "macOS holds these; Metistry Recorder asks the first time it needs one. Nothing here can grant a permission — System Settings can."
    /// Under the bar switch: the bar is T8-5's.
    public static let barNote = "The bar is not drawn yet. This switch and placement are what it reads when it is — and off means off: no bar, whatever else is set."
    /// Purge Now with no client to send it through.
    public static let purgeNeedsTheRecorder = "This app cannot reach the recorder's Purge yet; the retention rule above still deletes audio on time."
    /// The absent state (screen-11 §8).
    public static let absentTitle = "Live Capture Isn't Set Up"
    public static let absentSentence = "This Mac has no live-capture bridge, so there is no bar and nothing to grant. `metistry up` starts the bridge and its recorder once they are configured."
}

// MARK: - The model

@MainActor
@Observable
public final class LiveCaptureModel {
    public enum Presence: Sendable, Equatable {
        /// Doctor has not answered.
        case unknown
        /// No bridge on this Mac — a fact.
        case absent
        /// A bridge, in whatever state doctor found it.
        case present(CheckStatus)
    }

    /// The recorder's door, once the bar wires one in. Nil today: Purge Now is off and says why.
    @ObservationIgnored public var client: (any LiveCaptureClient)?
    public private(set) var recordings: [RecordingRetention] = []
    public private(set) var phase: ReadPhase = .idle
    /// The confirm on screen. `nil`: none. Presenting it sends nothing.
    public var confirmation: CostConfirmation?
    public private(set) var note: ScheduledNote?
    public private(set) var busy = false

    public static let transcriptsPrefix = RecordingRetention.transcriptsPrefix
    public static let bridgeName = "live-capture"

    @ObservationIgnored private let session: ConsoleSession?
    @ObservationIgnored private let status: StatusModel
    @ObservationIgnored public var now: () -> Date = Date.init
    @ObservationIgnored public var clock = ClockTime()

    public init(session: ConsoleSession?, status: StatusModel) {
        self.session = session
        self.status = status
    }

    public func reset() {
        recordings = []
        phase = .idle
        confirmation = nil
        note = nil
        busy = false
    }

    // MARK: The bridge, from doctor

    public var bridgeRow: DoctorRow? {
        status.report?.bridges.first { $0.name == Self.bridgeName }
    }

    public var presence: Presence {
        guard status.report != nil else { return .unknown }
        guard let row = bridgeRow, row.status != .absent else { return .absent }
        return .present(row.status)
    }

    /// The three grants, or nil when the bridge did not report them.
    public var grants: [CaptureGrant]? { CaptureGrant.read(bridgeRow) }

    // MARK: The recordings

    /// The transcripts name the recordings; each one's retention state is read.
    public func refresh() async {
        guard let session else {
            phase = .unavailable("no console session for this instance")
            return
        }
        phase = .reading
        switch await session.stores.knowledgePages(area: nil, prefix: Self.transcriptsPrefix, limit: 100, offset: nil) {
        case .failure(let error):
            phase = .unavailable(error.localizedDescription)
        case .success(let list):
            let ids = list.pages.map(\.path).compactMap(RecordingRetention.recordingID(fromPath:))
            var rows: [RecordingRetention] = []
            for id in ids {
                if case .success(let state) = await session.stores.recording(id), let row = RecordingRetention(json: state.json) {
                    rows.append(row)
                }
            }
            recordings = rows.sorted { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) }
            phase = .read
        }
    }

    public var kept: [RecordingRetention] { recordings.filter(\.audioKept) }
    public var keptBytes: Int { kept.reduce(0) { $0 + $1.audioBytes } }

    /// Beside the button — a destructive verb says what it will destroy
    /// (screen-11 §8): *26 MB in 1 recording*, or *No audio kept*.
    public var countLine: String {
        switch phase {
        case .idle, .reading: return "Counting…"
        case .unavailable: return "Count unavailable"
        case .read:
            let n = kept.count
            guard n > 0 else { return "No audio kept" }
            return "\(RecordingRetention.size(keptBytes)) in \(n) recording\(n == 1 ? "" : "s")"
        }
    }

    // MARK: Purge Now

    /// Why the button is off — a fact, always shown (components-01 §1.3). Nil
    /// when Purge Now may be pressed.
    public var purgeUnavailableReason: String? {
        if client == nil { return LiveCaptureWords.purgeNeedsTheRecorder }
        if case .unavailable(let why) = phase { return why }
        if phase == .read, kept.isEmpty { return "Nothing to purge — no audio is kept." }
        return nil
    }

    /// C136: the confirm, naming each recording whose audio goes. Nil when nothing is kept.
    public func confirmation(now: Date) -> CostConfirmation? {
        let rows = kept
        guard !rows.isEmpty else { return nil }
        return CostConfirmation(
            title: "Purge \(rows.count) Recording\(rows.count == 1 ? "" : "s") Now?",
            costHeading: "The audio of \(rows.count == 1 ? "this recording" : "these recordings") is deleted now — \(RecordingRetention.size(keptBytes)). Each transcript remains until its own 30 days:",
            costs: rows.map { $0.line(clock: clock, now: now) },
            confirm: LiveCaptureWords.purgeNow
        )
    }

    /// Purge Now pressed: the confirm. Sends nothing.
    public func purgeNow() {
        guard purgeUnavailableReason == nil else { return }
        confirmation = confirmation(now: now())
    }

    /// The dialog's answer. Only `.confirm` reaches the recorder — one purge per kept recording.
    public func choose(_ choice: CostConfirmView.Choice) async {
        confirmation = nil
        guard choice == .confirm, let client else { return }
        busy = true
        defer { busy = false }
        var purged = 0
        var failed: [String] = []
        for row in kept {
            switch await client.purge(row.id) {
            case .success: purged += 1
            case .failure(let error): failed.append(error.localizedDescription)
            }
        }
        if failed.isEmpty {
            note = ScheduledNote(kind: .done, text: "Purged \(purged) recording\(purged == 1 ? "" : "s") — the audio is gone; the transcripts remain.")
        } else {
            note = ScheduledNote(kind: .failed, text: "\(purged) purged; \(failed.count) refused: \(failed.joined(separator: "; "))")
        }
        await refresh()
    }
}
