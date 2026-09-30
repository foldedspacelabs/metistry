// Transcription on the Mac, as it records (plan §2.15, §4 Q18):
// SpeechAnalyzer + SpeechTranscriber, macOS 26. No authorization API and no
// network: the model is an OS asset (`AssetInventory`), downloaded once by
// the OS when first needed. Below macOS 26 there is no transcriber and
// `check()` says so; the audio is still kept.

import AVFoundation
import CoreMedia
import Foundation
import Speech

@available(macOS 26.0, *)
final class LiveTranscriber {
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let analyzer: SpeechAnalyzer
    private let work: Task<Void, Never>
    private let converter: AVAudioConverter?
    private let target: AVAudioFormat

    /// `careful`: `recording_review`'s setting (T8-4) — final results only,
    /// never `fastResults`, each with its confidence, at user-initiated
    /// priority. The live path keeps the same final-only results at the
    /// default priority, so a re-review is never slower to start than it has
    /// to be and never less careful than the recording was.
    init(locale requested: Locale, input: AVAudioFormat, careful: Bool = false, onSegment: @escaping (Double, Double, String) -> Void) throws {
        let (locale, format) = try blocking(timeout: 20) { () async throws -> (Locale, AVAudioFormat) in
            guard let l = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else { throw HelperFailure("no on-device transcriber for \(requested.identifier)") }
            let probe = SpeechTranscriber(locale: l, preset: .transcription)
            guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe], considering: input) else { throw HelperFailure("no audio format the transcriber takes") }
            return (l, f)
        }
        // Final results only, each with its time range in the stream.
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: careful ? [.audioTimeRange, .transcriptionConfidence] : [.audioTimeRange])
        let analyzer = careful
            ? SpeechAnalyzer(modules: [transcriber], options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .whileInUse))
            : SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        self.continuation = continuation
        self.target = format
        self.converter = input == format ? nil : AVAudioConverter(from: input, to: format)
        self.work = Task {
            do {
                // The model is an OS asset: installed on first use, then kept.
                // Audio arriving meanwhile waits in the stream.
                if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await install.downloadAndInstall()
                }
                try await analyzer.start(inputSequence: stream)
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    let start = result.range.start.seconds
                    onSegment(start, start + result.range.duration.seconds, text)
                }
            } catch {
                FileHandle.standardError.write(Data("transcriber: \(error)\n".utf8))
            }
        }
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converter else {
            continuation.yield(AnalyzerInput(buffer: copy(buffer)))
            return
        }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var handed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if handed { status.pointee = .noDataNow; return nil }
            handed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, out.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: out)) }
    }

    /// End of input: the analyzer finalises what it heard and the last
    /// segments are written before this returns (bounded — a stuck model
    /// never holds a stop).
    func finish(timeout: TimeInterval = 30) {
        continuation.finish()
        let analyzer = self.analyzer
        let work = self.work
        _ = try? blocking(timeout: timeout) {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            await work.value
        }
    }

    /// The tap hands a buffer that lives only for its callback; the stream
    /// keeps what it is given, so it gets a copy.
    private func copy(_ b: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        guard let c = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: b.frameLength) else { return b }
        c.frameLength = b.frameLength
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: b.audioBufferList))
        let dst = UnsafeMutableAudioBufferListPointer(c.mutableAudioBufferList)
        for (s, d) in zip(src, dst) {
            if let sp = s.mData, let dp = d.mData { memcpy(dp, sp, Int(min(s.mDataByteSize, d.mDataByteSize))) }
        }
        return c
    }
}

/// `recording_review`'s transcriber (T8-4): one span of one kept audio file,
/// read from the file and handed to a fresh analyzer at the careful setting.
/// Only text comes back — the lines and their times, in seconds from the
/// file's start. The audio is read here and goes nowhere else.
struct SpanTranscriber: SpanTranscribing {
    /// How long the analyzer may take to finish a span once it has all of it.
    /// limit: fixed — under the bridge's 150 s wait on the helper, so a slow
    /// model answers as a refusal the bridge can name, never a hung socket.
    static let finishTimeout: TimeInterval = 120

    func transcribe(file: URL, fromS: Double, toS: Double) throws -> [TimedText] {
        guard #available(macOS 26.0, *), SpeechTranscriber.isAvailable else { throw ReviewError.noTranscriber }
        let audio = try AVAudioFile(forReading: file)
        let format = audio.processingFormat
        let rate = format.sampleRate
        let start = AVAudioFramePosition(fromS * rate)
        guard start < audio.length else { return [] } // the span starts after this file's audio ends
        let end = min(audio.length, AVAudioFramePosition(toS * rate))
        audio.framePosition = start
        let lock = NSLock()
        var lines: [TimedText] = []
        let t = try LiveTranscriber(locale: transcriptionLocale(), input: format, careful: true) { from, to, text in
            lock.withLock { lines.append(TimedText(fromS: fromS + from, toS: fromS + to, text: text)) }
        }
        var remaining = end - start
        while remaining > 0 {
            let n = AVAudioFrameCount(min(remaining, 16_384))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { break }
            try audio.read(into: buffer, frameCount: n)
            if buffer.frameLength == 0 { break }
            t.feed(buffer)
            remaining -= AVAudioFramePosition(buffer.frameLength)
        }
        t.finish(timeout: Self.finishTimeout)
        return lock.withLock { lines }
    }
}

/// What `check()` reports about the transcriber.
struct SystemTranscriberProbe: TranscriberProbe {
    func status() -> TranscriberStatus {
        guard #available(macOS 26.0, *) else {
            return TranscriberStatus(engine: "SpeechTranscriber", available: false, assets: "unsupported", locale: nil, reason: "on-device transcription needs macOS 26 — recordings are kept without a transcript")
        }
        guard SpeechTranscriber.isAvailable else {
            return TranscriberStatus(engine: "SpeechTranscriber", available: false, assets: "unsupported", locale: nil, reason: "SpeechTranscriber is not available on this Mac")
        }
        let requested = transcriptionLocale()
        let answer = try? blocking(timeout: 10) { () async -> (String?, String) in
            guard let l = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else { return (nil, "unsupported") }
            let status = await AssetInventory.status(forModules: [SpeechTranscriber(locale: l, preset: .transcription)])
            let word: String
            switch status {
            case .installed: word = "installed"
            case .downloading: word = "downloading"
            case .supported: word = "supported"
            default: word = "unsupported"
            }
            return (l.identifier, word)
        }
        guard let (locale, assets) = answer else {
            return TranscriberStatus(engine: "SpeechTranscriber", available: false, assets: "unknown", locale: nil, reason: "the transcriber did not answer")
        }
        guard let locale else {
            return TranscriberStatus(engine: "SpeechTranscriber", available: false, assets: "unsupported", locale: nil, reason: "no on-device transcriber for \(requested.identifier) — set METISTRY_LC_LOCALE to a supported language")
        }
        return TranscriberStatus(
            engine: "SpeechTranscriber",
            available: assets != "unsupported",
            assets: assets,
            locale: locale,
            reason: assets == "supported" ? "the language model downloads the first time a recording starts" : nil
        )
    }
}
