// MetistryKit's store interface (design-build-plan §2.16, F-7).
//
// ONE PROTOCOL PER DOMAIN, ONE METHOD PER ROUTE. Every row of the client API
// table (`packages/core/src/client-api.ts`) the app reads or writes is exactly
// one requirement of exactly one `…Store` protocol, and the doc comment on it
// names the row — `/// route: GET /api/today` — so a test can hold the two
// together: `tests/kit/store-fixtures-tests.swift` parses these files, finds a
// recorded fixture for every `route:` line, and calls every method against it.
// `/api/q/:name` is the one row with several methods, one per named query,
// and each names its query (`/// route: GET /api/q/board`).
//
// The rows the kit has NO method for are listed, with the reason, in
// `apps/console/scripts/client-fixtures.mjs` (`NOT_IN_THE_KIT`): the passkey
// ceremony, logout and push are bound to a device session the Mac does not
// have, and `/mcp` is the agent door.
//
// WHAT IS FROZEN HERE, AND WHAT IS NOT. The protocols — which method, which
// parameters, which reply TYPE — are the interface views are written against.
// A reply's fields are frozen only as far as the contract freezes them:
//
//   * the routes `ConsoleAPI` already read keep their typed models
//     (console-data.swift) and their method names ("existing methods stay");
//   * a reply the contract spells out field by field is typed here;
//   * every other reply is a `ConsoleBody` — a named type holding the
//     console's JSON whole. The recorded fixture carries its real shape (or,
//     for a route not served yet, the shape its ticket must match), and the
//     ticket that renders it adds typed fields to THAT type, so no protocol
//     signature moves when it does.
//
// Request bodies follow the same rule: a parameter where the contract names
// the field, a `ConsoleRequestBody` type where the route's ticket has not
// frozen its body yet.
//
// OVER ANY TRANSPORT. `ConsoleStores` implements every protocol over a
// `ConsoleCallTransport` — `metistry console call` today, the session
// transport of F-12 in production, recorded fixtures in tests — and the event
// stream over a `ConsoleEventTransport` (events-store.swift). It adds nothing
// a route does not do: a path, a body, a decode.

import Foundation

// MARK: - Bodies the kit reads whole

/// A reply the kit does not type field by field yet: the console's JSON, whole.
///
/// Decoding never fails on shape — any JSON is a body — so a console that grew
/// a field, or a route whose shape its ticket is still settling, still reaches
/// the view. The fixture beside the route is where the shape is pinned.
public protocol ConsoleBody: Decodable, Sendable, Equatable {
    var json: JSONValue { get }
    init(json: JSONValue)
}

public extension ConsoleBody {
    init(from decoder: any Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    /// `reply["as_of"]` — one key of the body, nil when absent.
    subscript(key: String) -> JSONValue? { json[key] }
}

/// A request body whose fields its route's ticket has not frozen yet. The
/// type is the interface; `json` is what goes on the wire.
public protocol ConsoleRequestBody: Sendable, Equatable {
    var json: JSONValue { get }
}

/// A rating on a reply or a piece of generated prose: the wire's `1 | -1`.
public enum Rating: Int, Sendable, Equatable {
    case up = 1
    case down = -1
}

// MARK: - The implementation over any transport

/// Every store protocol, over one transport. Each method is a path, a body
/// and a decode — the same three lines `ConsoleAPI` is made of, which it
/// reuses for the routes it already read.
public struct ConsoleStores: Sendable {
    let transport: any ConsoleCallTransport
    let stream: (any ConsoleEventTransport)?
    let api: ConsoleAPI

    /// `stream` is where `GET /api/events` is read from — by default the
    /// transport itself when it can hold one open (the session transport of
    /// F-12). Without one the event stream ends at once with
    /// `ConsoleEventError.noStream`, and a client polls with `since` cursors
    /// instead — the contract's fallback (§2.20).
    public init(transport: any ConsoleCallTransport, stream: (any ConsoleEventTransport)? = nil) {
        self.transport = transport
        self.stream = stream ?? (transport as? any ConsoleEventTransport)
        self.api = ConsoleAPI(transport: transport)
    }

    // MARK: the three lines every new route is made of

    func get<T: Decodable & Sendable>(_ path: String, _ query: [String: String?] = [:]) async -> Result<T, ConsoleError> {
        await perform("GET", path + ConsoleAPI.queryString(query), nil)
    }

    func perform<T: Decodable & Sendable>(
        _ method: String,
        _ path: String,
        _ body: JSONValue?,
        idempotencyKey: String? = nil
    ) async -> Result<T, ConsoleError> {
        switch await data(method, path, body, idempotencyKey: idempotencyKey) {
        case .failure(let error):
            return .failure(error)
        case .success(let data):
            do {
                return .success(try JSONDecoder().decode(T.self, from: data))
            } catch {
                return .failure(.undecodable("\(method) \(path) answered a shape this app could not read: \(Self.describe(error))"))
            }
        }
    }

    func data(_ method: String, _ path: String, _ body: JSONValue?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        var payload: Data?
        if let body {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            guard let encoded = try? encoder.encode(body) else {
                return .failure(.undecodable("could not encode the request body for \(method) \(path)"))
            }
            payload = encoded
        }
        return await transport.call(method, path, body: payload, idempotencyKey: idempotencyKey)
    }

    /// One path segment, percent-encoded: an id, a name, a task key.
    static func segment(_ text: String) -> String {
        ConsoleAPI.escape(text)
    }

    static func describe(_ error: any Error) -> String {
        guard let decoding = error as? DecodingError else { return error.localizedDescription }
        switch decoding {
        case .keyNotFound(let key, _): return "no `\(key.stringValue)` in the reply"
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            return "`\(context.codingPath.map(\.stringValue).joined(separator: "."))` is not what the app expected"
        case .dataCorrupted(let context): return context.debugDescription
        @unknown default: return "the reply did not decode"
        }
    }
}

// MARK: - Building a body

extension JSONValue {
    /// An object from optional fields: a nil is left out, never sent as `null`.
    static func fields(_ pairs: KeyValuePairs<String, JSONValue?>) -> JSONValue {
        var object: [String: JSONValue] = [:]
        for (key, value) in pairs {
            if let value { object[key] = value }
        }
        return .object(object)
    }

    static func text(_ value: String?) -> JSONValue? { value.map(JSONValue.string) }
    static func int(_ value: Int?) -> JSONValue? { value.map { .number(Double($0)) } }
    static func double(_ value: Double?) -> JSONValue? { value.map(JSONValue.number) }
    static func texts(_ values: [String]?) -> JSONValue? { values.map { .array($0.map(JSONValue.string)) } }
}
