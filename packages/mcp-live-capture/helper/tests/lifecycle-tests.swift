// C137: reminders every two hours, the ten-hour stop, the disk lines, sleep.

import Foundation

func lifecycleTests() {
    print("lifecycle")
    let h: TimeInterval = 3600

    test("reminders at 2, 4, 6 and 8 hours; 10 is the stop, not a reminder") {
        let start = Date(timeIntervalSince1970: 0)
        var state = LifecycleState(startedAt: start)
        var said: [LifecycleAction] = []
        var t: TimeInterval = 0
        while t < 10 * h {
            said += evaluate(&state, now: start.addingTimeInterval(t), freeBytes: nil)
            t += 60
        }
        expectEqual(said, [.remind(hours: 2), .remind(hours: 4), .remind(hours: 6), .remind(hours: 8)], "reminders")
        expectEqual(evaluate(&state, now: start.addingTimeInterval(10 * h), freeBytes: nil), [.stop(.maxDuration)], "at ten hours")
    }

    test("disk: one warning under 10 GB, a stop under 5 GB, and the stop wins") {
        let start = Date(timeIntervalSince1970: 0)
        var state = LifecycleState(startedAt: start)
        expectEqual(evaluate(&state, now: start, freeBytes: 9_000_000_000), [.warnDisk(freeBytes: 9_000_000_000)], "first warning")
        expectEqual(evaluate(&state, now: start, freeBytes: 8_000_000_000), [], "said once")
        expectEqual(evaluate(&state, now: start, freeBytes: 4_999_999_999), [.stop(.diskFull)], "under 5 GB")
        var fresh = LifecycleState(startedAt: start)
        expectEqual(evaluate(&fresh, now: start, freeBytes: nil), [], "an unreadable volume infers nothing")
    }

    test("the 10-hour stop fires") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store) = makeRecorder(world, clock: clock)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expectEqual(world.openStreams, 2, "app and microphone open")

        clock.advance(10 * h - 1)
        recorder.tick()
        expect(recorder.isRecording, "stopped before ten hours")
        expectEqual(recorder.status().reminderDueHours, 8, "the latest reminder is due")

        clock.advance(1)
        recorder.tick()
        expect(!recorder.isRecording, "still recording at ten hours")
        expectEqual(world.openStreams, 0, "streams left open")
        let ended = store.sessions().first { $0.sessionID == session.sessionID }
        expectEqual(ended?.state, .ended, "session state on disk")
        expectEqual(ended?.endedReason, "max_duration", "why it ended")
        expectEqual(ended?.endedAt, clock.now, "when it ended")
        expectEqual(ended?.remindersRaised, 4, "reminders raised")
        expectEqual(recorder.status().state, "idle", "the read-back")
        expectEqual(recorder.status().session?.endedReason, "max_duration", "the read-back says how it ended")
    }

    test("the 10-hour stop fires across a sleep, and nothing reopens") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: false)
        let clock = FakeClock()
        let (recorder, store) = makeRecorder(world, clock: clock)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"], microphone: false))
        clock.advance(1 * h)
        recorder.willSleep()
        expectEqual(recorder.status().state, "paused", "asleep")
        expectEqual(world.openStreams, 0, "a stream stayed open through sleep")
        clock.advance(11 * h)
        recorder.didWake()
        expect(!recorder.isRecording, "resumed past ten hours")
        expectEqual(world.appStreams.count, 1, "a tap was reopened")
        let ended = store.sessions().first { $0.sessionID == session.sessionID }
        expectEqual(ended?.endedReason, "max_duration", "why it ended")
        expectEqual(ended?.gaps, [Gap(fromS: 1 * h, toS: 12 * h, reason: "sleep")], "the gap")
    }

    test("a sleep pauses, marks the gap in the transcript, and resumes on session time") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: false)
        let clock = FakeClock()
        let (recorder, store) = makeRecorder(world, clock: clock)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"], microphone: false))
        world.play(zoom, says: "x: before", from: 10, to: 12)
        clock.advance(60)
        recorder.willSleep()
        world.play(zoom, says: "x: while asleep", from: 0, to: 1)
        clock.advance(240)
        recorder.didWake()
        expectEqual(recorder.status().state, "recording", "awake")
        world.play(zoom, says: "x: after", from: 5, to: 7)
        recorder.stop(.owner)

        let lines = transcriptLines(store, session.sessionID)
        expectEqual(lines.map { ($0["text"] as? String) ?? "gap:\($0["reason"] ?? "")" }, ["x: before", "gap:sleep", "x: after"], "the transcript")
        expectEqual(lines.last?["from_s"] as? Double, 305, "times continue from Record")
        expectEqual(lines[1]["from_s"] as? Double, 60, "the gap starts at the sleep")
        expectEqual(lines[1]["to_s"] as? Double, 300, "and ends at the wake")
    }

    test("Keep Going answers the reminder once") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, _) = makeRecorder(world, clock: clock)
        _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expect(!recorder.keepGoing(), "answered a reminder that was never raised")
        clock.advance(2 * h)
        recorder.tick()
        expectEqual(recorder.status().reminderDueHours, 2, "two hours")
        expect(recorder.keepGoing(), "Keep Going")
        expectEqual(recorder.status().reminderDueHours, nil, "answered")
        expect(recorder.isRecording, "Keep Going stopped it")
    }

    test("the disk: refused under 5 GB, warned under 10, stopped under 5") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let disk = FakeDisk()
        let (recorder, store) = makeRecorder(world, disk: disk)
        disk.free = 4_000_000_000
        var refused = false
        do { _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"])) } catch RecorderError.diskFull { refused = true }
        expect(refused, "started with 4 GB free")
        expectEqual(world.openStreams, 0, "a stream opened for a refused start")

        disk.free = 50_000_000_000
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        disk.free = 9_000_000_000
        recorder.tick()
        expectEqual(recorder.status().diskLowFreeBytes, 9_000_000_000, "the warning")
        disk.free = 4_000_000_000
        recorder.tick()
        expect(!recorder.isRecording, "still recording under 5 GB")
        expectEqual(store.sessions().first { $0.sessionID == session.sessionID }?.endedReason, "disk_full", "why it ended")
    }

    test("a crash: the next start ends the session at its last write, and keeps what was written") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        let session = try recorder.start(StartRequest(apps: ["us.zoom.xos"], microphone: false))
        world.play(zoom, says: "x: said before the crash", from: 0, to: 2)
        // The helper dies here: nothing stops the session. A new helper opens the same directory.
        let reborn = Recorder(backend: FakeAudioWorld(processes: [], bundleIDTaps: true), store: FileSessionStore(root: store.root), disk: FakeDisk(), ownBundleID: ownBundle)
        let recovered = reborn.recoverInterrupted()
        expectEqual(recovered.map(\.sessionID), [session.sessionID], "the interrupted session")
        expectEqual(recovered.first?.endedReason, "crashed", "why it ended")
        expect(recovered.first?.endedAt != nil, "ended at its last write")
        expectEqual(transcriptLines(store, session.sessionID).compactMap { $0["text"] as? String }, ["x: said before the crash"], "the transcript up to the crash")
        expectEqual(reborn.recoverInterrupted().count, 0, "recovered twice")
    }

    test("one session at a time, and something must be recorded") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, _) = makeRecorder(world)
        var nothing = false
        do { _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"], appAudio: false, microphone: false)) } catch RecorderError.nothingToRecord { nothing = true }
        expect(nothing, "started with both sources off")
        _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        var already = false
        do { _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"])) } catch RecorderError.alreadyRecording { already = true }
        expect(already, "a second session started")
        expectEqual(world.appStreams.count, 1, "a second tap opened")
    }

    test("a stream that fails to open leaves nothing running and the session ended") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        world.failMicrophone = true
        let (recorder, store) = makeRecorder(world)
        var failed = false
        do { _ = try recorder.start(StartRequest(apps: ["us.zoom.xos"])) } catch RecorderError.streamFailed { failed = true }
        expect(failed, "started without a microphone")
        expect(!recorder.isRecording, "recording after a failed start")
        expectEqual(world.openStreams, 0, "the tap stayed open")
        expectEqual(store.sessions().first?.endedReason, "failed_to_start", "the session on disk")
    }
}
