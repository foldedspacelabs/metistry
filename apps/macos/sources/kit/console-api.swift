// The app's authenticated read/write path into THIS machine's console, and the
// only place in Swift that names a management route.
//
// WHY THERE IS STILL NO HTTP CLIENT HERE. docs/ops/mac-app.md wrote the
// condition for this file before it existed: "Adding it is a CLI change first:
// a `metistry console call <METHOD> <path>` keeps the token out of this process
// entirely, which a token-printing verb would not." That verb shipped, and
// docs/ops/cli.md says what to do with it — "the app and
// docs/ops/second-instance.md use it rather than a second HTTP client". So the
// authenticated surface is the CLI — held open as one long-lived child since
// F-12, with the one-shot verb as the fallback for an install that predates it:
//
//     metistry console session --stdio              (SessionConsoleCallTransport)
//     metistry console call <METHOD> <path> [--body -] --json   (CLIConsoleCallTransport)
//
// The CLI resolves the local owner token (environment, then this instance's
// login-Keychain account, then the user's — `packages/cli/src/console-client.ts`),
// presents it over loopback, refuses to send it to a console that is not
// loopback, and redacts it out of every message before printing. The value
// never reaches this process, there is no header for this file to set and no
// keychain for it to open, and `tests/kit/console-sign-in-tests.swift`'s source
// scan — one file uses URLSession, no file sets a credential header, no file
// names a keychain API, no file opens a file — still holds with this layer in.
//
// A request body goes in on STDIN (`--body -`, or inside the session's request
// line), never argv: the same rule `metistry compute providers add` follows,
// for the same reason.
//
// WHAT THE SEAM IS FOR. `ConsoleCallTransport` is a protocol so the store can
// be driven against recorded fixtures with nothing spawned and no network
// (tests/kit/console-api-tests.swift). It is the same seam `CommandRunner` is,
// one level up: `CommandRunner` fakes a process, this fakes a console.
//
// WHAT THIS LAYER COST, SAID PLAINLY (struck 2026-09-26; F-11). `metistry
// console call` used to print the error ENVELOPE (`code`, `message`) on
// stderr for a >= 400 and nothing of the response BODY, so the extra keys on
// the staleness/conflict 409 — `reason`, `decision`, `decided_at`,
// `proposal` — did not survive the trip. `--json` now prints the console's
// own body on stdout for a >= 400 too (`packages/cli/src/main.ts`), and
// `ConsoleError.fromConsoleCall` decodes `ConsoleErrorEnvelope` from THAT —
// real JSON, not a re-parse of the rendered stderr line — so a message that
// itself contains " — ", or a `field` the render did not carry, still comes
// through whole. `ConsoleError.conflictBodyIsUnavailable` is gone: the
// transport does see the body now, and since F-12 the extra conflict keys
// have a home — `ConsoleErrorEnvelope.details`, read as
// `ConsoleError.conflictReason` and `.details` — for the queue's
// `if_unchanged` repaint to draw from.
//
// WHAT IT CAN NOW DO (struck 2026-09-18; `console call` gained
// `--idempotency-key <key>`). `ConsoleCallTransport.call`'s fourth argument
// rides as `Idempotency-Key` (docs/ops/console-api.md, today read only by
// `POST /capture`), checked to the CLI's own shape before it ever reaches the
// process. Nothing here calls it yet — `ConsoleAPI` has no capture method,
// because capture itself is not on this layer — but the transport is no
// longer the reason it couldn't be.

import Foundation

// MARK: - Reachability, reported rather than inferred

/// Whether the console answered, said something was missing, or did not answer.
///
/// design-system P5: state is **reported**, never inferred. Every value here
/// comes from something the console or the CLI actually said — there is no
/// timer that decides a console is down, and no green that was not earned.
public enum ConsoleReachability: Sendable, Equatable {
    /// It answered. A route may still have refused this request; that is a
    /// `ConsoleError`, not a reachability state.
    case reachable
    /// It answered, and named something absent in this deployment — a `503
    /// not_available` naming the config field, or a read that arrived with its
    /// own `degraded` note ("keyword only — the embedder is down").
    case degraded(String)
    /// Nothing usable came back: no process, no connection, no door.
    case unreachable(String)

    /// O3: decision controls are disabled while unreachable. The Mac app is
    /// local-only (app-ux-plan.md §7.3) and the rule still applies — a button
    /// that cannot reach the service must not look like one that can.
    public var allowsDecisions: Bool {
        switch self {
        case .reachable, .degraded: return true
        case .unreachable: return false
        }
    }

    /// The sentence a §3.16 envelope prints, or nil when there is nothing to say.
    public var detail: String? {
        switch self {
        case .reachable: return nil
        case .degraded(let d), .unreachable(let d): return d
        }
    }

    /// How an error the client just got changes what the client may claim.
    ///
    /// `401` is **unreachable**: the door refused the owner, so nothing on the
    /// owner surface can be done and no control may pretend otherwise. `403` is
    /// not — the console is reachable and one route declined this credential,
    /// which is a refusal to explain where it happened (P4), not an outage.
    public static func after(_ error: ConsoleError) -> ConsoleReachability {
        switch error {
        case .transport(let d), .cliUnavailable(let d), .notConfigured(let d), .badOrigin(let d):
            return .unreachable(d)
        case .undecodable(let d):
            return .degraded(d)
        case .http(let status, let envelope):
            if status == 401 { return .unreachable(envelope?.message ?? "the console refused the owner token (401)") }
            if status == 503 { return .degraded(envelope?.message ?? "not available in this deployment") }
            return .reachable
        }
    }
}

// MARK: - The transport seam

/// One authenticated request against the local instance's console, as the
/// `user` principal. `.success` is a 2xx and the console's own bytes; every
/// other outcome is a typed `ConsoleError`.
public protocol ConsoleCallTransport: Sendable {
    /// `idempotencyKey`, when given, rides as `Idempotency-Key`
    /// (`docs/ops/console-api.md`, today read only by `POST /capture`).
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError>
}

extension ConsoleCallTransport {
    /// The common case: no `Idempotency-Key`. Every existing call site keeps
    /// this three-argument spelling; only a caller that wants the header
    /// reaches for the four-argument one above.
    public func call(_ method: String, _ path: String, body: Data?) async -> Result<Data, ConsoleError> {
        await call(method, path, body: body, idempotencyKey: nil)
    }
}

/// `metistry console call` — one process per request. The fallback
/// `SessionConsoleCallTransport` uses for an install whose CLI predates
/// `console session`, and still the simplest transport for a one-off.
public struct CLIConsoleCallTransport: ConsoleCallTransport {
    /// Named once so the screens that print "here is what was run" and the code
    /// that runs it cannot drift, exactly as `ConsoleClient.whoamiVerb` is.
    public static let verb = ["console", "call"]

    private let cli: MetistryCLI

    public init(cli: MetistryCLI) {
        self.cli = cli
    }

    /// The argument array for a request, for a view that shows its work.
    public func arguments(_ method: String, _ path: String, hasBody: Bool, idempotencyKey: String? = nil) -> [String] {
        Self.verb + [method, path, "--json"] + (hasBody ? ["--body", "-"] : []) + (idempotencyKey.map { ["--idempotency-key", $0] } ?? [])
    }

    public func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String? = nil) async -> Result<Data, ConsoleError> {
        let payload = body.flatMap { String(data: $0, encoding: .utf8) }
        if body != nil && payload == nil { return .failure(.undecodable("the request body is not UTF-8")) }
        let result: CommandResult
        do {
            result = try await cli.run(
                arguments(method, path, hasBody: body != nil, idempotencyKey: idempotencyKey),
                standardInput: payload
            )
        } catch {
            // The process could not be started at all. Not an answer from the
            // console, and it must not be dressed as one.
            return .failure(.transport("could not run `metistry console call`: \(error.localizedDescription)"))
        }
        if CLIDegradation.isUnknownVerb(result) {
            return .failure(.cliUnavailable(CLIDegradation.message(verb: "console call")))
        }
        if result.ok {
            guard let data = result.stdout.data(using: .utf8) else {
                return .failure(.undecodable("`metistry console call` printed bytes that are not UTF-8"))
            }
            return .success(data)
        }
        return .failure(ConsoleError.fromConsoleCall(stderr: result.stderr, stdout: result.stdout, exitCode: result.exitCode))
    }
}

// MARK: - The session transport: the same door, held open (F-12)

/// A long-lived child as MetistryKit sees it: lines out, lines in, and how it
/// ended. The kit is free of `Process` (Package.swift) — the app target's
/// `ProcessCommandRunner` is the one implementation, and a test is another.
public protocol SessionProcess: Sendable {
    /// stdout, one line per element, in order, finishing when stdout closes —
    /// which is when the child exits.
    var lines: AsyncStream<String> { get }
    /// One line to stdin; the newline is appended. Throws once the pipe is gone.
    func send(_ line: String) throws
    /// How it ended — the exit code and what it said on stderr (stdout is the
    /// `lines` above, already consumed). Awaited after `lines` finishes.
    func termination() async -> CommandResult
    func terminate()
}

/// Starts a `SessionProcess`. `ProcessCommandRunner` conforms in the app target.
public protocol SessionSpawner: Sendable {
    func spawn(executable: URL, arguments: [String], environment: [String: String], currentDirectory: URL?) throws -> any SessionProcess
}

/// One frame of `GET /api/events` (design-build-plan §2.20; `packages/core/src/events.ts`):
/// what changed, as ids and counts — never a body. The client refetches the
/// thing itself through the route that already decides who may read it.
public struct ConsoleLiveEvent: Sendable, Equatable {
    /// The SSE `id:` — opaque and increasing; what a resubscribe hands back as `lastEventID`.
    public let id: String?
    /// `work.changed`, `needs_you.changed`, … — passed through as sent, so an
    /// additive type on a newer console reaches a caller that can ignore it.
    public let type: String
    public let data: JSONValue

    public init(id: String?, type: String, data: JSONValue) {
        self.id = id
        self.type = type
        self.data = data
    }

    /// The stream's position with nothing to dispatch — an SSE `id:` with no
    /// `data:`. The console sends one to a fresh subscriber so that a stream
    /// which hears nothing before it drops still resumes from where it
    /// opened; `console session` passes it on as `{id, event: {id}}`. No type,
    /// no data: nothing changed, and there is nothing to refetch.
    public static func cursor(_ id: String) -> ConsoleLiveEvent {
        ConsoleLiveEvent(id: id, type: "", data: .null)
    }

    /// A cursor, not an event. SSE's default type is `message`, so a real
    /// frame is never typeless.
    public var isCursor: Bool { type.isEmpty }
}

/// `metistry console session --stdio` — `console call` as ONE long-lived
/// child instead of a process per request (~141 ms each on the scratch
/// instance, measured for F-12; ~1.5 ms through a session).
///
/// The contract is the CLI's (`packages/cli/src/console-client.ts`,
/// docs/ops/cli.md): a line of JSON per request on stdin, exactly one
/// terminal line per request on stdout, **matched by id** — never by order.
/// The token is resolved once, by the child, and never reaches this process:
/// the lines carry a method, a path and a body, and nothing here sets a
/// header or opens a keychain (the source scan in console-sign-in-tests.swift
/// still holds).
///
/// **A crashed child fails what is in flight — it never hangs it.** When stdout
/// closes, every pending call gets the child's own reason (its last stderr
/// line, classified the way `fromConsoleCall` classifies a one-shot's) and
/// every open event stream finishes with it. The next call starts a new child:
/// that is the restart, and it is lazy on purpose — a child that cannot start
/// (no token, a non-loopback console) is not respawned in a loop nobody asked
/// for. A call that gets no answer at all within `callTimeout` fails too.
///
/// **An install whose CLI predates the verb** answers the first call through
/// `fallback` — `CLIConsoleCallTransport`, one process per request — and every
/// call after it, so an older install is slower rather than broken.
public actor SessionConsoleCallTransport: ConsoleCallTransport {
    /// Named once, like `CLIConsoleCallTransport.verb`.
    public static let verb = ["console", "session", "--stdio"]

    private let start: @Sendable () throws -> any SessionProcess
    private let fallback: (any ConsoleCallTransport)?
    private let callTimeout: Duration

    private var child: (any SessionProcess)?
    private var generation = 0
    private var nextID = 0
    private var pending: [String: CheckedContinuation<Result<Data, ConsoleError>, Never>] = [:]
    private var streams: [String: AsyncThrowingStream<ConsoleLiveEvent, any Error>.Continuation] = [:]
    /// Set once the install's CLI turned out not to have the verb.
    private var predatesSession = false

    /// The production transport: the install's own CLI, spawned through the app's `Process` runner.
    public init(cli: MetistryCLI, spawner: any SessionSpawner, callTimeout: Duration = .seconds(45)) {
        self.init(fallback: CLIConsoleCallTransport(cli: cli), callTimeout: callTimeout) {
            try spawner.spawn(
                executable: cli.runtime.executable,
                arguments: cli.arguments(for: Self.verb),
                environment: cli.baseEnvironment,
                currentDirectory: cli.runtime.productDir
            )
        }
    }

    /// The seam: anything that produces a `SessionProcess` — a test's scripted child.
    public init(
        fallback: (any ConsoleCallTransport)? = nil,
        callTimeout: Duration = .seconds(45),
        start: @escaping @Sendable () throws -> any SessionProcess
    ) {
        self.start = start
        self.fallback = fallback
        self.callTimeout = callTimeout
    }

    public func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        if predatesSession, let fallback {
            return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
        }
        var request: [String: Any] = ["method": method, "path": path]
        if let body {
            // The line is JSON, so the body rides as a JSON value inside it.
            guard let value = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) else {
                return .failure(.undecodable("the request body is not JSON"))
            }
            request["body"] = value
        }
        if let idempotencyKey { request["idempotency_key"] = idempotencyKey }
        let result = await send(request)
        if case .failure(.cliUnavailable) = result, let fallback {
            predatesSession = true
            return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
        }
        return result
    }

    /// `GET /api/events` as a stream of frames — one subscription per app
    /// (§2.20). Cancelling the consuming task sends `{id, cancel: true}`; a
    /// console that closes the stream finishes it; a console that does not
    /// serve the route (a 404 before T2-18 lands) or a child that dies
    /// finishes it with the error, and the caller falls back to polling.
    public func events(lastEventID: String? = nil) -> AsyncThrowingStream<ConsoleLiveEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<ConsoleLiveEvent, any Error>.makeStream()
        let process: any SessionProcess
        switch ensureChild() {
        case .failure(let error):
            continuation.finish(throwing: error)
            return stream
        case .success(let p):
            process = p
        }
        let id = mintID("e")
        var request: [String: Any] = ["id": id, "method": "GET", "path": "/api/events", "stream": true]
        if let lastEventID { request["last_event_id"] = lastEventID }
        streams[id] = continuation
        continuation.onTermination = { [weak self] reason in
            guard case .cancelled = reason else { return }
            Task { await self?.cancelStream(id) }
        }
        do {
            try process.send(Self.encode(request))
        } catch {
            streams[id] = nil
            continuation.finish(throwing: ConsoleError.transport("could not write to `metistry console session`: \(error.localizedDescription)"))
        }
        return stream
    }

    /// Ends the child. The next call starts a new one.
    public func shutdown() {
        child?.terminate()
    }

    // MARK: the child

    private func ensureChild() -> Result<any SessionProcess, ConsoleError> {
        if let child { return .success(child) }
        let process: any SessionProcess
        do {
            process = try start()
        } catch {
            return .failure(.transport("could not run `metistry console session`: \(error.localizedDescription)"))
        }
        generation += 1
        let current = generation
        child = process
        Task { [weak self] in
            for await line in process.lines {
                await self?.receive(line)
            }
            let ended = await process.termination()
            await self?.childEnded(current, ended)
        }
        return .success(process)
    }

    private func mintID(_ prefix: String) -> String {
        nextID += 1
        return "\(prefix)\(nextID)"
    }

    private static func encode(_ request: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: request, options: [.fragmentsAllowed])
        guard let line = String(data: data, encoding: .utf8) else { throw ConsoleError.undecodable("the request is not UTF-8") }
        return line
    }

    private func send(_ request: [String: Any]) async -> Result<Data, ConsoleError> {
        let process: any SessionProcess
        switch ensureChild() {
        case .failure(let error): return .failure(error)
        case .success(let p): process = p
        }
        let id = mintID("r")
        var line = request
        line["id"] = id
        let text: String
        do {
            text = try Self.encode(line)
        } catch {
            return .failure(.undecodable("could not encode the request: \(error.localizedDescription)"))
        }
        let timeout = callTimeout
        return await withCheckedContinuation { (continuation: CheckedContinuation<Result<Data, ConsoleError>, Never>) in
            pending[id] = continuation
            do {
                try process.send(text)
            } catch {
                pending[id] = nil
                continuation.resume(returning: .failure(.transport("could not write to `metistry console session`: \(error.localizedDescription)")))
                return
            }
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                await self?.timeOut(id, after: timeout)
            }
        }
    }

    private func timeOut(_ id: String, after timeout: Duration) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(returning: .failure(.transport("`metistry console session` gave no answer in \(timeout) — the request may or may not have reached the console")))
    }

    private func cancelStream(_ id: String) {
        guard streams.removeValue(forKey: id) != nil, let child else { return }
        try? child.send((try? Self.encode(["id": id, "cancel": true])) ?? "")
    }

    /// One stdout line. Its `id` is the only thing that says what it answers.
    private func receive(_ line: String) {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = object["id"] as? String
        else { return } // a line with no id of ours answers nothing we asked
        if let event = object["event"] as? [String: Any] {
            // `{id, event: {id}}`: the console's cursor. Kept, not dropped —
            // it is the only id a stream that is quiet from the start has to
            // resume from (T2-18 found it lost here; T5-7).
            if event["type"] == nil, event["data"] == nil {
                if let cursor = event["id"] as? String, !cursor.isEmpty { streams[id]?.yield(.cursor(cursor)) }
                return
            }
            let payload = event["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
            streams[id]?.yield(ConsoleLiveEvent(
                id: event["id"] as? String,
                type: event["type"] as? String ?? "message",
                data: payload.flatMap { try? JSONValue.parse($0) } ?? .null
            ))
            return
        }
        let outcome = Self.outcome(of: object)
        if let continuation = pending.removeValue(forKey: id) {
            continuation.resume(returning: outcome)
        } else if let stream = streams.removeValue(forKey: id) {
            switch outcome {
            case .success: stream.finish() // `ended`: cancelled, or the console closed it
            case .failure(let error): stream.finish(throwing: error)
            }
        }
    }

    /// A terminal line, as the `Result` `ConsoleCallTransport` promises —
    /// the same bytes-and-errors contract `CLIConsoleCallTransport` keeps.
    static func outcome(of object: [String: Any]) -> Result<Data, ConsoleError> {
        if let error = object["error"] as? [String: Any] {
            let message = error["message"] as? String ?? "no message"
            if error["code"] as? String == "unreachable" { return .failure(.transport(message)) }
            return .failure(.undecodable("`metistry console session` refused the request: \(message)"))
        }
        if object["ended"] != nil { return .success(Data()) }
        guard let status = object["status"] as? Int else {
            return .failure(.undecodable("`metistry console session` printed a line with no status"))
        }
        var body: Any = object["body"] ?? NSNull()
        // `console call --json`'s fold, kept: a replay is the ORIGINAL
        // response, and a decoder that reads `replayed` finds it in the body.
        if object["replayed"] as? Bool == true, var dict = body as? [String: Any] {
            dict["replayed"] = true
            body = dict
        }
        // A body that is not JSON — `GET /api/runs/export`'s NDJSON — arrives
        // as its raw TEXT (`readConsoleResponse`: "not JSON: raw text
        // stands"), which on this line is a JSON string. Its bytes are the
        // answer. Re-encoding it would hand the reader one quoted line
        // instead of the rows, and an export read that way came back as a
        // single string row with no cursor. (No route answers with a bare
        // JSON string, which is the one body this reading would misread.)
        let data: Data
        if let text = body as? String {
            data = Data(text.utf8)
        } else {
            data = (try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed])) ?? Data()
        }
        if (200..<300).contains(status) { return .success(data) }
        return .failure(.http(status: status, envelope: (try? JSONValue.parse(data)).flatMap(ConsoleErrorEnvelope.init(json:))))
    }

    private func childEnded(_ ended: Int, _ result: CommandResult) {
        guard ended == generation else { return }
        child = nil
        let error = ConsoleError.fromSessionExit(result)
        let calls = pending
        pending = [:]
        for continuation in calls.values { continuation.resume(returning: .failure(error)) }
        let open = streams
        streams = [:]
        for stream in open.values { stream.finish(throwing: error) }
    }
}

extension ConsoleError {
    /// Why a session child stopped, from its exit code and stderr — the same
    /// reading `fromConsoleCall` gives a one-shot, plus the one thing only a
    /// session can be: a CLI that predates the verb. Such a CLI answers
    /// `console session` with `console`'s usage (exit 2), which names no
    /// `session`; a CLI with no `console` at all says "unknown command".
    static func fromSessionExit(_ result: CommandResult) -> ConsoleError {
        if result.exitCode == 2
            && (result.stderr.contains("unknown command")
                || (result.stderr.contains("usage: metistry console") && !result.stderr.contains("console session")))
        {
            return .cliUnavailable(CLIDegradation.message(verb: "console session"))
        }
        let text = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = text.split(separator: "\n").last.map(String.init) ?? text
        let detail = line.replacingOccurrences(of: "metistry console session: ", with: "")
        if detail.contains("is not set (") || detail.contains("is not loopback") {
            return .notConfigured(detail)
        }
        return .transport(
            detail.isEmpty
                ? "`metistry console session` exited \(result.exitCode) and said nothing"
                : "`metistry console session` exited \(result.exitCode): \(detail)"
        )
    }
}

// MARK: - The client

/// The typed client. One method per route in `docs/ops/console-api.md`, each
/// three lines over the same transport, so there is one place that knows what a
/// path is and one place that knows what a shape is.
public struct ConsoleAPI: Sendable {
    private let transport: any ConsoleCallTransport

    public init(transport: any ConsoleCallTransport) {
        self.transport = transport
    }

    public init(cli: MetistryCLI) {
        self.init(transport: CLIConsoleCallTransport(cli: cli))
    }

    /// Every request down one long-lived `metistry console session --stdio`
    /// child — the transport a screen that refreshes should use.
    public init(cli: MetistryCLI, spawner: any SessionSpawner) {
        self.init(transport: SessionConsoleCallTransport(cli: cli, spawner: spawner))
    }

    // MARK: identity

    /// `GET /api/identity` — instance id, display name, icon, the six coarse
    /// capabilities, version. The one unauthenticated read the console has; it
    /// is asked for down the same door as everything else, because the app has
    /// only one door.
    public func identity() async -> Result<ConsoleIdentity, ConsoleError> {
        await get("/api/identity")
    }

    /// `GET /api/whoami` — the principal this credential is. `console whoami`
    /// is the sign-in surface (console-sign-in.swift); this is the same fact
    /// for a screen that already holds a client.
    public func whoami() async -> Result<ConsoleWhoamiReply, ConsoleError> {
        await get("/api/whoami")
    }

    // MARK: the feed

    /// `GET /api/q/activity_feed` — the timeline (§3.2 rows).
    ///
    /// `since` is this query's own incremental parameter and is a **timestamp,
    /// inclusive**, not the opaque cursor the polled lists use: two rows can
    /// share a microsecond across two branches of the union, so the query
    /// returns rows *at or after* the instant and the client de-duplicates on
    /// `(ref, ts, kind)` (`seed/queries/activity_feed.yaml` says exactly this).
    /// `ActivityFeed.merging(_:)` is that de-duplication, in one place.
    ///
    /// `turnID` narrows the page to the calls one reply made — what a turn's
    /// disclosure fetches, so it shows every call rather than only those that
    /// fell inside the window's `limit` (screen-02-activity.md §6 fault 6).
    public func activityFeed(
        hours: Int? = nil,
        limit: Int? = nil,
        kind: String? = nil,
        project: String? = nil,
        agent: String? = nil,
        since: String? = nil,
        turnID: String? = nil
    ) async -> Result<ActivityFeed, ConsoleError> {
        await get("/api/q/activity_feed", [
            "hours": hours.map(String.init), "limit": limit.map(String.init),
            "kind": kind, "project": project, "agent": agent, "since": since,
            "turn_id": turnID,
        ])
    }

    /// `GET /api/runs/:id` — the drill-down a feed row's `runs:<id>` ref opens.
    public func run(_ id: Int) async -> Result<RunDetailReply, ConsoleError> {
        await get("/api/runs/\(id)")
    }

    // MARK: Needs You

    /// `GET /api/proposals` — the triage queue (no cursor: pending only, newest
    /// first, minus what `later` put down), or **everything that changed** since
    /// a cursor (oldest first, each row carrying `decision`, `decided_at` and
    /// `snoozed_until`). The cursor is an opaque string: it is handed back, never
    /// parsed.
    public func requests(limit: Int? = nil, since: String? = nil) async -> Result<RequestPage, ConsoleError> {
        await get("/api/proposals", ["limit": limit.map(String.init), "since": since])
    }

    /// `POST /api/proposals/:id` — one of the six answers
    /// (docs/ops/reply-feedback.md, ruled in app-ux-plan.md §7.4).
    ///
    /// `seenAt` is the `ts` of the row the client **rendered** (or the list
    /// cursor it rendered from). Sending it opts into the staleness check: if
    /// the row moved after that, nothing is decided. Approving a thing is
    /// approving *that* thing.
    public func answer(
        _ id: Int,
        _ answer: RequestAnswer,
        seenAt: String? = nil
    ) async -> Result<RequestAnswerResult, ConsoleError> {
        var body: [String: Any] = ["decision": answer.wire]
        if let feedback = answer.feedback { body["feedback"] = feedback }
        if let area = answer.area { body["area"] = area } // Revise on an access request grants THIS folder instead
        if let answers = answer.questionAnswers { body["answers"] = answers.map(\.wire) } // Send Answers: one per question, in order
        if let seenAt { body["if_unchanged"] = ["seen_at": seenAt] }
        return await post("/api/proposals/\(id)", body)
    }

    /// `POST /api/proposals/batch` — one verb, many rows, **all-or-nothing per
    /// row**: the response is always 200 and each id carries its own outcome.
    /// Only Later, Skip and Decline may be batched; `RequestAnswer.isBatchable`
    /// is that rule, and a caller that ignores it gets the route's own 400.
    public func answerMany(
        _ ids: [Int],
        _ answer: RequestAnswer
    ) async -> Result<RequestBatchResult, ConsoleError> {
        var body: [String: Any] = ["ids": ids, "decision": answer.wire]
        if let feedback = answer.feedback { body["feedback"] = feedback }
        return await post("/api/proposals/batch", body)
    }

    // MARK: Work

    /// `GET /api/q/board` — the board, as scalar columns so a native client
    /// renders it without server work (docs/ops/board.md). `limit` is **per
    /// column**, not per result set.
    public func board(project: String? = nil, limit: Int? = nil) async -> Result<Board, ConsoleError> {
        await get("/api/q/board", ["project": project, "limit": limit.map(String.init)])
    }

    /// `PATCH /api/tasks/:id` — the board's drags. Two arms, and the fields pick
    /// which: `owner`/`title`/`project` need no claim; `in_progress | blocked |
    /// closed` are the lease-holder's; `open` is the unblock and is legal from
    /// `blocked` only. Mixing the arms in one body is a 400 naming both fields,
    /// so `TaskPatch` refuses to build one.
    public func updateTask(_ id: Int, _ patch: TaskPatch) async -> Result<TaskMutation, ConsoleError> {
        guard let body = patch.wireBody else {
            return .failure(.http(status: 400, envelope: ConsoleErrorEnvelope(
                code: "invalid_request",
                message: TaskPatch.mixedArmsRefusal,
                field: "status"
            )))
        }
        return await patchRoute("/api/tasks/\(id)", body)
    }

    public func claimTask(_ id: Int, leaseSeconds: Int? = nil) async -> Result<TaskMutation, ConsoleError> {
        await post("/api/tasks/\(id)/claim", leaseSeconds.map { ["lease_seconds": $0] } ?? [:])
    }

    public func releaseTask(_ id: Int, note: String? = nil) async -> Result<TaskMutation, ConsoleError> {
        await post("/api/tasks/\(id)/release", note.map { ["note": $0] } ?? [:])
    }

    public func renewTask(_ id: Int, note: String? = nil, leaseSeconds: Int? = nil) async -> Result<TaskMutation, ConsoleError> {
        var body: [String: Any] = [:]
        if let note { body["note"] = note }
        if let leaseSeconds { body["lease_seconds"] = leaseSeconds }
        return await post("/api/tasks/\(id)/renew", body)
    }

    /// `POST /api/tasks/:id/dispatch` — the one task route that predates the
    /// four above. `target` and `brief` are both required by the route (a
    /// body without `brief` is a 400, which is all the old `target:`-only
    /// spelling of this method could ever get back), so `TaskDispatch` makes
    /// neither optional.
    public func dispatchTask(_ id: Int, _ dispatch: TaskDispatch) async -> Result<TaskDispatchResult, ConsoleError> {
        var body: [String: Any] = ["target": dispatch.target, "brief": dispatch.brief]
        if let sources = dispatch.sources { body["sources"] = sources }
        if let purpose = dispatch.purpose { body["purpose"] = purpose }
        if let maxACU = dispatch.maxACU { body["max_acu"] = maxACU }
        return await post("/api/tasks/\(id)/dispatch", body)
    }

    /// `GET /api/q/rooms` — threads on a card or an artifact, with participants
    /// and the consecutive-agent tail the ping-pong rule counts.
    public func rooms(
        state: String? = nil,
        project: String? = nil,
        anchor: String? = nil,
        limit: Int? = nil
    ) async -> Result<RoomList, ConsoleError> {
        await get("/api/q/rooms", [
            "state": state, "project": project, "anchor": anchor, "limit": limit.map(String.init),
        ])
    }

    // MARK: Agents

    /// `GET /api/agents` — the registry: grants, autonomy, `remote`,
    /// `approved_at` and a derived `pending`.
    public func agents() async -> Result<AgentList, ConsoleError> {
        await get("/api/agents")
    }

    /// `GET /api/q/agent_presence` — what each one is doing right now. Presence
    /// is a **derived** read through a named query (invariant 3), which is why
    /// it is a second call rather than a field on the registry.
    public func agentPresence(limit: Int? = nil) async -> Result<AgentPresenceList, ConsoleError> {
        await get("/api/q/agent_presence", ["limit": limit.map(String.init)])
    }

    /// `PUT /api/agents/:id/autonomy` — "the one route that may widen". The body
    /// **replaces** the record, so a caller reads, merges and writes; the reply
    /// carries `widened`, which is what a §3.17 confirmation has to quote.
    public func setAutonomy(_ id: String, _ update: AgentAutonomyUpdate) async -> Result<AgentAutonomyResult, ConsoleError> {
        await send("PUT", "/api/agents/\(escapePathSegment(id))/autonomy", update.wireBody)
    }

    public func approveAgent(_ id: String) async -> Result<AgentApprovalResult, ConsoleError> {
        await post("/api/agents/\(escapePathSegment(id))/approve", [:])
    }

    // MARK: Compute

    /// `GET /api/compute` — `metistry compute show --json`'s own report, plus
    /// `spend` folded from the `spend` named query, plus `writable`.
    ///
    /// The report itself decodes into `ComputeFacts`, which the Compute pane
    /// already reads from the CLI: one shape, two doors, no second decoder.
    public func compute() async -> Result<ConsoleCompute, ConsoleError> {
        await get("/api/compute")
    }

    /// `GET /api/compute/models` — live `/v1/models` per provider, plus the
    /// local servers this instance has not configured.
    public func computeModels(provider: String? = nil) async -> Result<ComputeModelsReply, ConsoleError> {
        await get("/api/compute/models", ["provider": provider])
    }

    /// `GET /api/compute/catalogue` (T4-18) — every switched-on provider's
    /// catalogue grouped by model. The console keeps the listings between
    /// searches; `refresh` re-reads every one of them now (C132's Refresh).
    public func computeCatalogue(query: String? = nil, provider: String? = nil, refresh: Bool = false) async -> Result<ComputeCatalogueReply, ConsoleError> {
        await get("/api/compute/catalogue", ["q": query, "provider": provider, "refresh": refresh ? "true" : nil])
    }

    /// `POST /api/compute/unassign` (T4-18) — remove a tier's or a crew's
    /// assignment. `default` is refused: it is reassigned, never removed.
    public func unassignCompute(_ target: ComputeAssignTarget) async -> Result<ComputeWriteResult, ConsoleError> {
        await post("/api/compute/unassign", [target.key: target.name])
    }

    /// `POST /api/compute/assign` — exactly one of `tier` or `crew`.
    public func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String? = nil) async -> Result<ComputeWriteResult, ConsoleError> {
        var body: [String: Any] = [target.key: target.name, "model": model]
        if let effort { body["effort"] = effort }
        return await post("/api/compute/assign", body)
    }

    public func setComputeBudget(scope: String, daily: Double? = nil, monthly: Double? = nil, action: String) async -> Result<ComputeWriteResult, ConsoleError> {
        var body: [String: Any] = ["scope": scope, "action": action]
        if let daily { body["daily"] = daily }
        if let monthly { body["monthly"] = monthly }
        return await post("/api/compute/budget", body)
    }

    /// `POST /api/compute/providers/test` — a real `GET <base_url>/models`, and
    /// with `complete` a one-token completion. Reports whether it worked and
    /// never what the credential is.
    public func testComputeProvider(_ name: String, complete: Bool = false) async -> Result<ComputeProviderTestReply, ConsoleError> {
        await post("/api/compute/providers/test", complete ? ["name": name, "complete": true] : ["name": name])
    }

    // MARK: Knowledge

    /// `GET /api/knowledge/search` — the full hit list, capped at 100 by the
    /// bridge with no offset and no cursor ("top 100, honestly"). `degraded`
    /// reaches the caller rather than being swallowed: "keyword only — the
    /// embedder is down" is a fact the UI states, not an error (P5).
    public func knowledgeSearch(_ q: String, mode: String? = nil, limit: Int? = nil) async -> Result<KnowledgeSearchReply, ConsoleError> {
        await get("/api/knowledge/search", ["q": q, "mode": mode, "limit": limit.map(String.init)])
    }

    /// `GET /api/knowledge/page` — one page's bytes, through the vault bridge
    /// (page content is not derived state, so it never comes from a query).
    /// A path that is refused and a path that is absent are the same `404`.
    public func knowledgePage(path: String) async -> Result<KnowledgePage, ConsoleError> {
        await get("/api/knowledge/page", ["path": path])
    }

    /// `GET /api/knowledge/pages` — the index, through a named query rather
    /// than the bridge, because a page LIST is derived state and a page's
    /// bytes are not. `area` is the derived grouping (`Areas/Health` covers
    /// its sub-folders); `prefix` narrows by path segment-wise, so
    /// `Areas/Health` never reaches `Areas/Healthcare`. Ordered by path and
    /// paged with `offset` against that total order — there is no `total`, so
    /// the end of the list is `isLastPage`.
    public func knowledgePages(area: String? = nil, prefix: String? = nil, limit: Int? = nil, offset: Int? = nil) async -> Result<KnowledgePageList, ConsoleError> {
        await get("/api/knowledge/pages", [
            "area": area,
            "prefix": prefix,
            "limit": limit.map(String.init),
            // Offset 0 is the default, and omitting it says the same thing —
            // so the first page has ONE spelling however the caller asks for
            // it: one stub key, one cache key, one line in a log.
            "offset": (offset ?? 0) == 0 ? nil : offset.map(String.init),
        ])
    }

    /// `GET /api/knowledge/links` — one page's links, both directions in one
    /// list. `direction` says which way an edge runs and `path` is always the
    /// OTHER end, so a client filters, groups and renders one array rather
    /// than reconciling two. An edge whose other end the caller may not see
    /// is dropped before it is sent, and an edge to a page no note lives at
    /// yet arrives with `resolved == false` — render it the way Obsidian
    /// does, not as an error. A path that is refused and one that is absent
    /// are the same `404`, exactly as on `knowledgePage`.
    public func knowledgeLinks(path: String, limit: Int? = nil, offset: Int? = nil) async -> Result<KnowledgePageLinkList, ConsoleError> {
        await get("/api/knowledge/links", [
            "path": path,
            "limit": limit.map(String.init),
            // Offset 0 is the default and omitting it says the same thing —
            // one spelling for "the first window" (as on `knowledgePages`).
            "offset": (offset ?? 0) == 0 ? nil : offset.map(String.init),
        ])
    }

    // MARK: The composer's menu

    /// `GET /api/commands` — generated from this instance's own `rules.yaml`
    /// plus the agent registry, never a static array. Order is deterministic
    /// (`/` commands then `@` agents, each sorted by id); the client re-ranks.
    public func commands() async -> Result<CommandMenu, ConsoleError> {
        await get("/api/commands")
    }

    // MARK: - The four lines every route above is made of

    private func get<T: Decodable & Sendable>(_ path: String, _ query: [String: String?] = [:]) async -> Result<T, ConsoleError> {
        await send("GET", path + Self.queryString(query), nil)
    }

    private func post<T: Decodable & Sendable>(_ path: String, _ body: [String: Any]) async -> Result<T, ConsoleError> {
        await send("POST", path, body)
    }

    private func patchRoute<T: Decodable & Sendable>(_ path: String, _ body: [String: Any]) async -> Result<T, ConsoleError> {
        await send("PATCH", path, body)
    }

    private func send<T: Decodable & Sendable>(_ method: String, _ path: String, _ body: [String: Any]?) async -> Result<T, ConsoleError> {
        var payload: Data?
        if let body {
            guard let encoded = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
                return .failure(.undecodable("could not encode the request body for \(method) \(path)"))
            }
            payload = encoded
        }
        switch await transport.call(method, path, body: payload) {
        case .failure(let error):
            return .failure(error)
        case .success(let data):
            do {
                return .success(try JSONDecoder().decode(T.self, from: data))
            } catch {
                return .failure(.undecodable("\(method) \(path) answered a shape this app could not read: \(shortDecodeFailure(error))"))
            }
        }
    }

    /// RFC 3986 unreserved characters. Everything else is percent-encoded —
    /// including `+`, which WHATWG query parsing would otherwise read as a
    /// space, so a search for `C++` would search for `C  `.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    /// Deterministic: keys sorted, empty and nil values dropped. A stub keys on
    /// the exact path (tests/kit/console-api-tests.swift), and a query string
    /// whose order depended on a dictionary's hashing would be untestable.
    static func queryString(_ query: [String: String?]) -> String {
        let pairs = query
            .compactMap { key, value -> (String, String)? in
                guard let value, !value.isEmpty else { return nil }
                return (key, value)
            }
            .sorted { $0.0 < $1.0 }
            .map { "\(escape($0.0))=\(escape($0.1))" }
        return pairs.isEmpty ? "" : "?" + pairs.joined(separator: "&")
    }

    static func escape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    /// An id in a path segment. Agent ids are already slugs
    /// (`^[a-z][a-z0-9-]{0,39}$`), so this encodes nothing in practice and is
    /// here so that a future id which is not a slug cannot build a path.
    private func escapePathSegment(_ text: String) -> String {
        Self.escape(text)
    }

    /// `DecodingError`'s own description is several lines of context path. One
    /// sentence is what a §3.16 envelope can print.
    private func shortDecodeFailure(_ error: any Error) -> String {
        guard let decoding = error as? DecodingError else { return error.localizedDescription }
        switch decoding {
        case .keyNotFound(let key, _): return "no `\(key.stringValue)` in the reply"
        case .typeMismatch(_, let context): return "`\(Self.path(context))` is the wrong type"
        case .valueNotFound(_, let context): return "`\(Self.path(context))` is null"
        case .dataCorrupted(let context): return context.debugDescription
        @unknown default: return "the reply did not decode"
        }
    }

    private static func path(_ context: DecodingError.Context) -> String {
        context.codingPath.map(\.stringValue).joined(separator: ".")
    }
}

// MARK: - `metistry console call`'s failures, read back into the envelope

public extension ConsoleError {
    /// What the CLI prints when a request did not come back 2xx.
    ///
    /// Three shapes, and they mean different things:
    ///
    ///   * `HTTP 409 — conflict — already decided` on stderr —
    ///     `renderConsoleCallError`'s render of the console's own envelope. The
    ///     status is read from here, always; the envelope itself is decoded
    ///     from `stdout` when `--json` put real JSON there (F-11), and from
    ///     this same rendered line otherwise — so nothing is lost for a 400,
    ///     401, 403, 404 or 503 either way, and a message containing " — " or
    ///     a `field` key the render did not carry now comes through intact.
    ///   * `METISTRY_LOCAL_OWNER_TOKEN is not set …` / `… is not loopback …` —
    ///     the door is not configured on this install. The CLI's own sentence,
    ///     verbatim, because it already names the fix.
    ///   * anything else — nothing answered.
    ///
    /// Matching is on phrases, not on the variable's name: the secret has been
    /// renamed once already and must not be load-bearing here
    /// (console-sign-in.swift holds the same line).
    static func fromConsoleCall(stderr: String, stdout: String = "", exitCode: Int32) -> ConsoleError {
        let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = text.split(separator: "\n").last.map(String.init) ?? text
        let detail = line.replacingOccurrences(of: "metistry console call: ", with: "")
        if let http = HTTPRender(detail) {
            // The real body, when `--json` printed one for this >= 400
            // (`packages/cli/src/main.ts`) — decoded straight from JSON rather
            // than re-parsed out of the rendered stderr line above.
            let decoded = stdout.data(using: .utf8).flatMap { try? JSONValue.parse($0) }.flatMap(ConsoleErrorEnvelope.init(json:))
            return .http(status: http.status, envelope: decoded ?? http.envelope)
        }
        if detail.contains("is not set (") || detail.contains("is not loopback") {
            return .notConfigured(detail)
        }
        return .transport(detail.isEmpty ? "`metistry console call` exited \(exitCode) and said nothing" : detail)
    }

    /// `HTTP <status> — <code> — <message>[ — (field: <name>)]`, which is
    /// `renderConsoleCallError`'s join in `packages/cli/src/console-client.ts`.
    private struct HTTPRender {
        let status: Int
        let envelope: ConsoleErrorEnvelope?

        init?(_ detail: String) {
            let parts = detail.components(separatedBy: " — ").map { $0.trimmingCharacters(in: .whitespaces) }
            guard let first = parts.first, first.hasPrefix("HTTP "), let status = Int(first.dropFirst(5)) else { return nil }
            let rest = Array(parts.dropFirst())
            var field: String?
            var described = rest
            if let last = rest.last, last.hasPrefix("(field: "), last.hasSuffix(")") {
                field = String(last.dropFirst(8).dropLast())
                described = Array(rest.dropLast())
            }
            self.status = status
            guard let code = described.first else {
                self.envelope = nil
                return
            }
            self.envelope = ConsoleErrorEnvelope(
                code: code,
                message: described.dropFirst().joined(separator: " — "),
                field: field
            )
        }
    }
}

// MARK: - Reading a refusal

public extension ConsoleError {
    var httpStatus: Int? {
        if case .http(let status, _) = self { return status }
        return nil
    }

    /// The envelope's `code` — `invalid_request`, `not_found`, `conflict`,
    /// `not_available`, `forbidden`, `unauthenticated`.
    var code: String? {
        if case .http(_, let envelope) = self { return envelope?.code }
        return nil
    }

    /// The console's own words for this refusal. P4: a refusal is explained
    /// where it happens, in the words of the thing that refused.
    var refusal: String? {
        if case .http(_, let envelope) = self { return envelope?.message }
        return nil
    }

    /// 401 — the door. Always the same body, whatever it was that failed.
    var isUnauthenticated: Bool { httpStatus == 401 }
    /// 403 — authenticated and not permitted. On the owner surface this means a
    /// capture owner token or an agent bearer reached a management route.
    var isForbidden: Bool { httpStatus == 403 }
    var isNotFound: Bool { httpStatus == 404 }
    /// 409 — already decided, or decided against a row that moved.
    var isConflict: Bool { httpStatus == 409 }
    /// A `409`'s `reason` (`stale` | `already_decided`), when the route sends one.
    var conflictReason: String? {
        if case .http(409, let envelope) = self { return envelope?.reason }
        return nil
    }
    /// The refusal's body beyond `{error}` — for a `409`, the row as it stands,
    /// which is what the queue's `if_unchanged` repaint draws from.
    var details: [String: JSONValue] {
        if case .http(_, let envelope) = self { return envelope?.details ?? [:] }
        return [:]
    }
    /// 503 `not_available` — the capability is absent in this deployment, which
    /// is a fact rather than a fault (degrades: absent), and the message names
    /// the config field that would supply it.
    var isNotAvailable: Bool { httpStatus == 503 }

    /// The field this refusal is about.
    ///
    /// The wire envelope is `{code, message}` and nothing else — "a refusal
    /// names the field that would permit it" (docs/ops/console-api.md) puts the
    /// field **in the message**, as prose. So the only honest attribution is to
    /// look for a name the caller already knows it sent: nothing is inferred
    /// from the sentence's shape, and a message that names no known field
    /// returns nil rather than a guess.
    func namedField(among known: [String]) -> String? {
        guard case .http(_, let envelope) = self, let envelope else { return nil }
        if let field = envelope.field { return field }
        return known.first { envelope.message.contains($0) }
    }
}
