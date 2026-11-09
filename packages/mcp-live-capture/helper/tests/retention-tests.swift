// Retention and re-review (T8-4, plan §2.15, Q7). The rule is one pure
// function and the recorder applies it; these tests drive it through the
// recorder and the wire, on the fake clock, against real files in a temp
// capture directory. The bold test's helper half is here: a re-review
// answers TEXT only, and says when the audio was deleted.

import Foundation

/// The transcriber, faked: what it was asked to re-read, and canned lines
/// (seconds from the start of the FILE it was handed, as the real one answers).
final class FakeSpanTranscriber: SpanTranscribing {
    var answer: (URL, Double, Double) -> [TimedText] = { _, from, _ in [TimedText(fromS: from + 0.5, toS: from + 2, text: "the numbers are in")] }
    private(set) var asked: [(String, Double, Double)] = []

    func transcribe(file: URL, fromS: Double, toS: Double) throws -> [TimedText] {
        asked.append((file.lastPathComponent, fromS, toS))
        return answer(file, fromS, toS)
    }
}

func retentionTests() {
    print("retention")

    let day: TimeInterval = 24 * 3600

    func parse(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    /// Stand in for the adapters: a media file in the session's directory,
    /// created when its stream would have written its first sample.
    func putMedia(_ store: FileSessionStore, _ id: String, _ name: String, createdAt: Date, bytes: Int = 1000) {
        let url = store.directory(for: id).appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 7, count: bytes))
        try? FileManager.default.setAttributes([.creationDate: createdAt], ofItemAtPath: url.path)
    }

    /// A recorded, ended session with its audio on disk.
    func recorded(_ world: FakeAudioWorld, clock: FakeClock) throws -> (Recorder, FileSessionStore, SessionRecord) {
        let (recorder, store) = makeRecorder(world, clock: clock)
        let s = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        putMedia(store, s.sessionID, "app.m4a", createdAt: s.startedAt)
        putMedia(store, s.sessionID, "mic.m4a", createdAt: s.startedAt)
        clock.advance(600)
        recorder.stop(.owner)
        return (recorder, store, s)
    }

    func files(_ store: FileSessionStore, _ id: String) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: store.directory(for: id).path)) ?? []).sorted()
    }

    test("media files are read back by source and where they start — from when each was created — and nothing else is media") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let (recorder, store) = makeRecorder(world)
        let s = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        recorder.stop(.owner)
        putMedia(store, s.sessionID, "app.m4a", createdAt: s.startedAt)
        putMedia(store, s.sessionID, "app-2.m4a", createdAt: s.startedAt.addingTimeInterval(150))
        putMedia(store, s.sessionID, "mic.m4a", createdAt: s.startedAt.addingTimeInterval(0.2))
        putMedia(store, s.sessionID, "screen.mp4", createdAt: s.startedAt)
        putMedia(store, s.sessionID, "notes.txt", createdAt: s.startedAt)
        expectEqual(store.media(s.sessionID, startedAt: s.startedAt).map { "\($0.base)@\($0.offsetS)" }, ["app@0.0", "app@150.0", "mic@0.2", "screen@0.0"], "by source, then offset")
        expectEqual(store.media(s.sessionID, startedAt: s.startedAt).map { $0.source?.rawValue ?? "frames" }, ["app", "app", "mic", "frames"], "the frames are not an audio source")
        for good in ["app.m4a", "mic-2.m4a", "screen-3.mp4"] { expect(parseMediaFileName(good) != nil, "\(good) is media") }
        for bad in ["app.m4a.bak", "app-1.m4a", "app-012.m4a", "app--5.m4a", "screen.m4a", "app.mp4", "session.json", "transcript.jsonl", "app-2.5.m4a", "app-.m4a"] {
            expect(parseMediaFileName(bad) == nil, "\(bad) is not a session's media")
        }
    }

    test("the ceiling: the audio goes 30 days after the end with nobody's word — and nothing but the audio goes") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store, s) = try recorded(world, clock: clock)
        let ended = clock.now
        clock.advance(30 * day - 1)
        expectEqual(recorder.applyRetention().count, 0, "a second before the ceiling")
        expectEqual(files(store, s.sessionID), ["app.m4a", "mic.m4a", "session.json"], "kept")
        clock.advance(1)
        let changed = recorder.applyRetention()
        expectEqual(changed.map(\.sessionID), [s.sessionID], "due at the ceiling")
        expectEqual(changed.first?.audioDeletedAt, ended.addingTimeInterval(30 * day), "when it went")
        expectEqual(changed.first?.audioDeletedReason, "retention", "and why")
        expectEqual(files(store, s.sessionID), ["session.json"], "the audio is gone; the record stays")
        expectEqual(recorder.applyRetention().count, 0, "a second sweep changes nothing")
    }

    test("ingestion brings it forward to 7 days after — and a report can never push it back past 30") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store, s) = try recorded(world, clock: clock)
        try recorder.markDelivered(s.sessionID, inboxID: 9)
        let delivered = clock.now
        clock.advance(2 * day)
        let r = try recorder.reportIngestion(s.sessionID, at: clock.now)
        expectEqual(r.ingestedAt, delivered.addingTimeInterval(2 * day), "recorded")
        expectEqual(audioDeleteAfter(r), delivered.addingTimeInterval(9 * day), "7 days after ingestion")
        clock.advance(7 * day - 1)
        expect(recorder.applyRetention().isEmpty, "a second before")
        clock.advance(1)
        expectEqual(recorder.applyRetention().first?.audioDeletedReason, "retention", "due 7 days after ingestion")
        expectEqual(store.media(s.sessionID, startedAt: s.startedAt).count, 0, "gone")

        // A late ingestion never extends the ceiling.
        let late = SessionRecord(sessionID: "x", startedAt: delivered, state: .ended, endedAt: delivered, endedReason: "owner", apps: [], tapMode: nil, processes: [], appAudio: true, microphone: true, gaps: [], appAudioObserved: true, remindersRaised: 0, delivery: Delivery(inboxID: 1, at: delivered), ingestedAt: delivered.addingTimeInterval(29 * day))
        expectEqual(audioDeleteAfter(late), delivered.addingTimeInterval(30 * day), "min(ingested + 7, end + 30)")
    }

    test("an ingestion report is clamped to the delivery and to now, kept once, and refused before delivery") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, _, s) = try recorded(world, clock: clock)
        var refused: DeliveryError?
        do { _ = try recorder.reportIngestion(s.sessionID, at: clock.now) } catch let e as DeliveryError { refused = e }
        expectEqual(refused?.code, "invalid_request", "never delivered: nothing can have ingested it")
        try recorder.markDelivered(s.sessionID, inboxID: 9)
        let delivered = clock.now
        clock.advance(day)
        let early = try recorder.reportIngestion(s.sessionID, at: delivered.addingTimeInterval(-10 * day))
        expectEqual(early.ingestedAt, delivered, "a claim before the delivery is the delivery")
        let again = try recorder.reportIngestion(s.sessionID, at: clock.now)
        expectEqual(again.ingestedAt, delivered, "the first report stands")

        let (recorder2, _, s2) = try recorded(world, clock: clock)
        try recorder2.markDelivered(s2.sessionID, inboxID: 10)
        let future = try recorder2.reportIngestion(s2.sessionID, at: clock.now.addingTimeInterval(5 * day))
        expectEqual(future.ingestedAt, clock.now, "a future claim is now")
    }

    test("this Mac's transcript copy goes at 30 days, and only once it reached Metistry") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store, s) = try recorded(world, clock: clock)
        store.append(TranscriptSegment(source: .app, fromS: 1, toS: 2, text: "hello"), to: s.sessionID)
        clock.advance(31 * day)
        recorder.applyRetention()
        expectEqual(files(store, s.sessionID), ["session.json", "transcript.jsonl"], "undelivered: the only copy is kept (check says it is owed)")
        try recorder.markDelivered(s.sessionID, inboxID: 3)
        let r = recorder.applyRetention().first
        expect(r?.transcriptDeletedAt != nil, "delivered and past 30 days: deleted")
        expectEqual(files(store, s.sessionID), ["session.json"], "only the record is left")
    }

    test("Purge Now: the owner's hand deletes the audio at once — ended sessions only, and twice is once") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store, s) = try recorded(world, clock: clock)
        putMedia(store, s.sessionID, "screen.mp4", createdAt: s.startedAt) // a Window / Screen session's frames go with its audio
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let r = parse(service.handle(#"{"id":1,"op":"purge","session_id":"\#(s.sessionID)"}"#))
        expectEqual(r["ok"] as? Bool, true, "purged")
        let session = r["session"] as? [String: Any]
        expectEqual(session?["audio_deleted_reason"] as? String, "owner", "why")
        expectEqual(session?["media_bytes"] as? Int, 0, "nothing kept")
        expectEqual(files(store, s.sessionID), ["session.json"], "gone")
        clock.advance(60)
        let again = parse(service.handle(#"{"id":2,"op":"purge","session_id":"\#(s.sessionID)"}"#))
        expectEqual((again["session"] as? [String: Any])?["audio_deleted_at"] as? String, session?["audio_deleted_at"] as? String, "the first purge's record")

        let running = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        putMedia(store, running.sessionID, "app.m4a", createdAt: running.startedAt)
        let refused = parse(service.handle(#"{"id":3,"op":"purge","session_id":"\#(running.sessionID)"}"#))
        expectEqual(refused["code"] as? String, "still_recording", "never the running session")
        expect(!store.media(running.sessionID, startedAt: running.startedAt).isEmpty, "its audio is untouched")
        for bad in ["../x", "", "A"] {
            expectEqual(parse(service.handle(#"{"id":4,"op":"purge","session_id":"\#(bad)"}"#))["code"] as? String, "invalid_request", "\(bad): no path is built from it")
        }
    }

    test("the retention op: the timer's sweep, and the console's report — both answer the rule's dates") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, _, s) = try recorded(world, clock: clock)
        try recorder.markDelivered(s.sessionID, inboxID: 5)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        let sweep = parse(service.handle(#"{"id":1,"op":"retention"}"#))
        expectEqual((sweep["changed"] as? [Any])?.count, 0, "nothing due")
        let iso = ISO8601DateFormatter()
        let r = parse(service.handle(#"{"id":2,"op":"retention","session_id":"\#(s.sessionID)","ingested_at":"\#(iso.string(from: clock.now))"}"#))
        let session = r["session"] as? [String: Any]
        expectEqual(session?["media_bytes"] as? Int, 2000, "two files kept")
        expectEqual(session?["audio_delete_after"] as? String, iso.string(from: clock.now.addingTimeInterval(7 * day)), "7 days from now")
        expectEqual(parse(service.handle(#"{"id":3,"op":"retention","session_id":"\#(s.sessionID)","ingested_at":"yesterday"}"#))["code"] as? String, "invalid_request", "an instant or nothing")
    }

    test("recording_review returns text only — the lines, their source and times from Record, and no audio") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, store) = makeRecorder(world, clock: clock)
        let s = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        clock.advance(100)
        recorder.willSleep()
        clock.advance(50)
        recorder.didWake()
        clock.advance(100)
        recorder.stop(.owner)
        // what the adapters left: one file per source per stretch (T8-3's names), the second from the wake
        putMedia(store, s.sessionID, "app.m4a", createdAt: s.startedAt)
        putMedia(store, s.sessionID, "mic.m4a", createdAt: s.startedAt)
        putMedia(store, s.sessionID, "app-2.m4a", createdAt: s.startedAt.addingTimeInterval(150))
        putMedia(store, s.sessionID, "mic-2.m4a", createdAt: s.startedAt.addingTimeInterval(150))
        let reviewer = FakeSpanTranscriber()
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4", reviewer: reviewer)
        let r = parse(service.handle(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":160,"to_s":170}"#))
        expectEqual(r["ok"] as? Bool, true, "reviewed")
        expectEqual(Set(r.keys), ["id", "ok", "session_id", "from_s", "to_s", "audio", "lines"], "the answer's fields — nothing that could carry audio")
        expectEqual(r["audio"] as? String, "kept", "the audio is still kept")
        let lines = (r["lines"] as? [[String: Any]]) ?? []
        for l in lines { expectEqual(Set(l.keys), ["source", "from_s", "to_s", "text"], "a line is text with times") }
        expectEqual(lines.map { "\($0["source"]!)@\($0["from_s"]!)" }, ["app@160.5", "mic@160.5"], "times from Record, each source")
        // The span after the sleep is the second files', from their own start.
        expectEqual(reviewer.asked.map { "\($0.0) \($0.1)-\($0.2)" }, ["app-2.m4a 10.0-20.0", "mic-2.m4a 10.0-20.0"], "the files that cover it, read from the right place")
        // A span across the sleep reads the end of the first files and the start of the second.
        _ = service.handle(#"{"id":2,"op":"review","session_id":"\#(s.sessionID)","from_s":90,"to_s":160}"#)
        expectEqual(reviewer.asked.suffix(4).map { "\($0.0) \($0.1)-\($0.2)" }, ["app.m4a 90.0-150.0", "app-2.m4a 0.0-10.0", "mic.m4a 90.0-150.0", "mic-2.m4a 0.0-10.0"], "both stretches")
    }

    test("recording_review after deletion says when the audio went — and why — and re-reads nothing") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, _, s) = try recorded(world, clock: clock)
        try recorder.markDelivered(s.sessionID, inboxID: 4)
        _ = try recorder.reportIngestion(s.sessionID, at: clock.now)
        clock.advance(7 * day)
        recorder.applyRetention()
        let reviewer = FakeSpanTranscriber()
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4", reviewer: reviewer)
        let r = parse(service.handle(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":0,"to_s":30}"#))
        expectEqual(r["ok"] as? Bool, true, "an answer, not an error")
        expectEqual(r["audio"] as? String, "deleted", "says so")
        let session = r["session"] as? [String: Any]
        expectEqual(session?["audio_deleted_at"] as? String, ISO8601DateFormatter().string(from: clock.now), "when")
        expectEqual(session?["audio_deleted_reason"] as? String, "retention", "why")
        expect(session?["ingested_at"] as? String != nil, "after ingestion")
        expectEqual((r["lines"] as? [Any])?.count, 0, "no text re-read")
        expectEqual(reviewer.asked.count, 0, "the transcriber was never asked")
    }

    test("recording_review refusals: a bad span, a long one, a running session, a malformed id, no transcriber") {
        let world = FakeAudioWorld(processes: [zoom], bundleIDTaps: true)
        let clock = FakeClock()
        let (recorder, _, s) = try recorded(world, clock: clock)
        let service = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4", reviewer: FakeSpanTranscriber())
        let code = { (line: String) in parse(service.handle(line))["code"] as? String }
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":30,"to_s":10}"#), "invalid_request", "backwards")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":-1,"to_s":10}"#), "invalid_request", "before Record")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":"0","to_s":10}"#), "invalid_request", "a string")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":true,"to_s":10}"#), "invalid_request", "a boolean")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":0,"to_s":901}"#), "invalid_request", "over 15 minutes")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"../etc","from_s":0,"to_s":10}"#), "invalid_request", "no path from a malformed id")
        expectEqual(code(#"{"id":1,"op":"review","session_id":"20990101-000000-0000","from_s":0,"to_s":10}"#), "unknown_session", "unknown")
        let running = try recorder.start(StartRequest(apps: ["us.zoom.xos"]))
        expectEqual(code(#"{"id":1,"op":"review","session_id":"\#(running.sessionID)","from_s":0,"to_s":10}"#), "still_recording", "the running session")
        recorder.stop(.owner)
        let bare = HelperService(recorder: recorder, grants: FakeGrants(), transcriber: FakeTranscriber(), osVersion: "26.4")
        expectEqual(parse(bare.handle(#"{"id":1,"op":"review","session_id":"\#(s.sessionID)","from_s":0,"to_s":10}"#))["code"] as? String, "no_transcriber", "below macOS 26")
    }

    test("a session.json from before retention existed reads with everything kept") {
        let old = #"{"session_id":"20260928-120000-00ab","started_at":"2026-09-28T12:00:00Z","state":"ended","ended_at":"2026-09-28T12:10:00Z","ended_reason":"owner","apps":["us.zoom.xos"],"tap_mode":"bundle_ids","processes":[],"app_audio":true,"microphone":true,"gaps":[],"app_audio_observed":true,"reminders_raised":0,"delivery":{"inbox_id":4,"at":"2026-09-28T12:11:00Z"}}"#
        let r = try sessionDecoder().decode(SessionRecord.self, from: Data(old.utf8))
        expect(r.audioDeletedAt == nil && r.ingestedAt == nil && r.transcriptDeletedAt == nil, "nothing deleted, nothing ingested")
        expectEqual(audioDeleteAfter(r), parseInstant("2026-10-28T12:10:00Z"), "the ceiling applies to it")
    }
}
