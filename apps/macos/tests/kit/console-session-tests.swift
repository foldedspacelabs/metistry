// `SessionConsoleCallTransport` against a scripted child — the F-12 transport:
// one long-lived `metistry console session --stdio` instead of a process per
// request.
//
// THE CHILD IS IN-PROCESS. `ScriptedChild` conforms to `SessionProcess`, so the
// transport is exercised for real — the line it writes, the id it matches on,
// what a crash does to what is in flight — with nothing spawned. The CLI half
// of the contract (the token resolved once, never printed; loopback only) is
// held by `packages/cli/test/console-session.test.ts`; the "no credential
// header, no Keychain" source scan in console-sign-in-tests.swift covers the
// new code here too.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - Requests

@Test(.timeLimit(.minutes(1)))
func sessionResponsesMatchByIdNotByOrder() async throws {
    let child = ScriptedChild()
    // Answer only once all three are in, and in REVERSE order.
    child.onSend = { child, sent in
        guard sent.count == 3 else { return }
        for request in sent.reversed() {
            let path = request["path"] as? String ?? ""
            child.reply(["id": request["id"]!, "status": 200, "body": ["path": path]])
        }
    }
    let children = ChildFactory(child)
    let transport = SessionConsoleCallTransport { children.next() }
    async let a = transport.call("GET", "/api/a", body: nil)
    async let b = transport.call("GET", "/api/b", body: nil)
    async let c = transport.call("GET", "/api/c", body: nil)
    let answers = await [a, b, c].map { try? JSONValue.parse($0.get())["path"]?.stringValue }
    #expect(answers == ["/api/a", "/api/b", "/api/c"])
    // Three requests, three distinct ids, one child.
    #expect(Set(child.sent.compactMap { $0["id"] as? String }).count == 3)
    #expect(children.spawned == 1)
}

@Test(.timeLimit(.minutes(1)))
func sessionLineCarriesMethodPathBodyAndKeyAndNoCredential() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        child.reply(["id": sent.last!["id"]!, "status": 201, "body": ["ok": true], "replayed": true])
    }
    let transport = SessionConsoleCallTransport { child }
    let result = await transport.call("POST", "/capture", body: Data(#"{"text":"hi"}"#.utf8), idempotencyKey: "k-1")
    let request = try #require(child.sent.first)
    #expect(request["method"] as? String == "POST")
    #expect(request["path"] as? String == "/capture")
    #expect((request["body"] as? [String: Any])?["text"] as? String == "hi")
    #expect(request["idempotency_key"] as? String == "k-1")
    // The line is the whole request: no header, no token, nothing to leak.
    for line in child.rawSent {
        #expect(!line.lowercased().contains("authorization"))
        #expect(!line.contains("Bearer"))
    }
    // `console call --json`'s replay fold is kept.
    let body = try JSONValue.parse(try result.get())
    #expect(body["replayed"]?.boolValue == true)
    #expect(body["ok"]?.boolValue == true)
}

@Test(.timeLimit(.minutes(1)))
func sessionA409KeepsItsReasonAndTheRowAsItStands() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        child.reply(["id": sent.last!["id"]!, "status": 409, "body": [
            "error": ["code": "conflict", "message": "changed since you saw it"],
            "reason": "stale", "decision": "pending", "decided_at": NSNull(),
            "proposal": ["id": 9, "ts": "2026-09-26T00:00:00Z"],
        ]])
    }
    let transport = SessionConsoleCallTransport { child }
    let result = await transport.call("POST", "/api/proposals/9", body: Data(#"{"decision":"approve"}"#.utf8))
    guard case .failure(let error) = result else { Issue.record("expected a 409"); return }
    #expect(error.isConflict)
    #expect(error.code == "conflict")
    #expect(error.conflictReason == "stale")
    #expect(error.details["decision"]?.stringValue == "pending")
    #expect(error.details["decided_at"] == .null)
    #expect(error.details["proposal"]?["id"]?.intValue == 9)
    #expect(error.details["error"] == nil)
}

@Test func theEnvelopeKeepsEveryKeyBesideError() throws {
    // The same home serves the one-shot transport: `fromConsoleCall` decodes
    // `--json`'s stdout body through `ConsoleErrorEnvelope(json:)` too.
    let stdout = #"{"error":{"code":"conflict","message":"already decided"},"reason":"already_decided","decision":"allow"}"#
    let error = ConsoleError.fromConsoleCall(stderr: "metistry console call: HTTP 409 — conflict — already decided", stdout: stdout, exitCode: 1)
    #expect(error.conflictReason == "already_decided")
    #expect(error.details["decision"]?.stringValue == "allow")
    // A 409 on an older route carries no reason, and says so.
    let bare = ConsoleError.http(status: 409, envelope: ConsoleErrorEnvelope(code: "conflict", message: "held by someone else"))
    #expect(bare.conflictReason == nil)
    #expect(bare.details.isEmpty)
}

@Test(.timeLimit(.minutes(1)))
func sessionErrorLinesAreTypedNotDressedAsHttp() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        let id = sent.last!["id"]!
        if sent.count == 1 {
            child.reply(["id": id, "error": ["code": "unreachable", "message": "console unreachable at http://127.0.0.1:8080: connect ECONNREFUSED"]])
        } else {
            child.reply(["id": id, "error": ["code": "invalid_request", "message": "path must be an absolute path"]])
        }
    }
    let transport = SessionConsoleCallTransport { child }
    let down = await transport.call("GET", "/api/whoami", body: nil)
    #expect(down.failure == .transport("console unreachable at http://127.0.0.1:8080: connect ECONNREFUSED"))
    let refused = await transport.call("GET", "api/whoami", body: nil)
    guard case .undecodable(let detail) = refused.failure else { Issue.record("expected undecodable"); return }
    #expect(detail.contains("refused the request"))
}

// MARK: - A crashed child

@Test(.timeLimit(.minutes(1)))
func aCrashedChildFailsInFlightCallsAndNeverHangs() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        // Two requests in, no answers, then the child dies.
        if sent.count == 2 { child.crash(exitCode: 1, stderr: "node: out of memory\n") }
    }
    let transport = SessionConsoleCallTransport { child }
    async let a = transport.call("GET", "/api/a", body: nil)
    async let b = transport.call("GET", "/api/b", body: nil)
    let (ra, rb) = await (a, b)
    for result in [ra, rb] {
        guard case .transport(let detail) = result.failure else { Issue.record("expected transport, got \(result)"); continue }
        #expect(detail == "`metistry console session` exited 1: node: out of memory")
    }
}

@Test(.timeLimit(.minutes(1)))
func theNextCallAfterACrashRestartsTheChild() async throws {
    let children = ChildFactory()
    let transport = SessionConsoleCallTransport { children.next() }
    let first = children.upcoming()
    first.onSend = { child, _ in child.crash(exitCode: 137, stderr: "") }
    let crashed = await transport.call("GET", "/api/whoami", body: nil)
    #expect(crashed.failure == .transport("`metistry console session` exited 137 and said nothing"))

    let second = children.upcoming()
    second.onSend = { child, sent in child.reply(["id": sent.last!["id"]!, "status": 200, "body": ["principal": "user"]]) }
    let answered = await transport.call("GET", "/api/whoami", body: nil)
    #expect((try? JSONValue.parse(answered.get())["principal"]?.stringValue) == "user")
    #expect(children.spawned == 2)
}

@Test(.timeLimit(.minutes(1)))
func aChildThatRefusesToStartIsNotConfiguredAndIsNotRespawnedInALoop() async throws {
    let children = ChildFactory()
    let transport = SessionConsoleCallTransport { children.next() }
    let child = children.upcoming()
    child.onSend = { child, _ in
        child.crash(exitCode: 1, stderr: "metistry console session: https://metis.example is not loopback — the local owner token this verb presents is minted for THIS machine only\n")
    }
    let result = await transport.call("GET", "/api/whoami", body: nil)
    guard case .notConfigured(let detail) = result.failure else { Issue.record("expected notConfigured, got \(result)"); return }
    #expect(detail.hasPrefix("https://metis.example is not loopback"))
    // Nothing asked again, so nothing started again.
    try await Task.sleep(for: .milliseconds(20))
    #expect(children.spawned == 1)
}

@Test(.timeLimit(.minutes(1)))
func aCallWithNoAnswerAtAllTimesOutRatherThanHanging() async throws {
    let child = ScriptedChild() // alive, and silent
    let transport = SessionConsoleCallTransport(callTimeout: .milliseconds(50)) { child }
    let result = await transport.call("GET", "/api/whoami", body: nil)
    guard case .transport(let detail) = result.failure else { Issue.record("expected transport, got \(result)"); return }
    #expect(detail.contains("gave no answer"))
}

@Test(.timeLimit(.minutes(1)))
func aCliThatPredatesTheVerbFallsBackToOneShotCalls() async throws {
    let children = ChildFactory()
    let fallback = FallbackConsole()
    let transport = SessionConsoleCallTransport(fallback: fallback) { children.next() }
    let old = children.upcoming()
    // What a pre-F-12 CLI says to `console session --stdio`: console's usage, exit 2.
    old.onSend = { child, _ in
        child.crash(exitCode: 2, stderr: """
        usage: metistry console whoami [--json] [--instance <dir>] [--env-file <path>]
               metistry console call <METHOD> <path> [--body @file|-] [--idempotency-key <key>] [--json] [--instance <dir>] [--env-file <path>]

        """)
    }
    let first = await transport.call("GET", "/api/whoami", body: nil)
    let second = await transport.call("GET", "/api/identity", body: nil)
    #expect((try? first.get()) == Data("GET /api/whoami".utf8))
    #expect((try? second.get()) == Data("GET /api/identity".utf8))
    #expect(await fallback.calls == ["GET /api/whoami", "GET /api/identity"])
    #expect(children.spawned == 1)
}

@Test func sessionExitIsReadTheWayAOneShotIs() {
    #expect(ConsoleError.fromSessionExit(CommandResult(exitCode: 2, stdout: "", stderr: "metistry: unknown command \"console\"")) == .cliUnavailable(CLIDegradation.message(verb: "console session")))
    // A CLI that HAS the verb and was misused prints a usage naming it: not "too old".
    let misuse = ConsoleError.fromSessionExit(CommandResult(exitCode: 2, stdout: "", stderr: "usage: metistry console whoami\n       metistry console session --stdio\n"))
    #expect(misuse != .cliUnavailable(CLIDegradation.message(verb: "console session")))
    let unset = ConsoleError.fromSessionExit(CommandResult(exitCode: 1, stdout: "", stderr: "metistry console session: METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain)"))
    guard case .notConfigured = unset else { Issue.record("expected notConfigured"); return }
}

// MARK: - The event stream

@Test(.timeLimit(.minutes(1)))
func eventsYieldFramesAndCancellingSendsCancel() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        let request = sent.last!
        guard request["stream"] as? Bool == true else { return }
        #expect(request["path"] as? String == "/api/events")
        #expect(request["last_event_id"] as? String == "41")
        child.reply(["id": request["id"]!, "event": ["id": "42", "type": "work.changed", "data": ["work_id": 7]]])
        child.reply(["id": request["id"]!, "event": ["id": "43", "type": "needs_you.changed", "data": ["waiting": 2]]])
    }
    let transport = SessionConsoleCallTransport { child }
    let stream = await transport.events(lastEventID: "41")
    let seen = Frames()
    let consumer = Task {
        for try await event in stream { seen.append(event) }
    }
    while seen.all.count < 2 { try await Task.sleep(for: .milliseconds(5)) }
    consumer.cancel() // the view goes away: that is the cancel
    #expect(seen.all == [
        ConsoleLiveEvent(id: "42", type: "work.changed", data: .object(["work_id": .number(7)])),
        ConsoleLiveEvent(id: "43", type: "needs_you.changed", data: .object(["waiting": .number(2)])),
    ])
    let streamID = try #require(child.sent.first?["id"] as? String)
    try await child.waitForSend { $0["cancel"] as? Bool == true && $0["id"] as? String == streamID }
}

@Test(.timeLimit(.minutes(1)))
func aStreamTheConsoleClosesFinishesAndOneItNeverOpenedThrows() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        let id = sent.last!["id"]!
        if sent.count == 1 {
            child.reply(["id": id, "event": ["id": "1", "type": "resync", "data": [String: Any]()]])
            child.reply(["id": id, "ended": "closed"])
        } else {
            child.reply(["id": id, "status": 404, "body": ["error": ["code": "not_found", "message": "not found"]]])
        }
    }
    let transport = SessionConsoleCallTransport { child }
    var frames: [String] = []
    for try await event in await transport.events() { frames.append(event.type) }
    #expect(frames == ["resync"])

    do {
        for try await _ in await transport.events() {}
        Issue.record("a 404 must not look like an empty stream")
    } catch let error as ConsoleError {
        #expect(error.isNotFound)
    }
}

@Test(.timeLimit(.minutes(1)))
func aCrashedChildEndsAnOpenStreamWithTheReason() async throws {
    let child = ScriptedChild()
    child.onSend = { child, sent in
        child.reply(["id": sent.last!["id"]!, "event": ["id": "1", "type": "work.changed", "data": ["work_id": 1]]])
        child.crash(exitCode: 1, stderr: "boom\n")
    }
    let transport = SessionConsoleCallTransport { child }
    var frames = 0
    do {
        for try await _ in await transport.events() { frames += 1 }
        Issue.record("a crash must not look like the console closing the stream")
    } catch let error as ConsoleError {
        #expect(error == .transport("`metistry console session` exited 1: boom"))
    }
    #expect(frames == 1)
}

// MARK: - Helpers

private extension Result {
    var failure: Failure? {
        if case .failure(let f) = self { return f }
        return nil
    }
}

/// A `metistry console session` that is not there: it records every line it
/// is sent, answers through `onSend`, and dies when told to.
private final class ScriptedChild: SessionProcess, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let out: AsyncStream<String>.Continuation
    private let lock = NSLock()
    private var _raw: [String] = []
    private var _ended: CommandResult?
    private var _waiters: [CheckedContinuation<CommandResult, Never>] = []
    private var _onSend: (@Sendable (ScriptedChild, [[String: Any]]) -> Void)?

    init() {
        (lines, out) = AsyncStream<String>.makeStream()
    }

    var onSend: (@Sendable (ScriptedChild, [[String: Any]]) -> Void)? {
        get { lock.withLock { _onSend } }
        set { lock.withLock { _onSend = newValue } }
    }

    var rawSent: [String] { lock.withLock { _raw } }
    var sent: [[String: Any]] {
        rawSent.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }

    func send(_ line: String) throws {
        let (dead, handler): (Bool, (@Sendable (ScriptedChild, [[String: Any]]) -> Void)?) = lock.withLock {
            if _ended != nil { return (true, nil) }
            _raw.append(line)
            return (false, _onSend)
        }
        if dead { throw CocoaError(.fileWriteUnknown) }
        handler?(self, sent)
    }

    func reply(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        out.yield(String(decoding: data, as: UTF8.self))
    }

    func crash(exitCode: Int32, stderr: String) {
        let waiting: [CheckedContinuation<CommandResult, Never>] = lock.withLock {
            _ended = CommandResult(exitCode: exitCode, stdout: "", stderr: stderr)
            defer { _waiters.removeAll() }
            return _waiters
        }
        out.finish()
        for w in waiting { w.resume(returning: CommandResult(exitCode: exitCode, stdout: "", stderr: stderr)) }
    }

    func termination() async -> CommandResult {
        await withCheckedContinuation { waiter in
            let done: CommandResult? = lock.withLock {
                if let _ended { return _ended }
                _waiters.append(waiter)
                return nil
            }
            if let done { waiter.resume(returning: done) }
        }
    }

    func terminate() { crash(exitCode: 15, stderr: "") }

    /// Wait until a sent line matches — for what the transport sends on its own (a cancel).
    func waitForSend(_ match: @escaping ([String: Any]) -> Bool) async throws {
        while !sent.contains(where: match) { try await Task.sleep(for: .milliseconds(5)) }
    }
}

/// Frames a consuming task collected.
private final class Frames: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [ConsoleLiveEvent] = []
    var all: [ConsoleLiveEvent] { lock.withLock { frames } }
    func append(_ frame: ConsoleLiveEvent) { lock.withLock { frames.append(frame) } }
}

/// Hands out a fresh `ScriptedChild` per spawn, prepared in advance by the test.
private final class ChildFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [ScriptedChild] = []
    private var count = 0

    var spawned: Int { lock.withLock { count } }

    init(_ children: ScriptedChild...) {
        queue = children
    }

    /// The child the next spawn will get.
    func upcoming() -> ScriptedChild {
        let child = ScriptedChild()
        lock.withLock { queue.append(child) }
        return child
    }

    func next() -> ScriptedChild {
        lock.withLock {
            count += 1
            return queue.isEmpty ? ScriptedChild() : queue.removeFirst()
        }
    }
}

/// The one-shot transport an older install falls back to, recording what it was asked.
private actor FallbackConsole: ConsoleCallTransport {
    private(set) var calls: [String] = []

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        calls.append("\(method) \(path)")
        return .success(Data("\(method) \(path)".utf8))
    }
}
