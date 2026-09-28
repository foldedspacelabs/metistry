// What a recording may hear: the tap plan, and the headline test of T8-2a —
// a tap scoped to app X yields nothing from app Y.

import Foundation

func scopeTests() {
    print("scope")

    test("a scope is a list of bundle IDs, never a pattern and never empty") {
        for bad in [[], ["*"], ["com.*"], ["zoom"], [" "], ["us.zoom.xos", "?"], ["us zoom.xos"]] as [[String]] {
            var refused = false
            do { _ = try validateScope(bad) } catch { refused = true }
            expect(refused, "\(bad) was accepted")
        }
        expectEqual(try validateScope(["us.zoom.xos", "us.zoom.xos", "com.google.Chrome"]).apps, ["us.zoom.xos", "com.google.Chrome"], "duplicates collapse, order kept")
        var tooMany = false
        do { _ = try validateScope((0...maxScopeApps).map { "com.example.app\($0)" }) } catch ScopeError.tooMany { tooMany = true }
        expect(tooMany, "more than \(maxScopeApps) apps accepted")
    }

    test("an app's own helpers belong to it; a lookalike does not") {
        expect(belongs("us.zoom.xos", to: "us.zoom.xos"), "the app itself")
        expect(belongs("us.zoom.xos.helper", to: "us.zoom.xos"), "its helper")
        expect(!belongs("us.zoom.xosfake", to: "us.zoom.xos"), "a bare prefix is not a dot boundary")
        expect(!belongs("us.zoom", to: "us.zoom.xos"), "a parent is not a child")
    }

    for bundleIDTaps in [false, true] {
        let mode = bundleIDTaps ? "macOS 26 bundle IDs" : "process objects"
        test("the plan names X and its helpers, never Y, a lookalike or the helper itself (\(mode))") {
            let plan = try planTap(scope: try validateScope(["us.zoom.xos"]), running: [zoom, zoomHelper, spotify, lookalike, ownHelper], bundleIDTaps: bundleIDTaps, ownBundleID: ownBundle)
            expectEqual(plan.processObjectIDs, [zoom.objectID, zoomHelper.objectID], "process objects")
            expectEqual(plan.bundleIDs, ["us.zoom.xos", "us.zoom.xos.helper"], "bundle IDs")
            for outsider in [spotify, lookalike, ownHelper] {
                expect(!plan.processObjectIDs.contains(outsider.objectID), "\(outsider.bundleID)'s process is in the plan")
                expect(!plan.bundleIDs.contains(outsider.bundleID), "\(outsider.bundleID) is in the plan")
            }
        }
    }

    test("below macOS 26 an app that is not running cannot be tapped — no plan, not an empty one") {
        var notRunning = false
        do { _ = try planTap(scope: try validateScope(["us.zoom.xos"]), running: [spotify], bundleIDTaps: false, ownBundleID: ownBundle) } catch ScopeError.notRunning { notRunning = true }
        expect(notRunning, "an empty process list became a plan")
    }

    test("on macOS 26 the helper cannot be scoped to itself — that is an empty scope") {
        var empty = false
        do { _ = try planTap(scope: try validateScope([ownBundle]), running: [ownHelper], bundleIDTaps: true, ownBundleID: ownBundle) } catch ScopeError.empty { empty = true }
        expect(empty, "the helper tapped itself")
    }

    for bundleIDTaps in [false, true] {
        let mode = bundleIDTaps ? "macOS 26 bundle IDs" : "process objects"
        test("a tap scoped to app X yields nothing from app Y (\(mode))") {
            let world = FakeAudioWorld(processes: [zoom, zoomHelper, spotify, lookalike], bundleIDTaps: bundleIDTaps)
            let (recorder, store) = makeRecorder(world)
            let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"], appAudio: true, microphone: false))

            world.play(spotify, says: "y: the song on the other app", from: 0, to: 4)
            world.play(zoom, says: "x: the meeting", from: 1, to: 3)
            world.play(lookalike, says: "y: a lookalike bundle", from: 3, to: 5)
            world.play(zoomHelper, says: "x: the meeting's helper process", from: 5, to: 6)
            // Y quits and relaunches mid-meeting as a new process object.
            let relaunched = AudioProcess(objectID: 202, pid: 6002, bundleID: "com.spotify.client")
            world.processes.append(relaunched)
            world.play(relaunched, says: "y: after a relaunch", from: 6, to: 8)
            recorder.stop(.owner)

            let texts = transcriptLines(store, session.sessionID).compactMap { $0["text"] as? String }
            expectEqual(texts, ["x: the meeting", "x: the meeting's helper process"], "the transcript")
            expect(!texts.contains { $0.hasPrefix("y:") }, "Y reached the transcript")
            expectEqual(world.appStreams.count, 1, "one tap")
            let plan = world.appStreams[0].plan
            expect(plan.map { !$0.bundleIDs.contains("com.spotify.client") } ?? false, "Y's bundle is in the tap")
            expect(plan.map { !$0.processObjectIDs.contains(spotify.objectID) && !$0.processObjectIDs.contains(relaunched.objectID) } ?? false, "Y's process is in the tap")
            expectEqual(session.processes.map(\.bundleID), ["us.zoom.xos", "us.zoom.xos.helper"], "the session records what the tap matched")
        }
    }

    test("app audio off: no tap is opened at all, whatever is playing") {
        let world = FakeAudioWorld(processes: [zoom, spotify], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"], appAudio: false, microphone: true))
        world.play(zoom, says: "x: unheard", from: 0, to: 1)
        world.play(spotify, says: "y: unheard", from: 0, to: 1)
        world.speak("me: my side", from: 1, to: 2)
        recorder.stop(.owner)
        expectEqual(world.appStreams.count, 0, "taps opened")
        let lines = transcriptLines(store, session.sessionID)
        expectEqual(lines.compactMap { $0["text"] as? String }, ["me: my side"], "the transcript")
        expectEqual(lines.compactMap { $0["source"] as? String }, ["mic"], "the source")
    }
}
