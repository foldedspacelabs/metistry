// What a recording may see — T8-3's headline test: the picker's choice is the
// only filter the helper builds. And around it: a start names no content, a
// cancelled or wrong pick is refused, a wake never re-asks or widens, and the
// read-back says which senses are open without carrying what they took.

import Foundation

func pictureTests() {
    print("picture")

    func parse(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    for streamMicrophone in [true, false] {
        let os = streamMicrophone ? "macOS 15: the microphone in the stream" : "macOS 14: the microphone as a second session"
        test("the picker's choice is the only filter the helper builds (\(os))") {
            let world = FakeAudioWorld(processes: [zoom, spotify], bundleIDTaps: true)
            let screen = FakeScreenWorld(streamMicrophone: streamMicrophone)
            screen.ownerChooses = meetingWindow
            let (recorder, store) = makePictureRecorder(world, screen)

            let session = try recorder.start(StartRequest(mode: .window, apps: [], appAudio: true, microphone: true))

            // The picker was asked once, for one window, with the helper excluded.
            expectEqual(screen.presented.count, 1, "the picker was presented")
            expectEqual(screen.presented.first?.mode, .window, "the picker's mode")
            expectEqual(screen.presented.first?.excluding, ownBundle, "the helper excluded from the picker")
            // One stream, from the picker's handle, and nothing else built.
            expectEqual(screen.streams.count, 1, "picture streams opened")
            let stream = screen.streams[0]
            expectEqual(stream.content, meetingWindow, "the stream's filter is the owner's pick")
            expectEqual(stream.plan.picked.handle, 7, "the picker's handle, unchanged")
            expectEqual(world.appStreams.count, 0, "a process tap was opened beside the picture")

            screen.draw(windowID: 12, "the chat window")
            screen.draw(windowID: 11, "the meeting")
            screen.play(app: "com.spotify.client", says: "y: the song on the other app", from: 0, to: 2)
            screen.play(app: "com.tinyspeck.slackmacgap", says: "y: a chat notification", from: 1, to: 2)
            screen.play(app: "us.zoom.xos", says: "x: the meeting", from: 2, to: 4)
            if streamMicrophone {
                screen.speak("me: my side", from: 4, to: 5)
                expectEqual(world.micStreams.count, 0, "a second microphone session on macOS 15")
            } else {
                expectEqual(world.micStreams.count, 1, "the microphone's second session below macOS 15")
                world.speak("me: my side", from: 4, to: 5)
            }
            expectEqual(stream.frames, ["the meeting"], "frames the stream took")
            recorder.stop(.owner)

            let lines = transcriptLines(store, session.sessionID)
            expectEqual(lines.compactMap { $0["text"] as? String }, ["x: the meeting", "me: my side"], "the transcript")
            expectEqual(lines.compactMap { $0["source"] as? String }, ["app", "mic"], "the sources")
            let ended = store.sessions().first { $0.sessionID == session.sessionID }
            expectEqual(ended?.mode, .window, "the session's mode")
            expectEqual(ended?.picture, PictureRecord(kind: .window, bundleID: "us.zoom.xos"), "what the picker chose, as kept")
            expectEqual(ended?.apps, ["us.zoom.xos"], "the picked window's app")
            expectEqual(ended?.tapMode, nil, "no tap")
            expectEqual(screen.released, [7], "the picker's filter let go at the end")
            expectEqual(screen.presented.count, 1, "the picker was asked again")
        }
    }

    test("a Window or Screen start names no content — the picker is never asked, nothing opens") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = meetingWindow
        let (recorder, _) = makePictureRecorder(world, screen)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        for (line, code) in [
            (#"{"id":1,"op":"start","mode":"window","apps":["us.zoom.xos"]}"#, "invalid_scope"),
            (#"{"id":1,"op":"start","mode":"screen","apps":[]}"#, "invalid_scope"),
            (#"{"id":1,"op":"start","mode":"window","window_id":12}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":"screen","display_id":1}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":"window","bundle_ids":["us.zoom.xos"]}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":"window","filter":{"display":1,"excluding":[]}}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":"everything"}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":"display"}"#, "invalid_request"),
            (#"{"id":1,"op":"start","mode":7}"#, "invalid_request"),
        ] {
            let r = parse(service.handle(line))
            expectEqual(r["ok"] as? Bool, false, "\(line) was accepted")
            expectEqual(r["code"] as? String, code, "\(line)")
        }
        var named = false
        do { _ = try recorder.start(StartRequest(mode: .window, apps: ["us.zoom.xos"])) } catch RecorderError.contentNamed { named = true }
        expect(named, "the recorder took a window start that named an app")
        expectEqual(screen.presented.count, 0, "the picker was presented")
        expectEqual(screen.openStreams + world.openStreams, 0, "a refusal opened a stream")
        expect(!recorder.isRecording, "a refusal started a recording")
    }

    test("a cancelled picker is no choice: refused, no session, nothing open") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = nil
        let (recorder, store) = makePictureRecorder(world, screen)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let r = parse(service.handle(#"{"id":1,"op":"start","mode":"window"}"#))
        expectEqual(r["ok"] as? Bool, false, "a cancel started something")
        expectEqual(r["code"] as? String, "invalid_scope", "the refusal")
        expectEqual(r["error"] as? String, PictureError.nothingChosen.message, "the owner's words")
        expectEqual(screen.presented.count, 1, "the picker was presented")
        expectEqual(screen.openStreams + world.openStreams, 0, "streams opened")
        expectEqual(store.sessions().count, 0, "a session was written")
        expectEqual(recorder.status().state, "idle", "the read-back")
    }

    test("a pick of the wrong kind is refused, never adapted, and its filter let go") {
        for (mode, chosen) in [(CaptureMode.window, mainDisplay), (.screen, meetingWindow), (.window, FakeContent.application(bundleID: "us.zoom.xos")), (.screen, .application(bundleID: "us.zoom.xos"))] {
            let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
            let screen = FakeScreenWorld(streamMicrophone: true)
            screen.ownerChooses = chosen
            let (recorder, _) = makePictureRecorder(world, screen)
            var wrong = false
            do { _ = try recorder.start(StartRequest(mode: mode, apps: [])) } catch RecorderError.picture(.wrongKind) { wrong = true }
            expect(wrong, "\(mode) took a \(chosen.kind)")
            expectEqual(screen.openStreams, 0, "\(mode): a stream opened")
            expectEqual(screen.released, [7], "\(mode): the refused pick's filter kept")
        }
    }

    test("the helper's own window is never a pick") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = .window(windowID: 99, bundleID: ownBundle)
        let (recorder, _) = makePictureRecorder(world, screen)
        var own = false
        do { _ = try recorder.start(StartRequest(mode: .window, apps: [])) } catch RecorderError.picture(.ownContent) { own = true }
        expect(own, "the helper recorded its own window")
        expectEqual(screen.openStreams, 0, "a stream opened")
    }

    test("Screen is one display the owner chose — the one act that sees every app on it") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = mainDisplay
        let (recorder, store) = makePictureRecorder(world, screen)
        let session = try recorder.start(StartRequest(mode: .screen, apps: [], appAudio: true, microphone: false))
        expectEqual(screen.presented.first?.mode, .screen, "the picker's mode")
        screen.draw(windowID: 11, "the meeting")
        screen.draw(windowID: 12, "the chat window")
        screen.play(app: "us.zoom.xos", says: "x: the meeting", from: 0, to: 1)
        expectEqual(screen.streams.first?.frames, ["the meeting", "the chat window"], "the display's frames")
        expectEqual(recorder.status().senses, Senses(display: true, appAudio: true, microphone: false), "the senses")
        recorder.stop(.owner)
        let ended = store.sessions().first { $0.sessionID == session.sessionID }
        expectEqual(ended?.picture, PictureRecord(kind: .display, bundleID: nil), "what was kept of the pick")
        expectEqual(ended?.apps, [], "a display names no app")
    }

    test("a wake reopens the same pick and never asks again; a pick that will not reopen ends the session") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = meetingWindow
        let clock = FakeClock()
        let (recorder, store) = makePictureRecorder(world, screen, clock: clock)
        let session = try recorder.start(StartRequest(mode: .window, apps: []))
        clock.advance(60)
        recorder.willSleep()
        expectEqual(screen.openStreams, 0, "the picture stream open through a sleep")
        expectEqual(recorder.status().senses, .none, "a paused session shows a sense")
        // Meanwhile the owner would pick something else — the helper must not ask.
        screen.ownerChooses = chatWindow
        clock.advance(600)
        recorder.didWake()
        expectEqual(screen.presented.count, 1, "the picker was presented on wake")
        expectEqual(screen.streams.count, 2, "picture streams across the wake")
        expectEqual(screen.streams.map(\.plan.picked.handle), [7, 7], "the same handle both times")
        expectEqual(screen.streams.map(\.content), [meetingWindow, meetingWindow], "the same window both times")
        expectEqual(transcriptLines(store, session.sessionID).compactMap { $0["kind"] as? String }, ["gap"], "the gap is marked")

        recorder.willSleep()
        screen.failOpen = true
        clock.advance(60)
        recorder.didWake()
        expect(!recorder.isRecording, "a session whose window is gone kept recording")
        expectEqual(store.sessions().first?.endedReason, "resume_failed", "why it ended")
        expectEqual(screen.presented.count, 1, "the picker was presented after a failed reopen")
        expectEqual(screen.released, [7], "the filter let go")
    }

    test("the ten-hour stop closes the picture too") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: false)
        screen.ownerChooses = meetingWindow
        let clock = FakeClock()
        let (recorder, store) = makePictureRecorder(world, screen, clock: clock)
        _ = try recorder.start(StartRequest(mode: .window, apps: []))
        expectEqual(screen.openStreams + world.openStreams, 2, "the picture and the microphone's second session")
        clock.advance(10 * 3600)
        recorder.tick()
        expectEqual(screen.openStreams + world.openStreams, 0, "streams left open")
        expectEqual(store.sessions().first?.endedReason, "max_duration", "why it ended")
    }

    test("a picture the system stops ends the session — the display sense is read, never assumed") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: false)
        screen.ownerChooses = meetingWindow
        let (recorder, store) = makePictureRecorder(world, screen)
        _ = try recorder.start(StartRequest(mode: .window, apps: []))
        expectEqual(recorder.status().senses.display, true, "the display while the stream runs")
        screen.streams[0].systemStops()
        expectEqual(recorder.status().senses.display, false, "the display after the system stopped the stream")
        recorder.tick()
        expect(!recorder.isRecording, "a picture recording with no picture kept going")
        expectEqual(store.sessions().first?.endedReason, "picture_lost", "why it ended")
        expectEqual(world.openStreams, 0, "the microphone's second session left open")
        expectEqual(screen.released, [7], "the filter let go")
    }

    test("while the picker is open nothing else starts, and the read-back says so") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = meetingWindow
        let (recorder, _) = makePictureRecorder(world, screen)
        var during: [String] = []
        screen.whilePickerOpen = {
            during.append(recorder.status().state)
            do { _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"])) } catch let e as RecorderError { during.append(e.code) } catch {}
            do { _ = try recorder.start(StartRequest(mode: .screen, apps: [])) } catch let e as RecorderError { during.append(e.code) } catch {}
        }
        _ = try recorder.start(StartRequest(mode: .window, apps: []))
        expectEqual(during, ["choosing", "already_recording", "already_recording"], "during the pick")
        expectEqual(world.appStreams.count, 0, "a tap opened during the pick")
        expectEqual(screen.presented.count, 1, "a second picker")
    }

    test("status says which senses are open — never a frame, a title or a line of transcript") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = meetingWindow
        let (recorder, _) = makePictureRecorder(world, screen)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let started = parse(service.handle(#"{"id":1,"op":"start","mode":"window","app_audio":true,"microphone":true}"#))
        expectEqual(started["ok"] as? Bool, true, "started")
        screen.draw(windowID: 11, "FRAME-PIXELS-SECRET")
        screen.play(app: "us.zoom.xos", says: "TRANSCRIPT-SECRET", from: 0, to: 1)
        let line = service.handle(#"{"id":2,"op":"status"}"#)
        let status = parse(line)
        expectEqual(status["senses"] as? [String: Bool], ["display": true, "app_audio": true, "microphone": true], "the senses")
        expectEqual((status["session"] as? [String: Any])?["mode"] as? String, "window", "the mode")
        for leak in ["FRAME-PIXELS-SECRET", "TRANSCRIPT-SECRET"] {
            expect(!line.contains(leak), "status carried \(leak)")
            expect(!service.handle(#"{"id":3,"op":"check"}"#).contains(leak), "check carried \(leak)")
        }
        _ = service.handle(#"{"id":4,"op":"stop"}"#)
        expectEqual(parse(service.handle(#"{"id":5,"op":"status"}"#))["senses"] as? [String: Bool], ["display": false, "app_audio": false, "microphone": false], "after Stop")

        // Audio only draws no display.
        let audio = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (tapRecorder, _) = makePictureRecorder(audio, nil)
        _ = try tapRecorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expectEqual(tapRecorder.status().senses, Senses(display: false, appAudio: true, microphone: true), "Audio only's senses")
    }

    test("no picture backend: Window and Screen are refused, Audio only still records") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makePictureRecorder(world, nil)
        for mode in [CaptureMode.window, .screen] {
            var unavailable = false
            do { _ = try recorder.start(StartRequest(mode: mode, apps: [])) } catch RecorderError.pictureUnavailable { unavailable = true }
            expect(unavailable, "\(mode) without a picture backend")
        }
        _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expect(recorder.isRecording, "Audio only")
    }

    test("a picture session's sound says nothing about the audio-capture grant") {
        let world = FakeAudioWorld(processes: [], bundleIDTaps: true)
        let screen = FakeScreenWorld(streamMicrophone: true)
        screen.ownerChooses = meetingWindow
        let (recorder, _) = makePictureRecorder(world, screen)
        _ = try recorder.start(StartRequest(mode: .window, apps: [], microphone: false))
        screen.play(app: "us.zoom.xos", says: "x: heard through the stream", from: 0, to: 1)
        recorder.stop(.owner)
        expectEqual(recorder.lastAppAudioObserved(), nil, "a ScreenCaptureKit session counted as a tap")
    }

    test("a reopened stream writes beside the first file, never over it") {
        let dir = URL(fileURLWithPath: "/nonexistent/session")
        var taken: Set<String> = []
        let exists = { (u: URL) in taken.contains(u.lastPathComponent) }
        expectEqual(nextMediaURL(in: dir, base: "screen", ext: "mp4", exists: exists).lastPathComponent, "screen.mp4", "the first")
        taken = ["screen.mp4"]
        expectEqual(nextMediaURL(in: dir, base: "screen", ext: "mp4", exists: exists).lastPathComponent, "screen-2.mp4", "after a wake")
        taken = ["app.m4a", "app-2.m4a"]
        expectEqual(nextMediaURL(in: dir, base: "app", ext: "m4a", exists: exists).lastPathComponent, "app-3.m4a", "after two wakes")
    }
}
