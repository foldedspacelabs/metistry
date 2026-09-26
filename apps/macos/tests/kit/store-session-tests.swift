// The stores as the app holds them (T5-1): `ConsoleSession` — one child, O3's
// gate, the fourteen protocols, the Phase-A sections — `SectionModel`, and
// `CLIManagementRunner`. Every-method O3 is in store-fixtures-tests.swift,
// where the drive table lives; this file is the gate's own rules, the wiring,
// the instance switch, and §2.2's verbs.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The gate's own rules

@Test func o3IsTheStrictOneForAnythingItDoesNotName() {
    #expect(ConsoleAct.of("GET", "/api/proposals?since=x") == .read)
    #expect(ConsoleAct.of("POST", "/capture") == .append)
    #expect(ConsoleAct.of("post", "/capture") == .append)
    #expect(ConsoleAct.of("POST", "/api/vault-tasks/Journal%2F2026-09-26.md%3A12/check") == .append)
    #expect(ConsoleAct.of("DELETE", "/api/messages/5/feedback") == .append)
    // a near miss is not an append: the default is the strict one
    #expect(ConsoleAct.of("POST", "/captures") == .decision)
    #expect(ConsoleAct.of("POST", "/capture/") == .decision)
    #expect(ConsoleAct.of("POST", "/api/vault-tasks//check") == .decision)
    #expect(ConsoleAct.of("PUT", "/api/vault-tasks/k/check") == .decision)
    #expect(ConsoleAct.of("POST", "/api/vault-tasks/k/check/again") == .decision)
    #expect(ConsoleAct.of("POST", "/api/something-new") == .decision)
    // "Send in Chat: refused with the reason" — a message is not queued (screen-18 §4)
    #expect(ConsoleAct.of("POST", "/message") == .decision)
}

@MainActor
@Test func a401ClosesDecisionsAndA403A503AndAConflictDoNot() async {
    let board = Switchboard()
    let session = ConsoleSession(transport: board, management: nil)

    await board.answer("GET /api/agents", .failure(.http(status: 403, envelope: ConsoleErrorEnvelope(code: "forbidden", message: "local_only"))))
    _ = await session.stores.agents()
    #expect(session.allowsDecisions, "a 403 is the console answering: one route declined this credential")

    await board.answer("GET /api/compute", .failure(.http(status: 503, envelope: ConsoleErrorEnvelope(code: "not_available", message: "no compute.yaml"))))
    _ = await session.stores.compute()
    #expect(session.reachability == .reachable, "a 503 is one section's fact, not the connection's")

    await board.answer("POST /api/proposals/9", .failure(.http(status: 409, envelope: ConsoleErrorEnvelope(code: "conflict", message: "already decided"))))
    _ = await session.stores.answer(9, .approve)
    #expect(session.allowsDecisions)

    await board.answer("GET /api/whoami", .failure(.http(status: 401, envelope: ConsoleErrorEnvelope(code: "unauthenticated", message: "authentication required"))))
    _ = await session.stores.whoami()
    #expect(!session.allowsDecisions, "the door refused the owner: nothing on the owner surface can be done")
    #expect(session.reachability == .unreachable("authentication required"))

    // and the refusal is O3's, before anything is sent
    let sentBefore = await board.calls.count
    guard case .failure(let error) = await session.stores.answer(9, .approve) else {
        Issue.record("an answer went while the door was refusing the owner"); return
    }
    #expect(error.wasHeldForReachability)
    #expect(error.localizedDescription.contains("decisions are never queued"))
    #expect(await board.calls.count == sentBefore)
    // …and a request that WAS sent and failed is not mistaken for one that was held
    #expect(!ConsoleError.transport("connect ECONNREFUSED").wasHeldForReachability)
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func anOlderRequestsLateAnswerNeverOverridesANewerOne() async throws {
    let board = Switchboard()
    let session = ConsoleSession(transport: board, management: nil)
    await board.answer("GET /api/q/board", .failure(.transport("`metistry console session` gave no answer in 45s")))
    await board.hold("GET /api/q/board")
    await board.answer("GET /health", .success(Data(#"{"ok":true,"api_version":1}"#.utf8)))

    let stores = session.stores
    async let slow = stores.board(project: nil, limit: nil)
    while !(await board.isHolding("GET /api/q/board")) { try await Task.sleep(for: .milliseconds(2)) }
    _ = await session.stores.health()          // sent later, answered first
    #expect(session.allowsDecisions)
    await board.release("GET /api/q/board")
    _ = await slow
    #expect(session.allowsDecisions, "a request that timed out overrode the newer answer that said the console is there")

    // the ordinary direction still holds: the newest answer is the one that counts
    await board.answer("GET /health", .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080")))
    _ = await session.stores.health()
    #expect(!session.allowsDecisions)
}

// MARK: - The wiring

@MainActor
@Test func withNoRuntimeTheSessionSaysSoFromTheStartAndDecidesNothing() async {
    let session = ConsoleSession(cli: nil, spawner: nil)
    let why = CLIReadError.noRuntime.localizedDescription
    // reported by the locator, not inferred from a timeout
    #expect(!session.allowsDecisions)
    #expect(session.reachability == .unreachable(why))
    #expect(session.management == nil)
    guard case .failure(let held) = await session.stores.approveAgent("devin") else { Issue.record("approved with no runtime"); return }
    #expect(held.wasHeldForReachability)
    #expect(await session.stores.health().failure == .notConfigured(why))
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func everyStoreAndTheEventStreamShareOneSessionChild() async throws {
    let spawner = EchoSpawner()
    let session = ConsoleSession(cli: sessionCLI(RecordingRunner()), spawner: spawner)
    #expect(spawner.spawned.isEmpty, "a session costs nothing until a screen asks")

    let health = try await session.stores.health().get()
    #expect(health.ok)
    _ = await session.stores.waitingCount()
    _ = await session.instance.refreshIdentity()
    let stream = session.stores.events(lastEventID: nil)
    var iterator = stream.makeAsyncIterator()
    _ = try await iterator.next()

    #expect(spawner.spawned.count == 1, "one child for the stores, the Phase-A sections and the stream")
    let spawn = try #require(spawner.spawned.first)
    #expect(spawn.arguments == ["/src/packages/cli/dist/main.js", "console", "session", "--stdio", "--product-dir", "/src"])
    #expect(spawn.environment["METISTRY_INSTANCE_DIR"] == "/Users/you/instance")
    let paths = spawn.child.sent.compactMap { $0["path"] as? String }
    #expect(paths == ["/health", "/api/needs-you/count", "/api/identity", "/api/events"])
}

@MainActor
@Test func withNoSpawnerEveryRequestIsAConsoleCallAndTheBodyGoesOnStdin() async throws {
    let runner = RecordingRunner(stdout: #"{"ok":true,"api_version":1}"#)
    let session = ConsoleSession(cli: sessionCLI(runner), spawner: nil)
    _ = try await session.stores.health().get()
    _ = await session.stores.closeDay("2026-09-26", line: "a good day")
    let calls = runner.calls
    #expect(calls.map(\.arguments) == [
        ["/src/packages/cli/dist/main.js", "console", "call", "GET", "/health", "--json", "--product-dir", "/src"],
        ["/src/packages/cli/dist/main.js", "console", "call", "POST", "/api/today/close", "--json", "--body", "-", "--product-dir", "/src"],
    ])
    #expect(calls[1].standardInput?.contains("a good day") == true)
}

// MARK: - Switching instance

@MainActor
@Test(.timeLimit(.minutes(1)))
func adoptingAnotherInstanceDropsEverySectionAndTheAnswerStillInFlight() async throws {
    let first = Switchboard()
    await first.answer("GET /api/needs-you/count", .success(Data(#"{"waiting":3,"oldest_ts":"2026-09-26T08:00:00Z"}"#.utf8)))
    await first.answer("GET /api/identity", .success(Data(#"{"instance_id":"i-1","name":"Aide","capabilities":[]}"#.utf8)))
    await first.answer("GET /health", .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080")))
    let session = ConsoleSession(transport: first, management: nil)
    let waiting = SectionModel(session: session, policy: .requests) { stores in
        await stores.waitingCount().map { ($0, WireTime.date($0.oldestTS)) }
    }
    await waiting.refresh()
    await session.instance.refreshIdentity()
    #expect(waiting.section.value?.waiting == 3)
    #expect(session.instance.identity.hasValue)
    _ = await session.stores.health()
    #expect(!session.allowsDecisions)

    // a refresh is in flight against the first instance when the switch happens
    await first.answer("GET /api/needs-you/count", .success(Data(#"{"waiting":99,"oldest_ts":null}"#.utf8)))
    await first.hold("GET /api/needs-you/count")
    let inFlight = Task { await waiting.refresh(background: true) }
    while !(await first.isHolding("GET /api/needs-you/count")) { try await Task.sleep(for: .milliseconds(2)) }

    let second = Switchboard()
    await second.answer("GET /api/needs-you/count", .success(Data(#"{"waiting":1,"oldest_ts":null}"#.utf8)))
    let generation = session.generation
    session.adopt(transport: second, management: nil)
    #expect(session.generation == generation + 1)
    // every value belonged to the first install, and none of it is shown beside the second
    #expect(!waiting.section.hasValue)
    #expect(!session.instance.identity.hasValue)
    // and the second install's gate has heard nothing, so it has closed nothing
    #expect(session.allowsDecisions)

    await first.release("GET /api/needs-you/count")
    await inFlight.value
    #expect(!waiting.section.hasValue, "the first instance's late answer landed on the second instance's screen")

    await waiting.refresh()
    #expect(waiting.section.value?.waiting == 1)
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func adoptingEndsTheOldChildAndTheNextRequestStartsOneForTheNewInstance() async throws {
    let spawner = EchoSpawner()
    let session = ConsoleSession(cli: sessionCLI(RecordingRunner()), spawner: spawner)
    _ = await session.stores.health()
    let old = try #require(spawner.spawned.first?.child)

    session.adopt(cli: sessionCLI(RecordingRunner(), instance: "/Users/you/second"))
    while !old.terminated { try await Task.sleep(for: .milliseconds(2)) }
    _ = await session.stores.health()
    #expect(spawner.spawned.count == 2)
    #expect(spawner.spawned.last?.environment["METISTRY_INSTANCE_DIR"] == "/Users/you/second")
}

// MARK: - A section of a screen

@MainActor
@Test func aSectionAsksWhenDueOrInvalidatedAndGoesStaleRatherThanBlank() async {
    let board = Switchboard()
    await board.answer("GET /api/needs-you/count", .success(Data(#"{"waiting":2,"oldest_ts":null}"#.utf8)))
    let session = ConsoleSession(transport: board, management: nil)
    let waiting = SectionModel(session: session, policy: .requests) { stores in
        await stores.waitingCount().map { ($0, nil) }
    }
    #expect(waiting.section.isFirstLoad)
    await waiting.refreshIfDue()
    #expect(waiting.section.value?.waiting == 2)

    // a redraw is not a request
    await waiting.refreshIfDue()
    #expect(await board.calls.count == 1)
    // an event said it changed: the next tick asks, whatever the clock says
    waiting.invalidate()
    #expect(waiting.section.value?.waiting == 2, "invalidating changes nothing on screen")
    await board.answer("GET /api/needs-you/count", .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080")))
    await waiting.refreshIfDue()
    #expect(await board.calls.count == 2)
    guard case .stale = waiting.section.state else { Issue.record("a failed refresh blanked the section: \(waiting.section.state)"); return }
    #expect(waiting.section.value?.waiting == 2)
    #expect(waiting.consecutiveFailures == 1)
    #expect(!waiting.isInvalidated)
    #expect(!session.allowsDecisions, "the section's read is what told the session")
}

@MainActor
@Test func aDegradedNoteInAnAnswerIsAFactOnALoadedSection() async {
    let board = Switchboard()
    await board.answer("GET /api/knowledge/search?q=sleep", .success(Data(#"{"q":"sleep","mode":"hybrid","hits":[],"degraded":"keyword only — the embedder is down","as_of":"2026-09-26T09:00:00Z"}"#.utf8)))
    let session = ConsoleSession(transport: board, management: nil)
    let search = SectionModel(session: session, policy: .configuration, degraded: { $0.degraded }) { stores in
        await stores.knowledgeSearch("sleep", mode: nil, limit: nil).map { ($0, nil) }
    }
    await search.refresh()
    #expect(search.section.state == .loaded)
    #expect(search.section.reachability == .degraded("keyword only — the embedder is down"))
    #expect(session.allowsDecisions)
}

// MARK: - §2.2's verbs

@MainActor
@Test func managementVerbsRunOnThisMacWhileTheConsoleIsDown() async throws {
    let runner = RecordingRunner()
    let board = Switchboard()
    await board.answer("GET /health", .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080")))
    let session = ConsoleSession(transport: board, management: CLIManagementRunner(cli: sessionCLI(runner)))
    _ = await session.stores.health()
    #expect(!session.allowsDecisions)

    // M5 is exactly what the owner needs when the console is down
    let restart = try #require(ManagementCommand(.services, ["restart", "console", "--json"]))
    let management = try #require(session.management)
    let result = try await management.run(restart) { _ in }
    #expect(result.ok)
    let call = try #require(runner.calls.first)
    #expect(call.arguments == ["/src/packages/cli/dist/main.js", "restart", "console", "--json", "--product-dir", "/src"])
    #expect(management.plannedArguments(restart) == ["/usr/bin/node"] + call.arguments)
    #expect(call.environment["METISTRY_INSTANCE_DIR"] == "/Users/you/instance")
    #expect(call.standardInput == nil, "an empty stdin, so no verb can sit at a prompt")
}

@Test func aPastedValueReachesTheVerbOnStdinAndIsInNoArgumentAnywhere() async throws {
    let runner = RecordingRunner()
    let management = CLIManagementRunner(cli: sessionCLI(runner))
    let key = "sk-or-v1-not-a-real-key"
    let add = try #require(ManagementCommand(.computeProviders, ["compute", "providers", "add", "--from", "openrouter", "--json"], standardInput: key))
    _ = try await management.run(add) { _ in }
    let call = try #require(runner.calls.first)
    #expect(call.standardInput == key)
    #expect(!call.arguments.contains { $0.contains(key) })
    #expect(!management.plannedArguments(add).contains { $0.contains(key) })
}

@Test func aCommandCannotNameItsOwnProductDirectory() {
    // which product runs a verb is the locator's answer, appended by the runner
    #expect(ManagementCommand(.doctor, ["doctor", "--json", "--product-dir", "/elsewhere"]) == nil)
    #expect(ManagementCommand(.update, ["update", "--product-dir=/elsewhere"]) == nil)
    #expect(ManagementCommand(.doctor, ["doctor", "--json"]) != nil)
}

// MARK: - The two bugs F-7 reported

@MainActor
@Test func aDispatchCarriesTheBriefTheRouteRequires() async throws {
    let console = try FixtureConsole.recorded()
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: nil, defaults: UserDefaults(suiteName: "t5-1.\(UUID())")!)
    await store.refreshBoard()
    let card = try #require(store.board.value?.rows.first { $0.id == 2 })
    let fixture = try ConsoleFixture.load("post-api-tasks-id-dispatch")

    let result = await store.dispatch(card, TaskDispatch(target: "github-issues", brief: "Open the release checklist for 0.12.0 under Projects/Metistry."))
    #expect(result.success?.ok == true)
    let sent = try #require(console.calls.first { $0.method == "POST" })
    #expect(sent.path == "/api/tasks/2/dispatch")
    #expect(sent.body == fixture.body)
    #expect(sent.body?["brief"]?.stringValue?.isEmpty == false)
}

@Test func aRoomsIdsAreTheTextTheConsoleSends() async throws {
    let stores = ConsoleStores(transport: try FixtureConsole.recorded())
    let rooms = try await stores.rooms(state: nil, project: nil, anchor: nil, limit: nil).get()
    #expect(rooms.rows.map(\.threadID) == ["cmt_01M3FYT8PDPMAX22C9X769GV7Q", "cmt_01M3FYT8NVNX3ZGBZH481KTHGE"])
    #expect(Set(rooms.rows.map(\.id)).count == rooms.rows.count, "every room had the same id")
    let artifactRoom = try #require(rooms.rows.first { $0.anchor == "artifact" })
    #expect(artifactRoom.artifactID == "art_01M3FYT8N8HRG4S2W4Q0GN28F1")
    #expect(artifactRoom.versionID == "ver_01M3FYT8NB0W22G5J1H3A71PTY")
    let workRoom = try #require(rooms.rows.first { $0.anchor == "work" })
    #expect(workRoom.workID == 3)

    // a number is still read — as its digits
    let legacy = try JSONDecoder().decode(Room.self, from: Data(#"{"thread_id":41,"artifact_id":7}"#.utf8))
    #expect(legacy.threadID == "41")
    #expect(legacy.artifactID == "7")
}

// MARK: - The app holds one

@MainActor
@Test func theAppHoldsOneSessionAndAnInstanceSwitchReadoptsIt() {
    let id = "com.foldedspacelabs.metistry.tests.session.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    defer { UserDefaults.standard.removePersistentDomain(forName: id) }
    let model = AppModel(bundleResourceURL: nil, runner: RecordingRunner(), defaults: defaults)
    let before = model.console.generation
    model.activateInstance(URL(fileURLWithPath: "/Users/you/instance"))
    #expect(model.console.generation == before + 1)
}

// MARK: - Helpers

private func sessionCLI(_ runner: any CommandRunner, instance: String = "/Users/you/instance") -> MetistryCLI {
    MetistryCLI(
        runtime: MetistryRuntime(
            source: .checkout,
            executable: URL(fileURLWithPath: "/usr/bin/node"),
            leadingArguments: ["/src/packages/cli/dist/main.js"],
            productDir: URL(fileURLWithPath: "/src")
        ),
        runner: runner,
        instanceDir: URL(fileURLWithPath: instance)
    )
}

/// A console with an answer per `METHOD path`, and any of them held until released.
private actor Switchboard: ConsoleCallTransport {
    private var answers: [String: Result<Data, ConsoleError>] = [:]
    private var holding: Set<String> = []
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
    private(set) var calls: [String] = []

    func answer(_ key: String, _ result: Result<Data, ConsoleError>) { answers[key] = result }
    func hold(_ key: String) { holding.insert(key) }
    func isHolding(_ key: String) -> Bool { waiting[key] != nil }

    func release(_ key: String) {
        holding.remove(key)
        waiting.removeValue(forKey: key)?.resume()
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let key = "\(method) \(path)"
        calls.append(key)
        if holding.contains(key) {
            await withCheckedContinuation { waiting[key] = $0 }
        }
        return answers[key] ?? .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no answer for \(key)")))
    }
}

/// Records every invocation; answers with `stdout`, exit 0.
private final class RecordingRunner: CommandRunner, @unchecked Sendable {
    struct Call {
        let arguments: [String]
        let environment: [String: String]
        let standardInput: String?
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private let stdout: String

    init(stdout: String = "{}") {
        self.stdout = stdout
    }

    var calls: [Call] { lock.withLock { recorded } }

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        lock.withLock { recorded.append(Call(arguments: arguments, environment: environment, standardInput: standardInput)) }
        return CommandResult(exitCode: 0, stdout: stdout, stderr: "")
    }
}

/// A `console session --stdio` child that answers every request line at once:
/// `/health` with a real health body, a stream with one frame, anything else `{}`.
private final class EchoChild: SessionProcess, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let out: AsyncStream<String>.Continuation
    private let lock = NSLock()
    private var raw: [String] = []
    private var ended: CommandResult?
    private var waiters: [CheckedContinuation<CommandResult, Never>] = []

    init() {
        (lines, out) = AsyncStream<String>.makeStream()
    }

    var sent: [[String: Any]] {
        lock.withLock { raw }.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }

    var terminated: Bool { lock.withLock { ended != nil } }

    func send(_ line: String) throws {
        let dead: Bool = lock.withLock {
            if ended != nil { return true }
            raw.append(line)
            return false
        }
        if dead { throw CocoaError(.fileWriteUnknown) }
        guard let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let id = request["id"] as? String else { return }
        if request["cancel"] != nil { return }
        if request["stream"] as? Bool == true {
            reply(["id": id, "event": ["id": "1", "type": "needs_you.changed", "data": ["waiting": 3]]])
            return
        }
        let body: [String: Any] = request["path"] as? String == "/health" ? ["ok": true, "api_version": 1] : [:]
        reply(["id": id, "status": 200, "body": body])
    }

    private func reply(_ object: [String: Any]) {
        out.yield(String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self))
    }

    func termination() async -> CommandResult {
        await withCheckedContinuation { waiter in
            let done: CommandResult? = lock.withLock {
                if let ended { return ended }
                waiters.append(waiter)
                return nil
            }
            if let done { waiter.resume(returning: done) }
        }
    }

    func terminate() {
        let result = CommandResult(exitCode: 15, stdout: "", stderr: "")
        let pending: [CheckedContinuation<CommandResult, Never>] = lock.withLock {
            ended = result
            defer { waiters.removeAll() }
            return waiters
        }
        out.finish()
        for w in pending { w.resume(returning: result) }
    }
}

private final class EchoSpawner: SessionSpawner, @unchecked Sendable {
    struct Spawn {
        let arguments: [String]
        let environment: [String: String]
        let child: EchoChild
    }

    private let lock = NSLock()
    private var all: [Spawn] = []

    var spawned: [Spawn] { lock.withLock { all } }

    func spawn(executable: URL, arguments: [String], environment: [String: String], currentDirectory: URL?) throws -> any SessionProcess {
        let child = EchoChild()
        lock.withLock { all.append(Spawn(arguments: arguments, environment: environment, child: child)) }
        return child
    }
}

private extension Result {
    var failure: Failure? {
        if case .failure(let error) = self { return error }
        return nil
    }

    var success: Success? {
        if case .success(let value) = self { return value }
        return nil
    }
}
