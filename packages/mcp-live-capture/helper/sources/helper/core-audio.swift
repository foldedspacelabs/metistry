// The Core Audio process tap: *Audio only* (plan §2.15, C76). A tap is
// per-process by construction — Core Audio mixes exactly the processes its
// description names — so this adapter's one job is to hand Core Audio the
// plan the kit built (sources/kit/scope.swift) and nothing else. It never
// uses `…GlobalTapButExcludeProcesses:` or `exclusive`; the plan cannot ask
// for them.
//
// macOS 14.2+ (`AudioHardwareCreateProcessTap`); the audio-capture grant
// (`NSAudioCaptureUsageDescription`, kTCCServiceAudioCapture) is asked for by
// the OS the first time the aggregate device starts.

import AVFoundation
import CoreAudio
import Foundation

private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let err = withUnsafeMutablePointer(to: &ref) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
    guard err == noErr, let ref else { return nil }
    return ref.takeRetainedValue() as String
}

private func readValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = address(selector)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let err = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
    return err == noErr ? value : nil
}

/// Every process Core Audio knows about, with its bundle ID.
func audioProcesses() -> [AudioProcess] {
    guard #available(macOS 14.2, *) else { return [] }
    let system = AudioObjectID(kAudioObjectSystemObject)
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        guard let bundle = readString(id, kAudioProcessPropertyBundleID), !bundle.isEmpty else { return nil }
        return AudioProcess(objectID: id, pid: readValue(id, kAudioProcessPropertyPID, pid_t(-1)) ?? -1, bundleID: bundle)
    }
}

private func defaultOutputDeviceUID() throws -> String {
    guard let device = readValue(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(kAudioObjectUnknown)),
          device != kAudioObjectUnknown,
          let uid = readString(device, kAudioDevicePropertyDeviceUID)
    else { throw HelperFailure("no output device") }
    return uid
}

private func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw HelperFailure("\(what) failed (\(status))") }
}

@available(macOS 14.2, *)
final class ProcessTapStream: CaptureStream {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "metistry.live-capture.tap")
    private var sink: SourceSink?

    var observedAudio: Bool { queue.sync { sink?.observedAudio ?? false } }

    init(plan: TapPlan, directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws {
        do { try open(plan: plan, directory: directory, onSegment: onSegment) } catch {
            stop()
            throw error
        }
    }

    private func open(plan: TapPlan, directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws {
        // The plan, and only the plan: an inclusive mixdown of the named processes.
        let description = CATapDescription(stereoMixdownOfProcesses: plan.processObjectIDs)
        if #available(macOS 26.0, *), plan.mode == .bundleIDs {
            description.bundleIDs = plan.bundleIDs
            description.isProcessRestoreEnabled = true
        }
        description.name = "Metistry live capture"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tapID), "creating the process tap")

        guard var asbd = readValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
              let format = AVAudioFormat(streamDescription: &asbd)
        else { throw HelperFailure("the tap reported no format") }

        let output = try defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Metistry live capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: output,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: output]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "creating the aggregate device")

        let sink = try SourceSink(url: nextMediaURL(in: directory, base: AudioSource.app.rawValue, ext: "m4a"), format: format, onSegment: onSegment)
        self.sink = sink
        try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
            sink.consume(buffer)
        }, "installing the tap's reader")
        try check(AudioDeviceStart(aggregateID, procID), "starting the tap")
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        procID = nil
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        // Drain the reader, then flush the text and close the file.
        queue.sync {}
        sink?.finish()
    }
}
