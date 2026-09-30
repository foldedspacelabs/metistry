// The machine, for real: the backend the recorder drives, the grants, the disk.

import AVFoundation
import CoreGraphics
import Foundation

final class SystemBackend: CaptureBackend {
    var bundleIDTapsAvailable: Bool {
        if #available(macOS 26.0, *) { return true }
        return false
    }

    func runningProcesses() -> [AudioProcess] { audioProcesses() }

    func openAppAudio(plan: TapPlan, directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream {
        guard #available(macOS 14.2, *) else { throw HelperFailure("recording an app's audio needs macOS 14.2") }
        return try ProcessTapStream(plan: plan, directory: directory, onSegment: onSegment)
    }

    func openMicrophone(directory: URL, onSegment: @escaping (Double, Double, String) -> Void) throws -> CaptureStream {
        try MicrophoneStream(directory: directory, onSegment: onSegment)
    }
}

/// Grants as macOS lets a helper know them (P5: reported, never inferred).
/// Reading a state asks nothing of the owner: no prompt is raised here.
struct SystemGrants: GrantProbe {
    func grants(lastAppAudioObserved: Bool?) -> [String: String] {
        let mic: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: mic = "granted"
        case .denied: mic = "denied"
        case .restricted: mic = "restricted"
        default: mic = "not_asked"
        }
        return [
            "microphone": mic,
            // macOS has no read-back for the audio-capture grant: a tap without
            // it delivers silence. What the helper can say is whether a tap has
            // ever delivered sound.
            "audio_capture": lastAppAudioObserved == true ? "observed" : "unverified",
            // Window and Screen (T8-3). Read, never requested: the first
            // picture stream is what makes macOS ask.
            "screen_recording": CGPreflightScreenCaptureAccess() ? "granted" : "not_granted",
        ]
    }
}

struct SystemDisk: DiskProbe {
    func freeBytes(at url: URL) -> Int64? {
        var probe = url
        while !FileManager.default.fileExists(atPath: probe.path), probe.pathComponents.count > 1 { probe.deleteLastPathComponent() }
        return (try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }
}
