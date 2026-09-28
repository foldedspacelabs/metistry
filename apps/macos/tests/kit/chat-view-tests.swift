// Chat (T6-2). Built against the recorded fixtures first — `GET /api/messages`,
// `GET /api/commands`, `GET /api/turns/:turn_id/progress` as the console
// serves them — and a scripted console where a fixture cannot say it: a turn
// that works, a reply that arrives while the reader is scrolled up, a console
// that stops answering.
//
// The ticket's two are first: **the viewport never moves on an arriving reply
// (P9)**, and **the dots hold flat under Reduce Motion**. Then the turn, the
// strip and the join it rests on, sending and O3, the tier, the tapbacks, the
// prompt card, the pane, and §2.18. macOS only, as the accessibility probe is.

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

@MainActor
@Test func theViewportNeverMovesOnAnArrivingReply() async throws {
    // The rule, in the model: scrolled up, an arrival is a pill and an
    // announcement — never a scroll, never a new identity for a row on screen.
    let console = ChatConsole(messages: (1...24).flatMap { i in [
        ChatConsole.message(i, .yours, "question \(i)", at: i * 60, status: "done"),
        ChatConsole.message(i, .reply, "answer \(i) — " + String(repeating: "a long line of prose that wraps. ", count: 6), at: i * 60 + 20),
    ] })
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    var heard: [String] = []
    model.announce = { heard.append($0) }
    await model.refresh()
    let firstPaint = model.followRequests
    let before = model.rows(calendar: utcCalendar)

    model.isAtBottom = false
    console.append(ChatConsole.message(25, .reply, "a reply while you read", at: 25 * 60))
    model.transcript.invalidate()
    await model.tick()
    #expect(model.followRequests == firstPaint, "an arrival asked the transcript to move")
    #expect(model.showsNewReplyPill)
    #expect(heard == [ChatSpoken.newReply], "announced once, politely: \(heard)")
    let after = model.rows(calendar: utcCalendar)
    #expect(Array(after.prefix(before.count)) == before, "a row already on screen changed identity or value")
    #expect(ChatArrival.of(newReplies: 1, isAtBottom: false) == .pill)
    #expect(ChatArrival.of(newReplies: 1, isAtBottom: true) == .follow)

    // …and in a window: scrolled to the top, a reply arrives, the view does not move.
    let window = host(ChatView(model: model, assistantName: "Aide", clock: ClockTime(timeZone: utc), calendar: utcCalendar), size: CGSize(width: 900, height: 560))
    defer { window.close() }
    // the first paint lands at the end; wait for it to settle there
    try await waitUntil(seconds: 5) { scrollViews(in: window.contentView!).contains { ($0.documentView?.frame.height ?? 0) > 1000 && $0.contentView.bounds.origin.y > 0 } }
    let scroll = try #require(scrollViews(in: window.contentView!).max { $0.documentView?.frame.height ?? 0 < $1.documentView?.frame.height ?? 0 })
    try await waitUntil(seconds: 5) { model.isAtBottom }
    try await Task.sleep(for: .milliseconds(200))
    // the reader scrolls up to the top
    scroll.contentView.scroll(to: .zero)
    scroll.reflectScrolledClipView(scroll.contentView)
    try await waitUntil(seconds: 5) { !model.isAtBottom }
    try await Task.sleep(for: .milliseconds(200))
    #expect(!model.isAtBottom, "at the top of thirty turns, the reader is not at the bottom")
    #expect(scroll.contentView.bounds.origin.y == 0)
    let origin = scroll.contentView.bounds.origin
    let pillsBefore = model.followRequests

    console.append(ChatConsole.message(26, .reply, "another reply while you read", at: 26 * 60))
    model.transcript.invalidate()
    await model.tick()
    try await Task.sleep(for: .milliseconds(400))
    #expect(scroll.contentView.bounds.origin == origin, "the viewport moved: \(origin) → \(scroll.contentView.bounds.origin)")
    #expect(model.followRequests == pillsBefore)
    #expect(model.showsNewReplyPill)

    // The pill, pressed, is the one thing that scrolls.
    model.jumpToNewReply()
    try await Task.sleep(for: .milliseconds(400))
    #expect(scroll.contentView.bounds.origin.y > origin.y, "the pill did not take the reader to the reply")
}

@Test func theDotsHoldFlatUnderReduceMotion() throws {
    #expect(!ChatDots.isAnimated(reduceMotion: true))
    for t in stride(from: 0.0, through: 3.0, by: 0.1) {
        #expect(ChatDots.opacities(at: t, reduceMotion: true) == [0.5, 0.5, 0.5], "at \(t)s")
    }
    // Without it, the loop moves: 1.45 s, every dot between 0.3 and 1.
    #expect(ChatDots.isAnimated(reduceMotion: false))
    #expect(ChatDots.period == 1.45)
    let frames = stride(from: 0.0, to: 1.45, by: 0.05).map { ChatDots.opacities(at: $0, reduceMotion: false) }
    #expect(Set(frames.map { $0[0] }).count > 5, "the dots did not move")
    #expect(frames.allSatisfy { $0.allSatisfy { (0.3...1.0).contains($0) } })
    for (a, b) in zip(ChatDots.opacities(at: 0.2, reduceMotion: false), ChatDots.opacities(at: 0.2 + 1.45, reduceMotion: false)) {
        #expect(abs(a - b) < 1e-9, "the loop's period is 1.45 s")
    }

    // And the view draws from that answer: no clock at all under Reduce Motion,
    // and nothing else on the screen moves (C16's closed list; P8: nothing
    // animates on arrival).
    let source = try chatSource("chat-view.swift")
    let dots = try #require(source.range(of: "struct WaitingDots: View {"))
    let body = source[dots.lowerBound...].prefix(900)
    #expect(body.contains("if ChatDots.isAnimated(reduceMotion: reduceMotion)"))
    #expect(body.contains("dots(ChatDots.opacities(at: 0, reduceMotion: true))"))
    for file in ["chat-view.swift", "chat-model.swift"] {
        let text = try chatSource(file)
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file) animates something")
        #expect(text.components(separatedBy: "TimelineView(.animation)").count - 1 == (file == "chat-view.swift" ? 1 : 0), "\(file): the dots are the one loop")
    }
}

// MARK: - The transcript, from the recorded fixture

@MainActor
@Test func theRecordedTranscriptReadsInOrderWithEachDirectionItsOwnId() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(console.calls.first?.path == "/api/messages?limit=30", "calls: \(console.calls.map(\.path))")
    // in 1 and out 1 share an id, and in 2 and out 2: a row is its direction and its id
    #expect(model.messages.map(\.id) == ["in:1", "out:1", "in:2", "out:2"])
    #expect(model.messages[1].text == "Three things today: the store interface, the fixture recorder, and a review.")
    #expect(model.messages[2].status == "new")
    #expect(model.routerLastTier == "default", "the tier the router put on the last message")
    // `new` is a turn the assistant has not picked up: working, from its own row
    #expect(model.activities[2]?.state == .working)
    #expect(model.isWorking)
    // one day, then the four turns and what the working one set going
    let rows = model.rows(calendar: utcCalendar)
    #expect(rows.map(\.id) == ["day:2026-09-28", "in:1", "out:1", "in:2", "turn:2", "out:2"], "rows: \(rows.map(\.id))")
    // an `alert` says what it is; a reply does not
    #expect(ChatMarks.attribution(name: "Aide", at: nil, kind: "alert", clock: ClockTime(timeZone: utc)).map(\.text) == ["Aide", "alert"])
    #expect(ChatMarks.attribution(name: "Aide", at: nil, kind: "reply", clock: ClockTime(timeZone: utc)).map(\.text) == ["Aide"])
}

@MainActor
@Test func theRecordedProgressIsTheStripAndAnOutcomeMeansFinished() throws {
    let fixture = try ConsoleFixture.load("get-api-turns-turn_id-progress")
    let progress = TurnProgress(json: try #require(fixture.replyJSON))
    let calls = progress.calls
    #expect(calls.map(\.tool) == ["knowledge_search", "tasks_update"])
    #expect(calls.map(\.durationMs) == [12, 30])
    // the recorder wrote no finished_at, but each row has its outcome: finished
    #expect(calls.allSatisfy { !$0.isRunning })
    let running = try #require(ChatToolCall(json: .object(["id": .string("9"), "tool": .string("knowledge_read"), "started_at": .string("2026-09-27T01:00:00Z"), "finished_at": .null, "ok": .null])))
    #expect(running.isRunning)
}

// MARK: - A turn: which one, joined exactly; the waiting moments; the strip

@MainActor
@Test func aWorkingTurnFindsItsRunByTheMessageItNamesAndNeverByTime() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(7, .yours, "what changed?", at: 0, status: "processing")])
    // two turns running at once: the nearer in time names ANOTHER message
    console.turnRuns = [
        (runID: 41, messageID: 99, turnID: "turn-other"),
        (runID: 40, messageID: 7, turnID: "turn-mine"),
    ]
    console.progress["turn-mine"] = [ChatConsole.call(1, "knowledge_search", ok: true, ms: 120), ChatConsole.call(2, "tasks_list", ok: nil)]
    console.progress["turn-other"] = [ChatConsole.call(3, "never_mine", ok: true, ms: 5)]
    var clock = base
    let (model, session) = chatModel(console, now: { clock })
    defer { withExtendedLifetime(session) {} }

    await model.refresh()
    let activity = try #require(model.activities[7])
    #expect(activity.turnID == "turn-mine", "bound to \(String(describing: activity.turnID))")
    #expect(activity.calls.map(\.tool) == ["knowledge_search", "tasks_list"])
    #expect(!console.paths.contains("/api/turns/turn-other/progress"), "another turn's calls were read for this one")

    // the moments, as the facts arrive
    #expect(ChatWaitingMoment.of(ChatTurnActivity(messageID: 1, startedAt: base, state: .working), now: base.addingTimeInterval(1)) == .dots)
    clock = base.addingTimeInterval(6)
    let bound = try #require(model.activities[7])
    #expect(ChatWaitingMoment.of(bound, now: clock) == .tools(running: "tasks_list", count: 2, elapsed: 6))
    // sixty seconds with nothing new: the count, on degraded-quiet — never "stuck"
    clock = base.addingTimeInterval(62)
    let silent = try #require(ChatWaitingMoment.of(bound, now: clock))
    #expect(silent == .silent(nothingBackFor: 62, count: 2))
    #expect(ChatMarks.waiting(silent).map(\.text) == ["working", "· nothing back for 62s"])
    #expect(ChatMarks.waiting(silent).allSatisfy { $0.on == .degradedQuiet })
    #expect(!ChatActivityView.spoken(silent, name: "Aide").contains("stuck"))

    // past the line the model asks less often; a console that stops answering backs it off further
    #expect(model.inFlightInterval(now: clock) == ChatModel.silentInterval)
    #expect(model.inFlightInterval(now: base.addingTimeInterval(7)) == ChatModel.inFlightInterval)

    // the message says done: the strip, with the turn's own duration and cost
    console.progress["turn-mine"] = [ChatConsole.call(1, "knowledge_search", ok: true, ms: 120), ChatConsole.call(2, "tasks_list", ok: true, ms: 80)]
    console.setStatus(7, "done")
    console.runDone[40] = (ms: 6200, cost: 0.031)
    clock = base.addingTimeInterval(64)
    await model.tick()
    let done = try #require(model.activities[7])
    #expect(done.state == .finished)
    #expect(ChatMarks.strip(done).map(\.text) == ["2 tools · 6.2s · $0.031"])
    #expect(!done.isExpanded, "collapsed by default")
    #expect(ChatSpoken.strip(done) == "2 tools, collapsed")
    #expect(!model.isWorking)
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func aWorkingTurnIsWatchedOffScreenUntilItsMessageSaysDone() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(7, .yours, "what changed?", at: 0, status: "processing")])
    let session = ConsoleSession(transport: console, management: nil)
    let model = ChatModel(session: session, now: { Date() })
    model.announce = { _ in }
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.isWorking, "the sidebar's dot")
    // no view is ticking: the model keeps asking on its own
    console.setStatus(7, "done")
    try await waitUntil(seconds: 10) { !model.isWorking }
    #expect(model.activities[7]?.state == .finished)
}

// 0.14.1 hung the window at 100 % CPU: the screen's clock was the first to
// see a working turn, its tick started the background watch, and the watch's
// first tick found the screen's tick still recorded as in flight — already
// finished, so `await` on it returned without ever suspending, and the loop
// that waited for it never let the main actor run the line that cleared it.
// Each test below is that shape. A regression spins forever, so none of them
// could fail on its own: the watchdog turns a main actor that has not answered
// for 20 s (other suites share it, and hold it for a second or two at most)
// into a crash naming the test, rather than a run that never ends.

@MainActor
@Test(.timeLimit(.minutes(1)))
func aWorkingTurnFirstSeenByTheScreensClockIsWatchedWithoutSpinning() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(7, .yours, "what changed?", at: 0, status: "processing")])
    let session = ConsoleSession(transport: console, management: nil)
    let model = ChatModel(session: session, now: { Date() })
    model.announce = { _ in }
    defer { withExtendedLifetime(session) {} }
    let watchdog = MainActorWatchdog("a working turn first seen by the screen's clock")
    defer { watchdog.stop() }

    // ChatView's clock: the first read, and the turn is working
    await model.tick()
    #expect(model.isWorking, "the sidebar's dot")
    // the watch runs beside the screen's clock, and a tick asks only what is
    // due: a working turn costs a read set per in-flight interval, however
    // many ticks there are
    let asked = console.paths.count
    let started = ContinuousClock.now
    for _ in 0..<6 {
        await model.tick()
        try await Task.sleep(for: .milliseconds(500))
    }
    let seconds = Double((ContinuousClock.now - started).components.seconds) + 1
    let reads = Array(console.paths[asked...])
    let routes = Set(reads.map { String($0.split(separator: "?").first ?? "") }).count
    #expect(reads.count <= (routes + 1) * (Int(seconds / ChatModel.inFlightInterval) + 1), "\(reads.count) reads in \(seconds) s: \(reads)")
    // walking away: the watch alone carries the turn to done
    console.setStatus(7, "done")
    try await waitUntil(seconds: 10) { !model.isWorking }
    #expect(model.activities[7]?.state == .finished)
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func aSendsOwnTickAndTheWatchItStartsTakeTurnsWithoutSpinning() async throws {
    let console = ChatConsole(messages: [])
    let session = ConsoleSession(transport: console, management: nil)
    let model = ChatModel(session: session, now: { Date() })
    model.announce = { _ in }
    defer { withExtendedLifetime(session) {} }
    let watchdog = MainActorWatchdog("a send and the watch it starts")
    defer { watchdog.stop() }
    await model.refresh()

    // the send starts the watch, then ticks itself: two ticks, one after the other
    model.draft = "what changed?"
    await model.send()
    #expect(model.isWorking)
    try await Task.sleep(for: .seconds(2))
    console.setStatus(console.lastInboundID, "done")
    try await waitUntil(seconds: 10) { !model.isWorking }
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func ticksThatPileUpRunOneAfterAnotherAndAllReturn() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(7, .yours, "what changed?", at: 0, status: "processing")])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    let watchdog = MainActorWatchdog("ticks that pile up")
    defer { watchdog.stop() }
    await model.refresh()
    // three callers at once — the screen's clock, a send's read, the watch
    let ticks = (0..<3).map { _ in Task { await model.tick() } }
    for tick in ticks { await tick.value }
    #expect(model.isWorking)
}

@MainActor
@Test func aLiveRunStartedBindsTheTurnWithoutWaitingForTheFeed() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(7, .yours, "what changed?", at: 0, status: "processing")])
    console.turnRuns = [(runID: 40, messageID: 7, turnID: "turn-mine")]
    console.feedIsEmpty = true
    console.progress["turn-mine"] = [ChatConsole.call(1, "knowledge_search", ok: nil)]
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.activities[7]?.turnID == nil, "the feed named no run")
    // the stream says a turn run started: it is read for the message it names
    let started = ConsoleEvent(id: "9", change: .runStarted(runID: 40, kind: "turn", turnID: "turn-mine"))
    #expect(started.change.topics.contains(.working))
    model.apply(started)
    await model.tick()
    #expect(model.activities[7]?.turnID == "turn-mine")
    #expect(model.activities[7]?.runningTool == "knowledge_search")
    // an event for a run that is not a turn is not read at all
    model.apply(ConsoleEvent(id: "10", change: .runStarted(runID: 41, kind: "tool", turnID: "turn-mine")))
    await model.tick()
    #expect(!console.paths.contains("/api/runs/41"))
}

@MainActor
@Test func aFailedCallOpensItsStripAndTheOwnerCanCloseIt() {
    var activity = ChatTurnActivity(messageID: 3, startedAt: base, state: .failed)
    activity.calls = [ChatToolCall(id: 1, tool: "knowledge_read", ok: true, durationMs: 40), ChatToolCall(id: 2, tool: "tasks_update", ok: false, error: "stale sha", durationMs: 12)]
    #expect(activity.isExpanded, "a failure is the one thing the system opens")
    #expect(ChatMarks.strip(activity).map(\.text).last == "failed")
    #expect(ChatMarks.call(activity.calls[1]).map(\.text) == ["tasks_update", "12ms", "failed", "stale sha"])
    activity.expandedByOwner = false
    #expect(!activity.isExpanded)
    // a turn that finished having called nothing leaves nothing behind
    #expect(!ChatTurnActivity(messageID: 4, startedAt: base, state: .finished).isShown)
}

// MARK: - Sending, and O3

@MainActor
@Test func theTurnIsOnScreenBeforeTheRequestLeavesAndBecomesItsRowWithoutChangingIdentity() async throws {
    let console = ChatConsole(messages: [])
    console.holdSend = true
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.isEmpty)

    model.draft = "  where is the compute budget this month?  "
    let sending = Task { await model.send() }
    try await waitUntil { console.isHoldingSend }
    #expect(model.draft.isEmpty, "the words moved into the turn")
    let local = try #require(model.localTurns.first)
    #expect(local.state == .sending)
    #expect(local.text == "where is the compute budget this month?")
    let localID = "local:\(local.id.uuidString)"
    #expect(model.rows(calendar: utcCalendar).contains { $0.id == localID }, "not on screen before the request left")
    #expect(model.isWorking)

    console.releaseSend()
    await sending.value
    let sent = try #require(console.sent.last)
    #expect(sent.path == "/message")
    #expect(sent.body?["text"]?.stringValue == "where is the compute budget this month?")
    #expect(sent.body?["tier"] == nil, "no tier unless one is pinned")
    // the console's row for it is drawn under the same identity
    #expect(model.localTurns.isEmpty)
    #expect(model.rows(calendar: utcCalendar).contains { $0.id == localID }, "the row the owner watched appear was replaced")
    #expect(model.activities[console.lastInboundID]?.state == .working)
}

@MainActor
@Test func aHeldTurnShowsAsWaitingOnTheProviderNotAsNothing() async throws {
    // `held`: the provider refused the account and the turn waits, unsent, on a Needs You report
    #expect(ChatTurnState(inboundStatus: "held") == .held)
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "what's on today?", at: 0, status: "held")])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let activity = try #require(model.activities[1], "a held turn is drawn, not dropped")
    #expect(activity.state == .held)
    #expect(activity.isShown)
    #expect(!model.isWorking, "nothing is running: no dots, no polling for tools")
    #expect(ChatWaitingMoment.of(activity, now: base.addingTimeInterval(90)) == nil)
    #expect(ChatMarks.held().map(\.text) == ["waiting on the provider", "· see Needs You"])
    #expect(model.rows(calendar: utcCalendar).map(\.id).contains("turn:1"))
    // released and answered: the same turn settles like any other
    console.setStatus(1, "done")
    await model.refresh()
    #expect(model.activities[1]?.state == .finished)
}

@MainActor
@Test func sendingWhileUnreachableIsOffWithTheGatesSentenceAndARefusalKeepsTheWords() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "hello", at: 0, status: "done")])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.allowsSending)

    // a message goes out and does not come back: Not sent, the words kept, Retry
    console.down = "connect ECONNREFUSED 127.0.0.1:1"
    model.draft = "are you there?"
    await model.send()
    let turn = try #require(model.localTurns.first)
    guard case .notSent(let reason, let held) = turn.state else { Issue.record("state: \(turn.state)"); return }
    #expect(!held)
    #expect(reason.contains("ECONNREFUSED"))
    #expect(ChatMarks.notSent(reason, held: held).ink == .failed)

    // the console said unreachable: Send is off, and says why — the gate's own sentence
    #expect(!model.allowsSending)
    #expect(model.sendingUnavailableReason == StateWords.unreachable)
    model.draft = "one more"
    let sentBefore = console.sent.count
    await model.send()
    #expect(console.sent.count == sentBefore, "a message was sent while unreachable")
    #expect(model.draft == "one more", "the draft stays")
    // a rating is an append, and is still sent (O3)
    #expect(ConsoleAct.of("POST", "/api/messages/1/feedback") == .append)
    #expect(ConsoleAct.of("POST", "/message") == .decision)

    // back: Retry sends the turn exactly as it was written
    console.down = nil
    await model.refresh()
    #expect(model.allowsSending)
    await model.retry(turn.id)
    #expect(console.sent.last?.body?["text"]?.stringValue == "are you there?")
    #expect(model.localTurns.allSatisfy { if case .notSent = $0.state { return false }; return true })
}

@MainActor
@Test func upInAnEmptyComposerTakesBackATurnNotSentAndCopiesOneThatWas() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "the last thing I asked", at: 0, status: "done")])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    #expect(model.recallLast())
    #expect(model.draft == "the last thing I asked")
    #expect(!model.recallLast(), "never over words already typed")
}

// MARK: - The tier (§3c)

@MainActor
@Test func theTiersAreTheOnesTheCommandsNameAndAPinIsForATurnOrTheConversation() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let tiers = model.tiers
    #expect(tiers.map(\.name) == ["deep", "default"], "from the recorded GET /api/commands: \(tiers.map(\.name))")
    #expect(ChatTierMenu.row(tiers[0]) == "deep — opus · high")
    #expect(ChatMarks.tierChip(pin: nil, tiers: tiers, routerLast: "default").text == "auto · default")
    #expect(ChatMarks.tierChip(pin: nil, tiers: tiers, routerLast: "default").ink == .textSecondary)

    let scripted = ChatConsole(messages: [])
    let (chat, chatSession) = chatModel(scripted)
    defer { withExtendedLifetime(chatSession) {} }
    await chat.refresh()
    chat.pinTier("deep", scope: .turn)
    let pinned = ChatMarks.tierChip(pin: chat.pin, tiers: tiers, routerLast: nil)
    #expect(pinned.text == "deep · high")
    #expect(pinned.ink == .accent)
    chat.draft = "think hard"
    await chat.send()
    #expect(scripted.sent.last?.body?["tier"]?.stringValue == "deep")
    #expect(chat.pin == nil, "a pin for this turn is spent by the turn")

    chat.pinTier("deep", scope: .conversation)
    chat.draft = "and again"
    await chat.send()
    #expect(scripted.sent.last?.body?["tier"]?.stringValue == "deep")
    #expect(chat.pin?.tier == "deep", "a pin for the conversation stays")
    // ⇧⌘N: New Conversation puts the tier back in the router's hands
    chat.newConversation()
    #expect(chat.pin == nil)
    chat.draft = "plain"
    await chat.send()
    #expect(scripted.sent.last?.body?["tier"] == nil)
}

// MARK: - Tapbacks (P8)

@MainActor
@Test func aRatingIsSentClearedAndGoesBackWhenRefused() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "q", at: 0, status: "done"), ChatConsole.message(1, .reply, "a", at: 10)])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let reply = try #require(model.messages.first { $0.direction == .reply })

    await model.rate(reply, .down, note: "  guessed instead of looking  ")
    let post = try #require(console.sent.last)
    #expect(post.method == "POST" && post.path == "/api/messages/1/feedback")
    #expect(post.body?["rating"]?.intValue == -1)
    #expect(post.body?["note"]?.stringValue == "guessed instead of looking")
    #expect(model.rating(of: reply) == .down)

    await model.rate(reply, nil)
    #expect(console.sent.last?.method == "DELETE")
    #expect(model.rating(of: reply) == nil)

    console.refuseFeedback = true
    await model.rate(reply, .up)
    #expect(model.rating(of: reply) == nil, "a refused rating went back to what it was")
    #expect(model.ratingProblem?.messageID == 1)
    // the owner's own turn has no rating to give
    let mine = try #require(model.messages.first { $0.direction == .yours })
    let before = console.sent.count
    await model.rate(mine, .up)
    #expect(console.sent.count == before)
}

// MARK: - The prompt card (§3.5)

@MainActor
@Test func aReplyCarriesTheQuestionItEndedWithAndOnlyThatOne() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "file it?", at: 0, status: "done"), ChatConsole.message(3, .reply, "Where should it land?", at: 10), ChatConsole.message(4, .reply, "noted", at: 20)])
    console.proposals = [ChatConsole.question(id: 12, messageID: 3)]
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let asked = try #require(model.messages.first { $0.messageID == 3 })
    let other = try #require(model.messages.first { $0.messageID == 4 })
    let card = try #require(model.promptCard(for: asked, assistantName: "Aide"))
    #expect(card.row.id == 12)
    #expect(model.promptCard(for: other, assistantName: "Aide") == nil)
    #expect(model.promptCard(for: asked, assistantName: nil) == nil, "no name, no card — it would print none")
    // answered elsewhere: it leaves the queue, and the card leaves the reply
    console.proposals = []
    model.requests.invalidate()
    await model.tick()
    #expect(model.promptCard(for: asked, assistantName: "Aide") == nil)
}

// MARK: - Page references and the pane (§3a, §3b)

@Test func aReplysWikilinksAreItsPageChips() {
    let refs = ChatPageReference.all(in: "See [[Projects/Metistry/Design]] and [[Ada|Ada Lovelace]], again [[Projects/Metistry/Design#Goals]], [[Journal/2026-09-27.md]], not [[../secrets]] or [[]].")
    #expect(refs.map(\.path) == ["Projects/Metistry/Design.md", "Ada.md", "Journal/2026-09-27.md"])
    #expect(refs.map(\.name) == ["Design", "Ada Lovelace", "2026-09-27.md"])
}

@MainActor
@Test func aChipOpensItsPageFromTheConsoleAndAMissingOneSaysWhy() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    let ref = try #require(ChatPageReference.all(in: "[[Projects/Metistry/Roadmap]]").first)
    await model.open(ref)
    guard case .loaded(let page) = model.preview?.state else { Issue.record("state: \(String(describing: model.preview?.state))"); return }
    #expect(page.content.hasPrefix("# Roadmap"))
    #expect(console.calls.last?.path == "/api/knowledge/page?path=Projects%2FMetistry%2FRoadmap.md")
    model.closePreview()
    #expect(model.preview == nil)

    // the column keeps its width and only moves: beside when it fits, a sheet when not
    #expect(ChatLayout.paneFitsBeside(available: 1200, size: .large))
    #expect(!ChatLayout.paneFitsBeside(available: 900, size: .large))
    #expect(ChatLayout.column(available: 1200 - ChatLayout.paneWidth, size: .large) == ChatLayout.column(available: 1200, size: .large))
}

// MARK: - §2.18

@MainActor
@Test func theScreenSpeaksEveryControlAndTheSpokenRowsVerbatim() async throws {
    let console = ChatConsole(messages: [
        ChatConsole.message(1, .yours, "Where is the compute budget this month?", at: 9 * 3600 + 14 * 60, status: "done"),
        ChatConsole.message(1, .reply, "The compute budget is at 68 percent with eleven days left. See [[Areas/Compute]].", at: 9 * 3600 + 15 * 60),
        ChatConsole.message(2, .yours, "and tomorrow?", at: 9 * 3600 + 16 * 60, status: "processing"),
    ])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    model.pinTier("deep", scope: .conversation)
    let tree = try await AccessibilityProbe.snapshot(ChatView(model: model, assistantName: "Aide", clock: ClockTime(timeZone: utc), calendar: utcCalendar).frame(width: 980, height: 720))
    defer { tree.close() }
    #expect(tree.unlabeledControls.filter { $0.role != "AXTextField" && $0.role != "AXTextArea" }.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty, "says assistant: \(tree.saysAssistant)")
    let said = tree.labels + tree.texts
    #expect(said.contains("your turn, 9:14 AM. Where is the compute budget this month?"), "said: \(said)")
    #expect(said.contains("from Aide: The compute budget is at 68 percent with eleven days left. See [[Areas/Compute]]."), "said: \(said)")
    #expect(said.contains("Aide is working"), "said: \(said)")
    let controls = tree.controlNames
    #expect(controls.contains("Good") && controls.contains("Bad"), "controls: \(controls)")
    #expect(controls.contains("Send, Command-Return"), "controls: \(controls)")
    #expect(controls.contains("Stop"), "controls: \(controls)")
    #expect(controls.contains("Page, Compute, Areas/Compute.md"), "controls: \(controls)")
    #expect(controls.contains { $0.hasPrefix("Tier, pinned to deep") }, "controls: \(controls) nodes: \(tree.nodes.filter { $0.name.contains("deep") || $0.role.contains("Menu") })")
    #expect(said.contains(ChatModel.stopUnavailable), "Stop says why it is off: \(said)")
}

@MainActor
@Test func theTierPickerSpeaksEachTierAndSaysTheRouterDecidesFirst() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    model.pinTier("deep", scope: .conversation)
    let tree = try await AccessibilityProbe.snapshot(ChatTierPicker(model: model) {})
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.saysAssistant.isEmpty, "says assistant: \(tree.saysAssistant)")
    let said = tree.labels + tree.texts
    #expect(said.first { $0.hasPrefix("The router picked default") } != nil, "the router's choice comes first: \(said)")
    let controls = tree.controlNames
    #expect(controls.contains("deep, opus, high effort") && controls.contains("default, haiku, medium effort"), "controls: \(controls)")
    #expect(controls.contains("Reset to the Router's Choice"), "controls: \(controls)")
    #expect(tree.nodes.contains { $0.label == "deep, opus, high effort" && $0.value == "chosen" }, "the pinned tier is marked: \(tree.nodes.filter { $0.label.hasPrefix("deep") })")
    #expect(!tree.nodes.contains { $0.label.hasPrefix("default") && $0.value == "chosen" })
    for scheme in [ColorScheme.light, .dark] {
        for (ink, ground) in [(MetistryColorRole.accent, MetistryColorRole.elevated), (.textPrimary, .elevated), (.textSecondary, .elevated), (.textPrimary, .sunken), (.textSecondary, .sunken)] {
            #expect(Contrast.ratio(ink, ground, scheme) >= 4.5, "\(ink.rawValue) on \(ground.rawValue) in \(scheme)")
        }
    }
}

@MainActor
@Test func thePreviewPaneNamesThePageAndItsWayOut() async throws {
    let page = try JSONDecoder().decode(KnowledgePage.self, from: try #require(ConsoleFixture.load("get-api-knowledge-page").reply))
    let reference = try #require(ChatPageReference.all(in: "[[Projects/Metistry/Roadmap]]").first)
    let tree = try await AccessibilityProbe.snapshot(ChatPreviewPane(preview: ChatPreview(reference: reference, state: .loaded(page)), clock: ClockTime(timeZone: utc)) {}.frame(width: 400, height: 400))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    #expect(tree.controlNames.contains("Close Preview, Esc"), "controls: \(tree.controlNames)")
    #expect((tree.labels + tree.texts).contains("Roadmap"), "said: \(tree.labels + tree.texts)")
    #expect((tree.labels + tree.texts).contains("Projects/Metistry/Roadmap.md"))
}

@MainActor
@Test func thePillSaysNewReplyAvailable() async throws {
    let tree = try await AccessibilityProbe.snapshot(NewReplyPill {}.padding())
    defer { tree.close() }
    #expect(tree.controlNames == [ChatSpoken.newReply], "controls: \(tree.controlNames)")
}

@MainActor
@Test func theSidebarsChatRowCarriesADotWhileATurnWorksAndNoCount() async throws {
    let name = "com.foldedspacelabs.metistry.tests.chat-shell.\(UUID().uuidString)"
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: name)!)
    model.shell.adopt(stores: ConsoleStores(transport: try FixtureConsole.recorded()))
    await model.shell.refresh()
    let tree = try await AccessibilityProbe.snapshot(ShellSidebar(shell: model.shell, chatIsWorking: true).frame(width: 260, height: 480))
    defer { tree.close() }
    #expect(tree.sidebarRows.contains("Chat, Aide is working"), "sidebar: \(tree.sidebarRows)")
    #expect(!tree.sidebarRows.contains { $0.hasPrefix("Chat") && $0.contains(where: \.isNumber) }, "presence, not a badge")
}

@MainActor
@Test func everyRowGrowsLongerNeverWiderAtTheLargestText() async throws {
    let console = ChatConsole(messages: [
        ChatConsole.message(1, .yours, "Where is the compute budget this month, and what is left for the rest of it?", at: 0, status: "done"),
        ChatConsole.message(1, .reply, String(repeating: "The compute budget is at 68 percent with eleven days left. ", count: 4), at: 30),
    ])
    let (model, session) = chatModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.refresh()
    let rows = model.rows(calendar: utcCalendar)
    var activity = ChatTurnActivity(messageID: 1, startedAt: base, state: .finished)
    activity.calls = [ChatToolCall(id: 1, tool: "knowledge_search_with_a_long_name", ok: false, error: "the embedder is down and the keyword index is stale", durationMs: 1200)]
    let width: CGFloat = 480
    let pieces: [(String, AnyView)] = [
        ("yours", AnyView(ChatRowView(row: rows[1], model: model, assistantName: "Aide", clock: ClockTime(timeZone: utc), calendar: utcCalendar))),
        ("reply", AnyView(ChatRowView(row: rows[2], model: model, assistantName: "Aide", clock: ClockTime(timeZone: utc), calendar: utcCalendar))),
        ("strip", AnyView(ChatToolStrip(activity: activity, model: model))),
        ("composer", AnyView(ChatComposerHost(model: model))),
    ]
    for (name, view) in pieces {
        var heights: [DynamicTypeSize: CGFloat] = [:]
        for size in [DynamicTypeSize.large, .accessibility5] {
            let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, size))
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 1
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(CGFloat(image.width) <= width, "\(name) is \(image.width) wide at \(size), offered \(width)")
            heights[size] = CGFloat(image.height)
        }
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text")
    }
    // the measure grows with the text, until the pane caps it
    #expect(ChatLayout.column(available: 3000, size: .accessibility5) > ChatLayout.column(available: 3000, size: .large))
    #expect(ChatLayout.column(available: 700, size: .accessibility5) <= 700)
}

@Test func everyInkOnTheScreenClearsItsGroundInBothSchemes() {
    var activity = ChatTurnActivity(messageID: 1, startedAt: base, state: .failed)
    activity.calls = [ChatToolCall(id: 1, tool: "knowledge_read", ok: true, durationMs: 40), ChatToolCall(id: 2, tool: "tasks_update", ok: false, error: "stale", durationMs: 1200)]
    activity.durationMs = 6200
    activity.costUSD = 0.031
    let clock = ClockTime(timeZone: utc)
    var marks: [Mark] = []
    marks += ChatMarks.yours(at: base, clock: clock) + [ChatMarks.yoursBody("hi"), ChatMarks.replyBody("hello")]
    marks += [ChatMarks.notSent("gone", held: false), ChatMarks.notSent("gone", held: true)]
    marks += ChatMarks.attribution(name: "Aide", at: base, kind: "alert", clock: clock)
    marks += ChatMarks.waiting(.dots) + ChatMarks.waiting(.tools(running: "knowledge_search", count: 2, elapsed: 6)) + ChatMarks.waiting(.tools(running: nil, count: 2, elapsed: 6)) + ChatMarks.waiting(.silent(nothingBackFor: 62, count: 2))
    marks += ChatMarks.strip(activity) + activity.calls.flatMap(ChatMarks.call)
    marks += ChatMarks.chip(ChatPageReference.all(in: "[[Areas/Compute]]")[0])
    marks += [ChatMarks.tierChip(pin: nil, tiers: [], routerLast: "fast"), ChatMarks.tierChip(pin: ChatPin(tier: "deep", scope: .turn), tiers: [], routerLast: nil), ChatMarks.pinnedLine(ChatPin(tier: "deep", scope: .conversation))]
    for mark in marks {
        for scheme in [ColorScheme.light, .dark] {
            let floor = mark.text.isEmpty ? 3.0 : 4.5
            let ratio = Contrast.ratio(mark.ink, mark.ground, scheme)
            #expect(ratio >= floor, "\(mark.ink.rawValue) on \(mark.ground.rawValue) is \(ratio) in \(scheme) — \(mark.text)")
        }
    }
    // the rule and the dots are `agent`, a mark against the transcript's ground (3:1)
    for scheme in [ColorScheme.light, .dark] {
        #expect(Contrast.ratio(.agent, .bg, scheme) >= 3)
        #expect(Contrast.ratio(.onAccent, .accent, scheme) >= 4.5, "the pill")
    }
}

@Test func noStringOnTheScreenSaysAssistantOrNamesOne() throws {
    for file in ["chat-view.swift", "chat-model.swift"] {
        let text = try chatSource(file)
        var literals: [String] = []
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
            let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
        #expect(literals.count > 20, "the scan found almost nothing in \(file)")
        for literal in literals {
            #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\(file): \"\(literal)\"")
            #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file): \"\(literal)\"")
        }
    }
}

@MainActor
@Test func anInstanceSwitchDropsTheTranscriptThePinAndThePane() async throws {
    let console = ChatConsole(messages: [ChatConsole.message(1, .yours, "q", at: 0, status: "processing")])
    let session = ConsoleSession(transport: console, management: nil)
    let model = ChatModel(session: session, now: { base })
    model.announce = { _ in }
    model.watchesInBackground = false
    await model.refresh()
    model.pinTier("deep", scope: .conversation)
    #expect(!model.messages.isEmpty && model.isWorking)
    session.adopt(transport: ChatConsole(messages: []), management: nil)
    #expect(model.messages.isEmpty && model.activities.isEmpty && model.pin == nil && !model.isWorking)
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
private let utcCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = utc
    return c
}()
/// 2026-09-27T00:00:00Z — the scripted console's day.
private let base = WireTime.date("2026-09-27T00:00:00Z")!

@MainActor
private func chatModel(_ console: any ConsoleCallTransport, now: @escaping @MainActor () -> Date = { base }) -> (ChatModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    let model = ChatModel(session: session, now: now)
    model.announce = { _ in }
    model.watchesInBackground = false
    return (model, session)
}

private func chatSource(_ file: String) throws -> String {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources/kit/\(file)")
    return try String(contentsOf: url, encoding: .utf8)
}

/// The composer with a focus binding of its own, for rendering alone.
private struct ChatComposerHost: View {
    let model: ChatModel
    @FocusState private var focused: Bool
    var body: some View { ChatComposer(model: model, assistantName: "Aide", focused: $focused) }
}

@MainActor
private func host<V: View>(_ view: V, size: CGSize) -> NSWindow {
    AccessibilityProbe.enable()
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
    window.orderFront(nil)
    return window
}

@MainActor
private func scrollViews(in view: NSView) -> [NSScrollView] {
    ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews)
}

@MainActor
private func waitUntil(seconds: Double = 2, _ condition: @escaping () -> Bool) async throws {
    for _ in 0..<Int(seconds * 100) {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out waiting")
}

/// Watches the main actor from a thread of its own. A main actor that has not
/// answered for `limit` is spinning, and the process stops there, naming the
/// test, rather than hanging the run — nothing on the main actor could report it.
private final class MainActorWatchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var lastBeat = ContinuousClock.now
    private var running = true

    @MainActor
    init(_ what: String, limit: Duration = .seconds(20)) {
        Task { @MainActor [weak self] in
            while let self, self.isRunning {
                self.beat()
                try? await Task.sleep(for: .milliseconds(20))
            }
        }
        let thread = Thread { [weak self] in
            while let self, self.isRunning {
                let stalled = self.sinceLastBeat
                if stalled > limit { fatalError("the main actor stalled for \(stalled) — \(what)") }
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        thread.start()
    }

    func stop() { lock.withLock { running = false } }

    private var isRunning: Bool { lock.withLock { running } }
    private var sinceLastBeat: Duration { lock.withLock { ContinuousClock.now - lastBeat } }
    private func beat() { lock.withLock { lastBeat = ContinuousClock.now } }
}

/// A console with a thread it holds: it answers the reads Chat makes, accepts
/// a message the way the route does (durable, then `202`), can hold a send in
/// flight, and can stop answering.
private final class ChatConsole: ConsoleCallTransport, @unchecked Sendable {
    struct Sent: Sendable {
        let method: String
        let path: String
        let body: JSONValue?
    }

    private let lock = NSLock()
    private var _messages: [JSONValue]
    private var _sent: [Sent] = []
    private var _paths: [String] = []
    private var _down: String?
    private var _holdSend = false
    private var _held: CheckedContinuation<Void, Never>?
    private var _turnRuns: [(runID: Int, messageID: Int, turnID: String)] = []
    private var _progress: [String: [JSONValue]] = [:]
    private var _runDone: [Int: (ms: Int, cost: Double)] = [:]
    private var _proposals: [JSONValue] = []
    private var _refuseFeedback = false
    private var _feedIsEmpty = false
    private var _nextInbound = 100

    init(messages: [JSONValue]) { _messages = messages }

    var sent: [Sent] { lock.withLock { _sent } }
    var paths: [String] { lock.withLock { _paths } }
    var down: String? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var holdSend: Bool { get { lock.withLock { _holdSend } } set { lock.withLock { _holdSend = newValue } } }
    var isHoldingSend: Bool { lock.withLock { _held != nil } }
    var turnRuns: [(runID: Int, messageID: Int, turnID: String)] { get { lock.withLock { _turnRuns } } set { lock.withLock { _turnRuns = newValue } } }
    var progress: [String: [JSONValue]] { get { lock.withLock { _progress } } set { lock.withLock { _progress = newValue } } }
    var runDone: [Int: (ms: Int, cost: Double)] { get { lock.withLock { _runDone } } set { lock.withLock { _runDone = newValue } } }
    var proposals: [JSONValue] { get { lock.withLock { _proposals } } set { lock.withLock { _proposals = newValue } } }
    var refuseFeedback: Bool { get { lock.withLock { _refuseFeedback } } set { lock.withLock { _refuseFeedback = newValue } } }
    /// Set: the feed names no runs, so only an event can say which run is which.
    var feedIsEmpty: Bool { get { lock.withLock { _feedIsEmpty } } set { lock.withLock { _feedIsEmpty = newValue } } }
    var lastInboundID: Int { lock.withLock { _nextInbound - 1 } }

    func append(_ message: JSONValue) { lock.withLock { _messages.append(message) } }

    func setStatus(_ id: Int, _ status: String) {
        lock.withLock {
            _messages = _messages.map { m in
                guard m["direction"]?.stringValue == "in", m["id"]?.stringValue == String(id), case .object(var o) = m else { return m }
                o["status"] = .string(status)
                return .object(o)
            }
        }
    }

    func releaseSend() {
        lock.withLock {
            _holdSend = false
            _held?.resume()
            _held = nil
        }
    }

    static func message(_ id: Int, _ direction: ChatMessage.Direction, _ text: String, at seconds: Int, status: String? = nil, tier: String? = nil) -> JSONValue {
        let ts = base.addingTimeInterval(TimeInterval(seconds))
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return .object([
            "id": .string(String(id)), "ts": .string(f.string(from: ts)), "thread": .string("default"), "text": .string(text),
            "status": .string(status ?? (direction == .yours ? "done" : "reply")), "direction": .string(direction.rawValue),
            "feedback": .null, "tier": tier.map(JSONValue.string) ?? .null, "cursor": .string("c\(seconds)"),
        ])
    }

    static func call(_ id: Int, _ tool: String, ok: Bool?, ms: Int? = nil) -> JSONValue {
        .object([
            "id": .string(String(id)), "tool": .string(tool), "started_at": .string("2026-09-27T00:00:01Z"),
            "finished_at": ok == nil ? .null : .string("2026-09-27T00:00:02Z"), "ok": ok.map(JSONValue.bool) ?? .null,
            "error": .null, "duration_ms": ms.map { .number(Double($0)) } ?? .null,
        ])
    }

    static func question(id: Int, messageID: Int) -> JSONValue {
        .object([
            "id": .string(String(id)), "ts": .string("2026-09-27T00:00:30Z"), "kind": .string("decision"), "source_agent": .string("assistant"), "trust": .string("internal"),
            "payload": .object(["title": .string("Where should it land?"), "message_id": .number(Double(messageID)), "thread": .string("default"), "options": .array([.string("main"), .string("a branch")])]),
            "decision": .string("pending"), "decided_at": .null, "work_id": .null, "snoozed_until": .null,
            "request": .object([
                "type": .string("question"), "word": .string("question"), "body": .string("choices"), "grouped": .bool(false),
                "primary": .object(["label": .string("Send Answers"), "sends": .object(["decision": .string("answers")])]),
                "decline": .object(["label": .string("Decline"), "sends": .object(["decision": .string("deny")])]),
                "decisions": .array([.string("answers"), .string("deny")]),
                "questions": .array([.object(["prompt": .string("Where should it land?"), "options": .array([.string("main"), .string("a branch")]), "multi": .bool(false), "allow_other": .bool(true)])]),
            ]),
        ])
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sentBody = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let route = "\(method) \(path.split(separator: "?").first ?? "")"
        let shouldHold: Bool = lock.withLock {
            _paths.append(path)
            if method != "GET" { _sent.append(Sent(method: method, path: path, body: sentBody)) }
            return route == "POST /message" && _holdSend && _down == nil
        }
        if shouldHold {
            await withCheckedContinuation { continuation in lock.withLock { _held = continuation } }
        }
        return lock.withLock { () -> Result<Data, ConsoleError> in
            if let down = _down { return .failure(.transport(down)) }
            switch route {
            case "GET /api/messages":
                let newestFirst = _messages.sorted { ($0["ts"]?.stringValue ?? "") > ($1["ts"]?.stringValue ?? "") }
                return .success(encode(["messages": .array(Array(newestFirst.prefix(30))), "cursor": .string("c"), "more": .bool(false)]))
            case "POST /message":
                let id = _nextInbound
                _nextInbound += 1
                let text = sentBody?["text"]?.stringValue ?? ""
                _messages.append(Self.message(id, .yours, text, at: 3600 + id, status: "new"))
                return .success(encode(["message_id": .string(String(id))]))
            case "GET /api/q/activity_feed":
                let rows: [JSONValue] = (_feedIsEmpty ? [] : _turnRuns).map { .object(["ts": .string("2026-09-27T00:00:00Z"), "kind": .string("turn"), "group": .string("run"), "actor": .string("assistant"), "subject": .string("turn"), "detail": .string("turn"), "ref": .string("runs:\($0.runID)"), "turn_id": .string($0.turnID), "ok": .null]) }
                return .success(encode(["rows": .array(rows), "as_of": .string("2026-09-27T00:00:00Z")]))
            case "GET /api/commands":
                return .success(encode(["commands": .array([]), "agents": .array([]), "as_of": .string("2026-09-27T00:00:00Z")]))
            case "GET /api/proposals":
                return .success(encode(["proposals": .array(_proposals), "cursor": .string("c"), "more": .bool(false)]))
            default:
                break
            }
            if method == "GET", path.hasPrefix("/api/runs/"), let runID = Int(path.dropFirst("/api/runs/".count)), let run = _turnRuns.first(where: { $0.runID == runID }) {
                let done = _runDone[runID]
                return .success(encode(["run": .object([
                    "id": .string(String(runID)), "kind": .string("turn"), "component": .string("assistant"),
                    "meta": .object(["message_id": .string(String(run.messageID)), "turn_id": .string(run.turnID)]),
                    "finished_at": done == nil ? .null : .string("2026-09-27T00:01:00Z"), "ok": done == nil ? .null : .bool(true),
                    "duration_ms": done.map { .number(Double($0.ms)) } ?? .null, "cost_usd": done.map { .string(String($0.cost)) } ?? .null,
                    "tool_calls": .array([]), "tool_calls_total": .number(0), "tool_calls_failed": .number(0),
                ]), "as_of": .string("2026-09-27T00:00:00Z")]))
            }
            if method == "GET", path.hasPrefix("/api/turns/"), path.hasSuffix("/progress") {
                let turnID = String(path.dropFirst("/api/turns/".count).dropLast("/progress".count))
                return .success(encode(["turn_id": .string(turnID), "calls": .array(_progress[turnID] ?? []), "as_of": .string("2026-09-27T00:00:00Z")]))
            }
            if path.hasPrefix("/api/messages/"), path.hasSuffix("/feedback") {
                if _refuseFeedback { return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "the message is not an outbound reply"))) }
                if method == "DELETE" { return .success(encode(["ok": .bool(true), "feedback": .null])) }
                return .success(encode(["ok": .bool(true), "feedback": .object(["rating": sentBody?["rating"] ?? .null, "note": sentBody?["note"] ?? .null, "ts": .string("2026-09-27T00:00:00Z")])]))
            }
            return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no script for \(route)")))
        }
    }

    private func encode(_ object: [String: JSONValue]) -> Data {
        (try? JSONEncoder().encode(JSONValue.object(object))) ?? Data()
    }
}
#endif
