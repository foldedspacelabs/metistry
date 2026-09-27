// Live changes on the Mac (T5-7, design-build-plan §2.20): `LiveEvents`, the
// app's one subscription to `GET /api/events`, what each event makes due, and
// the polling it falls back to while the stream is down.
//
// The stream is a SCRIPTED transport: every subscription the app opens is one
// entry the test drives by hand — yield the recorded frames of
// `fixtures/get-api-events.json`, drop it, see what the app asks for next.
// Every other request is answered by the recorded fixtures (`FixtureConsole`),
// so a section that refetches is visible as a call.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The catalogue's "the client refetches" column

@Test func eachEventMakesDueExactlyTheStoreTheCatalogueNames() {
    // Written from design-build-plan §2.20's table, not from the code: a
    // change to either side is a change to the other.
    let table: [(ConsoleEvent.Change, Set<EventTopic>)] = [
        (.runStarted(runID: 1, kind: "routine_run", turnID: nil), [.runs, .activity]),
        (.runFinished(runID: 1, kind: "tool", turnID: "t"), [.runs, .activity, .working]),
        (.turnProgress(turnID: "t"), [.working]),
        (.messageNew(messageID: 3, thread: "default"), [.chat]),
        (.presenceChanged(agentID: "cursor"), [.presence]),
        (.needsYouChanged(waiting: 2), [.needsYou]),
        (.workChanged(workID: 5), [.board]),
        (.threadChanged(workID: 5, artifactID: nil), [.threads]),
        (.captureNew(inboxID: 2), [.activity]),
        (.vaultReconciled(changed: 4), [.today, .knowledge]),
        (.vaultSync(state: "push"), [.vault]),
        (.routineStatus(name: "standup"), [.scheduled, .today]),
        (.syncStatus(name: "github-state"), [.scheduled]),
        (.connectionHealth(connection: "github"), [.connections]),
        (.configChanged(file: ".metistry/scheduled.yaml"), [.configuration]),
        (.configChanged(file: "identity.yaml"), [.configuration, .identity]),
        (.configChanged(file: ".metistry/compute.yaml"), [.configuration, .usage]),
        (.budgetState(scope: "instance"), [.usage]),
        (.releaseAvailable(version: "0.14.0"), [.identity]),
        (.resync, Set(EventTopic.allCases)),
        (.unreadable(type: "work.changed"), Set(EventTopic.allCases)),
        (.unknown(type: "something.new"), []),
        (.cursor, []),
    ]
    for (change, topics) in table {
        #expect(change.topics == topics, "\(change)")
    }
}

@Test func aCursorFrameIsAPositionNotAnEvent() throws {
    let cursor = try ConsoleEvent(frame: .cursor("7000"))
    #expect(cursor == ConsoleEvent(id: "7000", change: .cursor))
    #expect(cursor.change.topics.isEmpty)
}

@Test func anUnreadableFrameDoesNotEndTheStream() async throws {
    let scripted = ScriptedStream()
    let stores = ConsoleStores(transport: FixtureConsole([]), stream: scripted)
    let consumer = Task {
        var seen: [ConsoleEvent] = []
        for try await event in stores.events(lastEventID: nil) { seen.append(event) }
        return seen
    }
    let first = try await scripted.connection(0)
    first.yield(ConsoleLiveEvent(id: "1", type: "work.changed", data: .object([:])))
    first.yield(ConsoleLiveEvent(id: "2", type: "work.changed", data: .object(["work_id": .number(5)])))
    first.finish()
    let seen = try await consumer.value
    #expect(seen == [
        ConsoleEvent(id: "1", change: .unreadable(type: "work.changed")),
        ConsoleEvent(id: "2", change: .workChanged(workID: 5)),
    ])
}

// MARK: - The recorded stream, dropped and resumed

@MainActor
@Test(.timeLimit(.minutes(1)))
func aRecordedStreamReachesExactlyTheWatchersEachEventNamesAcrossADrop() async throws {
    let frames = try #require(try ConsoleFixture.load("get-api-events").stream)
    #expect(frames.count > 10)
    let scripted = ScriptedStream()
    let session = ConsoleSession(transport: try FixtureConsole.recorded(), stream: scripted, management: nil, eventTiming: .fast)
    var heard: [EventTopic: [String]] = [:]
    for topic in EventTopic.allCases {
        session.events.watch([topic]) { event in
            heard[topic, default: []].append(event.id ?? "-")
            return true
        }
    }
    session.events.start()

    // the recording opens with `resync` (it was recorded as a resume from a
    // stale id); the stream drops halfway through
    let half = frames.count / 2
    let first = try await scripted.connection(0)
    #expect(scripted.lastEventIDs == [nil])
    for frame in frames[..<half] { first.yield(frame) }
    try await until { session.events.lastEventID == frames[half - 1].id }
    #expect(session.events.isLive)
    first.finish(throwing: ConsoleError.transport("the stream from http://127.0.0.1:8080 broke: socket hang up"))
    try await until { !session.events.isLive }

    // the reopen resumes after the last id heard, and the rest arrives
    let second = try await scripted.connection(1)
    #expect(scripted.lastEventIDs == [nil, frames[half - 1].id])
    for frame in frames[half...] { second.yield(frame) }
    try await until { session.events.lastEventID == frames.last?.id }
    #expect(session.events.isLive)
    #expect(session.events.opened == 2)

    // each watcher heard the resync and then exactly the events that name it
    let events = try frames.map(ConsoleEvent.init(frame:))
    for topic in EventTopic.allCases {
        let expected = events.filter { $0.change.topics.contains(topic) }.map { $0.id ?? "-" }
        #expect(heard[topic, default: []] == expected, "\(topic)")
        #expect(expected.first == frames.first?.id, "the resync reaches \(topic)")
    }
    // and not everything is everyone's: a board watcher heard no chat
    #expect(heard[.board]?.count == 2, "the resync and the one work.changed")
    #expect(heard[.chat]?.count == 2, "the resync and the one message.new")
    session.events.stop()
}

// MARK: - Sections

@MainActor
@Test(.timeLimit(.minutes(1)))
func anEventInvalidatesExactlyItsSection() async throws {
    let console = try FixtureConsole.recorded()
    let scripted = ScriptedStream()
    let session = ConsoleSession(transport: console, stream: scripted, management: nil, eventTiming: .fast)
    let waiting = SectionModel(session: session, policy: .requests, topics: [.needsYou]) { await $0.waitingCount().map { ($0, nil) } }
    let board = SectionModel(session: session, policy: .board, topics: [.board]) { await $0.board(project: nil, limit: nil).map { ($0, nil) } }
    let chat = SectionModel(session: session, policy: .feed, topics: [.chat]) { await $0.messages(limit: nil, since: nil).map { ($0, nil) } }
    let sections: [() -> Bool] = [{ waiting.isInvalidated }, { board.isInvalidated }, { chat.isInvalidated }]
    await waiting.refresh()
    await board.refresh()
    await chat.refresh()
    #expect(waiting.section.state == .loaded && board.section.state == .loaded && chat.section.state == .loaded)

    // a fresh subscription cannot know what changed before it opened: its
    // first word (the console's cursor) makes every section due once
    session.events.start()
    let stream = try await scripted.connection(0)
    stream.yield(.cursor("7000"))
    try await until { session.events.isLive }
    #expect(sections.map { $0() } == [true, true, true])
    await waiting.refreshIfDue()
    await board.refreshIfDue()
    await chat.refreshIfDue()
    #expect(sections.map { $0() } == [false, false, false])

    stream.yield(ConsoleLiveEvent(id: "7001", type: "work.changed", data: .object(["work_id": .number(5)])))
    try await until { session.events.lastEventID == "7001" }
    #expect(sections.map { $0() } == [false, true, false])

    console.reset()
    await waiting.refreshIfDue()
    await board.refreshIfDue()
    await chat.refreshIfDue()
    #expect(console.calls.map(\.path) == ["/api/q/board"], "the board asked because it was told; the others had no reason to")

    stream.yield(ConsoleLiveEvent(id: "7002", type: "message.new", data: .object(["message_id": .number(3), "thread": .string("default")])))
    stream.yield(ConsoleLiveEvent(id: "7003", type: "something.new", data: .object([:])))
    stream.yield(.cursor("7004"))
    try await until { session.events.lastEventID == "7004" }
    #expect(sections.map { $0() } == [false, false, true], "an unknown type and a cursor make nothing due")
    session.events.stop()
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func aDroppedStreamFallsBackToPollingAndRecovers() async throws {
    let console = try FixtureConsole.recorded()
    let scripted = ScriptedStream()
    let session = ConsoleSession(transport: console, stream: scripted, management: nil, eventTiming: .fast)
    let waiting = SectionModel(session: session, policy: .requests, topics: [.needsYou]) { await $0.waitingCount().map { ($0, nil) } }
    let untold = SectionModel(session: session, policy: .requests) { await $0.waitingCount().map { ($0, nil) } }
    await waiting.refresh()
    await untold.refresh()
    // one poll interval after each section's own last attempt — never a date
    // taken up front, which a slow runner can reach before the test does
    func later(_ s: SectionModel<NeedsYouCount>) -> Date {
        (s.section.lastAttemptAt ?? Date()).addingTimeInterval(RefreshPolicy.requests.interval + 1)
    }

    // before the stream: both poll
    #expect(waiting.clock == .requests)
    session.events.start()
    let first = try await scripted.connection(0)
    first.yield(.cursor("7000"))
    try await until { session.events.isLive }
    await waiting.refreshIfDue()   // the fresh-subscription resync
    console.reset()

    // live: the section the stream speaks for waits to be told; one it does not speak for still polls
    #expect(waiting.clock == RefreshPolicy.requests.whileLive)
    #expect(untold.clock == .requests)
    await waiting.refreshIfDue(now: later(waiting))
    await untold.refreshIfDue(now: later(untold))
    #expect(console.calls.count == 1, "only the section no event names asked on the clock")

    // the stream drops: polling resumes at once, on the section's own clock
    first.finish(throwing: ConsoleError.transport("the stream from http://127.0.0.1:8080 broke: socket hang up"))
    try await until { !session.events.isLive }
    console.reset()
    #expect(waiting.clock == .requests)
    await waiting.refreshIfDue(now: later(waiting))
    #expect(console.calls.map(\.path) == ["/api/needs-you/count"])

    // it reopens from the console's cursor — the id of a stream that said nothing else
    let second = try await scripted.connection(1)
    #expect(scripted.lastEventIDs == [nil, "7000"])
    #expect(session.events.state == .connecting)
    #expect(waiting.clock == .requests, "not live until it has said something or stayed open")
    second.yield(ConsoleLiveEvent(id: "7001", type: "needs_you.changed", data: .object(["waiting": .number(5)])))
    try await until { session.events.isLive }
    #expect(waiting.isInvalidated, "a resume is not a resync: only what the replay names is due")
    console.reset()
    await waiting.refreshIfDue()   // told
    await waiting.refreshIfDue(now: later(waiting).addingTimeInterval(60))   // not told, not five minutes
    #expect(console.calls.map(\.path) == ["/api/needs-you/count"])
    session.events.stop()
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func aQuietResumedStreamIsLiveOnceItHasStayedOpen() async throws {
    let scripted = ScriptedStream()
    let timing = LiveEvents.Timing(openGrace: .milliseconds(20)) { _ in .milliseconds(5) }
    let session = ConsoleSession(transport: try FixtureConsole.recorded(), stream: scripted, management: nil, eventTiming: timing)
    var resyncs = 0
    session.events.watch([.needsYou]) { event in
        if event.change == .resync { resyncs += 1 }
        return true
    }
    session.events.start()
    let first = try await scripted.connection(0)
    first.yield(.cursor("7000"))
    try await until { session.events.isLive }
    #expect(resyncs == 1)
    first.finish()   // the console closed it — a restart, a slow-subscriber drop
    // the resume has nothing to replay, so it says nothing: open is enough
    _ = try await scripted.connection(1)
    #expect(scripted.lastEventIDs == [nil, "7000"])
    try await until { session.events.isLive }
    #expect(resyncs == 1, "a resume that went quiet is not a resync")
    session.events.stop()
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func withNoStreamTheAppPollsAndNothingRetries() async throws {
    let session = ConsoleSession(transport: CallOnlyTransport(), management: nil, eventTiming: .fast)
    session.events.start()
    try await until { if case .unavailable = session.events.state { true } else { false } }
    #expect(session.events.opened == 1)
    try await Task.sleep(for: .milliseconds(30))
    #expect(session.events.opened == 1, "a transport with no stream is not asked again")
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func anInstanceSwitchForgetsTheCursorAndReopensAgainstTheNewConsole() async throws {
    let old = ScriptedStream()
    let new = ScriptedStream()
    let session = ConsoleSession(transport: try FixtureConsole.recorded(), stream: old, management: nil, eventTiming: .fast)
    var heard: [String] = []
    session.events.watch([.board]) { event in
        heard.append(event.id ?? "-")
        return true
    }
    session.events.start()
    let first = try await old.connection(0)
    first.yield(.cursor("7000"))
    try await until { session.events.lastEventID == "7000" }

    session.adopt(transport: try FixtureConsole.recorded(), stream: new, management: nil)
    #expect(session.events.lastEventID == nil, "an id means nothing to another console")
    let second = try await new.connection(0)
    #expect(new.lastEventIDs == [nil])
    // a late frame from the old console reaches nobody
    first.yield(ConsoleLiveEvent(id: "7001", type: "work.changed", data: .object(["work_id": .number(1)])))
    second.yield(ConsoleLiveEvent(id: "9001", type: "work.changed", data: .object(["work_id": .number(2)])))
    try await until { session.events.lastEventID == "9001" }
    #expect(heard == ["-", "-", "9001"], "two fresh-subscription resyncs, then the new console's event — never the old one's")
    session.events.stop()
}

// MARK: - The shell: the row, the badge, the Dock

@MainActor
@Test(.timeLimit(.minutes(1)))
func theBadgeTakesTheCountFromTheStreamAndAnnouncesAChangeOnce() async throws {
    let console = try FixtureConsole.recorded()
    let scripted = ScriptedStream()
    let session = ConsoleSession(transport: console, stream: scripted, management: nil, eventTiming: .fast)
    let shell = ShellModel(stores: session.stores, defaults: UserDefaults(suiteName: "live-events-\(UUID())")!)
    var spoken: [String] = []
    shell.announce = { spoken.append($0) }
    shell.follow(session.events)
    session.events.start()

    let stream = try await scripted.connection(0)
    stream.yield(.cursor("7000"))
    stream.yield(ConsoleLiveEvent(id: "7001", type: "needs_you.changed", data: .object(["waiting": .number(2)])))
    try await until { shell.waiting == 2 }
    #expect(shell.showsNeedsYouRow)
    #expect(spoken.isEmpty, "the first reading is not a change")

    stream.yield(ConsoleLiveEvent(id: "7002", type: "needs_you.changed", data: .object(["waiting": .number(3)])))
    stream.yield(ConsoleLiveEvent(id: "7003", type: "needs_you.changed", data: .object(["waiting": .number(3)])))
    try await until { session.events.lastEventID == "7003" }
    #expect(shell.waiting == 3)
    #expect(spoken == [NeedsYouBadge.spoken(3)], "one change, one announcement — a repeat of the same count says nothing")
    #expect(shell.badgeLabel == "3")

    // live: the count is not asked on the requests' clock. The first tick
    // asks once (nothing has asked yet), and the recorded answer (4) is a
    // change the badge announces — once.
    console.reset()
    let now = Date()
    await shell.refreshDue(now: now)
    await shell.refreshDue(now: now.addingTimeInterval(RefreshPolicy.requests.interval + 1))
    #expect(console.calls.filter { $0.path == "/api/needs-you/count" }.count == 1)
    #expect(shell.waiting == 4)
    #expect(spoken == [NeedsYouBadge.spoken(3), NeedsYouBadge.spoken(4)])

    // the stream drops: the count is polled again
    stream.finish(throwing: ConsoleError.transport("socket hang up"))
    try await until { !shell.countIsLive }
    console.reset()
    await shell.refreshDue(now: now.addingTimeInterval(2 * RefreshPolicy.requests.interval + 2))
    #expect(console.calls.filter { $0.path == "/api/needs-you/count" }.count == 1)
    #expect(spoken.count == 2, "the poll said what the stream had said: nothing to announce")
    session.events.stop()
}

// MARK: - Through the session child (the F-12 frames, T2-18's cursor)

@MainActor
@Test(.timeLimit(.minutes(1)))
func theSessionChildsCursorIsWhatAReopenResumesFrom() async throws {
    let child = CursorChild()
    let transport = SessionConsoleCallTransport { child }
    let session = ConsoleSession(transport: transport, management: nil, eventTiming: .fast)
    session.events.start()
    // the console said only its cursor, then the stream closed
    try await until { child.streams.count == 2 }
    #expect(child.streams[0]["last_event_id"] == nil)
    #expect(child.streams[1]["last_event_id"] as? String == "1790000000000007")
    session.events.stop()
}

// MARK: - Helpers

extension LiveEvents.Timing {
    /// Live only on a frame; reopen at once.
    static let fast = LiveEvents.Timing(openGrace: .seconds(3600)) { _ in .milliseconds(5) }
}

/// Waits for `condition`, a few ms at a time; the test's time limit is the bound.
@MainActor
private func until(_ condition: @MainActor () -> Bool) async throws {
    while !condition() { try await Task.sleep(for: .milliseconds(2)) }
}

/// The stream transport, by hand: each `events(lastEventID:)` is a connection
/// the test yields to, finishes, or drops.
private final class ScriptedStream: ConsoleEventTransport, @unchecked Sendable {
    typealias Connection = AsyncThrowingStream<ConsoleLiveEvent, any Error>.Continuation
    private let lock = NSLock()
    private var opened: [(lastEventID: String?, connection: Connection)] = []

    var lastEventIDs: [String?] { lock.withLock { opened.map(\.lastEventID) } }

    func events(lastEventID: String?) async -> AsyncThrowingStream<ConsoleLiveEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<ConsoleLiveEvent, any Error>.makeStream()
        lock.withLock { opened.append((lastEventID, continuation)) }
        return stream
    }

    /// The `n`th subscription, once the app has opened it.
    func connection(_ n: Int) async throws -> Connection {
        while true {
            if let c = lock.withLock({ opened.count > n ? opened[n].connection : nil }) { return c }
            try await Task.sleep(for: .milliseconds(2))
        }
    }
}

/// `metistry console call`'s shape: requests, and no stream.
private struct CallOnlyTransport: ConsoleCallTransport {
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.transport("nothing answers here"))
    }
}

/// A `console session --stdio` child whose console sends a fresh subscriber
/// only its cursor — `{id, event: {id}}`, exactly what the CLI prints for the
/// id-only frame — and then closes the stream.
private final class CursorChild: SessionProcess, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let out: AsyncStream<String>.Continuation
    private let lock = NSLock()
    private var requests: [[String: Any]] = []

    init() {
        (lines, out) = AsyncStream<String>.makeStream()
    }

    var streams: [[String: Any]] { lock.withLock { requests.filter { $0["stream"] as? Bool == true } } }

    func send(_ line: String) throws {
        guard let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let id = request["id"] as? String, request["cancel"] == nil else { return }
        let first: Bool = lock.withLock {
            requests.append(request)
            return requests.count == 1
        }
        guard request["stream"] as? Bool == true else { return }
        if first {
            reply(["id": id, "event": ["id": "1790000000000007"]])
            reply(["id": id, "ended": "closed"])
        }
    }

    private func reply(_ object: [String: Any]) {
        out.yield(String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self))
    }

    func termination() async -> CommandResult {
        for await _ in lines {}
        return CommandResult(exitCode: 0, stdout: "", stderr: "")
    }

    func terminate() { out.finish() }
}
