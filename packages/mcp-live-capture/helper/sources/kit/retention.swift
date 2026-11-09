// Retention and re-review (T8-4, plan §2.15, Q7).
//
// THE RULE. A session's audio stays under `.metistry/state/capture/<session>/`
// until its transcript is ingested — the meeting's proposals decided, or the
// fold has read it — plus 7 days, and never more than 30 days after the
// recording ended. Then the audio files are deleted and the record says when
// (`audio_deleted_at`). This Mac's copy of the transcript (`transcript.jsonl`)
// goes 30 days after the end, once it has reached Metistry.
//
// Enforced HERE, on the one machine that holds the audio, by one pure
// function — whoever asks. The ceiling needs nobody's word: the bridge's own
// timer applies it every sweep, so a console that is down, rebuilt or never
// configured cannot keep audio past 30 days. Ingestion is the console's to
// report (only it knows when the proposals were decided); it can bring the
// deletion FORWARD, never push it back, and it is clamped to the delivery —
// a transcript cannot have been ingested before it reached the console.
//
// The media is the audio and, for a Window / Screen session, its frames
// (T8-3's `screen.mp4`): "audio (and screen frames) stay … then the media is
// deleted" (plan §2.15). Both go together.
//
// RE-REVIEW. `recording_review` re-transcribes a span of the kept audio and
// answers TEXT with timestamps. The audio itself never leaves this helper:
// the only thing the review path returns is what the transcriber wrote.

import Foundation

public struct RetentionPolicy: Equatable {
    /// After ingestion (§2.15: "plus 7 days").
    public let afterIngestion: TimeInterval
    /// The ceiling, from the end of the recording (§4 Q6: "never more than 30").
    public let ceiling: TimeInterval
    /// This Mac's transcript copy, from the end (C91: 30 days).
    public let transcript: TimeInterval

    public init(afterIngestion: TimeInterval, ceiling: TimeInterval, transcript: TimeInterval) {
        self.afterIngestion = afterIngestion
        self.ceiling = ceiling
        self.transcript = transcript
    }

    private static let day: TimeInterval = 24 * 3600
    /// The owner's rulings: 7 days after ingestion, never over 30; transcripts 30.
    public static let q7 = RetentionPolicy(afterIngestion: 7 * day, ceiling: 30 * day, transcript: 30 * day)
}

/// When the session's audio is deleted under `policy`: nil while it is still
/// recording (it has no end yet). Ingestion can only bring it forward.
public func audioDeleteAfter(_ r: SessionRecord, policy: RetentionPolicy = .q7) -> Date? {
    guard r.state == .ended, let ended = r.endedAt else { return nil }
    let ceiling = ended.addingTimeInterval(policy.ceiling)
    guard let ingested = r.ingestedAt else { return ceiling }
    return min(ingested.addingTimeInterval(policy.afterIngestion), ceiling)
}

/// When this Mac's copy of the transcript is deleted: 30 days after the end.
public func transcriptDeleteAfter(_ r: SessionRecord, policy: RetentionPolicy = .q7) -> Date? {
    guard r.state == .ended, let ended = r.endedAt else { return nil }
    return ended.addingTimeInterval(policy.transcript)
}

/// The ingestion time the record will keep for a reported one: never before
/// the delivery (it cannot have been read before it arrived), never after
/// `now` (a future claim is not a report). nil — refused — when the session
/// was never delivered.
public func clampIngestion(_ reported: Date, record: SessionRecord, now: Date) -> Date? {
    guard let delivered = record.delivery?.at else { return nil }
    return min(max(reported, delivered), now)
}

// MARK: - Re-review

/// One stretch of speech the transcriber wrote, in seconds from the start of
/// the audio it was handed.
public struct TimedText: Equatable {
    public let fromS: Double
    public let toS: Double
    public let text: String

    public init(fromS: Double, toS: Double, text: String) {
        self.fromS = fromS
        self.toS = toS
        self.text = text
    }
}

/// Re-transcribe `[fromS, toS)` of one audio file (seconds from the file's
/// start) with the on-device transcriber's most careful setting. The real one
/// is `SpanTranscriber` in sources/helper; the tests' is a fake.
public protocol SpanTranscribing {
    func transcribe(file: URL, fromS: Double, toS: Double) throws -> [TimedText]
}

/// No transcriber (below macOS 26, or a test that wants none).
public struct NoSpanTranscriber: SpanTranscribing {
    public init() {}
    public func transcribe(file: URL, fromS: Double, toS: Double) throws -> [TimedText] {
        throw ReviewError.noTranscriber
    }
}

public enum ReviewError: Error, Equatable {
    case invalid(String)
    case noTranscriber
    case failed(String)

    public var code: String {
        switch self {
        case .invalid: return "invalid_request"
        case .noTranscriber: return "no_transcriber"
        case .failed: return "review_failed"
        }
    }

    public var message: String {
        switch self {
        case .invalid(let why): return why
        case .noTranscriber: return "the on-device transcriber is not available on this Mac (macOS 26) — the transcript made while recording is all there is"
        case .failed(let why): return "the transcriber could not re-read that span: \(why)"
        }
    }
}

/// The longest span one review re-transcribes. limit: fixed — a re-review
/// answers "what exactly was said there", a few minutes around a moment, and
/// the helper answers one request at a time; a longer span would hold every
/// other request (the bar's Stop included) behind it.
public let maxReviewSpanS: Double = 15 * 60

/// One re-transcribed line, in seconds from Record.
public struct ReviewLine: Equatable {
    public let source: AudioSource
    public let fromS: Double
    public let toS: Double
    public let text: String
}

public enum ReviewResult: Equatable {
    /// The span, re-read: every line the transcriber wrote, in time order.
    case text([ReviewLine])
    /// The audio is gone: the record says when, and why (`retention` or
    /// `owner`), and whether the transcript was ingested first.
    case audioDeleted(SessionRecord)
}

/// The audio files, and the part of each, a span covers: a file runs from
/// its offset to the next file of the same source (or on, for the last one).
/// The frames (`screen.mp4`) are never re-read — a review is of what was said.
public func reviewPlan(_ media: [MediaFile], fromS: Double, toS: Double) -> [(MediaFile, Double, Double)] {
    var out: [(MediaFile, Double, Double)] = []
    for source in AudioSource.allCases {
        let files = media.filter { $0.source == source }.sorted { $0.offsetS < $1.offsetS }
        for (i, f) in files.enumerated() {
            let end = i + 1 < files.count ? files[i + 1].offsetS : Double.infinity
            let lo = max(fromS, f.offsetS)
            let hi = min(toS, end)
            if lo < hi { out.append((f, lo - f.offsetS, hi - f.offsetS)) }
        }
    }
    return out
}
