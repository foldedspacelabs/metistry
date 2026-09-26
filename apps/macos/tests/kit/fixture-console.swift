// The fake transport that serves the recorded fixtures (design-build-plan
// §2.16, F-7): a `ConsoleCallTransport` and a `ConsoleEventTransport` that
// answer from `tests/kit/fixtures/<stem>.json` and never from a console. A
// view built on `ConsoleStores(transport: FixtureConsole.recorded())` is built
// with no console running, no CLI spawned and no network (U9).
//
// A request is matched the way the console's own table matches it
// (`packages/core/src/client-api.ts`, `matchRoute`): the method, then each
// path segment — a literal exactly, a parameter any non-empty segment — and
// where two rows match, the one with more literal segments wins. The
// `/api/q/:name` fixtures are told apart by their concrete path. Every
// request is recorded, with the fixture that answered it, so a test can hold
// a store method to the route it claims and the body it must send.
//
// Fixtures are read with `#filePath`, as the source scan in
// console-sign-in-tests.swift reads the sources: the directory is excluded
// from the test target in Package.swift, so nothing is bundled.

import Foundation

@testable import MetistryKit

/// One fixture file, read.
struct ConsoleFixture: Sendable {
    let stem: String
    /// The table row: `GET /api/runs/:id`.
    let route: String
    /// `recorded` or `contract`.
    let source: String
    let ticket: String?
    let method: String
    /// The request as the recorder (or the contract) made it, query included.
    let path: String
    let body: JSONValue?
    let idempotencyKey: String?
    let lastEventID: String?
    let status: Int
    /// The bytes served: the JSON body, or NDJSON lines.
    let reply: Data
    let replyJSON: JSONValue?
    let stream: [ConsoleLiveEvent]?

    var pathOnly: String { String(path.split(separator: "?", maxSplits: 1).first ?? "") }

    /// `?a=1&b=2` → `["a": "1", "b": "2"]`, still percent-encoded.
    var query: [String: String] { Self.query(of: path) }

    static func query(of path: String) -> [String: String] {
        guard let q = path.split(separator: "?", maxSplits: 1).dropFirst().first else { return [:] }
        var out: [String: String] = [:]
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            out[kv[0]] = kv.count > 1 ? kv[1] : ""
        }
        return out
    }

    /// The directory, from this file's own path.
    static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")

    static func loadAll() throws -> [ConsoleFixture] {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        return try names.map { try load(String($0.dropLast(5))) }
    }

    static func load(_ stem: String) throws -> ConsoleFixture {
        let data = try Data(contentsOf: directory.appendingPathComponent("\(stem).json"))
        guard let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any],
              let route = object["route"] as? String,
              let source = object["source"] as? String,
              let request = object["request"] as? [String: Any],
              let method = request["method"] as? String,
              let path = request["path"] as? String,
              let status = object["status"] as? Int
        else { throw FixtureError.malformed(stem) }
        let json = try JSONDecoder().decode(JSONValue.self, from: data)

        var reply = Data()
        var stream: [ConsoleLiveEvent]?
        if let lines = object["body_ndjson"] as? [Any] {
            reply = Data(try lines.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]), as: UTF8.self) }.joined(separator: "\n").utf8)
        } else if let frames = json["stream"]?.arrayValue {
            stream = frames.map { ConsoleLiveEvent(id: $0["id"]?.stringValue, type: $0["event"]?.stringValue ?? "", data: $0["data"] ?? .null) }
        } else if let body = object["body"] {
            reply = try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed])
        }
        return ConsoleFixture(
            stem: stem, route: route, source: source, ticket: object["ticket"] as? String,
            method: method, path: path, body: json["request"]?["body"].flatMap { $0 == .null ? nil : $0 },
            idempotencyKey: request["idempotency_key"] as? String, lastEventID: request["last_event_id"] as? String,
            status: status, reply: reply, replyJSON: json["body"] ?? json["body_ndjson"], stream: stream
        )
    }

    enum FixtureError: Error { case malformed(String) }
}

/// What a store sent, and which fixture answered.
struct FixtureCall: Sendable, Equatable {
    let method: String
    let path: String
    let body: JSONValue?
    let idempotencyKey: String?
    let lastEventID: String?
    /// Nil when nothing matched — the request went to a route with no fixture.
    let servedBy: String?
}

final class FixtureConsole: ConsoleCallTransport, ConsoleEventTransport, @unchecked Sendable {
    let fixtures: [ConsoleFixture]
    private let lock = NSLock()
    private var log: [FixtureCall] = []

    init(_ fixtures: [ConsoleFixture]) {
        self.fixtures = fixtures
    }

    /// Every fixture under `tests/kit/fixtures/`.
    static func recorded() throws -> FixtureConsole { FixtureConsole(try ConsoleFixture.loadAll()) }

    var calls: [FixtureCall] { lock.withLock { log } }
    func reset() { lock.withLock { log.removeAll() } }

    /// The fixture a request is for, as the console's table would route it.
    func match(_ method: String, _ path: String) -> ConsoleFixture? {
        let concrete = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        let segments = concrete.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        var best: (fixture: ConsoleFixture, literals: Int, exact: Bool)?
        for f in fixtures where f.method == method {
            let template = f.route.split(separator: " ", maxSplits: 1).last.map(String.init) ?? ""
            let names = template.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
            guard names.count == segments.count else { continue }
            guard zip(names, segments).allSatisfy({ $0.hasPrefix(":") ? !$1.isEmpty : $0 == $1 }) else { continue }
            let literals = names.filter { !$0.hasPrefix(":") }.count
            let exact = f.pathOnly == concrete
            if let b = best, (b.exact && !exact) || (b.exact == exact && b.literals >= literals) { continue }
            best = (f, literals, exact)
        }
        // `/api/q/:name` is one row with a fixture per query: only the exact query answers
        if let b = best, b.fixture.route == "GET /api/q/:name", !b.exact { return nil }
        return best?.fixture
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let fixture = match(method, path)
        lock.withLock {
            log.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: fixture?.stem))
        }
        guard let fixture else {
            return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no fixture for \(method) \(path)")))
        }
        guard (200..<300).contains(fixture.status) else {
            return .failure(.http(status: fixture.status, envelope: fixture.replyJSON.flatMap(ConsoleErrorEnvelope.init(json:))))
        }
        return .success(fixture.reply)
    }

    func events(lastEventID: String?) async -> AsyncThrowingStream<ConsoleLiveEvent, any Error> {
        let path = "/api/events"
        let fixture = match("GET", path)
        lock.withLock {
            log.append(FixtureCall(method: "GET", path: path, body: nil, idempotencyKey: nil, lastEventID: lastEventID, servedBy: fixture?.stem))
        }
        return AsyncThrowingStream { continuation in
            guard let frames = fixture?.stream else {
                continuation.finish(throwing: ConsoleError.http(status: 404, envelope: ConsoleErrorEnvelope(code: "not_found", message: "no stream fixture for \(path)")))
                return
            }
            // a resubscribe resumes after the id the client last saw
            let start = lastEventID.flatMap { id in frames.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
            for frame in frames[start...] { continuation.yield(frame) }
            continuation.finish()
        }
    }
}
