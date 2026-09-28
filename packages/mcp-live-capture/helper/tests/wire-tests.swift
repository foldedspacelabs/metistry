// The socket protocol the bridge speaks to the helper.

import Foundation

func wireTests() {
    print("wire")

    func parse(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    test("check reports the grants and the transcriber") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makeRecorder(world)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(available: false), osVersion: "15.5")
        let r = parse(service.handle(#"{"id":1,"op":"check"}"#))
        expectEqual(r["ok"] as? Bool, true, "ok")
        let grants = r["grants"] as? [String: String]
        expectEqual(grants?["microphone"], "granted", "microphone")
        expectEqual(grants?["audio_capture"], "unverified", "audio capture before any recording")
        let t = r["transcriber"] as? [String: Any]
        expectEqual(t?["available"] as? Bool, false, "transcriber")
        expectEqual(t?["reason"] as? String, "on-device transcription needs macOS 26", "why")
        expectEqual(r["recording"] as? Bool, false, "recording")
    }

    test("start, status, keep_going, stop") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makeRecorder(world)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let started = parse(service.handle(#"{"id":2,"op":"start","apps":["us.zoom.xos"],"app_audio":true,"microphone":false}"#))
        expectEqual(started["ok"] as? Bool, true, "started")
        let session = started["session"] as? [String: Any]
        expectEqual(session?["apps"] as? [String], ["us.zoom.xos"], "the scope")
        expectEqual(session?["microphone"] as? Bool, false, "the microphone toggle")
        expectEqual(parse(service.handle(#"{"id":3,"op":"status"}"#))["state"] as? String, "recording", "status")
        expectEqual(parse(service.handle(#"{"id":4,"op":"keep_going"}"#))["answered"] as? Bool, false, "no reminder due")
        world.play(zoom, says: "x: heard", from: 0, to: 1)
        let stopped = parse(service.handle(#"{"id":5,"op":"stop"}"#))
        expectEqual((stopped["session"] as? [String: Any])?["ended_reason"] as? String, "owner", "stopped by the owner")
        expectEqual((stopped["session"] as? [String: Any])?["app_audio_observed"] as? Bool, true, "the tap was heard")
        let grants = parse(service.handle(#"{"id":6,"op":"check"}"#))["grants"] as? [String: String]
        expectEqual(grants?["audio_capture"], "observed", "audio capture once a tap delivered sound")
    }

    test("refusals carry a code and the owner's words, and start nothing") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makeRecorder(world)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        for (line, code) in [
            (#"{"id":1,"op":"start"}"#, "invalid_request"),
            (#"{"id":1,"op":"start","apps":"us.zoom.xos"}"#, "invalid_request"),
            (#"{"id":1,"op":"start","apps":[]}"#, "invalid_scope"),
            (#"{"id":1,"op":"start","apps":["*"]}"#, "invalid_scope"),
            (#"{"id":1,"op":"start","apps":["us.zoom.xos"],"microphone":"yes"}"#, "invalid_request"),
            (#"{"id":1,"op":"start","apps":["us.zoom.xos"],"app_audio":false,"microphone":false}"#, "nothing_to_record"),
            (#"{"id":1,"op":"record_everything"}"#, "invalid_request"),
            ("not json", "invalid_request"),
        ] {
            let r = parse(service.handle(line))
            expectEqual(r["ok"] as? Bool, false, "\(line) was accepted")
            expectEqual(r["code"] as? String, code, "\(line)")
        }
        expectEqual(world.openStreams, 0, "a refusal opened a stream")
        expect(!recorder.isRecording, "a refusal started a recording")
    }
}
