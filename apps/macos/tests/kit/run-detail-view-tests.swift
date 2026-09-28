// Run detail (T6-10). Built against the recorded fixtures first — the run, the
// archived session, the queue — and a scripted console where a fixture cannot
// say it (an expired session, a failed call, a fold request naming this
// session).
//
// The ticket's bold test is the first: **an expired session still shows cost
// and tool calls.** Then the recorded run, the conversation's order, what was
// taken, the shell's way in and out, and §2.18. macOS only, as the
// accessibility probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's test

@MainActor
@Test func anExpiredSessionStillShowsCostAndToolCalls() async throws {
    let console = RunConsole()
    console.run = runJSON(ts: now.addingTimeInterval(-40 * 86_400))
    console.sessionGone = true
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(7, over: .activity)
    await model.load()

    #expect(model.conversation == .gone(expired: true), "\(model.conversation)")
    let run = try #require(model.detail)
    // The ledger's, not the archive's: every one of these outlives the transcript.
    let facts = RunDetailWords.facts(run)
    #expect(facts.contains(RunFact(label: "Cost", value: "2.1¢")), "\(facts)")
    #expect(facts.contains(RunFact(label: "Model", value: "sonnet · anthropic")), "\(facts)")
    #expect(facts.contains(RunFact(label: "Cache", value: "71% from cache")), "\(facts)")
    #expect(RunToolLine.lines(run.toolCalls).map(\.tool) == ["calendar_events", "knowledge_read", "work_list"])
    // The session was asked for exactly its turn.
    #expect(console.calls.contains { $0.path == "/api/sessions/\(sessionID)?turn_id=turn-7" }, "\(console.calls.map(\.path))")

    let tree = try await AccessibilityProbe.snapshot(runView(model).frame(width: 1100, height: 1200))
    defer { tree.close() }
    let said = tree.labels + tree.texts
    #expect(said.contains { $0.contains(RunDetailWords.expired) }, "components-03 §2's row: \(said)")
    #expect(said.contains("Cost, 2.1¢"), "\(said)")
    #expect(said.contains("Tokens, 18.4k in · 120 out"), "\(said)")
    #expect(said.contains("calendar_events, 400 milliseconds"), "\(said)")
    #expect(said.contains { $0.hasPrefix("knowledge_read, 200 milliseconds, failed") }, "\(said)")
    #expect(tree.headings.contains("Tool Calls · 3"), "\(tree.headings)")
    #expect(!said.contains { $0.contains("Couldn't") }, "an expired transcript is not the failed state: \(said)")
}

@MainActor
@Test func aSessionGoneWithinThirtyDaysSaysPurgedNotExpired() async throws {
    let console = RunConsole()
    console.run = runJSON(ts: now.addingTimeInterval(-2 * 86_400))
    console.sessionGone = true
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(7, over: .activity)
    await model.load()
    #expect(model.conversation == .gone(expired: false))
    #expect(RunDetailWords.facts(try #require(model.detail)).contains { $0.label == "Cost" })
}

// MARK: - The recorded run

@MainActor
@Test func theRecordedRunNamesNoSessionAndSaysSoWithItsFacts() async throws {
    let console = try FixtureConsole.recorded()
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(1, over: .activity)
    await model.load()
    let run = try #require(model.detail)
    // The recording's turn carries a turn_id and no session_id: nothing to ask the archive.
    #expect(model.conversation == .notKept)
    #expect(model.taken == nil)
    #expect(RunDetailWords.facts(run) == [
        RunFact(label: "Model", value: "gemma · lmstudio"),
        RunFact(label: "Tier", value: "default"),
        RunFact(label: "Time", value: "2.3s"),
        RunFact(label: "Tokens", value: "900 in · 120 out"),
        RunFact(label: "Cost", value: "0.4¢"),
    ])
    let lines = RunToolLine.lines(run.toolCalls)
    #expect(lines.map(\.tool) == ["knowledge_search", "tasks_update"])
    #expect(lines.map(\.duration) == ["12ms", "30ms"])
    #expect(lines.last?.fraction == 1)
    #expect(RunDetailWords.title(run, assistantName: "Aide") == "Aide", "the configured name, never the component's word")
    #expect(RunPill(run.ok).text == "ran clean")
    // One read path: the run, and nothing it does not name.
    #expect(console.calls.map(\.path) == ["/api/runs/1"])
}

@Test func theRecordedSessionReadsAsTurnsOldestFirst() throws {
    let fixture = try #require(try FixtureConsole.recorded().fixtures.first { $0.route == "GET /api/sessions/:id" })
    let body = try JSONDecoder().decode(JSONValue.self, from: fixture.reply)
    let turns = ArchivedTurn.list(body)
    #expect(turns.map(\.turnID) == ["turn-fixture-1", "turn-fixture-2"])
    #expect(turns.first?.systemPrompt == "you are Aide")
    #expect(turns.allSatisfy { $0.foldedAt == nil && $0.expiresAt != nil })
    let entries = RunConversation.entries(turns)
    // One definition — the prompt did not change — then each turn's task.
    #expect(entries.map(\.id) == ["1-definition", "1-0", "2-0"])
    guard case .task(_, let text, _) = entries[1] else { Issue.record("\(entries)"); return }
    #expect(text == "what is on today?")
    let fold = RunDetailWords.foldLine(turns, clock: ClockTime(timeZone: utc), now: now)
    #expect(fold?.hasPrefix("The fold hasn't read this yet. It is kept until ") == true, "\(fold ?? "nil")")
}

// MARK: - The conversation

@Test func eachCallStandsWhereItWasAskedAndATooledAnswerIsNotDrawnTwice() throws {
    let turns = ArchivedTurn.list(sessionJSON())
    let entries = RunConversation.entries(turns)
    let kinds = entries.map { entry -> String in
        switch entry {
        case .definition: return "definition"
        case .task: return "task"
        case .reply: return "reply"
        case .call(_, let call): return "call:\(call.tool)\(call.failed ? "!" : "")"
        case .toolText: return "tool"
        }
    }
    #expect(kinds == ["definition", "task", "call:calendar_events", "call:knowledge_read!", "reply"], "\(kinds)")
    guard case .call(_, let read) = entries[3] else { Issue.record("\(entries)"); return }
    #expect(read.asked == "{\n  \"path\" : \"Journal/2026-09-27.md\"\n}", "the model's argument string, pretty printed: \(read.asked)")
    #expect(read.got == "refused: Journal/ is outside this routine's grant")
    #expect(read.spoken == "knowledge_read, failed")
    #expect(RunDetailWords.shortTool("mcp__brain__knowledge_read") == "knowledge_read")
    #expect(RunDetailWords.shortTool("work_list") == "work_list")
}

@Test func aLongResultIsClippedAndSaysHowMuchIsLeft() {
    let long = String(repeating: "x", count: RunConversation.shownCharacters + 250)
    let shown = RunConversation.shown(.string(long))
    #expect(shown.hasSuffix("… 250 more characters, kept in the archive"))
    #expect(RunConversation.shown(nil) == "—")
    #expect(RunConversation.shown(.null) == "—")
}

// MARK: - A whole run, as drawn

@MainActor
@Test func aFailedRunLeadsWithItsConversationItsFailureAndWhatWasTaken() async throws {
    let console = RunConsole()
    console.run = runJSON(ts: now.addingTimeInterval(-3600), ok: false, error: "the brief was written without the journal")
    console.session = sessionJSON()
    console.requests = [foldRequest(id: 41, session: sessionID, turn: "turn-7"), foldRequest(id: 42, session: "0b0b0b0b-0000-4000-8000-000000000009", turn: "turn-1")]
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(7, over: .projects)
    await model.load()

    let run = try #require(model.detail)
    #expect(RunDetailWords.failure(run) == "It failed at one tool call: the brief was written without the journal")
    let pill = RunPill(run.ok)
    #expect(pill.text == "failed" && pill.glyph == .failed && pill.ink == .failed, "C95: failed in `failed`, with its own mark")
    #expect(model.taken?.value?.map(\.line) == ["Lead with the number, then the why."], "only this session's items")
    #expect(model.taken?.value?.first?.spoken == "Preference, Lead with the number, then the why., lands in Me/Working Style.md, In Needs You")

    let tree = try await AccessibilityProbe.snapshot(runView(model).frame(width: 1100, height: 1600))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    for h in ["Morning Brief", "Conversation", "What Aide Took From This", "The Run", "Tool Calls · 3"] {
        #expect(tree.headings.contains(h), "headings: \(tree.headings)")
    }
    let controls = tree.controlNames
    #expect(controls.contains { $0.hasPrefix("Back to Projects") }, "\(controls)")
    #expect(controls.contains { $0.hasPrefix("Definition") }, "the definition layer, collapsed: \(controls)")
    #expect(controls.contains { $0.hasPrefix("calendar_events") }, "\(controls)")
    #expect(controls.contains { $0.hasPrefix("knowledge_read, failed") }, "\(controls)")
    let said = tree.labels + tree.texts
    #expect(said.contains("failed"), "the pill says it in words: \(said)")
    #expect(said.contains { $0.contains("refused: Journal/ is outside this routine's grant") }, "§3: the failed call is open, its refusal as its result: \(said)")
    #expect(!said.contains { $0.contains("\"path\"") && $0.contains("2026-09-27") && $0.contains("calendar") }, "a call that did not fail stays closed")
    #expect(said.contains { $0.contains("Four things on today") }, "the reply: \(said)")
    #expect(said.contains { $0.hasPrefix("Task, Write today's brief.") }, "\(said)")
    #expect(tree.saysAssistant.isEmpty, "the configured name, never the internal word: \(tree.saysAssistant)")
}

@MainActor
@Test func aRunTheConsoleDoesNotAnswerIsTheFailedPanelWithTryAgain() async throws {
    let console = RunConsole()
    console.down = true
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(7, over: .activity)
    await model.load()
    guard case .failed(let why) = model.run else { Issue.record("\(model.run)"); return }
    #expect(why.contains("ECONNREFUSED"), "\(why)")
    let tree = try await AccessibilityProbe.snapshot(runView(model).frame(width: 900, height: 700))
    defer { tree.close() }
    #expect(tree.controlNames.contains { $0.hasPrefix(StateWords.tryAgain) }, "\(tree.controlNames)")
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
}

// MARK: - The shell's way in and out

@MainActor
@Test func aRunOpensOverTheScreenItWasChosenOnAndBackClosesIt() async throws {
    let console = RunConsole()
    console.run = runJSON(ts: now)
    console.session = sessionJSON()
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    #expect(ActivityDestination(ref: "runs:7")?.isOpenable == true)
    model.open(7, over: .activity)
    #expect(model.isShowing(over: .activity))
    #expect(!model.isShowing(over: .projects), "the sidebar's other screens are untouched")
    await model.load()
    #expect(model.entries.count == 5)
    model.close()
    #expect(!model.isShowing(over: .activity))
    #expect(model.run == .waiting && model.conversation == .waiting && model.taken == nil)
}

@MainActor
@Test func openingRunDetailNeverRaisesTheWindowsMinimum() async throws {
    let console = RunConsole()
    console.run = runJSON(ts: now)
    console.session = sessionJSON()
    let (model, session) = runModel(console)
    defer { withExtendedLifetime(session) {} }
    model.open(7, over: .activity)
    await model.load()
    let size = MinimumProbe().minimum(of: runView(model))
    #expect(size.height <= 460, "Run detail asks for \(size) at the least")
}

// MARK: - §2.18

@MainActor
@Test func eachRowGrowsLongerNeverWiderAtTheLargestText() throws {
    let pieces: [(String, AnyView)] = [
        ("fact", AnyView(RunFactRow(fact: RunFact(label: "Model", value: "claude-sonnet-4 · anthropic")))),
        ("tool", AnyView(RunToolRow(line: RunToolLine(id: 1, tool: "knowledge_read", duration: "0.2s", fraction: 0.5, failed: true, error: "refused: outside the grant")))),
        ("taken", AnyView(RunTakenRow(item: RunTakenItem(id: "1", kind: "Preference", path: "Me/Working Style.md", line: "Lead with the number, then the why.", status: RunDetailWords.inNeedsYou, requestID: 1)))),
        ("task", AnyView(RunTaskView(text: "Write today's brief from yesterday's journal and the calendar.", at: now, clock: ClockTime(timeZone: utc)))),
        ("call", AnyView(RunCallView(call: RunCallEntry(tool: "knowledge_read", asked: "{\"path\": \"Journal/2026-09-27.md\"}", got: "refused", failed: true), isOpen: true, toggle: {}))),
    ]
    let width: CGFloat = 300
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
        #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0), "\(name) did not grow at the largest text: \(heights)")
    }
}

@MainActor
@Test func everyInkOnRunDetailClearsItsGround() {
    let pairs: [(MetistryColorRole, MetistryColorRole, Double)] = [
        (.textPrimary, .surface, 4.5), (.textSecondary, .surface, 4.5), (.textPrimary, .okQuiet, 4.5),
        (.failed, .failedQuiet, 4.5), (.failed, .surface, 3), (.textSecondary, .sunken, 4.5), (.textPrimary, .sunken, 4.5),
        (.textPrimary, .agentQuiet, 4.5), (.textSecondary, .agentQuiet, 4.5), (.failed, .agentQuiet, 3), (.accent, .surface, 3),
    ]
    for scheme in [ColorScheme.light, .dark] {
        for (ink, ground, floor) in pairs {
            let ratio = Contrast.ratio(ink, ground, scheme)
            #expect(ratio >= floor, "\(ink.rawValue) on \(ground.rawValue) is \(ratio) in \(scheme)")
        }
    }
}

@Test func noStringInRunDetailSourceNamesTheAssistant() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    for file in ["run-detail-view.swift", "run-detail-model.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
        var literals: [String] = []
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
            let code = line.components(separatedBy: " // ").first ?? String(line)
            let parts = code.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
        #expect(literals.count > 20, "\(file): the scan found almost nothing")
        // §2.18.4: nothing on the page moves, so Reduce Motion has nothing to stop.
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(file)")
        // No bare key outside the menu table (C119).
        #expect(!text.contains(".keyboardShortcut("), "\(file)")
        for literal in literals {
            // The one exception: the archive's own role name for a reply, read off the wire.
            if literal == "assistant" && file == "run-detail-model.swift" { continue }
            #expect(!literal.localizedCaseInsensitiveContains("assistant"), "\(file): \"\(literal)\"")
            #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\(file): \"\(literal)\"")
        }
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
private let now = WireTime.date("2026-09-28T12:00:00.000Z")!
private let sessionID = "7b1f2c9e-0000-4000-8000-0000000000aa"

@MainActor
private func runModel(_ console: any ConsoleCallTransport) -> (RunDetailModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (RunDetailModel(session: session, timeZone: utc, now: { now }), session)
}

@MainActor
private func runView(_ model: RunDetailModel) -> RunDetailView {
    RunDetailView(model: model, assistantName: "Aide", onOpenPath: { _ in })
}

private func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
}

/// A routine's turn: its session and turn keyed as the drain stamps them, and
/// three calls, the second failed — the ledger's rows, not the archive's.
private func runJSON(ts: Date, ok: Bool = true, error: String? = nil) -> JSONValue {
    func call(_ id: Int, _ tool: String, _ ms: Int, ok: Bool = true, error: String? = nil) -> JSONValue {
        .object(["id": .number(Double(id)), "ts": .string(iso(ts)), "component": .string("assistant"), "tool": .string(tool), "ok": .bool(ok), "error": error.map(JSONValue.string) ?? .null, "duration_ms": .number(Double(ms))])
    }
    return .object([
        "id": .number(7), "ts": .string(iso(ts)), "started_at": .null, "finished_at": .null,
        "component": .string("morning-brief"), "kind": .string("turn"), "session_id": .null, "tool": .null,
        "ok": .bool(ok), "error": error.map(JSONValue.string) ?? .null, "duration_ms": .number(72_000),
        "provider": .string("anthropic"), "model": .string("sonnet"),
        "tokens_in": .number(18_400), "tokens_out": .number(120), "cache_read_tokens": .number(45_100), "cache_write_tokens": .number(0),
        "cost_usd": .string("0.021000"),
        "meta": .object(["session_id": .string(sessionID), "turn_id": .string("turn-7")]),
        "tool_calls": .array([call(11, "mcp__brain__calendar_events", 400), call(12, "knowledge_read", 200, ok: false, error: "refused: outside the grant"), call(13, "work_list", 300)]),
        "tool_calls_total": .string("3"), "tool_calls_failed": .string(ok ? "0" : "1"),
    ])
}

/// One archived turn: the prompt, the task, a reply asking for two calls, the
/// two tool answers, and the reply — with the second call refused.
private func sessionJSON() -> JSONValue {
    func requested(_ id: String, _ name: String, _ args: String) -> JSONValue {
        .object(["id": .string(id), "type": .string("function"), "function": .object(["name": .string(name), "arguments": .string(args)])])
    }
    let messages: [JSONValue] = [
        .object(["role": .string("user"), "content": .string("Write today's brief.")]),
        .object(["role": .string("assistant"), "content": .string(""), "tool_calls": .array([
            requested("c1", "mcp__brain__calendar_events", "{\"day\":\"2026-09-28\"}"),
            requested("c2", "mcp__brain__knowledge_read", "{\"path\":\"Journal/2026-09-27.md\"}"),
        ])]),
        .object(["role": .string("tool"), "tool_call_id": .string("c1"), "content": .string("{\"events\":[]}")]),
        .object(["role": .string("tool"), "tool_call_id": .string("c2"), "content": .string("refused: Journal/ is outside this routine's grant")]),
        .object(["role": .string("assistant"), "content": .string("Four things on today, and nothing from yesterday's journal — I couldn't read it.")]),
    ]
    let calls: [JSONValue] = [
        .object(["id": .string("c1"), "tool": .string("mcp__brain__calendar_events"), "args": .object(["day": .string("2026-09-28")]), "result": .object(["events": .array([])]), "is_error": .bool(false)]),
        .object(["id": .string("c2"), "tool": .string("mcp__brain__knowledge_read"), "args": .string("{\"path\":\"Journal/2026-09-27.md\"}"), "result": .string("refused: Journal/ is outside this routine's grant"), "is_error": .bool(true)]),
    ]
    return .object([
        "session_id": .string(sessionID),
        "turns": .array([.object([
            "id": .string("31"), "session_id": .string(sessionID), "thread": .string("morning-brief"), "turn_id": .string("turn-7"),
            "ts": .string(iso(now)), "system_prompt": .string("You are the collator. Read the journal, then write the brief."),
            "messages": .array(messages), "tool_calls": .array(calls), "folded_at": .null, "expires_at": .string(iso(now.addingTimeInterval(30 * 86_400))),
        ])]),
        "as_of": .string(iso(now)),
    ])
}

/// A session fold request (C79): one Working Style line from `session`'s `turn`.
private func foldRequest(id: Int, session: String, turn: String) -> JSONValue {
    .object([
        "id": .number(Double(id)), "ts": .string(iso(now)), "kind": .string("improvement"), "trust": .string("internal"), "decision": .string("pending"),
        "source": .object(["kind": .string("metistry"), "external_ref": .string("Me/Working Style.md#session-fold")]),
        "payload": .object([
            "title": .string("Learned from your sessions: Me/Working Style.md"),
            "edit": .object(["path": .string("Me/Working Style.md"), "base_sha256": .string("abc")]),
            "items": .array([.object([
                "kind": .string("preference"), "path": .string("Me/Working Style.md"), "line": .string("Lead with the number, then the why."),
                "quote": .string("Lead with the number, then the why."), "archive_id": .number(31), "session_id": .string(session),
                "turn_id": .string(turn), "thread": .string("default"), "ts": .string(iso(now)),
            ])]),
        ]),
    ])
}

/// The recorded fixtures, with the run, its session and the queue scripted
/// where a test needs them to say something a recording cannot.
private final class RunConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let fallback = try! FixtureConsole.recorded()
    private var _run: JSONValue?
    private var _session: JSONValue?
    private var _sessionGone = false
    private var _requests: [JSONValue]?
    private var _down = false
    private var _calls: [FixtureCall] = []

    var run: JSONValue? { get { lock.withLock { _run } } set { lock.withLock { _run = newValue } } }
    var session: JSONValue? { get { lock.withLock { _session } } set { lock.withLock { _session = newValue } } }
    var sessionGone: Bool { get { lock.withLock { _sessionGone } } set { lock.withLock { _sessionGone = newValue } } }
    var requests: [JSONValue]? { get { lock.withLock { _requests } } set { lock.withLock { _requests = newValue } } }
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        lock.withLock { _calls.append(FixtureCall(method: method, path: path, body: nil, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil)) }
        let bare = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        if down {
            return .failure(.http(status: 503, envelope: ConsoleErrorEnvelope(code: "not_available", message: "connect ECONNREFUSED 127.0.0.1:1")))
        }
        if method == "GET", bare.hasPrefix("/api/runs/"), let run {
            return .success(try! JSONEncoder().encode(JSONValue.object(["run": run, "as_of": .string(iso(now))])))
        }
        if method == "GET", bare.hasPrefix("/api/sessions/") {
            if sessionGone {
                return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no session \(sessionID) in the archive (expired, purged, or never existed)")))
            }
            if let session { return .success(try! JSONEncoder().encode(session)) }
        }
        if method == "GET", bare == "/api/proposals", let requests {
            return .success(try! JSONEncoder().encode(JSONValue.object(["proposals": .array(requests), "cursor": .string("c1"), "more": .bool(false)])))
        }
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif
