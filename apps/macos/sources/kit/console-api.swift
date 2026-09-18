// The app's authenticated read/write path into THIS machine's console, and the
// only place in Swift that names a management route.
//
// WHY THERE IS STILL NO HTTP CLIENT HERE. docs/ops/mac-app.md wrote the
// condition for this file before it existed: "Adding it is a CLI change first:
// a `metistry console call <METHOD> <path>` keeps the token out of this process
// entirely, which a token-printing verb would not." That verb shipped, and
// docs/ops/cli.md says what to do with it — "the app and
// docs/ops/second-instance.md use it rather than a second HTTP client". So the
// authenticated surface is one CLI invocation per request:
//
//     metistry console call <METHOD> <path> [--body -] --json
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
// A request body goes in on STDIN (`--body -`), never argv: the same rule
// `metistry compute providers add` follows, for the same reason.
//
// WHAT THE SEAM IS FOR. `ConsoleCallTransport` is a protocol so the store can
// be driven against recorded fixtures with nothing spawned and no network
// (tests/kit/console-api-tests.swift). It is the same seam `CommandRunner` is,
// one level up: `CommandRunner` fakes a process, this fakes a console.
//
// WHAT THIS LAYER COSTS, SAID PLAINLY. `metistry console call` prints the error
// ENVELOPE (`code`, `message`) on stderr for a >= 400 and does not print the
// response BODY, so the extra keys on the staleness/conflict 409 —
// `reason`, `decision`, `decided_at`, `proposal` — do not survive the trip.
// Everything phase A reads is unaffected (the envelope IS `{code, message}`);
// the queue's `if_unchanged` repaint in phase B needs the body, which is one
// change in `packages/cli/src/main.ts` — print `r.raw` on stdout for a >= 400
// too — and not a second client here. `ConsoleError.http` carries the status
// and the envelope; `ConsoleError.conflictBodyIsUnavailable` says so out loud
// rather than letting a caller believe it asked and got nothing.
//
// WHAT IT CANNOT DO AT ALL. `console call` sets no request headers, so
// `POST /capture`'s `Idempotency-Key` (docs/ops/console-api.md) is unreachable
// from here. Capture is not on this layer for that reason.

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
    func call(_ method: String, _ path: String, body: Data?) async -> Result<Data, ConsoleError>
}

/// `metistry console call` — the production transport, and the only one.
public struct CLIConsoleCallTransport: ConsoleCallTransport {
    /// Named once so the screens that print "here is what was run" and the code
    /// that runs it cannot drift, exactly as `ConsoleClient.whoamiVerb` is.
    public static let verb = ["console", "call"]

    private let cli: MetistryCLI

    public init(cli: MetistryCLI) {
        self.cli = cli
    }

    /// The argument array for a request, for a view that shows its work.
    public func arguments(_ method: String, _ path: String, hasBody: Bool) -> [String] {
        Self.verb + [method, path, "--json"] + (hasBody ? ["--body", "-"] : [])
    }

    public func call(_ method: String, _ path: String, body: Data?) async -> Result<Data, ConsoleError> {
        let payload = body.flatMap { String(data: $0, encoding: .utf8) }
        if body != nil && payload == nil { return .failure(.undecodable("the request body is not UTF-8")) }
        let result: CommandResult
        do {
            result = try await cli.run(
                arguments(method, path, hasBody: body != nil),
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
        return .failure(ConsoleError.fromConsoleCall(stderr: result.stderr, exitCode: result.exitCode))
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
    public func activityFeed(
        hours: Int? = nil,
        limit: Int? = nil,
        kind: String? = nil,
        project: String? = nil,
        agent: String? = nil,
        since: String? = nil
    ) async -> Result<ActivityFeed, ConsoleError> {
        await get("/api/q/activity_feed", [
            "hours": hours.map(String.init), "limit": limit.map(String.init),
            "kind": kind, "project": project, "agent": agent, "since": since,
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
    /// four above.
    public func dispatchTask(_ id: Int, target: String? = nil) async -> Result<TaskDispatchResult, ConsoleError> {
        await post("/api/tasks/\(id)/dispatch", target.map { ["target": $0] } ?? [:])
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
    /// What the CLI prints on stderr when a request did not come back 2xx.
    ///
    /// Three shapes, and they mean different things:
    ///
    ///   * `HTTP 409 — conflict — already decided` — `renderConsoleCallError`'s
    ///     render of the console's own envelope. The status and the envelope are
    ///     recovered verbatim; `code` and `message` are the whole envelope
    ///     (`packages/core/src/errors.ts`), so nothing is lost for a 400, 401,
    ///     403, 404 or 503.
    ///   * `METISTRY_LOCAL_OWNER_TOKEN is not set …` / `… is not loopback …` —
    ///     the door is not configured on this install. The CLI's own sentence,
    ///     verbatim, because it already names the fix.
    ///   * anything else — nothing answered.
    ///
    /// Matching is on phrases, not on the variable's name: the secret has been
    /// renamed once already and must not be load-bearing here
    /// (console-sign-in.swift holds the same line).
    static func fromConsoleCall(stderr: String, exitCode: Int32) -> ConsoleError {
        let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = text.split(separator: "\n").last.map(String.init) ?? text
        let detail = line.replacingOccurrences(of: "metistry console call: ", with: "")
        if let http = HTTPRender(detail) {
            return .http(status: http.status, envelope: http.envelope)
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
    /// 503 `not_available` — the capability is absent in this deployment, which
    /// is a fact rather than a fault (degrades: absent), and the message names
    /// the config field that would supply it.
    var isNotAvailable: Bool { httpStatus == 503 }

    /// True where a caller wanted the 409's extra keys and this transport
    /// cannot supply them. See the file header: `console call` puts the
    /// envelope on stderr and does not print the body, so `reason`, `decision`
    /// and the row itself do not survive a conflict. Said out loud so no caller
    /// reads their absence as "the console sent none".
    var conflictBodyIsUnavailable: Bool { isConflict }

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
