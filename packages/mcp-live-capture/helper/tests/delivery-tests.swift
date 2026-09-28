// The end of a session (T8-2b): which transcripts are owed to POST /capture,
// what the bridge reads to deliver one, and the one record that says it went.
// The bold test — a crash saves up to the crash — is here end to end on the
// helper's side: the session a dead helper left recording is found, ended as
// `crashed`, owed, and read back with every line written before the crash.

import Foundation

func deliveryTests() {
    print("delivery")

    func parse(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    test("a crash saves up to the crash, and the session is owed with every line written before it") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        world.play(zoom, says: "them: the numbers are in", from: 1, to: 3)
        world.speak("me: send them over", from: 4, to: 5)
        // A torn last line: the helper died mid-write.
        let url = store.directory(for: session.sessionID).appendingPathComponent(transcriptFile)
        let h = try FileHandle(forWritingTo: url)
        _ = try h.seekToEnd()
        try h.write(contentsOf: Data(#"{"kind":"segment","source":"app","from_s":6,"to_s":"#.utf8))
        try h.close()

        // The helper dies: nothing stops the session. launchd starts a new one.
        let reborn = Recorder(backend: FakeAudioWorld(processes: [], bundleIDTaps: true), store: FileSessionStore(root: store.root), disk: FakeDisk(), ownBundleID: ownBundle)
        expectEqual(reborn.owed().count, 0, "owed before recovery — a session still marked recording is not finished")
        _ = reborn.recoverInterrupted()
        let owed = reborn.owed()
        expectEqual(owed.map(\.sessionID), [session.sessionID], "the crashed session is owed")
        expectEqual(owed.first?.endedReason, "crashed", "and says why it ended")

        let service = HelperService(recorder: reborn, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let r = parse(service.handle(#"{"id":1,"op":"transcript","session_id":"\#(session.sessionID)"}"#))
        expectEqual(r["ok"] as? Bool, true, "transcript read")
        let lines = (r["lines"] as? [[String: Any]]) ?? []
        expectEqual(lines.compactMap { $0["text"] as? String }, ["them: the numbers are in", "me: send them over"], "every whole line before the crash, the torn one skipped")
        expectEqual(lines.compactMap { $0["source"] as? String }, ["app", "mic"], "each line's source")
        expectEqual((r["session"] as? [String: Any])?["ended_reason"] as? String, "crashed", "the record carries the crash")
    }

    test("owed: ended and undelivered only — never the running session, never a failed start") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makeRecorder(world)
        let first = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        recorder.stop(.owner)
        world.failMicrophone = true
        _ = try? recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        world.failMicrophone = false
        let running = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expectEqual(recorder.owed().map(\.sessionID), [first.sessionID], "only the ended session")
        var refused: DeliveryError?
        do { _ = try recorder.transcript(of: running.sessionID) } catch let e as DeliveryError { refused = e }
        expectEqual(refused?.code, "still_recording", "the running session's transcript is not finished")
    }

    test("delivered is recorded once, and a delivered session is owed no more") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        let s = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        recorder.tick()
        recorder.stop(.maxDuration)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        expectEqual((parse(service.handle(#"{"id":1,"op":"owed"}"#))["sessions"] as? [[String: Any]])?.count, 1, "owed after the ten-hour stop")
        let d = parse(service.handle(#"{"id":2,"op":"delivered","session_id":"\#(s.sessionID)","inbox_id":42}"#))
        expectEqual(d["ok"] as? Bool, true, "delivered")
        expectEqual(((d["session"] as? [String: Any])?["delivery"] as? [String: Any])?["inbox_id"] as? Int, 42, "where it went")
        _ = parse(service.handle(#"{"id":3,"op":"delivered","session_id":"\#(s.sessionID)","inbox_id":43}"#))
        expectEqual(store.sessions().first?.delivery?.inboxID, 42, "the first delivery stands")
        expectEqual((parse(service.handle(#"{"id":4,"op":"owed"}"#))["sessions"] as? [[String: Any]])?.count, 0, "owed after delivery")
        // Survives the helper: a new one reads the record from disk.
        let reborn = Recorder(backend: world, store: FileSessionStore(root: store.root), disk: FakeDisk(), ownBundleID: ownBundle)
        expectEqual(reborn.owed().count, 0, "owed after a restart")
    }

    test("delivery refusals: a malformed id builds no path, an unknown one is named, and nothing is marked") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        recorder.stop(.owner)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        for (line, code) in [
            (#"{"id":1,"op":"transcript"}"#, "invalid_request"),
            (#"{"id":1,"op":"transcript","session_id":"../../etc"}"#, "invalid_request"),
            (#"{"id":1,"op":"transcript","session_id":"20990101-000000-0000"}"#, "unknown_session"),
            (#"{"id":1,"op":"delivered","session_id":"20990101-000000-0000","inbox_id":1}"#, "unknown_session"),
            (#"{"id":1,"op":"delivered","session_id":"../x","inbox_id":1}"#, "invalid_request"),
            (#"{"id":1,"op":"delivered","session_id":"\#(store.sessions()[0].sessionID)"}"#, "invalid_request"),
            (#"{"id":1,"op":"delivered","session_id":"\#(store.sessions()[0].sessionID)","inbox_id":0}"#, "invalid_request"),
        ] {
            let r = parse(service.handle(line))
            expectEqual(r["ok"] as? Bool, false, "\(line) was accepted")
            expectEqual(r["code"] as? String, code, "\(line)")
        }
        expect(store.sessions().allSatisfy { $0.delivery == nil }, "a refusal marked a session delivered")
    }

    test("a session.json from before delivery existed reads as owed") {
        let dir = tempCaptureDir()
        let store = FileSessionStore(root: dir)
        let id = "20260928-120000-00ab"
        try FileManager.default.createDirectory(at: store.directory(for: id), withIntermediateDirectories: true)
        let old = #"{"app_audio":true,"app_audio_observed":true,"apps":["us.zoom.xos"],"ended_at":"2026-09-28T13:00:00Z","ended_reason":"owner","gaps":[],"microphone":true,"processes":[],"reminders_raised":0,"session_id":"\#(id)","started_at":"2026-09-28T12:00:00Z","state":"ended","tap_mode":"bundle_ids"}"#
        try Data(old.utf8).write(to: store.directory(for: id).appendingPathComponent(sessionFile))
        let recorder = Recorder(backend: FakeAudioWorld(processes: [], bundleIDTaps: true), store: store, disk: FakeDisk(), ownBundleID: ownBundle)
        expectEqual(recorder.owed().map(\.sessionID), [id], "owed")
    }

    test("the capture directory: METISTRY_CAPTURE_DIR, else under the instance's state") {
        expectEqual(captureDirectory(["METISTRY_CAPTURE_DIR": "/x/capture", "METISTRY_INSTANCE_DIR": "/i"]), "/x/capture", "explicit wins")
        expectEqual(captureDirectory(["METISTRY_INSTANCE_DIR": "/Users/o/Metistry/"]), "/Users/o/Metistry/.metistry/state/capture", "from the instance")
        expectEqual(captureDirectory(["METISTRY_INSTANCE_DIR": "  "]), nil, "blank is unset")
        expectEqual(captureDirectory([:]), nil, "neither: refuse to start")
    }
}
