// The owner's microphone — *your side only* (screen 11 §5): the default input
// device through AVAudioEngine, kept and transcribed like the tap. macOS asks
// for the microphone grant (NSMicrophoneUsageDescription) the first time.

import AVFoundation
import Foundation

final class MicrophoneStream: CaptureStream {
    private let engine = AVAudioEngine()
    private var sink: SourceSink?
    private let lock = NSLock()

    var observedAudio: Bool { lock.withLock { sink?.observedAudio ?? false } }

    init(directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            throw HelperFailure("the microphone is not allowed — System Settings ▸ Privacy & Security ▸ Microphone, or record without it")
        case .notDetermined:
            let asked = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { granted = $0; asked.signal() }
            _ = asked.wait(timeout: .now() + 120)
            guard granted else { throw HelperFailure("the microphone was not allowed") }
        default:
            break
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else { throw HelperFailure("no input device") }
        let sink = try SourceSink(url: nextMediaURL(in: directory, base: AudioSource.mic.rawValue, ext: "m4a"), format: format, onSegment: onSegment)
        self.sink = sink
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [lock] buffer, _ in
            lock.withLock { sink.consume(buffer) }
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            throw HelperFailure("could not start the microphone: \(error.localizedDescription)")
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.withLock { sink?.finish() }
    }
}
