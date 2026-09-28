// lc-helper — the live-capture half that holds the grants (Swift, D3;
// TCC-bound: its own launchd service and responsible process, PoC-1). It
// serves the JSON-lines protocol in sources/kit/wire.swift on an owner-only
// Unix socket (METISTRY_LC_SOCKET); the node bridge is its one client. With
// no socket it answers stdin line by line (a one-shot `check`).
//
//   METISTRY_CAPTURE_DIR   where sessions live: <instance>/.metistry/state/capture (required)
//   METISTRY_LC_SOCKET     serve this Unix socket
//   METISTRY_LC_LOCALE     the transcriber's language (default: the Mac's)
//
// The bundle, its usage strings, signing and the launchd job are T8-2b's.

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
guard let captureDir = env["METISTRY_CAPTURE_DIR"], !captureDir.isEmpty else {
    FileHandle.standardError.write(Data("METISTRY_CAPTURE_DIR is required (<instance>/.metistry/state/capture)\n".utf8))
    exit(2)
}

let ownBundleID = Bundle.main.bundleIdentifier ?? "com.foldedspacelabs.metistry.live-capture"
let store = FileSessionStore(root: URL(fileURLWithPath: captureDir, isDirectory: true))
let recorder = Recorder(backend: SystemBackend(), store: store, disk: SystemDisk(), ownBundleID: ownBundleID)
let os = ProcessInfo.processInfo.operatingSystemVersion
let service = HelperService(recorder: recorder, grants: SystemGrants(), transcriber: SystemTranscriberProbe(), osVersion: "\(os.majorVersion).\(os.minorVersion)")

// A session left recording by a crash is ended at its last write, first.
for r in recorder.recoverInterrupted() {
    print("recovered session \(r.sessionID): ended \(r.endedReason ?? "") at \(r.endedAt.map { ISO8601DateFormatter().string(from: $0) } ?? "?")")
}

// C137 runs on the helper's own clock, whatever else is running.
let lifecycle = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "metistry.live-capture.lifecycle"))
lifecycle.schedule(deadline: .now() + 5, repeating: 5)
lifecycle.setEventHandler { recorder.tick() }
lifecycle.resume()

// Sleep pauses and marks the gap; wake resumes (or stops, past ten hours).
let workspace = NSWorkspace.shared.notificationCenter
workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in recorder.willSleep() }
workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in recorder.didWake() }

// launchd's stop is a clean save, not a crash.
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler {
    recorder.stop(.helperStopped)
    exit(0)
}
term.resume()

func serve(socketPath: String) {
    unlink(socketPath)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutablePointer(to: &addr.sun_path) { p in
        p.withMemoryRebound(to: CChar.self, capacity: 104) { _ = strlcpy($0, socketPath, 104) }
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }) == 0, listen(fd, 8) == 0 else {
        FileHandle.standardError.write(Data("bind/listen failed on \(socketPath)\n".utf8))
        exit(1)
    }
    chmod(socketPath, 0o600) // owner-only: the bridge's private channel
    print("lc-helper serving \(socketPath)")
    while true {
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        let h = FileHandle(fileDescriptor: client, closeOnDealloc: true)
        var buf = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            buf.append(chunk)
            while let nl = buf.firstIndex(of: 0x0A) {
                let line = String(decoding: buf[buf.startIndex..<nl], as: UTF8.self)
                buf.removeSubrange(buf.startIndex...nl)
                if !line.isEmpty { h.write(Data((service.handle(line) + "\n").utf8)) }
            }
        }
    }
}

if let socketPath = env["METISTRY_LC_SOCKET"], !socketPath.isEmpty {
    Thread { serve(socketPath: socketPath) }.start()
    RunLoop.main.run()
} else {
    Thread {
        while let line = readLine(strippingNewline: true) { print(service.handle(line)) }
        recorder.stop(.helperStopped)
        exit(0)
    }.start()
    RunLoop.main.run()
}
