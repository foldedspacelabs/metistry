// *Window* and *Screen* (plan §2.15, C76; screen 11 §5–§6): one `SCStream`
// whose content filter is the one the system picker built from the owner's
// click, with `capturesAudio` — the picked content's sound, scoped by the same
// filter as the picture — and `captureMicrophone` on macOS 15 (below that the
// recorder opens the microphone as a second session).
//
// THE FILTER RULE. This file never constructs an `SCContentFilter` and never
// enumerates shareable content. The one filter a stream is opened from is
// the object `SCContentSharingPickerObserver` received, kept under a handle
// until the session ends. The Screen Recording grant would let the helper
// build any filter it liked; having no code that does is what holds the
// scope (research 2026-09-21 §2.2 — our boundary, not the kernel's, and said
// so). test/helper-kit.test.ts reads these sources to keep it that way.
//
// The picker is configured to take one window (or one display), to exclude
// the helper, and not to let the choice change mid-stream; an answer that
// arrives when no pick is pending is ignored. Nothing here hides anything
// from the system's own indicators: macOS draws its recording indicator and
// its picker as it always does.
//
// What is kept: `screen.mp4` (H.264 at one frame a second — well inside
// C137's ~150 MB/h with both audio files), `app.m4a` and `mic.m4a` through
// the same `SourceSink` as the process tap — written to the session
// directory, transcribed on the Mac, and never sent anywhere by this file.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// limit: fixed — one frame a second is enough to see what was on screen in
// a meeting, and keeps ten hours of picture near 90 MB/h (C137's budget).
private let framesPerSecond: Int32 = 1
// limit: fixed — the frame's longest side; a 5K display is scaled to it.
private let maxFrameSide: CGFloat = 1920
// limit: fixed — a picker left open this long is abandoned; the bridge's own
// wait (METISTRY_LC_HELPER_TIMEOUT_MS, 150 s) is longer.
private let pickerTimeout: TimeInterval = 120

final class SystemPicture: NSObject, PictureBackend, SCContentSharingPickerObserver {
    private let lock = NSLock()
    /// The filters the picker handed over, by handle. The only filters there are.
    private var filters: [Int: SCContentFilter] = [:]
    private var nextHandle = 1
    private var waiting: DispatchSemaphore?
    private var answer: Result<SCContentFilter?, Error>?

    var streamMicrophoneAvailable: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    func pick(_ mode: CaptureMode, excludingBundleID: String) throws -> PickedContent? {
        let style: SCShareableContentStyle
        let pickerMode: SCContentSharingPickerMode
        switch mode {
        case .window: (style, pickerMode) = (.window, .singleWindow)
        case .screen: (style, pickerMode) = (.display, .singleDisplay)
        case .audioOnly: throw HelperFailure("audio only takes no picture")
        }
        let done = DispatchSemaphore(value: 0)
        lock.withLock {
            waiting = done
            answer = nil
        }
        DispatchQueue.main.async {
            let picker = SCContentSharingPicker.shared
            var config = SCContentSharingPickerConfiguration()
            config.allowedPickerModes = pickerMode
            config.excludedBundleIDs = [excludingBundleID]
            config.allowsChangingSelectedContent = false
            picker.defaultConfiguration = config
            picker.maximumStreamCount = 1
            picker.add(self)
            picker.isActive = true
            picker.present(using: style)
        }
        let waited = done.wait(timeout: .now() + pickerTimeout)
        DispatchQueue.main.async {
            let picker = SCContentSharingPicker.shared
            picker.remove(self)
            picker.isActive = false
        }
        let result: Result<SCContentFilter?, Error>? = lock.withLock {
            let r = answer
            waiting = nil
            answer = nil
            return r
        }
        guard waited == .success, let result else { throw HelperFailure("the picker was left open — nothing was chosen") }
        guard let filter = try result.get() else { return nil }
        let handle: Int = lock.withLock {
            let h = nextHandle
            nextHandle += 1
            filters[h] = filter
            return h
        }
        return PickedContent(handle: handle, kind: Self.kind(of: filter), bundleID: Self.bundleID(of: filter))
    }

    func openPicture(plan: PicturePlan, directory: URL, onSegment: @escaping (AudioSource, Double, Double, String) -> Void) throws -> PictureStream {
        guard let filter = lock.withLock({ filters[plan.picked.handle] }) else { throw HelperFailure("the picker's choice is no longer held") }
        return try PictureCaptureStream(filter: filter, plan: plan, directory: directory, onSegment: onSegment)
    }

    func release(_ handle: Int) {
        lock.withLock { filters[handle] = nil }
    }

    // MARK: - The observer: the one place a filter arrives

    /// Taken only while a pick is pending, and only the first answer.
    private func settle(_ r: Result<SCContentFilter?, Error>) {
        lock.withLock {
            guard let w = waiting, answer == nil else { return }
            answer = r
            w.signal()
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        settle(.success(nil))
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        settle(.success(filter))
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        settle(.failure(error))
    }

    private static func kind(of filter: SCContentFilter) -> PickedContent.Kind {
        switch filter.style {
        case .window: return .window
        case .display: return .display
        case .application: return .application
        default: return .unknown
        }
    }

    /// The picked window's app, where macOS says (15.2). Never the title.
    private static func bundleID(of filter: SCContentFilter) -> String? {
        guard filter.style == .window else { return nil }
        if #available(macOS 15.2, *) { return filter.includedWindows.first?.owningApplication?.bundleIdentifier }
        return nil
    }
}

/// One stream from one picker filter: frames to `screen.mp4`, the content's
/// sound and (macOS 15) the microphone to their `SourceSink`s. Each output
/// has its own queue, so the transcriber's first set-up never stalls frames.
final class PictureCaptureStream: NSObject, PictureStream, SCStreamOutput, SCStreamDelegate {
    private let frameQueue = DispatchQueue(label: "metistry.live-capture.frames")
    private let audioQueue = DispatchQueue(label: "metistry.live-capture.picture-audio")
    private let micQueue = DispatchQueue(label: "metistry.live-capture.picture-mic")
    private let lock = NSLock()
    private var stream: SCStream?
    private var running = false
    private let frames: FrameWriter
    private let directory: URL
    private let onSegment: (AudioSource, Double, Double, String) -> Void
    private var appSink: SourceSink?
    private var micSink: SourceSink?

    var isRunning: Bool { lock.withLock { running } }
    var observedFrames: Bool { frameQueue.sync { frames.written > 0 } }
    var observedAudio: Bool { audioQueue.sync { appSink?.observedAudio ?? false } }

    init(filter: SCContentFilter, plan: PicturePlan, directory: URL, onSegment: @escaping (AudioSource, Double, Double, String) -> Void) throws {
        self.directory = directory
        self.onSegment = onSegment
        let size = Self.frameSize(filter)
        frames = try FrameWriter(url: nextMediaURL(in: directory, base: "screen", ext: "mp4"), width: size.width, height: size.height)
        super.init()

        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
        config.queueDepth = 3
        // The sound is the filter's: a window's app, or the display's.
        config.capturesAudio = plan.appAudio
        config.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) { config.captureMicrophone = plan.microphoneInStream }

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
        if plan.appAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        if #available(macOS 15.0, *), plan.microphoneInStream { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: micQueue) }
        stream = s
        do {
            try blocking(timeout: 30) { try await s.startCapture() }
        } catch {
            stream = nil
            frames.finish()
            throw HelperFailure("could not start the picture: \(error)")
        }
        lock.withLock { running = true }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid else { return }
        if type == .screen {
            guard Self.isCompleteFrame(sb) else { return }
            frames.append(sb)
        } else if type == .audio {
            Self.withPCM(sb) { buffer in
                if appSink == nil { appSink = try? SourceSink(url: nextMediaURL(in: directory, base: AudioSource.app.rawValue, ext: "m4a"), format: buffer.format) { [onSegment] in onSegment(.app, $0, $1, $2) } }
                appSink?.consume(buffer)
            }
        } else if #available(macOS 15.0, *), type == .microphone {
            Self.withPCM(sb) { buffer in
                if micSink == nil { micSink = try? SourceSink(url: nextMediaURL(in: directory, base: AudioSource.mic.rawValue, ext: "m4a"), format: buffer.format) { [onSegment] in onSegment(.mic, $0, $1, $2) } }
                micSink?.consume(buffer)
            }
        }
    }

    /// The system stopped the stream: the window closed, the display went
    /// away, the grant was withdrawn. The recorder reads `isRunning` and ends
    /// the session (`picture_lost`).
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("picture stream stopped: \(error)\n".utf8))
        lock.withLock { running = false }
    }

    func stop() {
        guard let s = stream else { return }
        stream = nil
        _ = try? blocking(timeout: 10) { try await s.stopCapture() }
        lock.withLock { running = false }
        // Drain each output, then close its file and flush its text.
        frameQueue.sync { frames.finish() }
        audioQueue.sync { appSink?.finish() }
        micQueue.sync { micSink?.finish() }
    }

    /// The content's own size in pixels, its longest side capped, even.
    private static func frameSize(_ filter: SCContentFilter) -> (width: Int, height: Int) {
        var w = max(filter.contentRect.width * CGFloat(filter.pointPixelScale), 2)
        var h = max(filter.contentRect.height * CGFloat(filter.pointPixelScale), 2)
        let longest = max(w, h)
        if longest > maxFrameSide {
            w = w * maxFrameSide / longest
            h = h * maxFrameSide / longest
        }
        return (Int(w) & ~1, Int(h) & ~1)
    }

    /// ScreenCaptureKit sends idle and blank frames too; only complete ones carry a picture.
    private static func isCompleteFrame(_ sb: CMSampleBuffer) -> Bool {
        guard CMSampleBufferGetImageBuffer(sb) != nil,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw)
        else { return false }
        return status == .complete
    }

    /// The sample buffer's audio as a PCM buffer, for the length of `body`.
    private static func withPCM(_ sb: CMSampleBuffer, _ body: (AVAudioPCMBuffer) -> Void) {
        guard let description = sb.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        try? sb.withAudioBufferList { list, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer, deallocator: nil) else { return }
            body(buffer)
        }
    }
}

/// Frames to an H.264 file, in real time. Called on the stream's frame queue only.
final class FrameWriter {
    private let url: URL
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var started = false
    private var finished = false
    private(set) var written = 0

    init(url: URL, width: Int, height: Int) throws {
        self.url = url
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 200_000,
                AVVideoExpectedSourceFrameRateKey: Int(framesPerSecond),
                AVVideoMaxKeyFrameIntervalKey: 60,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw HelperFailure("cannot write the picture's file") }
        writer.add(input)
    }

    func append(_ sb: CMSampleBuffer) {
        guard !finished else { return }
        if !started {
            guard writer.startWriting() else { return }
            writer.startSession(atSourceTime: sb.presentationTimeStamp)
            started = true
        }
        if input.isReadyForMoreMediaData, input.append(sb) { written += 1 }
    }

    /// Close the file (bounded — a stuck writer never holds a stop). A stream
    /// that never drew a frame leaves no file.
    func finish() {
        guard !finished else { return }
        finished = true
        guard started else {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            return
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        _ = done.wait(timeout: .now() + 10)
    }
}
