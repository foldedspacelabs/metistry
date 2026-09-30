// Where one source's audio goes as it arrives: the session's audio file, and
// the on-device transcriber (macOS 26). Shared by the process tap and the
// microphone, so both are kept and transcribed the same way.

import AVFoundation
import Foundation

struct HelperFailure: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

/// Run async work from the helper's synchronous request path, bounded.
func blocking<T>(timeout: TimeInterval, _ body: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task {
        do { result = .success(try await body()) } catch { result = .failure(error) }
        done.signal()
    }
    guard done.wait(timeout: .now() + timeout) == .success, let r = result else { throw HelperFailure("timed out after \(Int(timeout))s") }
    return try r.get()
}

/// The locale the transcriber listens in: `METISTRY_LC_LOCALE`, else the Mac's.
func transcriptionLocale() -> Locale {
    if let id = ProcessInfo.processInfo.environment["METISTRY_LC_LOCALE"], !id.isEmpty { return Locale(identifier: id) }
    return Locale.current
}

final class SourceSink {
    private var file: AVAudioFile?
    private let transcriber: AnyObject?
    private let feed: ((AVAudioPCMBuffer) -> Void)?
    private let finishTranscriber: (() -> Void)?
    private(set) var observedAudio = false

    /// `url` is `<session>/<source>.m4a` (`-2`, `-3`… after a wake — never
    /// the first file again: AVAudioFile truncates what it opens for
    /// writing): AAC at 64 kb/s — about 29 MB an hour, well inside C137's
    /// ~150 MB/h budget.
    init(url: URL, format: AVAudioFormat, onSegment: @escaping (Double, Double, String) -> Void) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: min(format.channelCount, 2),
            AVEncoderBitRateKey: 64_000,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        if #available(macOS 26.0, *) {
            let t = try? LiveTranscriber(locale: transcriptionLocale(), input: format, onSegment: onSegment)
            transcriber = t
            feed = t.map { t in { t.feed($0) } }
            finishTranscriber = t.map { t in { t.finish() } }
        } else {
            transcriber = nil
            feed = nil
            finishTranscriber = nil
        }
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        try? file?.write(from: buffer)
        feed?(buffer)
        if !observedAudio, let channels = buffer.floatChannelData {
            let n = Int(buffer.frameLength)
            outer: for c in 0..<Int(buffer.format.channelCount) where !buffer.format.isInterleaved || c == 0 {
                let count = buffer.format.isInterleaved ? n * Int(buffer.format.channelCount) : n
                for i in 0..<count where channels[c][i] != 0 {
                    observedAudio = true
                    break outer
                }
            }
        }
    }

    /// Flush the text and close the file.
    func finish() {
        finishTranscriber?()
        file = nil // AVAudioFile finalises the container when released
    }
}
